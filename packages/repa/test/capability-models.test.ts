import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { RepaCapabilityServices } from "../src/capabilities/services.js";
import type { CapabilityDefinition } from "../src/capabilities/types.js";
import { RepaClient } from "../src/client.js";
import { ModelAttemptSchema, ModelBindingSchema, ModelFallbackSchema, ModelSelectionSchema, ModelOutputSchema, type ModelFallback, type ModelCompleteOptions } from "../src/models/schema.js";
import type { ResourceRef } from "../src/content/schema.js";
import { inputResources } from "../src/requests/input.js";
import { InputSchema, RepresentationSchema, type BackgroundRequest, type Input, type ProcessingResult } from "../src/requests/schema.js";
import { object } from "../src/schema.js";
import { startRepaServer, type RepaServer } from "../src/server.js";

const contract = { id: "fixture.models.process", version: "1" };
const CapabilityInputSchema = object({ model: ModelSelectionSchema, input: InputSchema, fallback: Type.Optional(ModelFallbackSchema) });
const ProviderInputSchema = Type.Object({
  messages: Type.Array(Type.Object({ role: Type.String(), content: Type.Unknown() })),
  max_tokens: Type.Optional(Type.Number()), max_completion_tokens: Type.Optional(Type.Number()),
});
const ModelDataSchema = Type.Object({
  binding: ModelBindingSchema,
  input: Type.String(),
  attempts: Type.Array(ModelAttemptSchema),
  output: Type.Optional(Type.Unknown()),
  outputFormat: Type.Optional(ModelOutputSchema),
  message: Type.Object({ stopReason: Type.String(), content: Type.Array(Type.Unknown()), usage: Type.Object({
    input: Type.Number(), output: Type.Number(), totalTokens: Type.Number(),
  }) }),
});
interface Captured {
  body: Static<typeof ProviderInputSchema>;
  url: string;
  authorization?: string;
  closed: boolean;
}

async function until<T>(read: () => T | Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= deadline) assert.fail(`等待能力模型处理状态超时：${JSON.stringify(value)}`);
    await delay(10);
  }
}

async function fixture(t: TestContext, options: {
  block?: boolean;
  failPrimary?: boolean;
  failFallback?: boolean;
  agent?: boolean;
  responseText?: string;
  finish?: string;
  intermediateResource?: boolean;
  configureComplete?(options: ModelCompleteOptions): void;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-capability-models-"));
  const agentDir = path.join(root, "agent");
  const directory = path.join(root, "space");
  const requests: Captured[] = [];
  const intermediateResources: ResourceRef[] = [];
  const providerErrors: unknown[] = [];
  const invocations: { source: string; aborted: boolean; finished: boolean }[] = [];
  let server: RepaServer | undefined;
  let client: RepaClient | undefined;
  const otherClients: RepaClient[] = [];
  const provider = createServer((request, response) => {
    void (async () => {
      request.setEncoding("utf8");
      let text = "";
      for await (const chunk of request) text += chunk;
      const body: unknown = JSON.parse(text);
      assert(Check(ProviderInputSchema, body));
      const captured: Captured = { body, url: request.url ?? "", authorization: request.headers.authorization, closed: false };
      response.once("close", () => { captured.closed = true; });
      requests.push(captured);
      if (options.block) return;
      const fallback = captured.url.startsWith("/fallback/");
      if (fallback ? options.failFallback : options.failPrimary) {
        response.writeHead(fallback ? 400 : 503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: fallback ? "invalid request" : "service unavailable" } }));
        return;
      }
      const chunk = (content: string, finish: string | null) => ({
        id: "capability-model", object: "chat.completion.chunk", created: 1, model: "local-model",
        choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: finish }],
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        `data: ${JSON.stringify(chunk(options.responseText ?? "能力子处理结果", null))}`,
        `data: ${JSON.stringify({ ...chunk("", options.finish ?? "stop"), usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}`,
        "data: [DONE]", "",
      ].join("\n\n"));
    })().catch((error: unknown) => {
      providerErrors.push(error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  t.after(async () => {
    try {
      await server?.close("cancel");
      await client?.close();
      await Promise.all(otherClients.map(other => other.close()));
    } finally {
      provider.closeAllConnections();
      if (provider.listening) await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    }
    assert.deepEqual(providerErrors, []);
  });
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: [], extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"],
    retry: { enabled: false }, compaction: { enabled: false },
  }));
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("本地模型服务未监听");
  const capability: CapabilityDefinition<typeof CapabilityInputSchema, typeof RepresentationSchema, RepaCapabilityServices> = {
    contract, implementationId: "local", scopes: ["space"], execution: "background",
    inputSchema: CapabilityInputSchema, outputSchema: RepresentationSchema,
    tool: { name: "fixture_models_process", description: "通过窄模型服务处理明确输入。" },
    inputResources: input => inputResources(input.input),
    async invoke(input, context) {
      assert(context.services?.models);
      assert.equal(context.scope.kind, "space");
      const observed = { source: context.source.kind, aborted: false, finished: false };
      invocations.push(observed);
      try {
        if (options.intermediateResource) {
          assert(context.services.resources);
          intermediateResources.push(await context.services.resources.create(Buffer.from("模型调用前的中间材料"), "text/plain"));
        }
        const completeOptions: ModelCompleteOptions = {
          model: input.model, input: input.input, fallback: input.fallback, system: "只处理能力提交的明确输入。", thinkingLevel: "off", maxTokens: 32,
        };
        options.configureComplete?.(completeOptions);
        return await context.services.models.complete(completeOptions);
      } finally {
        observed.aborted = context.signal.aborted;
        observed.finished = true;
      }
    },
  };
  const faux = options.agent ? fauxProvider({
    api: `capability-models-${randomUUID()}`, provider: `capability-models-${randomUUID()}`,
    models: [{ id: "agent", reasoning: false, input: ["text"], contextWindow: 16384, maxTokens: 1024 }],
    tokensPerSecond: 0,
  }) : undefined;
  const modelRuntime = faux ? await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  }) : undefined;
  if (faux && modelRuntime) modelRuntime.registerNativeProvider(faux.provider);
  const serverOptions = { ...(faux && modelRuntime ? { modelOverride: { modelRuntime, model: faux.getModel() } } : {}), agentDir, appDirectory: path.join(root, "app"), disconnectGraceMs: 0,
    plugins: [{ id: "model-fixture", enabled: true, factory: () => ({ capabilities: [capability] }) }] };
  server = await startRepaServer(serverOptions);
  client = await RepaClient.connect(server.connection);
  const space = await client.call("space.open", { path: directory });
  const scope = { kind: "space" as const, spaceId: space.id };
  const connection = await client.call("connection.create", {
    name: "能力所选本地模型", provider: "openai", authMode: "none", baseUrl: `http://127.0.0.1:${address.port}/v1`,
    models: [{ id: "local-model", name: "本地模型", api: "openai-completions", reasoning: false, input: ["text"],
      contextWindow: 8192, maxTokens: 256, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  const model = { connectionId: connection.id, id: "local-model" };
  const currentClient = () => { assert(client); return client; };
  const currentServer = () => { assert(server); return server; };
  const invoke = async (input: Input, fallback?: ModelFallback) => {
    const requestId = randomUUID();
    const accepted = await currentClient().call("capability.invoke", { scope, requestId, contract, input: { model, input, ...(fallback ? { fallback } : {}) } });
    assert.equal(accepted.kind, "background");
    if (accepted.kind !== "background") assert.fail("模型能力应由真实后台请求持有");
    assert.equal(accepted.request.requestId, requestId);
    assert.equal(accepted.request.operation, "repa.capability.invoke");
    return accepted.request;
  };
  const finished = async (request: BackgroundRequest) => {
    const result = await until(() => currentClient().call("request.get", { spaceId: space.id, requestId: request.requestId }),
      value => ["completed", "failed", "cancelled", "interrupted"].includes(value.status));
    assert("operation" in result);
    return result;
  };
  const reopen = async () => {
    await currentServer().close("cancel");
    await currentClient().close();
    server = await startRepaServer(serverOptions);
    client = await RepaClient.connect(server.connection);
    assert.equal((await client.call("space.open", { path: directory })).id, space.id);
  };
  const uploader = async () => {
    const other = await RepaClient.connect(currentServer().connection);
    otherClients.push(other);
    return other;
  };
  return { root, directory, space, connection, model, faux, requests, intermediateResources, invocations, invoke, finished, reopen, uploader,
    get client() { assert(client); return client; } };
}

function modelResult(request: BackgroundRequest) {
  assert.equal(request.status, "completed", JSON.stringify(request));
  assert(request.result);
  assert.deepEqual(request.result.format, contract);
  assert.equal(request.result.value.kind, "inline");
  if (request.result.value.kind !== "inline") assert.fail("父结果应保留能力返回的表示");
  assert(Check(RepresentationSchema, request.result.value.data));
  const nested = request.result.value.data;
  return { outer: request.result, nested, data: responseData(nested) };
}

function responseData(result: ProcessingResult) {
  assert.deepEqual(result.format, { id: "repa.model-response", version: "1" });
  assert.equal(result.value.kind, "inline");
  if (result.value.kind !== "inline") assert.fail("模型结果应为内联表示");
  assert(Check(ModelDataSchema, result.value.data));
  return result.value.data;
}

async function onlyParents(directory: string, ids: string[]) {
  assert.deepEqual((await readdir(path.join(directory, ".repa", "runtime", "processing"))).filter(name => name.endsWith(".json")).sort(), ids.map(id => `${id}.json`).sort(), "能力调用模型不创建另一个后台请求");
}

test("能力调用真实 HTTP 模型，父后台请求持久保留模型表示、来源、用量和资源", async (t) => {
  const f = await fixture(t);
  const uploader = await f.uploader();
  const target = { kind: "file" as const, spaceId: f.space.id, location: { kind: "relative" as const, path: "source.txt" } };
  await f.client.call("content.write", { target, operationId: randomUUID(), base: { kind: "absent" }, value: { kind: "text", text: "能力引用的原文" } });
  const read = await uploader.call("content.read", { target });
  assert(read.content.bodyRevision);
  assert(read.resource);
  const bytes = Buffer.from("能力输入附件字节");
  const { resource } = await uploader.uploadResource(f.space.id, bytes, "application/octet-stream");
  const accepted = await f.invoke({ parts: [{ kind: "reference", target }, { kind: "resource", resource, description: "能力附件" }] });
  const completed = await f.finished(accepted);
  const result = modelResult(completed);
  assert.deepEqual(result.outer.sources, [{ target, revision: read.content.bodyRevision }]);
  assert.deepEqual(result.outer.sources, result.nested.sources);
  assert.deepEqual(result.outer.resources, [resource, read.resource]);
  assert.deepEqual(result.outer.resources, result.nested.resources);
  assert.equal(result.data.message.usage.input, 3);
  assert.equal(result.data.message.usage.output, 2);
  assert.equal(result.data.message.usage.totalTokens, 5);
  assert.equal(result.data.binding.connection.id, f.connection.id);
  assert.match(result.data.input, /能力引用的原文/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]?.authorization, undefined, "显式无凭据模式不借用环境密钥");
  assert.match(JSON.stringify(f.requests[0]?.body.messages), /只处理能力提交的明确输入。/);
  assert.equal(f.requests[0]?.body.max_completion_tokens ?? f.requests[0]?.body.max_tokens, 32);
  assert.deepEqual(f.invocations, [{ source: "client", aborted: false, finished: true }]);
  await onlyParents(f.directory, [accepted.requestId]);
  await uploader.close();
  await f.reopen();
  assert.deepEqual(await f.client.call("request.get", { spaceId: f.space.id, requestId: accepted.requestId }), completed);
  await f.client.call("resource.collect", { spaceId: f.space.id });
  assert.deepEqual(Buffer.from(await (await f.client.resource(resource)).arrayBuffer()), bytes);
  assert.equal(await (await f.client.resource(read.resource)).text(), "能力引用的原文");
});

test("JavaScript 插件的非法模型选项在模型绑定和资源准备前失败，provider 不收到请求", async (t) => {
  let patch: Record<string, unknown> = {};
  const f = await fixture(t, { configureComplete: options => { Object.assign(options, patch); } });
  const invalidOptions: Record<string, unknown>[] = [
    { system: 42 },
    { system: undefined },
    { maxTokens: 0 },
    { maxTokens: -1 },
    { maxTokens: 1.5 },
    { maxTokens: "32" },
    { maxTokens: Number.NaN },
    { maxTokens: Number.POSITIVE_INFINITY },
    { input: { parts: [] } },
    { input: { parts: [{ kind: "text", text: 42 }] } },
    { input: { parts: [{ kind: "resource", resource: { id: "missing" } }] } },
    { input: { parts: [{ kind: "text", text: "输入", unknown: true }] } },
    { model: { connectionId: f.connection.id, id: "" } },
    { model: { connectionId: f.connection.id, id: f.model.id, unknown: true } },
    { thinkingLevel: "unsupported" },
    { fallback: { on: "any_error", models: [f.model] } },
    { fallback: { on: "transient_error", models: [] } },
    { fallback: { on: "transient_error", models: [{ ...f.model, unknown: true }] } },
    { unknown: true },
    // 即使模型和引用本身需要异步解析，也先拒绝非法输出上限。
    { maxTokens: 0, model: { connectionId: "missing", id: "missing" } },
    { maxTokens: 0, input: { parts: [{ kind: "reference", target: {
      kind: "file", spaceId: f.space.id, location: { kind: "relative", path: "missing.txt" },
    } }] } },
  ];
  for (patch of invalidOptions) {
    const accepted = await f.invoke({ parts: [{ kind: "text", text: "合法父输入" }] });
    const result = await f.finished(accepted);
    assert.equal(result.status, "failed", JSON.stringify(patch));
    assert.equal(result.error?.code, "invalid_input", JSON.stringify(patch));
    assert.deepEqual(result.modelAttempts ?? [], [], "无效选项不创建模型尝试");
    assert.equal(f.requests.length, 0, "无效选项不发送 provider 请求");
  }
  assert(f.invocations.every(invocation => invocation.finished && !invocation.aborted));
});

test("共享模型服务保留空系统提示和空文本，正整数上限与省略思考强度仍进入真实 provider", async (t) => {
  const f = await fixture(t, { configureComplete: options => {
    options.system = "";
    options.maxTokens = 1;
    delete options.thinkingLevel;
  } });
  const accepted = await f.invoke({ parts: [{ kind: "text", text: "" }] });
  modelResult(await f.finished(accepted));
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]?.body.max_completion_tokens ?? f.requests[0]?.body.max_tokens, 1);
  assert.equal(f.requests[0]?.body.messages.some(message => ["system", "developer"].includes(message.role)), false);
  assert.deepEqual(f.invocations, [{ source: "client", aborted: false, finished: true }]);
});

test("真实父请求取消和连接移除均结束能力借用的 HTTP 子调用，取消状态留在父请求", async (t) => {
  const f = await fixture(t, { block: true });
  const first = await f.invoke({ parts: [{ kind: "text", text: "显式取消父请求" }] });
  await until(() => f.requests.length, count => count === 1);
  await f.client.call("request.cancel", { spaceId: f.space.id, requestId: first.requestId });
  assert.equal((await f.finished(first)).status, "cancelled");
  await until(() => f.requests[0]?.closed, value => value === true);
  assert.deepEqual(f.invocations[0], { source: "client", aborted: true, finished: true });
  const second = await f.invoke({ parts: [{ kind: "text", text: "移除正在借用的连接" }] });
  await until(() => f.requests.length, count => count === 2);
  assert.deepEqual(await f.client.call("connection.remove", { connectionId: f.connection.id, base: f.connection.revision }), { removed: true });
  assert.equal((await f.finished(second)).status, "cancelled");
  await until(() => f.requests[1]?.closed, value => value === true);
  assert.deepEqual(f.invocations[1], { source: "client", aborted: true, finished: true });
  assert.deepEqual(await f.client.call("connection.list", {}), []);
  await onlyParents(f.directory, [first.requestId, second.requestId]);
  await f.reopen();
  assert.equal((await f.finished(first)).status, "cancelled");
  assert.equal((await f.finished(second)).status, "cancelled");
  assert.equal(f.requests.length, 2, "重开不重新执行已取消的能力子调用");
});


test("能力的窄模型服务回退沿父后台请求保存选择与最终失败，不另建模型请求", async (t) => {
  for (const failFallback of [false, true]) {
    const f = await fixture(t, { failPrimary: true, failFallback });
    const alternate = await f.client.call("connection.create", {
      name: "明确备用", provider: "openai", authMode: "none",
      baseUrl: f.connection.baseUrl?.replace("/v1", "/fallback/v1"), models: f.connection.models,
    });
    const accepted = await f.invoke({ parts: [{ kind: "text", text: "能力回退的明确输入" }] }, {
      on: "transient_error", models: [{ connectionId: alternate.id, id: f.model.id }],
    });
    const completed = await f.finished(accepted);
    assert.equal(completed.status, failFallback ? "failed" : "completed", completed.error?.message);
    assert.deepEqual(completed.modelAttempts?.map(attempt => attempt.status), ["failed", failFallback ? "failed" : "completed"]);
    assert.equal(completed.modelAttempts?.[0]?.binding.connection.id, f.connection.id);
    assert.equal(completed.modelAttempts?.[1]?.binding.connection.id, alternate.id);
    assert.equal(f.requests.length, 2);
    assert.deepEqual(f.requests[0]?.body.messages, f.requests[1]?.body.messages);
    if (!failFallback) assert.equal(modelResult(completed).data.binding.connection.id, alternate.id);
    else assert.equal(completed.error?.code, "provider");
    await onlyParents(f.directory, [accepted.requestId]);
    await f.reopen();
    assert.deepEqual(await f.client.call("request.get", { spaceId: f.space.id, requestId: accepted.requestId }), completed);
    assert.equal(f.requests.length, 2);
  }
});


test("Agent 能力的窄模型最终失败保留父输入的尝试事实，不重启工具循环或创建子请求", async (t) => {
  const f = await fixture(t, { agent: true, failPrimary: true, failFallback: true });
  assert(f.faux);
  const alternate = await f.client.call("connection.create", {
    name: "明确备用", provider: "openai", authMode: "none",
    baseUrl: f.connection.baseUrl?.replace("/v1", "/fallback/v1"), models: f.connection.models,
  });
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("fixture_models_process", {
      model: f.model, input: { parts: [{ kind: "text", text: "Agent 的明确子调用" }] },
      fallback: { on: "transient_error", models: [{ connectionId: alternate.id, id: f.model.id }] },
    })),
    fauxAssistantMessage("子调用失败，未执行其他动作。"),
  ]);
  const session = await f.client.call("session.create", { spaceId: f.space.id });
  const accepted = await f.client.call("session.submit", {
    target: { spaceId: f.space.id, sessionId: session.sessionId }, requestId: randomUUID(),
    input: { parts: [{ kind: "text", text: "调用子模型并保留失败事实" }] }, dispatch: { kind: "start" },
  });
  const completed = await until(() => f.client.call("request.get", { spaceId: f.space.id, requestId: accepted.requestId }),
    value => ["completed", "failed", "cancelled", "interrupted"].includes(value.status));
  assert("target" in completed);
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.modelAttempts?.map(attempt => attempt.status), ["failed", "failed"]);
  assert.equal(completed.modelAttempts?.[1]?.binding.connection.id, alternate.id);
  assert.equal(f.requests.length, 2);
  assert.equal(f.faux.state.callCount, 2);
  await onlyParents(f.directory, []);
  await f.reopen();
  assert.deepEqual(await f.client.call("request.get", { spaceId: f.space.id, requestId: accepted.requestId }), completed);
});

test("插件 JSON 服务成功与失败均留在父请求，原回复和资源持久保留且无输出修补或额外回退", async (t) => {
  const schema = { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false };
  for (const example of [
    { text: ' { "count": 3 }\n', status: "completed" },
    { text: ' { "count": "3" } \n', status: "failed" },
  ]) {
    const f = await fixture(t, { responseText: example.text, intermediateResource: example.status === "failed", configureComplete: options => { options.output = { kind: "json", schema }; } });
    const uploader = await f.uploader();
    const target = { kind: "file" as const, spaceId: f.space.id, location: { kind: "relative" as const, path: "source.txt" } };
    await f.client.call("content.write", { target, operationId: randomUUID(), base: { kind: "absent" }, value: { kind: "text", text: "能力 JSON 的原文\n" } });
    const source = await uploader.call("content.read", { target });
    assert(source.resource && source.content.bodyRevision);
    const bytes = Buffer.from("能力 JSON 附件");
    const { resource } = await uploader.uploadResource(f.space.id, bytes, "application/octet-stream");
    const alternate = await f.client.call("connection.create", {
      name: "不用于修补 JSON 的备用连接", provider: "openai", authMode: "none",
      baseUrl: f.connection.baseUrl?.replace("/v1", "/fallback/v1"), models: f.connection.models,
    });
    const input: Input = { parts: [{ kind: "reference", target }, { kind: "resource", resource }] };
    const fallback: ModelFallback = { on: "transient_error", models: [{ connectionId: alternate.id, id: f.model.id }] };
    const accepted = await f.invoke(input, fallback);
    const completed = await f.finished(accepted);
    assert.equal(completed.status, example.status, JSON.stringify(completed));
    assert(completed.result);
    const representation = example.status === "completed" ? modelResult(completed).nested : completed.result;
    const data = responseData(representation);
    assert.deepEqual(data.outputFormat, { kind: "json", schema });
    assert.equal(data.message.stopReason, "stop");
    assert.equal(data.message.content.map(part => part && typeof part === "object" && "text" in part ? part.text : "").join(""), example.text);
    assert.deepEqual({ input: data.message.usage.input, output: data.message.usage.output, totalTokens: data.message.usage.totalTokens },
      { input: 3, output: 2, totalTokens: 5 });
    assert.deepEqual(data.attempts, completed.modelAttempts);
    assert.equal(data.attempts[0]?.status, example.status);
    assert.equal(data.attempts[0]?.usage?.totalTokens, 5);
    if (example.status === "completed") assert.deepEqual(data.output, { count: 3 });
    else {
      assert.equal(completed.error?.code, "invalid_model_output");
      assert.equal(data.attempts[0]?.error?.code, "invalid_model_output");
      assert.equal(Object.hasOwn(data, "output"), false);
    }
    assert.deepEqual(representation.sources, [{ target, revision: source.content.bodyRevision }]);
    assert.deepEqual(representation.resources, [resource, source.resource]);
    assert.equal(f.requests.length, 1, "JSON 验收失败不切换候选，也不发起修补调用");
    await onlyParents(f.directory, [accepted.requestId]);
    await uploader.close();
    await f.client.call("resource.collect", { spaceId: f.space.id });
    assert.deepEqual(Buffer.from(await (await f.client.resource(resource)).arrayBuffer()), bytes);
    if (example.status === "failed") {
      const intermediate = f.intermediateResources[0];
      assert(intermediate);
      assert.equal(await (await f.client.resource(intermediate)).text(), "模型调用前的中间材料", "失败结果保留资源时不覆盖父 owner 已持有的中间材料");
    }
    const repeated = await f.client.call("capability.invoke", {
      scope: { kind: "space", spaceId: f.space.id }, requestId: accepted.requestId, contract, input: { model: f.model, input, fallback },
    });
    assert(repeated.kind === "background");
    assert.deepEqual(repeated.request, completed);
    await f.reopen();
    assert.deepEqual(await f.client.call("request.get", { spaceId: f.space.id, requestId: accepted.requestId }), completed);
    const destination = path.join(f.root, "copied-space");
    assert.equal((await f.client.call("space.copy", { spaceId: f.space.id, operationId: randomUUID(), destination })).status, "completed");
    const copied = await f.client.call("space.open", { path: destination });
    const request = await f.client.call("request.get", { spaceId: copied.id, requestId: accepted.requestId });
    assert("operation" in request && request.result);
    const saved = example.status === "completed" ? modelResult(request).nested : request.result;
    assert.deepEqual(responseData(saved), data);
    assert.deepEqual(saved.sources, [{ target: { ...target, spaceId: copied.id }, revision: source.content.bodyRevision }]);
    assert.deepEqual(saved.resources, [resource, source.resource].map(ref => ({ ...ref, spaceId: copied.id })));
    await f.client.call("resource.collect", { spaceId: copied.id });
    for (const ref of saved.resources) assert.equal((await f.client.resource(ref)).ok, true);
    assert.equal(f.requests.length, 1);
  }
});

test("插件 JSON schema 在不存在模型和资源准备前失败，父请求只记录输入错误", async (t) => {
  const f = await fixture(t, { configureComplete: options => {
    options.model = { connectionId: "missing", id: "missing" };
    options.output = { kind: "json", schema: { type: "object", unexpectedKeyword: true } };
  } });
  const accepted = await f.invoke({ parts: [{ kind: "reference", target: {
    kind: "file", spaceId: f.space.id, location: { kind: "relative", path: "missing.txt" },
  } }] });
  const failed = await f.finished(accepted);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error?.code, "invalid_output_schema");
  assert.deepEqual(failed.modelAttempts ?? [], []);
  assert.equal(failed.result, undefined);
  assert.equal(f.requests.length, 0);
});

test("Agent 的 JSON 子调用失败保存真实 Pi 工具 details、原回复与资源，重开复制不重发请求", async (t) => {
  const schema = { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false };
  const rawReply = ' { "count": "3" } \n';
  const f = await fixture(t, { agent: true, responseText: rawReply, configureComplete: options => { options.output = { kind: "json", schema }; } });
  assert(f.faux);
  const uploader = await f.uploader();
  const target = { kind: "file" as const, spaceId: f.space.id, location: { kind: "relative" as const, path: "source.txt" } };
  await f.client.call("content.write", { target, operationId: randomUUID(), base: { kind: "absent" }, value: { kind: "text", text: "Agent JSON 引用原文\n" } });
  const source = await uploader.call("content.read", { target });
  assert(source.resource && source.content.bodyRevision);
  const bytes = Buffer.from("Agent 子调用输入附件");
  const { resource } = await uploader.uploadResource(f.space.id, bytes, "application/octet-stream");
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("fixture_models_process", {
      model: f.model, input: { parts: [{ kind: "reference", target }, { kind: "resource", resource }] },
    })),
    context => {
      const message = context.messages.findLast(item => item.role === "toolResult");
      assert(message?.role === "toolResult" && message.isError);
      assert(Check(RepresentationSchema, message.details));
      const data = responseData(message.details);
      assert.equal(data.attempts[0]?.error?.code, "invalid_model_output");
      assert.equal(Object.hasOwn(data, "output"), false);
      assert.deepEqual(message.details.resources, [resource, source.resource]);
      return fauxAssistantMessage("子调用的 JSON 不符合要求，保留原回复。");
    },
  ]);
  const session = await f.client.call("session.create", { spaceId: f.space.id });
  const key = { spaceId: f.space.id, sessionId: session.sessionId };
  const accepted = await f.client.call("session.submit", {
    target: key, requestId: randomUUID(), input: { parts: [{ kind: "text", text: "调用子模型取得 JSON" }] }, dispatch: { kind: "start" },
  });
  const completed = await until(() => f.client.call("request.get", { spaceId: f.space.id, requestId: accepted.requestId }),
    value => ["completed", "failed", "cancelled", "interrupted"].includes(value.status));
  assert.equal(completed.status, "completed", JSON.stringify(completed));
  assert.equal(completed.modelAttempts?.[0]?.status, "failed");
  assert.equal(completed.modelAttempts?.[0]?.usage?.totalTokens, 5);
  const history = await f.client.call("session.history", key);
  const tool = history.messages.find(message => message.role === "tool" && message.name === "fixture_models_process");
  assert(tool?.error);
  assert(Check(RepresentationSchema, tool.details));
  const data = responseData(tool.details);
  assert.deepEqual(data.outputFormat, { kind: "json", schema });
  assert.equal(data.message.stopReason, "stop");
  assert.deepEqual(data.attempts, completed.modelAttempts);
  assert.equal(data.message.content.map(part => part && typeof part === "object" && "text" in part ? part.text : "").join(""), rawReply);
  assert.deepEqual(tool.details.sources, [{ target, revision: source.content.bodyRevision }]);
  assert.deepEqual(tool.details.resources, [resource, source.resource]);
  const RetentionSchema = object({ version: Type.Literal(1), owners: Type.Record(Type.String(), Type.Array(Type.String())), leases: Type.Unknown() });
  const retention: unknown = JSON.parse(await readFile(path.join(f.directory, ".repa/content/resources.json"), "utf8"));
  assert(Check(RetentionSchema, retention));
  assert(retention.owners[`session:${session.sessionId}`]?.includes(resource.id));
  assert(retention.owners[`session:${session.sessionId}`]?.includes(source.resource.id));
  await onlyParents(f.directory, []);
  await uploader.close();
  await f.client.call("resource.collect", { spaceId: f.space.id });
  assert.deepEqual(Buffer.from(await (await f.client.resource(resource)).arrayBuffer()), bytes);
  assert.equal(f.requests.length, 1);
  assert.equal(f.faux.state.callCount, 2);
  await f.reopen();
  assert.deepEqual(await f.client.call("session.history", key), history);
  const destination = path.join(f.root, "copied-space");
  assert.equal((await f.client.call("space.copy", { spaceId: f.space.id, operationId: randomUUID(), destination })).status, "completed");
  const copied = await f.client.call("space.open", { path: destination });
  const saved = await f.client.call("session.history", { spaceId: copied.id, sessionId: session.sessionId });
  const savedTool = saved.messages.find(message => message.id === tool.id);
  assert(Check(RepresentationSchema, savedTool?.details));
  assert.deepEqual(responseData(savedTool.details), data);
  assert.deepEqual(savedTool.details.sources, [{ target: { ...target, spaceId: copied.id }, revision: source.content.bodyRevision }]);
  assert.deepEqual(savedTool.details.resources, [resource, source.resource].map(ref => ({ ...ref, spaceId: copied.id })));
  await f.client.call("resource.collect", { spaceId: copied.id });
  for (const ref of savedTool.details.resources) assert.equal((await f.client.resource(ref)).ok, true);
  assert.equal(f.requests.length, 1);
});
