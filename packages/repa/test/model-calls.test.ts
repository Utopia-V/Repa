import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { ContentStore } from "../src/content/store.js";
import { RepaFault } from "../src/errors.js";
import { ModelCalls, type ModelCallOptions } from "../src/models/calls.js";
import { ModelBindingSchema, type ModelBinding } from "../src/models/schema.js";
import { ModelConnections } from "../src/models/service.js";
import type { Input } from "../src/requests/schema.js";

const ProviderInputSchema = Type.Object({
  messages: Type.Array(Type.Object({ role: Type.String(), content: Type.Unknown() })),
  max_tokens: Type.Optional(Type.Number()), max_completion_tokens: Type.Optional(Type.Number()),
});
const ModelDataSchema = Type.Object({
  binding: ModelBindingSchema,
  input: Type.String(),
  message: Type.Object({
    stopReason: Type.String(), content: Type.Array(Type.Unknown()),
    usage: Type.Object({ input: Type.Number(), output: Type.Number(), totalTokens: Type.Number() }),
  }),
});
interface Captured {
  url: string;
  authorization?: string;
  body: Static<typeof ProviderInputSchema>;
  closed: boolean;
  release(): void;
}

async function until<T>(read: () => T | Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > deadline) assert.fail(`等待模型调用状态超时：${JSON.stringify(value)}`);
    await delay(10);
  }
}

async function fixture(t: TestContext, options: { block?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-model-calls-"));
  const spaceRoot = path.join(root, "space");
  await mkdir(spaceRoot);
  const requests: Captured[] = [];
  const providerErrors: unknown[] = [];
  let content: ContentStore | undefined;
  let models: ModelConnections | undefined;
  let calls: ModelCalls | undefined;
  const connectionIds: string[] = [];
  const provider = createServer((request, response) => {
    void (async () => {
      request.setEncoding("utf8");
      let bytes = "";
      for await (const chunk of request) bytes += chunk;
      const body: unknown = JSON.parse(bytes);
      assert(Check(ProviderInputSchema, body));
      const captured: Captured = {
        url: request.url ?? "", authorization: request.headers.authorization, body, closed: false,
        release() {
          if (response.destroyed) return;
          const chunk = (text: string, finish: string | null) => ({
            id: "model-calls", object: "chat.completion.chunk", created: 1, model: "local-call",
            choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: finish }],
          });
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end([
            `data: ${JSON.stringify(chunk("子处理结果", null))}`,
            `data: ${JSON.stringify({ ...chunk("", "stop"), usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}`,
            "data: [DONE]", "",
          ].join("\n\n"));
        },
      };
      response.once("close", () => { captured.closed = true; });
      requests.push(captured);
      if (!options.block) captured.release();
    })().catch((error: unknown) => {
      providerErrors.push(error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  t.after(async () => {
    try {
      for (const id of connectionIds) await calls?.cancel(id);
      await models?.cancelAll();
      await content?.settled();
    } finally {
      provider.closeAllConnections();
      if (provider.listening) await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    }
    assert.deepEqual(providerErrors, []);
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("本地 provider 未监听");
  const endpoint = `http://127.0.0.1:${address.port}`;
  content = await ContentStore.open({ root: spaceRoot, spaceId: randomUUID(), assertOwned() {} });
  models = new ModelConnections({ directory: path.join(root, "models") });
  calls = new ModelCalls(models);
  const service = models;
  const store = content;
  const first = await connection("one");
  const second = await connection("two");
  async function connection(route: string): Promise<ModelBinding> {
    const connection = await service.create({
      name: route, provider: "openai", authMode: "credentials", baseUrl: `${endpoint}/${route}/v1`,
      models: [{ id: "local-call", name: "本地子处理模型", api: "openai-completions", reasoning: false, input: ["text"],
        contextWindow: 8192, maxTokens: 256, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    });
    connectionIds.push(connection.id);
    const login = await service.authStart(connection.id, "api_key");
    const query = await until(() => service.authGet(login.loginId), (value) => value.challenge !== undefined || value.status !== "pending");
    assert(query.challenge);
    await service.authReply(login.loginId, query.challenge.id, `model-calls-fake-key-${route}`);
    assert.equal((await until(() => service.authGet(login.loginId), (value) => value.status !== "pending")).status, "completed");
    return (await service.bind({ connectionId: connection.id, id: "local-call" })).binding;
  }
  const prepared = (binding: ModelBinding, input: Input, signal = new AbortController().signal): ModelCallOptions => ({
    binding, input, signal, content: store, requestId: randomUUID(), resourceOwner: `parent:${randomUUID()}`,
    system: "只处理本次明确输入。", thinkingLevel: "off", retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }, maxTokens: 32,
  });
  return { calls, content: store, first, second, requests, prepared, spaceRoot };
}

test("独立模型 helper 保留 SDK 用量、引用与资源，不创建后台请求或泄漏凭据", async (t) => {
  const f = await fixture(t);
  const target = f.content.target("note.txt");
  await f.content.write({ target, value: { kind: "text", text: "被引用的正文" }, base: { kind: "absent" }, operationId: randomUUID() });
  const reference = await f.content.read({ target });
  const revision = reference.content.bodyRevision;
  assert(revision);
  assert(reference.resource);
  const resource = { spaceId: f.content.options.spaceId, id: await f.content.blobs.put("附件字节"), mediaType: "application/octet-stream" };
  const options = f.prepared(f.first, { parts: [{ kind: "reference", target }, { kind: "resource", resource, description: "附件" }] });
  const result = await f.calls.complete(options);
  assert.deepEqual(result.format, { id: "repa.model-response", version: "1" });
  assert.equal(result.value.kind, "inline");
  if (result.value.kind !== "inline") assert.fail("应返回内联模型结果");
  assert(Check(ModelDataSchema, result.value.data));
  assert.equal(result.value.data.message.stopReason, "stop");
  const usage = result.value.data.message.usage;
  assert.equal(usage.input, 3);
  assert.equal(usage.output, 2);
  assert.equal(usage.totalTokens, 5);
  assert.match(result.value.data.input, /被引用的正文/);
  assert.deepEqual(result.value.data.binding, f.first);
  assert.deepEqual(result.sources, [{ target, revision }]);
  assert.equal((await f.content.read({ target, revision })).text, "被引用的正文");
  assert.deepEqual(result.resources, [resource, reference.resource]);
  assert.deepEqual(f.content.retention.snapshot().state.owners[options.resourceOwner], [resource.id, reference.resource.id].sort());
  assert.equal(JSON.stringify(result).includes("model-calls-fake-key"), false);
  assert.equal(f.requests[0]?.authorization, "Bearer model-calls-fake-key-one");
  assert.equal(f.requests[0]?.body.max_completion_tokens ?? f.requests[0]?.body.max_tokens, 32);
  assert.match(JSON.stringify(f.requests[0]?.body.messages), /只处理本次明确输入/);
  await assert.rejects(stat(path.join(f.spaceRoot, ".repa", "runtime", "processing")), { code: "ENOENT" });
  await assert.rejects(f.calls.complete({ ...options, thinkingLevel: "high" }), (error) => error instanceof RepaFault && error.code === "configuration");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==", "base64");
  const image = { spaceId: f.content.options.spaceId, id: await f.content.blobs.put(png), mediaType: "image/png" };
  await assert.rejects(f.calls.complete(f.prepared(f.first, { parts: [{ kind: "resource", resource: image }] })),
    (error) => error instanceof RepaFault && error.code === "unsupported_input");
  assert.equal(f.requests.length, 1, "不支持的图片不能被降级成文本后发送");
});

test("父信号取消停止真实 HTTP 调用，不再次通知父 owner", async (t) => {
  const f = await fixture(t, { block: true });
  const parent = new AbortController();
  let notified = 0;
  const completed = f.calls.complete({ ...f.prepared(f.first, { parts: [{ kind: "text", text: "父取消" }] }, parent.signal), onCancel: () => { notified++; } });
  const failure = assert.rejects(completed, (error) => error instanceof Error && error.name === "AbortError");
  await until(() => f.requests.length, (count) => count === 1);
  parent.abort();
  await failure;
  await until(() => f.requests[0]?.closed, (closed) => closed === true);
  await f.calls.cancel(f.first.connection.id);
  assert.equal(notified, 0);
});

test("连接取消通知匹配的真实父控制器并等待结束，不取消另一连接", async (t) => {
  const f = await fixture(t, { block: true });
  const parents = [new AbortController(), new AbortController(), new AbortController()];
  const bindings = [f.first, f.first, f.second];
  const outcomes = bindings.map((binding, index) => {
    const parent = parents[index];
    assert(parent);
    return f.calls.complete({
      ...f.prepared(binding, { parts: [{ kind: "text", text: `调用 ${index}` }] }, parent.signal),
      onCancel: () => parent.abort(),
    }).then(() => "completed", (error: unknown) => {
      assert(error instanceof Error && error.name === "AbortError");
      return "cancelled";
    });
  });
  await until(() => f.requests.length, (count) => count === 3);
  await f.calls.cancel(f.first.connection.id);
  assert.deepEqual(await Promise.all(outcomes.slice(0, 2)), ["cancelled", "cancelled"]);
  assert.equal(parents[0]?.signal.aborted, true);
  assert.equal(parents[1]?.signal.aborted, true);
  assert.equal(parents[2]?.signal.aborted, false);
  await until(() => f.requests.filter((request) => request.url.startsWith("/one/")).every((request) => request.closed), Boolean);
  const other = f.requests.find((request) => request.url.startsWith("/two/"));
  assert(other);
  assert.equal(other.closed, false);
  other.release();
  assert.equal(await outcomes[2], "completed");
});
