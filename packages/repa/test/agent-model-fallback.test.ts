import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { RepaClient } from "../src/client.js";
import type { ConnectionModel } from "../src/models/schema.js";
import type { RequestRecord, Submit } from "../src/requests/schema.js";
import { startRepaServer } from "../src/server.js";

const model: ConnectionModel = {
  id: "local-agent", name: "本地 Agent", api: "openai-completions", reasoning: false,
  input: ["text"], contextWindow: 16384, maxTokens: 256,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const RequestSchema = Type.Object({
  messages: Type.Array(Type.Object({ role: Type.String(), content: Type.Unknown() })),
});
type CapturedRequest = { route: string; body: Static<typeof RequestSchema>; authorization?: string };

async function until<T>(read: () => Promise<T> | T, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= deadline) assert.fail(`等待状态超时：${JSON.stringify(value)}`);
    await delay(10);
  }
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-agent-fallback-"));
  const directory = path.join(root, "space");
  const agentDir = path.join(root, "agent");
  await mkdir(directory);
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"], packages: [],
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0 },
    compaction: { enabled: false, reserveTokens: 400, keepRecentTokens: 200 },
  }));
  const requests: CapturedRequest[] = [];
  const failures = new Map<string, { status: number; message: string; afterTool?: boolean }>();
  const gates = new Map<string, { wait: Promise<void>; release(): void }>();
  const providerErrors: unknown[] = [];
  const provider = createServer((request, response) => {
    void (async () => {
      request.setEncoding("utf8");
      let bytes = "";
      for await (const chunk of request) bytes += chunk;
      const body: unknown = JSON.parse(bytes);
      assert(Check(RequestSchema, body));
      const route = request.url?.split("/")[1] ?? "";
      requests.push({ route, body, authorization: request.headers.authorization });
      const failure = failures.get(route);
      const toolResult = body.messages.some(message => message.role === "tool");
      if (!failure?.afterTool || toolResult) {
        const gate = gates.get(route);
        if (gate) {
          await Promise.race([gate.wait, new Promise<void>(resolve => response.once("close", resolve))]);
          if (response.destroyed) return;
        }
        if (failure) {
          response.writeHead(failure.status, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: failure.message, type: "local_test_error" } }));
          return;
        }
      }
      const tool = failure?.afterTool && !toolResult;
      const chunk = (delta: unknown, finishReason: string | null) => ({
        id: randomUUID(), object: "chat.completion.chunk", created: 1, model: model.id,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        `data: ${JSON.stringify(chunk(tool ? { role: "assistant", tool_calls: [{ index: 0, id: "saved-tool", type: "function", function: {
          name: "write", arguments: JSON.stringify({ path: "saved.md", content: "已保存的内容\n" }),
        } }] } : { role: "assistant", content: "根据已保存工具结果继续完成。" }, null))}`,
        `data: ${JSON.stringify({ ...chunk({}, tool ? "tool_calls" : "stop"), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,
        "data: [DONE]", "",
      ].join("\n\n"));
    })().catch((error: unknown) => {
      providerErrors.push(error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const backend = await startRepaServer({ agentDir, appDirectory: path.join(root, "application"), trustExtensions: false });
  const client = await RepaClient.connect(backend.connection);
  t.after(async () => {
    for (const gate of gates.values()) gate.release();
    await backend.close("cancel");
    await client.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
    assert.deepEqual(providerErrors, []);
  });
  const space = await client.call("space.open", { path: directory });
  const session = await client.call("session.create", { spaceId: space.id });
  const target = { spaceId: space.id, sessionId: session.sessionId };
  return {
    client, target, directory, requests, failures,
    input(route: string, selectedModel: ConnectionModel = model) {
      return { name: route, provider: "openai", baseUrl: `${endpoint}/${route}/v1`, authMode: "none" as const, models: [selectedModel] };
    },
    block(route: string) {
      let release = () => {};
      const wait = new Promise<void>(resolve => { release = resolve; });
      const gate = { wait, release };
      gates.set(route, gate);
      return gate;
    },
    async connection(route: string, selectedModel: ConnectionModel = model) {
      return client.call("connection.create", this.input(route, selectedModel));
    },
    async submit(selection: Submit["selection"], text = "保存内容并继续") {
      return client.call("session.submit", { target, requestId: randomUUID(),
        input: { parts: [{ kind: "text", text }] }, dispatch: { kind: "start" }, selection });
    },
    async request(requestId: string) {
      const value = await client.call("request.get", { spaceId: space.id, requestId });
      assert("delivery" in value);
      return value;
    },
    async finished(requestId: string): Promise<RequestRecord> {
      return until(() => this.request(requestId), value => !["running", "queued"].includes(value.status));
    },
  };
}

test("Agent 同连接重试耗尽后按冻结策略自动接续，已保存工具只执行一次且用户队列保持暂停", async t => {
  const f = await fixture(t);
  const primary = await f.connection("primary");
  const fallback = await f.connection("fallback");
  const gate = f.block("primary");
  f.failures.set("primary", { status: 503, message: "service unavailable", afterTool: true });
  const accepted = await f.submit({
    model: { connectionId: primary.id, id: model.id },
    fallback: { on: "transient_error", models: [{ connectionId: fallback.id, id: model.id }] },
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 0, maxAgentDelayMs: 0 },
  });
  await until(() => f.requests.filter(request => request.route === "primary").length, count => count === 2);
  assert.equal(await readFile(path.join(f.directory, "saved.md"), "utf8"), "已保存的内容\n");
  const queued = await f.client.call("session.submit", { target: f.target, requestId: randomUUID(),
    input: { parts: [{ kind: "text", text: "用户后续排队输入" }] }, dispatch: { kind: "queue" },
    selection: { model: { connectionId: fallback.id, id: model.id } } });
  await f.client.call("connection.update", { connectionId: fallback.id, base: fallback.revision, input: f.input("changed") });
  gate.release();
  const failed = await f.finished(accepted.requestId);
  assert.equal(failed.status, "failed");
  const linked = await until(() => f.request(accepted.requestId), value => value.fallbackRequestId !== undefined);
  assert(linked.fallbackRequestId);
  const continued = await f.finished(linked.fallbackRequestId);
  assert.equal(continued.status, "completed", continued.error?.message);
  assert.deepEqual(continued.continuation, { kind: "model_fallback", previousRequestId: accepted.requestId });
  assert("previousRequestId" in continued.submission);
  assert.equal(continued.submission.previousRequestId, accepted.requestId);
  assert.equal(continued.runOptions.connection?.connection.baseUrl, fallback.baseUrl);
  assert.equal(continued.runOptions.connection?.connection.authId, fallback.authId);
  assert.equal(linked.modelAttempts?.[0]?.status, "failed");
  assert.equal(continued.modelAttempts?.[0]?.status, "completed");
  assert.equal(f.requests.filter(request => request.route === "primary").length, 3, "一次工具请求后由 SDK 重试两次失败调用");
  assert.equal(f.requests.filter(request => request.route === "fallback").length, 1);
  assert(!f.requests.some(request => request.route === "changed"));
  const second = f.requests.find(request => request.route === "fallback");
  assert(second);
  assert.equal(second.body.messages.filter(message => message.role === "tool").length, 1);
  assert.equal(second.body.messages.filter(message => message.role === "user" && JSON.stringify(message.content).includes("保存内容并继续")).length, 1);
  const history = await f.client.call("session.history", { ...f.target });
  assert.equal(history.messages.filter(message => message.role === "tool" && message.name === "write").length, 1);
  assert.equal(await readFile(path.join(f.directory, "saved.md"), "utf8"), "已保存的内容\n");
  assert.equal((await f.client.call("queue.list", f.target)).status, "paused");
  assert.equal((await f.request(queued.requestId)).status, "queued");
});

test("Agent 未配置策略时保持临时失败，显式 null 关闭继承策略", async t => {
  const f = await fixture(t);
  const primary = await f.connection("primary");
  const fallback = await f.connection("fallback");
  f.failures.set("primary", { status: 503, message: "service unavailable" });
  const accepted = await f.submit({ model: { connectionId: primary.id, id: model.id } });
  const failed = await f.finished(accepted.requestId);
  assert.equal(failed.status, "failed");
  assert.equal(failed.fallbackRequestId, undefined);
  const scope = { kind: "session" as const, ...f.target };
  const settings = await f.client.call("settings.get", { scope, namespace: "runtime" });
  const entry = settings.entries.find(entry => entry.key === "fallback");
  assert(entry);
  await f.client.call("settings.set", { scope, namespace: "runtime", key: "fallback", base: entry.revision,
    value: { on: "transient_error", models: [{ connectionId: fallback.id, id: model.id }] } });
  const disabled = await f.submit({ model: { connectionId: primary.id, id: model.id }, fallback: null }, "关闭回退");
  const disabledFailure = await f.finished(disabled.requestId);
  assert.equal(disabledFailure.fallbackRequestId, undefined);
  assert.equal(disabledFailure.runOptions.fallback, undefined);
  assert(!f.requests.some(request => request.route === "fallback"));
});

for (const failure of [
  { status: 401, message: "Invalid API key" },
  { status: 400, message: "maximum context length exceeded" },
  { status: 400, message: "invalid input" },
]) {
  test(`Agent 的 ${failure.status} ${failure.message} 不自动更换连接`, async t => {
    const f = await fixture(t);
    const primary = await f.connection("primary");
    const fallback = await f.connection("fallback");
    f.failures.set("primary", failure);
    const accepted = await f.submit({ model: { connectionId: primary.id, id: model.id },
      fallback: { on: "transient_error", models: [{ connectionId: fallback.id, id: model.id }] } });
    const failed = await f.finished(accepted.requestId);
    assert.equal(failed.status, "failed");
    assert.equal(failed.fallbackRequestId, undefined);
    assert(!f.requests.some(request => request.route === "fallback"));
  });
}

test("Agent 取消正在等待的临时失败调用，不发起自动回退", async t => {
  const f = await fixture(t);
  const primary = await f.connection("primary");
  const fallback = await f.connection("fallback");
  const gate = f.block("primary");
  f.failures.set("primary", { status: 503, message: "service unavailable" });
  const accepted = await f.submit({ model: { connectionId: primary.id, id: model.id },
    fallback: { on: "transient_error", models: [{ connectionId: fallback.id, id: model.id }] } });
  await until(() => f.requests.length, count => count === 1);
  const running = await f.request(accepted.requestId);
  assert(running.runId);
  await f.client.call("run.cancel", { spaceId: f.target.spaceId, runId: running.runId });
  gate.release();
  const cancelled = await f.finished(accepted.requestId);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.modelAttempts?.[0]?.status, "cancelled");
  assert.equal(cancelled.fallbackRequestId, undefined);
  assert(!f.requests.some(request => request.route === "fallback"));
});

test("Agent 继承有序回退策略，多个连接失败各自保留事实，候选耗尽不循环", async t => {
  const f = await fixture(t);
  const primary = await f.connection("primary");
  const second = await f.connection("second");
  const third = await f.connection("third");
  for (const route of ["primary", "second", "third"]) f.failures.set(route, { status: 503, message: "service unavailable" });
  const scope = { kind: "session" as const, ...f.target };
  const settings = await f.client.call("settings.get", { scope, namespace: "runtime" });
  const entry = settings.entries.find(entry => entry.key === "fallback");
  assert(entry);
  await f.client.call("settings.set", { scope, namespace: "runtime", key: "fallback", base: entry.revision,
    value: { on: "transient_error", models: [{ connectionId: second.id, id: model.id }, { connectionId: third.id, id: model.id }] } });
  const accepted = await f.submit({ model: { connectionId: primary.id, id: model.id } });
  const firstResult = await until(() => f.request(accepted.requestId), value => value.fallbackRequestId !== undefined);
  assert(firstResult.fallbackRequestId);
  const secondRequestId = firstResult.fallbackRequestId;
  const secondResult = await until(() => f.request(secondRequestId), value => value.fallbackRequestId !== undefined);
  assert(secondResult.fallbackRequestId);
  const thirdResult = await f.finished(secondResult.fallbackRequestId);
  assert.deepEqual([firstResult, secondResult, thirdResult].map(request => request.status), ["failed", "failed", "failed"]);
  assert.deepEqual([firstResult, secondResult, thirdResult].map(request => request.modelAttempts?.[0]?.binding.connection.id), [primary.id, second.id, third.id]);
  assert.equal(thirdResult.fallbackRequestId, undefined);
  assert.equal(thirdResult.runOptions.fallback, undefined);
  assert.deepEqual(f.requests.map(request => request.route), ["primary", "second", "third"]);
});

test("Agent 回退候选不支持历史图片时明确失败，不丢弃旧输入也不绕到下个候选", async t => {
  const f = await fixture(t);
  const primary = await f.connection("visual", { ...model, input: ["text", "image"] });
  const second = await f.connection("text-only");
  const third = await f.connection("other");
  f.failures.set("visual", { status: 503, message: "service unavailable" });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==", "base64");
  const uploaded = await f.client.uploadResource(f.target.spaceId, png, "image/png");
  const accepted = await f.client.call("session.submit", {
    target: f.target, requestId: randomUUID(), dispatch: { kind: "start" },
    input: { parts: [{ kind: "text", text: "分析图片" }, { kind: "resource", resource: uploaded.resource }] },
    selection: { model: { connectionId: primary.id, id: model.id }, fallback: { on: "transient_error",
      models: [{ connectionId: second.id, id: model.id }, { connectionId: third.id, id: model.id }] } },
  });
  const failed = await until(() => f.request(accepted.requestId), value => value.fallbackRequestId !== undefined);
  assert(failed.fallbackRequestId);
  const continued = await f.finished(failed.fallbackRequestId);
  assert.equal(continued.status, "failed");
  assert.equal(continued.error?.code, "unsupported_input");
  assert.equal(continued.fallbackRequestId, undefined);
  assert.deepEqual(f.requests.map(request => request.route), ["visual"]);
  const history = await f.client.call("session.history", f.target);
  assert(history.messages.some(message => message.role === "user" && message.content.some(part => part.type === "resource" && part.resource.id === uploaded.resource.id)));
  assert.deepEqual((await f.request(accepted.requestId)).input, accepted.input);
});

test("Agent 自动接续保留旧运行已进入的 steer，不向新运行重传或丢失受理事实", async t => {
  const f = await fixture(t);
  const primary = await f.connection("primary");
  const fallback = await f.connection("fallback");
  const gate = f.block("primary");
  f.failures.set("primary", { status: 503, message: "service unavailable" });
  const accepted = await f.submit({ model: { connectionId: primary.id, id: model.id },
    fallback: { on: "transient_error", models: [{ connectionId: fallback.id, id: model.id }] } });
  await until(() => f.requests.length, count => count === 1);
  const running = await f.request(accepted.requestId);
  assert(running.runId);
  const steer = await f.client.call("session.submit", {
    target: f.target, requestId: randomUUID(), input: { parts: [{ kind: "text", text: "补充：保留这条新要求" }] },
    dispatch: { kind: "steer", expectedRunId: running.runId },
  });
  gate.release();
  const failed = await until(() => f.request(accepted.requestId), value => value.fallbackRequestId !== undefined);
  assert(failed.fallbackRequestId);
  const continued = await f.finished(failed.fallbackRequestId);
  assert.equal(continued.status, "completed");
  const savedSteer = await f.request(steer.requestId);
  assert.equal(savedSteer.runId, running.runId);
  assert.equal(savedSteer.delivery.status, "entered");
  const second = f.requests.find(request => request.route === "fallback");
  assert(second);
  assert.equal(second.body.messages.filter(message => message.role === "user" && JSON.stringify(message.content).includes("补充：保留这条新要求")).length, 1);
});
