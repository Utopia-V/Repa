import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { RepaClient, RpcError } from "../src/client.js";
import type { DiagnosticOptions, DiagnosticRecord } from "../src/diagnostics.js";
import { AuthQuerySchema, BoundModelFallbackSchema, ModelAttemptSchema, ModelBindingSchema, ModelOutputSchema, type ConnectionInput, type ConnectionModel, type ModelConnection } from "../src/models/schema.js";
import { ModelConnections } from "../src/models/service.js";
import type { BackgroundRequest, Params, RequestRecord, SessionKey, SettingScope, Submit } from "../src/protocol.js";
import { startRepaServer, type RepaServer } from "../src/server.js";

const model: ConnectionModel = {
  id: "local-model",
  name: "本地集成模型",
  api: "openai-completions",
  reasoning: false,
  input: ["text"],
  contextWindow: 16384,
  maxTokens: 256,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const ProviderRequestSchema = Type.Object({
  model: Type.String(),
  messages: Type.Array(Type.Object({ role: Type.String(), content: Type.Unknown() })),
  max_tokens: Type.Optional(Type.Number()),
  max_completion_tokens: Type.Optional(Type.Number()),
  tools: Type.Optional(Type.Array(Type.Object({
    type: Type.String(),
    function: Type.Object({ name: Type.String() }),
  }))),
});

const CompletionConfigurationSchema = Type.Object({
  connection: ModelBindingSchema,
  system: Type.String(),
  thinkingLevel: Type.String(),
  maxTokens: Type.Optional(Type.Number()),
  fallback: Type.Optional(BoundModelFallbackSchema),
  output: Type.Optional(ModelOutputSchema),
});

const ModelResponseSchema = Type.Object({
  binding: ModelBindingSchema,
  attempts: Type.Array(ModelAttemptSchema),
  input: Type.String(),
  output: Type.Optional(Type.Unknown()),
  outputFormat: Type.Optional(ModelOutputSchema),
  message: Type.Object({
    role: Type.Literal("assistant"),
    content: Type.Array(Type.Unknown()),
    stopReason: Type.String(),
    usage: Type.Object({ input: Type.Number(), output: Type.Number(), totalTokens: Type.Number() }),
  }),
});

interface CapturedRequest {
  url: string;
  authorization: string | undefined;
  body: Static<typeof ProviderRequestSchema>;
  closed: boolean;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: unknown) => {
    if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
    return "";
  }).join("\n");
}

function userTexts(request: CapturedRequest): string[] {
  return request.body.messages.filter((message) => message.role === "user").map((message) => textOf(message.content));
}

async function until<T>(read: () => T | Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= deadline) assert.fail(`等待状态超时：${JSON.stringify(value)}`);
    await delay(10);
  }
}

async function fixture(t: TestContext, options: {
  observeExtension?: boolean;
  diagnostics?: DiagnosticOptions;
  responseText?: string;
  finish?: string;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-model-api-"));
  const agentDir = path.join(root, "agent");
  const directory = path.join(root, "space");
  const extensionPath = path.join(root, "observe-extension.mjs");
  const extensionLog = path.join(root, "extension-loads.txt");
  const requests: CapturedRequest[] = [];
  const gates = new Map<string, { wait: Promise<void>; release(): void }>();
  const failures = new Set<string>();
  const routeFailures = new Map<string, { status: number; message: string }>();
  const providerErrors: unknown[] = [];
  let backend: RepaServer | undefined;
  let client: RepaClient | undefined;
  const provider = createServer((request, response) => {
    void (async () => {
      request.setEncoding("utf8");
      let bytes = "";
      for await (const chunk of request) bytes += chunk;
      const body: unknown = JSON.parse(bytes);
      assert(Check(ProviderRequestSchema, body), "Pi 请求须为可读取的 chat completions 输入");
      const captured: CapturedRequest = {
        url: request.url ?? "",
        authorization: request.headers.authorization,
        body,
        closed: false,
      };
      const closed = new Promise<void>((resolve) => {
        response.once("close", () => {
          captured.closed = true;
          resolve();
        });
      });
      requests.push(captured);
      const input = userTexts(captured).at(-1) ?? "";
      const gate = gates.get(input);
      if (gate) await Promise.race([gate.wait, closed]);
      if (response.destroyed) return;
      const routeFailure = routeFailures.get(captured.url.split("/")[1] ?? "");
      if (routeFailure) {
        response.writeHead(routeFailure.status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: routeFailure.message, type: "local_test_error" } }));
        return;
      }
      if (failures.has(input)) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "本地测试拒绝该请求", type: "invalid_request_error" } }));
        return;
      }
      const chunk = (delta: Record<string, unknown>, finishReason: string | null) => ({
        id: randomUUID(),
        object: "chat.completion.chunk",
        created: 1,
        model: model.id,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        `data: ${JSON.stringify(chunk({ role: "assistant", content: options.responseText ?? `本地回复：${input}` }, null))}`,
        `data: ${JSON.stringify({ ...chunk({}, options.finish ?? "stop"), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,
        "data: [DONE]",
        "",
      ].join("\n\n"));
    })().catch((error: unknown) => {
      providerErrors.push(error);
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "本地 provider 夹具失败" } }));
    });
  });
  t.after(async () => {
    try {
      await backend?.close("cancel");
      await client?.close();
    } finally {
      for (const gate of gates.values()) gate.release();
      provider.closeAllConnections();
      if (provider.listening) {
        await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
      }
      await rm(root, { recursive: true, force: true });
    }
    assert.deepEqual(providerErrors, [], "本地 provider 不应发生夹具错误");
  });
  await mkdir(agentDir);
  await mkdir(directory);
  if (options.observeExtension) {
    await writeFile(extensionPath, `
import { appendFileSync } from "node:fs";
export default function () {
  appendFileSync(${JSON.stringify(extensionLog)}, "loaded\\n");
}
`);
  }
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    extensions: options.observeExtension ? [extensionPath] : ["!**/*"],
    skills: ["!**/*"],
    prompts: ["!**/*"],
    themes: ["!**/*"],
    packages: [],
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0 },
    compaction: { enabled: false, reserveTokens: 400, keepRecentTokens: 200 },
  }));
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const serverOptions = { agentDir, appDirectory: path.join(root, "application"),
    trustExtensions: options.observeExtension ?? false, diagnostics: options.diagnostics };
  backend = await startRepaServer(serverOptions);
  client = await RepaClient.connect(backend.connection);
  const connected = client;
  const space = await connected.call("space.open", { path: directory });
  const session = await connected.call("session.create", { spaceId: space.id });
  const key: SessionKey = { spaceId: space.id, sessionId: session.sessionId };
  return {
    get client() { assert(client); return client; },
    get backend() { assert(backend); return backend; },
    root,
    async reopen() {
      await backend?.close("cancel");
      await client?.close();
      backend = await startRepaServer(serverOptions);
      client = await RepaClient.connect(backend.connection);
      assert.equal((await client.call("space.open", { path: directory })).id, space.id);
    },
    agentDir,
    directory,
    appDirectory: path.join(root, "application"),
    key,
    requests,
    async extensionLoads() {
      try {
        return (await readFile(extensionLog, "utf8")).split("\n").filter(Boolean).length;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
        throw error;
      }
    },
    fail: (text: string) => { failures.add(text); },
    failRoute: (route: string, status: number, message: string) => { routeFailures.set(route, { status, message }); },
    block(text: string) {
      let release = () => {};
      const wait = new Promise<void>((resolve) => { release = resolve; });
      const gate = { wait, release };
      gates.set(text, gate);
      return gate;
    },
    async received(text: string): Promise<CapturedRequest> {
      const request = await until(() => requests.find((item) => userTexts(item).at(-1) === text), (value) => value !== undefined);
      assert(request);
      return request;
    },
    input(name: string, route: string): ConnectionInput {
      return { name, provider: "openai", baseUrl: `${endpoint}/${route}/v1`, authMode: "credentials", models: [model] };
    },
  };
}

async function login(client: RepaClient, connectionId: string, key: string): Promise<ModelConnection> {
  const started = await client.call("auth.start", { connectionId, type: "api_key" });
  const pending = await until(() => client.call("auth.get", { loginId: started.loginId }),
    (query) => query.challenge !== undefined || query.status !== "pending");
  assert.equal(pending.status, "pending");
  assert(pending.challenge);
  assert.equal(pending.challenge.type, "secret");
  await client.call("auth.reply", { loginId: started.loginId, challengeId: pending.challenge.id, value: key });
  const completed = await until(() => client.call("auth.get", { loginId: started.loginId }), (query) => query.status !== "pending");
  assert.equal(completed.status, "completed", completed.error?.message);
  return client.call("connection.get", { connectionId });
}

async function connection(f: Awaited<ReturnType<typeof fixture>>, name: string, route: string, secret: string) {
  const created = await f.client.call("connection.create", f.input(name, route));
  const catalog = await f.client.call("model.list", { connectionId: created.id });
  assert.deepEqual(catalog.models.map((item) => item.id), [model.id]);
  return login(f.client, created.id, secret);
}

async function setting(client: RepaClient, name: string, value: unknown, scope: SettingScope = { kind: "application" }, namespace = "runtime") {
  const current = await client.call("settings.get", { scope, namespace });
  const entry = current.entries.find((item) => item.key === name);
  assert(entry);
  return client.call("settings.set", { scope, namespace, key: name, value, base: entry.revision });
}

async function submit(client: RepaClient, key: SessionKey, text: string, selection?: Submit["selection"]) {
  return client.call("session.submit", {
    target: key,
    requestId: randomUUID(),
    input: { parts: [{ kind: "text", text }] },
    dispatch: { kind: "start" },
    ...(selection ? { selection } : {}),
  });
}

async function request(client: RepaClient, accepted: RequestRecord): Promise<RequestRecord> {
  const current = await client.call("request.get", { spaceId: accepted.target.spaceId, requestId: accepted.requestId });
  assert("delivery" in current);
  return current;
}

async function finish(client: RepaClient, accepted: RequestRecord): Promise<RequestRecord> {
  return until(() => request(client, accepted), (current) => !["queued", "running"].includes(current.status));
}

async function finishProcessing(client: RepaClient, accepted: BackgroundRequest): Promise<BackgroundRequest> {
  return until(async () => {
    const current = await client.call("request.get", { spaceId: accepted.spaceId, requestId: accepted.requestId });
    assert("operation" in current);
    return current;
  }, (current) => !["accepted", "running", "cancelling"].includes(current.status));
}

test("诊断日志在实际认证和模型调用后只保留元信息，debug 也不输出密钥和正文", async t => {
  for (const level of ["info", "debug"] as const) {
    await t.test(level, async t => {
      const lines: string[] = [];
      const f = await fixture(t, { diagnostics: { level, write: line => { lines.push(line); } } });
      const secret = `private-api-key-${randomUUID()}`;
      const identity = await connection(f, "本地日志核验", "diagnostic", secret);
      const text = `PRIVATE_USER_BODY_${randomUUID()}`;
      const accepted = await submit(f.client, f.key, text, { model: { connectionId: identity.id, id: model.id } });
      assert.equal((await finish(f.client, accepted)).status, "completed");
      assert.equal((await f.received(text)).authorization, `Bearer ${secret}`);
      const records = lines.map(line => JSON.parse(line) as DiagnosticRecord);
      assert(records.some(record => record.event === "run.finished" && record.requestId === accepted.requestId));
      assert.equal(records.some(record => record.event === "rpc.completed" && record.level === "debug"), level === "debug");
      if (level === "debug") {
        const call = records.find(record => record.event === "rpc.completed" && record.method === "session.submit");
        assert(call && typeof call.rpcId === "string");
        assert(records.some(record => record.event === "rpc.started" && record.rpcId === call.rpcId));
      }
      const logged = lines.join("");
      for (const value of [secret, text, f.backend.connection.token]) assert(!logged.includes(value));
    });
  }
});

test("同 provider 的双连接分别使用认证与端点，并行会话只带各自历史", async (t) => {
  const f = await fixture(t);
  const first = await connection(f, "甲连接", "one", "first-secret");
  const second = await connection(f, "乙连接", "two", "second-secret");
  const other = await f.client.call("session.create", { spaceId: f.key.spaceId });
  const otherKey = { spaceId: other.spaceId, sessionId: other.sessionId };
  await setting(f.client, "model", { connectionId: first.id, id: model.id }, { kind: "session", ...f.key });
  await setting(f.client, "model", { connectionId: second.id, id: model.id }, { kind: "session", ...otherKey });
  const gate = f.block("甲会话第一问");
  const left = await submit(f.client, f.key, "甲会话第一问");
  await f.received("甲会话第一问");
  const right = await submit(f.client, otherKey, "乙会话第一问");
  assert.equal((await finish(f.client, right)).status, "completed");
  assert.equal((await request(f.client, left)).status, "running");
  gate.release();
  assert.equal((await finish(f.client, left)).status, "completed");
  const leftAgain = await submit(f.client, f.key, "甲会话第二问");
  const rightAgain = await submit(f.client, otherKey, "乙会话第二问");
  assert.equal((await finish(f.client, leftAgain)).status, "completed");
  assert.equal((await finish(f.client, rightAgain)).status, "completed");
  for (const [key, own, foreign, url, authorization] of [
    [f.key, "甲", "乙", "/one/v1/chat/completions", "Bearer first-secret"],
    [otherKey, "乙", "甲", "/two/v1/chat/completions", "Bearer second-secret"],
  ] as const) {
    for (const turn of ["第一问", "第二问"]) {
      const sent = await f.received(`${own}会话${turn}`);
      assert.equal(sent.url, url);
      assert.equal(sent.authorization, authorization);
      assert(userTexts(sent).includes(`${own}会话第一问`));
      assert.equal(JSON.stringify(sent.body.messages).includes(`${foreign}会话`), false);
    }
    const history = await f.client.call("session.history", key);
    assert.deepEqual(history.messages.filter((message) => message.role === "user").map((message) => textOf(message.content)),
      [`${own}会话第一问`, `${own}会话第二问`]);
  }
  const visible = JSON.stringify(await f.client.call("connection.list", {}));
  assert.equal(visible.includes("first-secret"), false);
  assert.equal(visible.includes("second-secret"), false);
});

test("单次工具和模型选择不改写下次默认，空工具运行之后恢复原工具集合", async (t) => {
  const f = await fixture(t);
  const first = await connection(f, "默认连接", "default", "default-secret");
  const second = await connection(f, "临时连接", "temporary", "temporary-secret");
  await setting(f.client, "model", { connectionId: first.id, id: model.id });
  const withoutTools = await submit(f.client, f.key, "本次不使用工具", { tools: [] });
  assert.equal((await finish(f.client, withoutTools)).status, "completed");
  assert.deepEqual((await f.received("本次不使用工具")).body.tools ?? [], []);
  const withDefaults = await submit(f.client, f.key, "下一次恢复工具");
  assert.equal((await finish(f.client, withDefaults)).status, "completed");
  const toolNames = (await f.received("下一次恢复工具")).body.tools?.map((tool) => tool.function.name).sort();
  const capabilities = await f.client.call("capability.describe", { scope: { kind: "space", spaceId: f.key.spaceId } });
  const capabilityTools = capabilities.capabilities.flatMap(item => item.tool ? [item.tool.name] : []);
  assert.deepEqual(toolNames, ["apply_patch", "bash", "content_info", "content_operation", "edit", "read", "write", ...capabilityTools].sort());
  const temporary = await submit(f.client, f.key, "临时选择其他模型连接", { model: { connectionId: second.id, id: model.id } });
  assert.equal((await finish(f.client, temporary)).status, "completed");
  assert.equal((await f.received("临时选择其他模型连接")).url, "/temporary/v1/chat/completions");
  const restored = await submit(f.client, f.key, "重新使用默认连接");
  assert.equal((await finish(f.client, restored)).status, "completed");
  const sent = await f.received("重新使用默认连接");
  assert.equal(sent.url, "/default/v1/chat/completions");
  assert.equal(sent.authorization, "Bearer default-secret");
  assert(userTexts(sent).includes("临时选择其他模型连接"));
  assert.equal(restored.runOptions.connection?.connection.id, first.id);
  const settings = await f.client.call("settings.get", { scope: { kind: "application" }, namespace: "runtime" });
  assert.deepEqual(settings.entries.find((entry) => entry.key === "model")?.effective, { connectionId: first.id, id: model.id });
  assert.equal(settings.entries.find((entry) => entry.key === "tools")?.effective, null);
});

test("非视觉连接明确拒绝图片，原输入仍保留且不会以文本占位启动模型", async (t) => {
  const f = await fixture(t);
  const selected = await connection(f, "纯文本模型", "text-only", "test-image-key");
  await setting(f.client, "model", { connectionId: selected.id, id: model.id });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==", "base64");
  const uploaded = await f.client.uploadResource(f.key.spaceId, png, "image/png");
  const accepted = await f.client.call("session.submit", {
    target: f.key, requestId: randomUUID(), dispatch: { kind: "start" },
    input: { parts: [{ kind: "text", text: "解释这张图" }, { kind: "resource", resource: uploaded.resource }] },
  });
  const finished = await finish(f.client, accepted);
  assert.equal(finished.status, "failed");
  assert.equal(finished.error?.code, "unsupported_input");
  assert.equal(finished.delivery.status, "not_entered");
  assert.deepEqual(finished.input, accepted.input);
  assert.equal(f.requests.length, 0);
  assert.deepEqual((await f.client.call("session.history", f.key)).messages, []);
});

test("排队输入保留受理端点和认证，失败接续采用当前连接且不重复原输入", async (t) => {
  const f = await fixture(t);
  const first = await connection(f, "原连接", "original", "old-secret");
  const second = await connection(f, "新默认", "current", "current-secret");
  await setting(f.client, "model", { connectionId: first.id, id: model.id });
  const gate = f.block("等待后续输入受理");
  const active = await submit(f.client, f.key, "等待后续输入受理");
  await f.received("等待后续输入受理");
  f.fail("排队后会失败的输入");
  const submission: Submit = {
    target: f.key,
    requestId: randomUUID(),
    input: { parts: [{ kind: "text", text: "排队后会失败的输入" }] },
    dispatch: { kind: "queue" },
  };
  const queued = await f.client.call("session.submit", submission);
  assert.equal(queued.status, "queued");
  assert.equal(queued.runOptions.connection?.connection.authId, first.authId);
  await setting(f.client, "model", { connectionId: second.id, id: model.id });
  await f.client.call("connection.update", {
    connectionId: first.id,
    base: first.revision,
    input: f.input("原连接的新端点", "changed"),
  });
  const relogged = await login(f.client, first.id, "new-secret");
  assert.notEqual(relogged.authId, first.authId);
  assert.deepEqual((await f.client.call("session.submit", submission)).runOptions, queued.runOptions);
  gate.release();
  assert.equal((await finish(f.client, active)).status, "completed");
  const failed = await finish(f.client, queued);
  assert.equal(failed.status, "failed");
  assert.equal(failed.delivery.status, "entered");
  const original = await f.received("排队后会失败的输入");
  assert.equal(original.url, "/original/v1/chat/completions");
  assert.equal(original.authorization, "Bearer old-secret");
  const continued = await f.client.call("session.continue", {
    target: f.key,
    requestId: randomUUID(),
    previousRequestId: queued.requestId,
    input: { parts: [{ kind: "text", text: "按现在的连接继续" }] },
  });
  assert.equal(continued.runOptions.connection?.connection.id, second.id);
  assert.equal((await finish(f.client, continued)).status, "completed");
  const last = f.requests.at(-1);
  assert(last);
  assert.equal(last.url, "/current/v1/chat/completions");
  assert.equal(last.authorization, "Bearer current-secret");
  assert.equal(userTexts(last).filter((text) => text === "排队后会失败的输入").length, 1);
  const history = await f.client.call("session.history", f.key);
  assert.equal(history.messages.filter((message) => message.role === "user" && textOf(message.content) === "排队后会失败的输入").length, 1);
  assert.equal((await request(f.client, queued)).status, "failed");
  assert.deepEqual((await request(f.client, queued)).runOptions, queued.runOptions);
});

test("注销和移除取消关联运行，旧队列不能借重新登录或其他默认连接换身份执行", async (t) => {
  const f = await fixture(t);
  const first = await connection(f, "待注销连接", "logout", "old-secret");
  const second = await connection(f, "待移除连接", "remove", "other-secret");
  await setting(f.client, "model", { connectionId: first.id, id: model.id });
  f.block("等待注销取消");
  const active = await submit(f.client, f.key, "等待注销取消");
  const activeHttp = await f.received("等待注销取消");
  const queued = await f.client.call("session.submit", {
    target: f.key,
    requestId: randomUUID(),
    input: { parts: [{ kind: "text", text: "使用注销前身份的队列" }] },
    dispatch: { kind: "queue" },
  });
  const loggedOut = await f.client.call("auth.logout", { connectionId: first.id });
  assert.equal(loggedOut.authentication.configured, false);
  assert.equal((await finish(f.client, active)).status, "cancelled");
  await until(() => activeHttp.closed, Boolean);
  assert.equal((await f.client.call("queue.list", f.key)).status, "paused");
  const relogged = await login(f.client, first.id, "new-secret");
  assert.notEqual(relogged.authId, first.authId);
  await setting(f.client, "model", { connectionId: second.id, id: model.id });
  await f.client.call("queue.resume", f.key);
  const stale = await finish(f.client, queued);
  assert.equal(stale.status, "failed");
  assert.equal(stale.error?.code, "auth_required");
  assert.equal(stale.delivery.status, "not_entered");
  assert.equal(stale.runOptions.connection?.connection.authId, first.authId);
  assert.equal(f.requests.length, 1);

  f.block("等待移除取消");
  const removing = await submit(f.client, f.key, "等待移除取消");
  const removingHttp = await f.received("等待移除取消");
  const removedQueue = await f.client.call("session.submit", {
    target: f.key,
    requestId: randomUUID(),
    input: { parts: [{ kind: "text", text: "使用被移除连接的队列" }] },
    dispatch: { kind: "queue" },
  });
  await f.client.call("connection.remove", { connectionId: second.id, base: second.revision });
  assert.equal((await finish(f.client, removing)).status, "cancelled");
  await until(() => removingHttp.closed, Boolean);
  await setting(f.client, "model", { connectionId: first.id, id: model.id });
  await f.client.call("queue.resume", f.key);
  const unavailable = await finish(f.client, removedQueue);
  assert.equal(unavailable.status, "failed");
  assert.equal(unavailable.error?.code, "connection_not_found");
  assert.equal(unavailable.delivery.status, "not_entered");
  assert.equal(unavailable.runOptions.connection?.connection.id, second.id);
  assert.equal(f.requests.length, 2);
});

test("独立模型调用保留空提示、输入、用量和原绑定，重传及取消不创建会话", async (t) => {
  const f = await fixture(t);
  await f.client.call("session.remove", f.key);
  const first = await connection(f, "独立调用连接", "independent", "old-secret");
  await setting(f.client, "base", "独立调用不能继承这个会话提示", { kind: "application" }, "prompts");
  assert.deepEqual(await f.client.call("session.list", { spaceId: f.key.spaceId }), []);
  const gate = f.block("独立处理的明确输入");
  const params: Params<"model.complete"> = {
    spaceId: f.key.spaceId,
    requestId: randomUUID(),
    input: { parts: [{ kind: "text", text: "独立处理的明确输入" }] },
    model: { connectionId: first.id, id: model.id },
    system: "",
    thinkingLevel: "off",
    maxTokens: 64,
  };
  const accepted = await f.client.call("model.complete", params);
  assert.equal(accepted.operation, "repa.model.complete");
  assert.deepEqual(accepted.input, params.input);
  assert.deepEqual(accepted.options, { model: params.model, system: "", thinkingLevel: "off", maxTokens: 64 });
  assert(Check(CompletionConfigurationSchema, accepted.configuration));
  assert.equal(accepted.configuration.connection.connection.id, first.id);
  assert.equal(accepted.configuration.connection.connection.authId, first.authId);
  assert.equal(accepted.configuration.system, "");
  const sent = await f.received("独立处理的明确输入");
  assert.deepEqual(userTexts(sent), ["独立处理的明确输入"]);
  assert.equal(sent.body.messages.filter((message) => ["system", "developer"].includes(message.role))
    .map((message) => textOf(message.content)).join(""), "");
  assert.equal(sent.body.max_completion_tokens ?? sent.body.max_tokens, 64);
  assert.equal(sent.authorization, "Bearer old-secret");
  await f.client.call("connection.update", {
    connectionId: first.id,
    base: first.revision,
    input: f.input("独立调用更新端点", "independent-new"),
  });
  const relogged = await login(f.client, first.id, "new-secret");
  await setting(f.client, "retry", { enabled: false, maxRetries: 2, baseDelayMs: 5, maxAgentDelayMs: 100 });
  const repeated = await f.client.call("model.complete", params);
  assert.deepEqual(repeated.configuration, accepted.configuration);
  assert.deepEqual(repeated.options, accepted.options);
  assert.equal(f.requests.length, 1);
  gate.release();
  const completed = await finishProcessing(f.client, accepted);
  assert.equal(completed.status, "completed", completed.error?.message);
  assert.deepEqual(completed.configuration, accepted.configuration);
  assert.deepEqual(completed.result?.format, { id: "repa.model-response", version: "1" });
  assert(completed.result?.value.kind === "inline");
  const result = completed.result.value.data;
  assert(Check(ModelResponseSchema, result));
  assert.equal(result.input, "独立处理的明确输入");
  assert.equal(result.message.stopReason, "stop");
  assert.equal(textOf(result.message.content), "本地回复：独立处理的明确输入");
  assert.equal(result.message.usage.input, 1);
  assert.equal(result.message.usage.output, 1);
  assert.equal(result.message.usage.totalTokens, 2);
  assert.deepEqual(await f.client.call("model.complete", params), completed);
  await assert.rejects(f.client.call("model.complete", { ...params, system: "另一份提示" }),
    (error: unknown) => error instanceof RpcError && error.data !== null && typeof error.data === "object" &&
      "code" in error.data && error.data.code === "request_id_conflict");
  assert.equal(f.requests.length, 1);
  assert.deepEqual(await f.client.call("session.list", { spaceId: f.key.spaceId }), []);

  f.block("等待取消的独立输入");
  const cancelParams: Params<"model.complete"> = {
    ...params,
    requestId: randomUUID(),
    input: { parts: [{ kind: "text", text: "等待取消的独立输入" }] },
  };
  const cancellable = await f.client.call("model.complete", cancelParams);
  assert(Check(CompletionConfigurationSchema, cancellable.configuration));
  assert.equal(cancellable.configuration.connection.connection.authId, relogged.authId);
  const cancellingHttp = await f.received("等待取消的独立输入");
  assert.equal(cancellingHttp.url, "/independent-new/v1/chat/completions");
  assert.equal(cancellingHttp.authorization, "Bearer new-secret");
  await f.client.call("request.cancel", { spaceId: f.key.spaceId, requestId: cancellable.requestId });
  const cancelled = await finishProcessing(f.client, cancellable);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.result, undefined);
  await until(() => cancellingHttp.closed, Boolean);
  assert.deepEqual(await f.client.call("model.complete", cancelParams), cancelled);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(await f.client.call("session.list", { spaceId: f.key.spaceId }), []);
});

test("提示预览不执行扩展或模型，来源开关与实际运行提示一致", async (t) => {
  const f = await fixture(t, { observeExtension: true });
  const selected = await connection(f, "预览连接", "preview", "preview-secret");
  await setting(f.client, "model", { connectionId: selected.id, id: model.id });
  const scope: SettingScope = { kind: "session", ...f.key };
  await setting(f.client, "base", "PREVIEW_BASE", scope, "prompts");
  await setting(f.client, "append", ["预览中的追加内容"], scope, "prompts");
  const preview = await f.client.call("prompts.preview", f.key);
  assert.match(preview.prompt.system, /PREVIEW_BASE/);
  assert.match(preview.prompt.system, /预览中的追加内容/);
  assert.equal(preview.prompt.sources.find((source) => source.id === "base")?.content, "PREVIEW_BASE");
  assert.deepEqual(preview.settings.find((view) => view.namespace === "prompts")?.entries.find((entry) => entry.key === "base")?.source, scope);
  assert.equal(f.requests.length, 0);
  assert.equal(await f.extensionLoads(), 0);
  assert.equal((await f.client.call("session.get", f.key)).runtime, "unloaded");
  const accepted = await submit(f.client, f.key, "核对普通预览");
  assert.equal((await finish(f.client, accepted)).status, "completed");
  assert(accepted.runId);
  const run = await f.client.call("run.get", { spaceId: f.key.spaceId, runId: accepted.runId });
  assert(run.status !== "unknown");
  assert.equal(run.prompt?.system, preview.prompt.system);
  const actual = await f.received("核对普通预览");
  assert.equal(actual.body.messages.filter((message) => ["system", "developer"].includes(message.role))
    .map((message) => textOf(message.content)).join("\n\n"), preview.prompt.system);
  const loads = await f.extensionLoads();
  assert(loads > 0, "实际运行应加载已信任的测试扩展");

  const disabled = {
    base: "", append: [], projectInstructions: false, skillCatalog: false,
    environment: false, fileChanges: "on-demand",
  };
  for (const [key, value] of Object.entries(disabled)) await setting(f.client, key, value, scope, "prompts");
  const empty = await f.client.call("prompts.preview", f.key);
  assert.equal(empty.prompt.system, "");
  for (const id of ["projectInstructions", "skillCatalog", "environment", "fileChanges"]) {
    assert.equal(empty.prompt.sources.find((source) => source.id === id)?.enabled, false);
  }
  assert.equal(empty.prompt.sources.some(source => source.id === "learningContext"), false, "通用底座没有未安装的学习来源");
  assert.equal(f.requests.length, 1);
  assert.equal(await f.extensionLoads(), loads);
  const emptyRun = await submit(f.client, f.key, "核对空提示运行");
  assert.equal((await finish(f.client, emptyRun)).status, "completed");
  assert(emptyRun.runId);
  const emptyResult = await f.client.call("run.get", { spaceId: f.key.spaceId, runId: emptyRun.runId });
  assert(emptyResult.status !== "unknown");
  assert.equal(emptyResult.prompt?.system, "");
  const emptySent = await f.received("核对空提示运行");
  assert.equal(emptySent.body.messages.filter((message) => ["system", "developer"].includes(message.role))
    .map((message) => textOf(message.content)).join(""), "");
  assert.equal(JSON.stringify(emptySent.body.messages).includes("<repa_learning_context>"), false);
});

test("提示预览读取已安装包的 Skill，缺失包保留动态来源而不安装", async (t) => {
  const f = await fixture(t, { observeExtension: true });
  const packageRoot = path.join(f.agentDir, "local-package");
  const skillRoot = path.join(packageRoot, "skills", "preview-local");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "repa-preview-fixture", pi: { skills: ["./skills"] } }));
  await writeFile(path.join(skillRoot, "SKILL.md"), "---\nname: preview-local\ndescription: 本地预览测试资源\n---\n仅用于测试。\n");
  const settingsFile = path.join(f.agentDir, "settings.json");
  const settings: unknown = JSON.parse(await readFile(settingsFile, "utf8"));
  assert(settings !== null && typeof settings === "object" && !Array.isArray(settings));
  const missingSource = "git:https://repa.invalid/fixtures/preview-missing.git";
  await writeFile(settingsFile, JSON.stringify({ ...settings, packages: [packageRoot, missingSource] }));
  const resolve = DefaultPackageManager.prototype.resolve;
  t.mock.method(DefaultPackageManager.prototype, "resolve", function (this: DefaultPackageManager, onMissing: Parameters<typeof resolve>[0]) {
    // 拦在安装边界，回归失败时也不让测试尝试联网安装。
    assert(onMissing, "静态预览必须显式处理缺失包");
    return resolve.call(this, onMissing);
  });
  const preview = await f.client.call("prompts.preview", f.key);
  assert.match(preview.prompt.system, /preview-local/);
  assert.deepEqual(preview.prompt.sources.find(source => source.reference === missingSource), {
    id: `package:${missingSource}`, enabled: true, dynamic: true, reference: missingSource,
  });
  assert.equal(await f.extensionLoads(), 0);
  assert.equal(f.requests.length, 0);
});

test("排空退出拒绝新登录，已有认证仍可回答和取消并完成正常退出", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const completing = await f.client.call("connection.create", f.input("退出前完成认证", "drain-complete"));
  const cancelling = await f.client.call("connection.create", f.input("退出前取消认证", "drain-cancel"));
  const first = await f.client.call("auth.start", { connectionId: completing.id, type: "api_key" });
  const second = await f.client.call("auth.start", { connectionId: cancelling.id, type: "api_key" });
  const pending = await until(() => f.client.call("auth.get", { loginId: first.loginId }), (query) => query.challenge !== undefined);
  const otherPending = await until(() => f.client.call("auth.get", { loginId: second.loginId }), (query) => query.challenge !== undefined);
  assert(pending.challenge);
  assert.equal(pending.challenge.type, "secret");
  assert.equal(otherPending.challenge?.type, "secret");

  f.backend.application.shutdown("drain");
  assert.equal((await f.client.call("state.get", { scope: {} })).lifecycle, "draining");
  await assert.rejects(f.client.call("auth.start", { connectionId: completing.id, type: "api_key" }),
    (error: unknown) => error instanceof RpcError && error.data !== null && typeof error.data === "object" &&
      "code" in error.data && error.data.code === "shutting_down");
  await f.client.call("auth.reply", { loginId: first.loginId, challengeId: pending.challenge.id, value: "drain-secret" });
  const completed = await until(() => f.client.call("auth.get", { loginId: first.loginId }), (query) => query.status !== "pending");
  assert.equal(completed.status, "completed", completed.error?.message);
  const saved = await f.client.call("connection.get", { connectionId: completing.id });
  assert.equal(saved.authentication.configured, true);

  // 最后一项认证结束会关闭传输，直接等待应用回执以避开 RPC 发送与断开的竞态。
  const cancelled = await f.backend.application.modelCall("auth.cancel", { loginId: second.loginId });
  assert(Check(AuthQuerySchema, cancelled));
  assert.equal(cancelled.status, "cancelled");
  await f.backend.closed;
  assert.equal(f.backend.application.snapshot({}).lifecycle, "stopped");
  const credentials: unknown = JSON.parse(await readFile(path.join(f.appDirectory, "models", "auth", `${saved.authId}.json`), "utf8"));
  assert.deepEqual(credentials, { openai: { type: "api_key", key: "drain-secret" } });
});

test("会话已开始切换连接时，注销旧连接不取消绑定新连接的运行", async (t) => {
  const f = await fixture(t);
  const first = await connection(f, "旧连接", "previous", "previous-secret");
  const second = await connection(f, "新连接", "next", "next-secret");
  const previous = await submit(f.client, f.key, "先使用旧连接", { model: { connectionId: first.id, id: model.id } });
  assert.equal((await finish(f.client, previous)).status, "completed");
  const original = ModelConnections.prototype.assertBinding;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered = false;
  t.mock.method(ModelConnections.prototype, "assertBinding", async function (this: ModelConnections, binding: Parameters<typeof original>[0]) {
    if (binding.connection.id === second.id && !entered) {
      // 停在真实的绑定读取边界，此时新运行已受理，旧 Host 尚未关闭。
      entered = true;
      await gate;
    }
    return original.call(this, binding);
  });
  let revoking: Promise<void> | undefined;
  try {
    const next = await submit(f.client, f.key, "本次已选择新连接", { model: { connectionId: second.id, id: model.id } });
    assert(next.runId);
    const runId = next.runId;
    await until(() => entered, Boolean);
    let loggedOut: ModelConnection | undefined;
    let logoutError: unknown;
    revoking = f.client.call("auth.logout", { connectionId: first.id }).then(
      (result) => { loggedOut = result; },
      (error: unknown) => { logoutError = error; },
    );
    const during = await until(() => f.client.call("run.get", { spaceId: f.key.spaceId, runId }),
      (run) => loggedOut !== undefined || logoutError !== undefined || run.status === "cancelling");
    assert.ifError(logoutError);
    assert.equal(during.status, "running", "注销旧连接不应取消另一连接已经受理的工作");
    assert(loggedOut);
    assert.equal(loggedOut.authentication.configured, false);
    release();
    const completed = await finish(f.client, next);
    assert.equal(completed.status, "completed", completed.error?.message);
    const sent = await f.received("本次已选择新连接");
    assert.equal(sent.url, "/next/v1/chat/completions");
    assert.equal(sent.authorization, "Bearer next-secret");
    assert.equal(completed.runOptions.connection?.connection.id, second.id);
  } finally {
    release();
    await revoking;
  }
});

test("未显式选择思考强度时，普通和独立调用沿用 SDK 对非推理模型的默认适配", async (t) => {
  const f = await fixture(t);
  const settingsFile = path.join(f.agentDir, "settings.json");
  const settings: unknown = JSON.parse(await readFile(settingsFile, "utf8"));
  assert(settings !== null && typeof settings === "object" && !Array.isArray(settings));
  await writeFile(settingsFile, JSON.stringify({ ...settings, defaultThinkingLevel: "high" }));
  const selected = await connection(f, "非推理模型", "no-reasoning", "no-reasoning-secret");
  const view = await f.client.call("settings.get", { scope: { kind: "application" }, namespace: "runtime" });
  assert.equal(view.entries.find((entry) => entry.key === "thinkingLevel")?.effective, null);
  const choice = { connectionId: selected.id, id: model.id };
  const ordinary = await submit(f.client, f.key, "普通运行采用可用的默认强度", { model: choice });
  assert.equal(ordinary.runOptions.thinkingLevel, "off");
  const completed = await finish(f.client, ordinary);
  assert.equal(completed.status, "completed", completed.error?.message);
  const independent = await f.client.call("model.complete", {
    spaceId: f.key.spaceId,
    requestId: randomUUID(),
    input: { parts: [{ kind: "text", text: "独立调用采用可用的默认强度" }] },
    model: choice,
    system: "",
  });
  assert(Check(CompletionConfigurationSchema, independent.configuration));
  assert.equal(independent.configuration.thinkingLevel, "off");
  const processed = await finishProcessing(f.client, independent);
  assert.equal(processed.status, "completed", processed.error?.message);
  assert.equal(f.requests.length, 2);
  for (const sent of f.requests) {
    assert.equal(sent.url, "/no-reasoning/v1/chat/completions");
    assert.equal(sent.authorization, "Bearer no-reasoning-secret");
  }
});


test("公开独立回退固定所有候选身份，保留实际尝试且重传重开不重新调用", async (t) => {
  const f = await fixture(t);
  const first = await connection(f, "同名", "fallback-one", "first-key");
  const second = await connection(f, "同名", "fallback-two", "old-second-key");
  f.failRoute("fallback-one", 503, "service unavailable");
  const gate = f.block("公开回退固定输入");
  const params: Params<"model.complete"> = {
    spaceId: f.key.spaceId, requestId: randomUUID(), input: { parts: [{ kind: "text", text: "公开回退固定输入" }] },
    model: { connectionId: first.id, id: model.id }, system: "明确系统提示", thinkingLevel: "off",
    fallback: { on: "transient_error", models: [{ connectionId: second.id, id: model.id }] },
  };
  const accepted = await f.client.call("model.complete", params);
  assert(Check(CompletionConfigurationSchema, accepted.configuration));
  assert.equal(accepted.configuration.fallback?.models[0]?.connection.authId, second.authId);
  await f.received("公开回退固定输入");
  const changed = await f.client.call("connection.update", {
    connectionId: second.id, base: second.revision, input: f.input("新名字", "fallback-new"),
  });
  await login(f.client, changed.id, "new-second-key");
  const repeated = await f.client.call("model.complete", params);
  assert.deepEqual(repeated.configuration, accepted.configuration);
  assert.equal(f.requests.length, 1);
  gate.release();
  const completed = await finishProcessing(f.client, accepted);
  assert.equal(completed.status, "completed", completed.error?.message);
  assert.deepEqual(completed.modelAttempts?.map(attempt => attempt.status), ["failed", "completed"]);
  assert.equal(completed.modelAttempts?.[1]?.binding.connection.authId, second.authId);
  assert.equal(completed.modelAttempts?.[1]?.usage?.totalTokens, 2);
  assert.deepEqual(f.requests.map(request => request.url.split("/")[1]), ["fallback-one", "fallback-two"]);
  assert.equal(f.requests[1]?.authorization, "Bearer old-second-key");
  assert.deepEqual(f.requests[0]?.body.messages, f.requests[1]?.body.messages);
  assert(completed.result?.value.kind === "inline");
  assert(Check(ModelResponseSchema, completed.result.value.data));
  assert.equal(completed.result.value.data.binding.connection.id, second.id);
  assert.deepEqual(completed.result.value.data.attempts, completed.modelAttempts);
  assert.equal(JSON.stringify(completed).includes("old-second-key"), false);
  assert.equal(JSON.stringify(completed).includes("new-second-key"), false);
  await f.backend.close("cancel");
  await f.client.close();
  const reopened = await startRepaServer({ agentDir: f.agentDir, appDirectory: f.appDirectory });
  const client = await RepaClient.connect(reopened.connection);
  t.after(async () => { await reopened.close("cancel"); await client.close(); });
  await client.call("space.open", { path: f.directory });
  assert.deepEqual(await client.call("model.complete", params), completed);
  assert.equal(f.requests.length, 2);
});

test("公开独立模型调用复用选项校验，非法输入在受理前拒绝且 provider 不收到请求", async (t) => {
  const f = await fixture(t);
  const selected = await connection(f, "校验连接", "validation", "validation-key");
  const selection = { connectionId: selected.id, id: model.id };
  const invalidOptions: Record<string, unknown>[] = [
    { system: 42 },
    { system: undefined },
    { maxTokens: 0 },
    { maxTokens: -1 },
    { maxTokens: 1.5 },
    { maxTokens: "32" },
    { maxTokens: null },
    { input: { parts: [] } },
    { input: { parts: [{ kind: "text", text: 42 }] } },
    { input: { parts: [{ kind: "resource", resource: { id: "missing" } }] } },
    { input: { parts: [{ kind: "text", text: "输入", unknown: true }] } },
    { model: { ...selection, id: "" } },
    { model: { ...selection, unknown: true } },
    { thinkingLevel: "unsupported" },
    { fallback: { on: "any_error", models: [selection] } },
    { fallback: { on: "transient_error", models: [] } },
    { fallback: { on: "transient_error", models: [{ ...selection, unknown: true }] } },
    { unknown: true },
  ];
  for (const patch of invalidOptions) {
    const params: Params<"model.complete"> = {
      spaceId: f.key.spaceId, requestId: randomUUID(), model: selection,
      input: { parts: [{ kind: "text", text: "非法选项不应发送" }] }, system: "",
    };
    Object.assign(params, patch);
    await assert.rejects(f.client.call("model.complete", params), error => error instanceof RpcError && error.code === -32602);
    assert.deepEqual(await f.client.call("request.get", { spaceId: f.key.spaceId, requestId: params.requestId }),
      { requestId: params.requestId, status: "unknown" });
    assert.equal(f.requests.length, 0);
  }
  const accepted = await f.client.call("model.complete", {
    spaceId: f.key.spaceId, requestId: randomUUID(), model: selection,
    input: { parts: [{ kind: "text", text: "" }] }, system: "", maxTokens: 1,
  });
  const completed = await finishProcessing(f.client, accepted);
  assert.equal(completed.status, "completed", completed.error?.message);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]?.body.max_completion_tokens ?? f.requests[0]?.body.max_tokens, 1);
  assert.equal(f.requests[0]?.body.messages.some(message => ["system", "developer"].includes(message.role)), false);
});

test("公开回退的最终失败保存每个候选错误，重复主模型在受理前拒绝", async (t) => {
  const f = await fixture(t);
  const first = await connection(f, "主连接", "failed-one", "first-key");
  const second = await connection(f, "备用连接", "failed-two", "second-key");
  f.failRoute("failed-one", 503, "service unavailable");
  f.failRoute("failed-two", 400, "invalid request");
  const params: Params<"model.complete"> = {
    spaceId: f.key.spaceId, requestId: randomUUID(), input: { parts: [{ kind: "text", text: "两个候选都失败" }] },
    model: { connectionId: first.id, id: model.id }, system: "", thinkingLevel: "off",
    fallback: { on: "transient_error", models: [{ connectionId: second.id, id: model.id }] },
  };
  const completed = await finishProcessing(f.client, await f.client.call("model.complete", params));
  assert.equal(completed.status, "failed");
  assert.equal(completed.error?.code, "provider");
  assert.deepEqual(completed.modelAttempts?.map(attempt => attempt.status), ["failed", "failed"]);
  assert.match(completed.modelAttempts?.[0]?.error?.message ?? "", /service unavailable/u);
  assert.match(completed.modelAttempts?.[1]?.error?.message ?? "", /invalid request/u);
  assert.deepEqual(await f.client.call("model.complete", params), completed);
  assert.equal(f.requests.length, 2);
  const duplicate = { ...params, requestId: randomUUID(), fallback: { on: "transient_error" as const, models: [params.model] } };
  await assert.rejects(f.client.call("model.complete", duplicate), error => error instanceof RpcError &&
    typeof error.data === "object" && error.data !== null && "code" in error.data && error.data.code === "configuration");
  assert.deepEqual(await f.client.call("request.get", { spaceId: f.key.spaceId, requestId: duplicate.requestId }),
    { requestId: duplicate.requestId, status: "unknown" });
});

test("公开 JSON 输出保留原回复、用量和来源资源，成功与失败重传重开复制均不重新调用", async (t) => {
  const schema = { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false };
  for (const example of [
    { text: ' { "count": 3 }\n', finish: "stop", status: "completed" },
    { text: ' { "count": "3" } \n', finish: "stop", status: "failed" },
    { text: ' { "count": 3 }\n', finish: "length", status: "failed" },
  ]) {
    const f = await fixture(t, { responseText: example.text, finish: example.finish });
    const selected = await connection(f, "结构化输出连接", "json", "json-key");
    const target = { kind: "file" as const, spaceId: f.key.spaceId, location: { kind: "relative" as const, path: "source.txt" } };
    await f.client.call("content.write", { target, operationId: randomUUID(), base: { kind: "absent" }, value: { kind: "text", text: "JSON 调用引用的原文\n" } });
    const uploader = await RepaClient.connect(f.backend.connection);
    t.after(() => uploader.close());
    const source = await uploader.call("content.read", { target });
    assert(source.resource && source.content.bodyRevision);
    const bytes = Buffer.from("JSON 输入附件的原始字节");
    const { resource } = await uploader.uploadResource(f.key.spaceId, bytes, "application/octet-stream");
    const params: Params<"model.complete"> = {
      spaceId: f.key.spaceId, requestId: randomUUID(), model: { connectionId: selected.id, id: model.id },
      input: { parts: [{ kind: "reference", target }, { kind: "resource", resource }] },
      system: "读取原文并返回计数。", thinkingLevel: "off", output: { kind: "json", schema },
    };
    const accepted = await f.client.call("model.complete", params);
    assert(Check(CompletionConfigurationSchema, accepted.configuration));
    assert.deepEqual(accepted.configuration.output, params.output);
    const completed = await finishProcessing(f.client, accepted);
    assert.equal(completed.status, example.status, JSON.stringify(completed));
    assert(completed.result?.value.kind === "inline");
    assert(Check(ModelResponseSchema, completed.result.value.data));
    const data = completed.result.value.data;
    assert.deepEqual(data.outputFormat, { kind: "json", schema });
    assert.equal(data.message.stopReason, example.finish);
    assert.equal(textOf(data.message.content), example.text, "原回复保留空白，不用重序列化后的 JSON 替代");
    assert.deepEqual({ input: data.message.usage.input, output: data.message.usage.output, totalTokens: data.message.usage.totalTokens }, { input: 1, output: 1, totalTokens: 2 });
    assert.deepEqual(data.attempts, completed.modelAttempts);
    assert.equal(data.attempts[0]?.status, example.status);
    assert.equal(data.attempts[0]?.usage?.totalTokens, 2);
    if (example.status === "completed") assert.deepEqual(data.output, { count: 3 });
    else {
      assert.equal(completed.error?.code, "invalid_model_output");
      assert.equal(data.attempts[0]?.error?.code, "invalid_model_output");
      assert.equal(Object.hasOwn(data, "output"), false, "失败不补出或转换一个结构化值");
    }
    assert.deepEqual(completed.result.sources, [{ target, revision: source.content.bodyRevision }]);
    assert.deepEqual(completed.result.resources, [resource, source.resource]);
    assert.equal(f.requests.length, 1);
    assert(f.requests[0]?.body.messages.some(message => textOf(message.content).includes(JSON.stringify(schema))));
    await uploader.close();
    await f.client.call("resource.collect", { spaceId: f.key.spaceId });
    assert.deepEqual(Buffer.from(await (await f.client.resource(resource)).arrayBuffer()), bytes);
    assert.equal(await (await f.client.resource(source.resource)).text(), "JSON 调用引用的原文\n");
    assert.deepEqual(await f.client.call("model.complete", params), completed);
    await f.reopen();
    assert.deepEqual(await f.client.call("model.complete", params), completed);
    const destination = path.join(f.root, "copied-space");
    const copied = await f.client.call("space.copy", { operationId: randomUUID(), spaceId: f.key.spaceId, destination });
    assert.equal(copied.status, "completed");
    const opened = await f.client.call("space.open", { path: destination });
    const saved = await f.client.call("request.get", { spaceId: opened.id, requestId: params.requestId });
    assert("operation" in saved && saved.result?.value.kind === "inline");
    assert(Check(ModelResponseSchema, saved.result.value.data));
    assert.equal(saved.status, example.status);
    assert.deepEqual(saved.result.value.data, data, "复制保存当时的原回复与尝试事实");
    assert.deepEqual(saved.result.sources, [{ target: { ...target, spaceId: opened.id }, revision: source.content.bodyRevision }]);
    assert.deepEqual(saved.result.resources, [resource, source.resource].map(ref => ({ ...ref, spaceId: opened.id })));
    await f.client.call("resource.collect", { spaceId: opened.id });
    for (const ref of saved.result.resources) {
      const response = await f.client.resource(ref);
      assert.equal(response.ok, true);
    }
    assert.equal(f.requests.length, 1, "重传、重开和空间复制都不重新发送模型请求");
  }
});

test("公开 JSON schema 在绑定不存在模型前拒绝，无后台记录或 provider 请求", async (t) => {
  const f = await fixture(t);
  for (const schema of [
    { type: "unknown" },
    { type: "object", unexpectedKeyword: true },
    { $ref: "https://example.invalid/not-installed.json" },
    { type: "object", properties: { count: { type: "unknown" } } },
  ]) {
    const params: Params<"model.complete"> = {
      spaceId: f.key.spaceId, requestId: randomUUID(), model: { connectionId: "missing", id: "missing" },
      input: { parts: [{ kind: "text", text: "不应被发送" }] }, system: "", output: { kind: "json", schema },
    };
    await assert.rejects(f.client.call("model.complete", params), error => error instanceof RpcError &&
      typeof error.data === "object" && error.data !== null && "code" in error.data && error.data.code === "invalid_output_schema");
    assert.deepEqual(await f.client.call("request.get", { spaceId: f.key.spaceId, requestId: params.requestId }),
      { requestId: params.requestId, status: "unknown" });
    assert.equal(f.requests.length, 0);
  }
});
