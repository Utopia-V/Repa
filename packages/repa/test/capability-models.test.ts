import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { RepaCapabilityServices } from "../src/capabilities/services.js";
import type { CapabilityDefinition } from "../src/capabilities/types.js";
import { RepaClient } from "../src/client.js";
import { ModelBindingSchema, ModelSelectionSchema } from "../src/models/schema.js";
import { inputResources } from "../src/requests/input.js";
import { InputSchema, RepresentationSchema, type BackgroundRequest, type Input } from "../src/requests/schema.js";
import { object } from "../src/schema.js";
import { startRepaServer, type RepaServer } from "../src/server.js";

const contract = { id: "fixture.models.process", version: "1" };
const CapabilityInputSchema = object({ model: ModelSelectionSchema, input: InputSchema });
const ProviderInputSchema = Type.Object({
  messages: Type.Array(Type.Object({ role: Type.String(), content: Type.Unknown() })),
  max_tokens: Type.Optional(Type.Number()), max_completion_tokens: Type.Optional(Type.Number()),
});
const ModelDataSchema = Type.Object({
  binding: ModelBindingSchema, input: Type.String(),
  message: Type.Object({ content: Type.Array(Type.Unknown()), usage: Type.Object({
    input: Type.Number(), output: Type.Number(), totalTokens: Type.Number(),
  }) }),
});
interface Captured {
  body: Static<typeof ProviderInputSchema>;
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

async function fixture(t: TestContext, options: { block?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-capability-models-"));
  const agentDir = path.join(root, "agent");
  const directory = path.join(root, "space");
  const requests: Captured[] = [];
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
      const captured: Captured = { body, authorization: request.headers.authorization, closed: false };
      response.once("close", () => { captured.closed = true; });
      requests.push(captured);
      if (options.block) return;
      const chunk = (content: string, finish: string | null) => ({
        id: "capability-model", object: "chat.completion.chunk", created: 1, model: "local-model",
        choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: finish }],
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        `data: ${JSON.stringify(chunk("能力子处理结果", null))}`,
        `data: ${JSON.stringify({ ...chunk("", "stop"), usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}`,
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
    inputResources: input => inputResources(input.input),
    async invoke(input, context) {
      assert(context.services?.models);
      assert.equal(context.scope.kind, "space");
      const observed = { source: context.source.kind, aborted: false, finished: false };
      invocations.push(observed);
      try {
        return await context.services.models.complete({
          model: input.model, input: input.input, system: "只处理能力提交的明确输入。", thinkingLevel: "off", maxTokens: 32,
        });
      } finally {
        observed.aborted = context.signal.aborted;
        observed.finished = true;
      }
    },
  };
  const serverOptions = { agentDir, appDirectory: path.join(root, "app"), disconnectGraceMs: 0,
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
  const invoke = async (input: Input) => {
    const requestId = randomUUID();
    const accepted = await currentClient().call("capability.invoke", { scope, requestId, contract, input: { model, input } });
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
  return { directory, space, connection, model, requests, invocations, invoke, finished, reopen, uploader,
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
  assert.deepEqual(nested.format, { id: "repa.model-response", version: "1" });
  assert.equal(nested.value.kind, "inline");
  if (nested.value.kind !== "inline") assert.fail("模型结果应为内联表示");
  assert(Check(ModelDataSchema, nested.value.data));
  return { outer: request.result, nested, data: nested.value.data };
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
