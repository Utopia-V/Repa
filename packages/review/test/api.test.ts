import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { RepaClient, RpcError, startRepaServer, type CapabilityEvent, type CapabilityScope, type SettingScope } from "repa";
import {
  ListReviewsResultSchema, ParameterVersionSchema, ReviewHistoryResultSchema, ReviewItemSchema,
  ReviewMutationResultSchema, SetReviewParametersResultSchema, ReviewOptimizationResultSchema,
} from "../dist/index.js";

const application = { kind: "application" as const };
const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const fault = (code: string) => (error: unknown) => error instanceof RpcError &&
  error.data !== null && typeof error.data === "object" && "code" in error.data && error.data.code === code;

async function until<T>(read: () => T | Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= deadline) assert.fail(`等待复习状态超时：${JSON.stringify(value)}`);
    await delay(10);
  }
}
async function set(client: RepaClient, scope: SettingScope, key: string, value: unknown) {
  const entry = (await client.call("settings.get", { scope, namespace: "plugins" })).entries.find(entry => entry.key === key);
  assert(entry);
  await client.call("settings.set", { scope, namespace: "plugins", key, value, base: entry.revision });
}
async function invoke<S extends TSchema>(client: RepaClient, scope: CapabilityScope, name: string,
  input: unknown, schema: S, requestId = randomUUID()): Promise<Static<S>> {
  const result = await client.call("capability.invoke", { scope, requestId, contract: { id: `repa.review.${name}`, version: "1" }, input });
  assert(result.kind === "inline");
  assert.equal(result.requestId, requestId);
  assert(Check(schema, result.result));
  return result.result;
}
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: unknown) => part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "").join("\n");
}
function toolResult<S extends TSchema>(context: TranscriptContext, name: string, schema: S): Static<S> {
  const message = context.messages.findLast(message => message.role === "toolResult" && message.toolName === name);
  assert(message && message.role === "toolResult");
  assert.equal(message.isError, false, textOf(message.content));
  const value: unknown = JSON.parse(textOf(message.content));
  assert(Check(schema, value));
  return value;
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-review-api-"));
  const directory = path.join(root, "space");
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: [packageDirectory], extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"],
    retry: { enabled: false }, compaction: { enabled: false },
  }));
  const faux = fauxProvider({
    api: `repa-review-api-${randomUUID()}`, provider: `repa-review-provider-${randomUUID()}`,
    models: [{ id: "test", reasoning: false, input: ["text"], contextWindow: 16384, maxTokens: 1024 }], tokensPerSecond: 0,
  });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const options = { agentDir, appDirectory: path.join(root, "app"), modelOverride: { modelRuntime, model: faux.getModel() } };
  let server = await startRepaServer(options);
  let client = await RepaClient.connect(server.connection);
  t.after(async () => {
    await server.close("cancel");
    await client.close();
    await rm(root, { recursive: true, force: true });
  });
  const space = await client.call("space.open", { path: directory });
  await set(client, application, "disabled", ["repa-review"]);
  const session = await client.call("session.create", { spaceId: space.id });
  const scope = { kind: "space" as const, spaceId: space.id };
  const key = { spaceId: space.id, sessionId: session.sessionId };
  return {
    root, directory, space, scope, key, faux,
    database: path.join(directory, ".repa", "plugins", "review", "reviews.sqlite"),
    get client() { return client; },
    async connect(hostKey?: string) {
      const peer = await RepaClient.connect(server.connection, hostKey ? { hostKey } : {});
      t.after(() => peer.close());
      return peer;
    },
    async enable() {
      await set(client, application, "backends", [{ id: "review", package: { kind: "source", source: packageDirectory, scope: "user" } }]);
      await set(client, application, "trusted", [{ kind: "package", name: "@repa/review" }]);
    },
    async reopen() {
      await server.close("cancel");
      await client.close();
      server = await startRepaServer(options);
      client = await RepaClient.connect(server.connection);
      assert.equal((await client.call("space.open", { path: directory })).id, space.id);
    },
    async send(text: string) {
      const accepted = await client.call("session.submit", { target: key, requestId: randomUUID(), input: { parts: [{ kind: "text", text }] }, dispatch: { kind: "start" } });
      assert(accepted.runId);
      const runId = accepted.runId;
      const run = await until(() => client.call("run.get", { spaceId: space.id, runId }), value => ["completed", "failed", "cancelled", "interrupted"].includes(value.status));
      assert.equal(run.status, "completed", JSON.stringify(run));
      return accepted;
    },
  };
}

test("复习列表和历史查询返回当前数据，处理记录只保留修改请求", async (t) => {
  const f = await fixture(t);
  await f.enable();
  const queryId = randomUUID();
  const list = () => invoke(f.client, f.scope, "list", {}, ListReviewsResultSchema, queryId);
  assert.deepEqual((await list()).items, []);
  const created = await invoke(f.client, f.scope, "create", {
    operationId: randomUUID(), prompt: "为什么月球引力会引起潮汐？",
  }, ReviewMutationResultSchema);
  assert.equal((await list()).items[0]?.id, created.item.id);
  await invoke(f.client, f.scope, "get", { itemId: created.item.id }, ReviewItemSchema);
  await invoke(f.client, f.scope, "history", { itemId: created.item.id }, ReviewHistoryResultSchema);
  await invoke(f.client, f.scope, "parameters.get", {}, ParameterVersionSchema);
  const records = await readdir(path.join(f.directory, ".repa/runtime/processing"));
  assert.equal(records.length, 1);
  assert.deepEqual(await f.client.call("request.get", { spaceId: f.space.id, requestId: queryId }), {
    requestId: queryId, status: "unknown",
  });
});

test("安装包描述不创建数据库，公共复习操作绑定客户端来源且重传和竞争不重复记录", async (t) => {
  const f = await fixture(t);
  assert.equal(existsSync(f.database), false);
  const before = await f.client.call("capability.describe", { scope: f.scope });
  assert(before.packages.some(item => item.name === "@repa/review"));
  assert(!before.capabilities.some(item => item.contract.id.startsWith("repa.review.")));
  assert.equal(existsSync(f.database), false);
  await f.enable();
  const described = await f.client.call("capability.describe", { scope: f.scope });
  assert(described.packages.some(item => item.name === "@repa/review" && item.backend?.status === "ready"));
  assert.equal(described.capabilities.filter(item => item.pluginId === "review").length, 12);
  const createDescriptor = described.capabilities.find(item => item.contract.id === "repa.review.create");
  assert(createDescriptor && "properties" in createDescriptor.inputSchema && createDescriptor.inputSchema.properties && typeof createDescriptor.inputSchema.properties === "object");
  assert("operationId" in createDescriptor.inputSchema.properties);
  assert(createDescriptor.tool?.inputSchema && "properties" in createDescriptor.tool.inputSchema && createDescriptor.tool.inputSchema.properties && typeof createDescriptor.tool.inputSchema.properties === "object");
  assert.equal("operationId" in createDescriptor.tool.inputSchema.properties, false);
  assert.equal(JSON.stringify(described.capabilities).includes("prepare"), false);
  assert.equal(described.capabilities.find(item => item.contract.id === "repa.review.parameters.optimize")?.execution, "background");
  assert.equal(existsSync(f.database), false);
  const created = await invoke(f.client, f.scope, "create", { operationId: randomUUID(), prompt: "潮汐是什么？", answer: "海面周期性升降" }, ReviewMutationResultSchema);
  assert.equal(existsSync(f.database), true);
  assert.deepEqual(await invoke(f.client, f.scope, "get", { itemId: created.item.id }, ReviewItemSchema), created.item);
  const due = await invoke(f.client, f.scope, "list", { dueBefore: Date.now() }, ListReviewsResultSchema);
  assert.deepEqual(due.items.map(item => item.id), [created.item.id]);
  const requestId = randomUUID();
  const input = { operationId: randomUUID(), itemId: created.item.id, base: created.item.revision, rating: 3, response: "海面周期性升降" };
  const feedback = await invoke(f.client, f.scope, "feedback", input, ReviewMutationResultSchema, requestId);
  assert(feedback.event && feedback.event.kind === "feedback");
  assert.equal(feedback.event.recordedBy.kind, "client");
  assert.deepEqual(await invoke(f.client, f.scope, "feedback", input, ReviewMutationResultSchema, requestId), feedback);
  assert.deepEqual(await invoke(f.client, f.scope, "feedback", input, ReviewMutationResultSchema), feedback);
  const competing = await Promise.allSettled([2, 4].map(rating => invoke(f.client, f.scope, "feedback", {
    operationId: randomUUID(), itemId: feedback.item.id, base: feedback.item.revision, rating,
  }, ReviewMutationResultSchema)));
  assert.equal(competing.filter(value => value.status === "fulfilled").length, 1);
  const rejected = competing.find(value => value.status === "rejected");
  assert(rejected && rejected.status === "rejected" && fault("review_conflict")(rejected.reason));
  const current = await invoke(f.client, f.scope, "get", { itemId: created.item.id }, ReviewItemSchema);
  const corrected = await invoke(f.client, f.scope, "correct", {
    operationId: randomUUID(), itemId: current.id, base: current.revision, feedbackId: feedback.event.id,
    correction: { kind: "replace", rating: 2, reviewedAt: feedback.event.reviewedAt }, reason: "第一次回忆有提示，实际应为困难。",
  }, ReviewMutationResultSchema);
  assert(corrected.event && corrected.event.kind === "correction");
  assert.deepEqual(corrected.event.recordedBy, feedback.event.recordedBy);
  const history = await invoke(f.client, f.scope, "history", { itemId: current.id }, ReviewHistoryResultSchema);
  assert.equal(history.events.length, 3);
  assert.deepEqual(history.events[0], feedback.event);
  const parameters = await invoke(f.client, f.scope, "parameters.get", {}, ParameterVersionSchema);
  const changed = await invoke(f.client, f.scope, "parameters.set", { operationId: randomUUID(), base: parameters.version, patch: { request_retention: 0.85 } }, SetReviewParametersResultSchema);
  assert.equal(changed.parameters.version, parameters.version + 1);
  assert.equal(changed.recomputedItems, 1);
  assert.deepEqual(await invoke(f.client, f.scope, "parameters.get", { version: parameters.version }, ParameterVersionSchema), parameters);
  const latest = await invoke(f.client, f.scope, "get", { itemId: current.id }, ReviewItemSchema);
  const scheduled = await invoke(f.client, f.scope, "schedule", { operationId: randomUUID(), itemId: latest.id, base: latest.revision, dueAt: Date.now() + 86400000 }, ReviewMutationResultSchema);
  const paused = await invoke(f.client, f.scope, "status", { operationId: randomUUID(), itemId: latest.id, base: scheduled.item.revision, paused: true }, ReviewMutationResultSchema);
  assert(paused.item.paused);
  assert.equal((await invoke(f.client, f.scope, "list", {}, ListReviewsResultSchema)).items.length, 0);
  assert.equal((await invoke(f.client, f.scope, "list", { paused: true }, ListReviewsResultSchema)).items.length, 1);
  assert.equal((await invoke(f.client, f.scope, "history", { itemId: current.id }, ReviewHistoryResultSchema)).events.length, 3);
  assert(f.client.hostKey);
  const restored = await f.connect(f.client.hostKey);
  const separate = await f.connect();
  const restoredItem = await invoke(restored, f.scope, "create", { operationId: randomUUID(), prompt: "潮流是什么？" }, ReviewMutationResultSchema);
  const restoredFeedback = await invoke(restored, f.scope, "feedback", { operationId: randomUUID(), itemId: restoredItem.item.id, base: restoredItem.item.revision, rating: 3 }, ReviewMutationResultSchema);
  assert(restoredFeedback.event);
  assert.deepEqual(restoredFeedback.event.recordedBy, feedback.event.recordedBy, "凭真实恢复凭据连接的同一宿主拥有相同录入来源");
  const separateFeedback = await invoke(separate, f.scope, "feedback", { operationId: randomUUID(), itemId: restoredItem.item.id, base: restoredFeedback.item.revision, rating: 3 }, ReviewMutationResultSchema);
  assert(separateFeedback.event && separateFeedback.event.recordedBy.kind === "client");
  assert.notDeepEqual(separateFeedback.event.recordedBy, feedback.event.recordedBy, "独立连接绑定自己的宿主，来源不是插件固定值");
});

test("复习失效通知携带真实调用来源并只投递本空间、其会话和全局订阅", async (t) => {
  const f = await fixture(t);
  await f.enable();
  const other = await f.client.call("space.open", { path: path.join(f.root, "other") });
  const all: CapabilityEvent[][] = [[], [], [], []];
  const scopes = [{}, { spaceId: f.space.id }, f.key, { spaceId: other.id }];
  const watches = await Promise.all(scopes.map((scope, index) => f.client.watch(scope, (_snapshot, delivery) => {
    if (delivery.type === "changes") for (const change of delivery.changes) {
      if (change.type === "capability") all[index]?.push(change.event);
    }
  })));
  t.after(async () => { for (const watch of watches) await watch.stop(); });
  const requestId = randomUUID();
  const input = { operationId: randomUUID(), prompt: "解释潮汐" };
  const created = await invoke(f.client, f.scope, "create", input, ReviewMutationResultSchema, requestId);
  await until(() => all.map(events => events.length), lengths => lengths[0] === 1 && lengths[1] === 1 && lengths[2] === 1);
  const event = all[0]?.[0];
  assert(event);
  assert.deepEqual(event.scope, f.scope);
  assert.equal(event.pluginId, "review");
  assert.equal(event.requestId, requestId);
  assert.equal(event.source.kind, "client");
  assert.deepEqual(event.format, { id: "repa.review.invalidated", version: "1" });
  assert.deepEqual(event.data, {});
  assert.deepEqual(all[1], [event]);
  assert.deepEqual(all[2], [event]);
  assert.deepEqual(all[3], []);
  const feedback = await invoke(f.client, f.scope, "feedback", { operationId: randomUUID(), itemId: created.item.id, base: created.item.revision, rating: 3 }, ReviewMutationResultSchema);
  assert(feedback.event);
  assert.deepEqual(feedback.event.recordedBy, event.source);
  await invoke(f.client, f.scope, "create", input, ReviewMutationResultSchema);
  // 通知用于重新读取，不要求与幂等业务记录形成另一个 exactly-once 账本。
  await until(() => all.map(events => events.length), lengths => lengths[0] === 3 && lengths[1] === 3 && lengths[2] === 3);
  assert.deepEqual(all[3], []);
});

test("真实Pi请求获得完整复习工具参数并按明确自评记录反馈、维护题目和读取历史", async (t) => {
  const f = await fixture(t);
  await f.enable();
  let itemId = "";
  let recordedBy: unknown;
  f.faux.setResponses([
    context => {
      const tools = getCurrentTools(context.messages);
      for (const name of ["review_create", "review_feedback", "review_history", "review_parameters_get"]) assert(tools.some(tool => tool.name === name));
      for (const name of ["review_create", "review_update", "review_feedback", "review_correct", "review_status", "review_schedule", "review_parameters_set"]) {
        const tool = tools.find(tool => tool.name === name);
        assert(tool && "properties" in tool.parameters && tool.parameters.properties && typeof tool.parameters.properties === "object");
        assert.equal("operationId" in tool.parameters.properties, false);
      }
      const create = tools.find(tool => tool.name === "review_create");
      assert(create);
      assert("properties" in create.parameters && create.parameters.properties && typeof create.parameters.properties === "object" && "prompt" in create.parameters.properties, "真实模型工具声明必须包含可用参数，不能用预设调用掩盖空 schema");
      assert.equal("operationId" in create.parameters.properties, false);
      const feedback = tools.find(tool => tool.name === "review_feedback");
      assert(feedback && "properties" in feedback.parameters && feedback.parameters.properties && typeof feedback.parameters.properties === "object");
      for (const field of ["itemId", "base", "rating"]) assert(field in feedback.parameters.properties);
      assert.equal("operationId" in feedback.parameters.properties, false);
      const update = tools.find(tool => tool.name === "review_update");
      assert(update && "properties" in update.parameters && update.parameters.properties && typeof update.parameters.properties === "object");
      for (const field of ["itemId", "base", "patch"]) assert(field in update.parameters.properties);
      assert.match(context.messages.map(message => textOf(message.content)).join("\n"), /自评良好/u);
      return fauxAssistantMessage(fauxToolCall("review_create", { prompt: "潮汐是什么？", answer: "海面周期性升降" }), { stopReason: "toolUse" });
    },
    context => {
      const created = toolResult(context, "review_create", ReviewMutationResultSchema);
      itemId = created.item.id;
      return fauxAssistantMessage(fauxToolCall("review_feedback", { itemId, base: created.item.revision, rating: 3, response: "海面周期性升降" }), { stopReason: "toolUse" });
    },
    context => {
      const feedback = toolResult(context, "review_feedback", ReviewMutationResultSchema);
      assert(feedback.event && feedback.event.kind === "feedback");
      assert.equal(feedback.event.rating, 3);
      recordedBy = feedback.event.recordedBy;
      return fauxAssistantMessage(fauxToolCall("review_update", { itemId, base: feedback.item.revision, patch: { prompt: "潮汐的定义是什么？", answer: null, sources: [] } }), { stopReason: "toolUse" });
    },
    context => {
      const updated = toolResult(context, "review_update", ReviewMutationResultSchema);
      assert.equal(updated.item.prompt, "潮汐的定义是什么？");
      assert.equal(updated.item.answer, undefined);
      assert.deepEqual(updated.item.sources, []);
      return fauxAssistantMessage(fauxToolCall("review_history", { itemId }), { stopReason: "toolUse" });
    },
    context => {
      const history = toolResult(context, "review_history", ReviewHistoryResultSchema);
      assert.equal(history.events.length, 1);
      assert.deepEqual(history.events[0]?.recordedBy, recordedBy);
      return fauxAssistantMessage("已按你的良好自评记录这次复习。");
    },
  ]);
  const accepted = await f.send("我刚回答了：潮汐是海面周期性升降，自评良好。请创建复习项并记录这次实际反馈，然后把题目改为‘潮汐的定义是什么？’，去掉参考答案和来源，检查历史。");
  assert.equal(f.faux.state.callCount, 5);
  assert.deepEqual(recordedBy, { kind: "agent", ...f.key, runId: accepted.runId, requestId: accepted.requestId });
  assert.equal((await invoke(f.client, f.scope, "history", { itemId }, ReviewHistoryResultSchema)).events.length, 1);
});

test("停用重启仍保留复习数据，轻量快照复制后重新启用副本可独立继续", async (t) => {
  const f = await fixture(t);
  await f.enable();
  const target = { kind: "file" as const, spaceId: f.space.id, location: { kind: "relative" as const, path: "tides.md" } };
  await f.client.call("content.write", { target, operationId: randomUUID(), base: { kind: "absent" }, value: { kind: "text", text: "潮汐是海面周期性升降。\n" } });
  const associated = await f.client.call("content.associate", { spaceId: f.space.id, location: target.location, role: "material", operationId: randomUUID() });
  const ref = associated.contents[0]?.ref;
  assert(ref);
  const content = await f.client.call("content.get", { target: { kind: "content", ref } });
  assert(content.bodyRevision);
  const created = await invoke(f.client, f.scope, "create", { operationId: randomUUID(), prompt: "潮汐是什么？", sources: [{ contentId: ref.id, revision: content.bodyRevision }] }, ReviewMutationResultSchema);
  const feedback = await invoke(f.client, f.scope, "feedback", { operationId: randomUUID(), itemId: created.item.id, base: created.item.revision, rating: 3 }, ReviewMutationResultSchema);
  const parameters = await invoke(f.client, f.scope, "parameters.get", {}, ParameterVersionSchema);
  const changed = await invoke(f.client, f.scope, "parameters.set", { operationId: randomUUID(), base: parameters.version, patch: { request_retention: 0.85 } }, SetReviewParametersResultSchema);
  const beforeUpdate = await invoke(f.client, f.scope, "get", { itemId: created.item.id }, ReviewItemSchema);
  const updated = await invoke(f.client, f.scope, "update", {
    operationId: randomUUID(), itemId: beforeUpdate.id, base: beforeUpdate.revision,
    patch: { prompt: "潮汐的定义是什么？", answer: "海面周期性升降" },
  }, ReviewMutationResultSchema);
  assert.deepEqual(updated.item.card, beforeUpdate.card);
  assert.deepEqual(updated.item.sources, beforeUpdate.sources);
  const original = updated.item;
  const history = await invoke(f.client, f.scope, "history", { itemId: created.item.id }, ReviewHistoryResultSchema);
  await set(f.client, f.scope, "disabled", ["repa-review", "review"]);
  await f.reopen();
  const disabled = await f.client.call("capability.describe", { scope: f.scope });
  assert(!disabled.capabilities.some(item => item.pluginId === "review"));
  assert(existsSync(f.database));
  const copied = await f.client.call("space.copy", { spaceId: f.space.id, operationId: randomUUID(), destination: path.join(f.root, "copy") });
  assert.equal(copied.status, "completed", copied.error?.message);
  const copy = await f.client.call("space.open", { path: copied.destination });
  const copyScope = { kind: "space" as const, spaceId: copy.id };
  assert.notEqual(copy.id, f.space.id);
  assert(!(await f.client.call("capability.describe", { scope: copyScope })).capabilities.some(item => item.pluginId === "review"));
  await set(f.client, copyScope, "disabled", ["repa-review"]);
  assert.deepEqual(await invoke(f.client, copyScope, "get", { itemId: original.id }, ReviewItemSchema), original);
  assert.deepEqual(await invoke(f.client, copyScope, "history", { itemId: original.id }, ReviewHistoryResultSchema), history);
  assert.deepEqual(await invoke(f.client, copyScope, "parameters.get", {}, ParameterVersionSchema), changed.parameters);
  assert.deepEqual(await invoke(f.client, copyScope, "parameters.get", { version: parameters.version }, ParameterVersionSchema), parameters);
  const source = original.sources[0];
  assert(source);
  assert.equal((await f.client.readText({ kind: "content", ref: { ...ref, spaceId: copy.id, id: source.contentId } })).text, "潮汐是海面周期性升降。\n");
  await invoke(f.client, copyScope, "status", { operationId: randomUUID(), itemId: original.id, base: original.revision, paused: true }, ReviewMutationResultSchema);
  await set(f.client, f.scope, "disabled", ["repa-review"]);
  assert.deepEqual(await invoke(f.client, f.scope, "get", { itemId: original.id }, ReviewItemSchema), original);
  assert.deepEqual(await invoke(f.client, f.scope, "history", { itemId: original.id }, ReviewHistoryResultSchema), history);
  assert(feedback.event);
});

test("公共参数优化使用持久反馈并保存后台结果，重开后显式采用候选才改变安排", async (t) => {
  try {
    await import("@open-spaced-repetition/binding");
  } catch {
    t.skip("当前安装未包含可选优化组件。");
    return;
  }
  const f = await fixture(t);
  await f.enable();
  const created = await invoke(f.client, f.scope, "create", {
    operationId: randomUUID(), prompt: "潮汐与潮流的区别？",
  }, ReviewMutationResultSchema);
  const first = await invoke(f.client, f.scope, "feedback", {
    operationId: randomUUID(), itemId: created.item.id, base: created.item.revision,
    rating: 3, reviewedAt: Date.parse("2026-01-01T23:59:00Z"),
  }, ReviewMutationResultSchema);
  const second = await invoke(f.client, f.scope, "feedback", {
    operationId: randomUUID(), itemId: first.item.id, base: first.item.revision,
    rating: 3, reviewedAt: Date.parse("2026-01-02T00:01:00Z"),
  }, ReviewMutationResultSchema);
  // 锁定优化器至少需要 8 个跨日候选样本；每项实际完成两次复习。
  for (let index = 1; index < 8; index++) {
    let { item } = await invoke(f.client, f.scope, "create", {
      operationId: randomUUID(), prompt: `潮汐复习题 ${index + 1}`,
    }, ReviewMutationResultSchema);
    for (const reviewedAt of [Date.parse("2026-01-01T23:59:00Z"), Date.parse("2026-01-02T00:01:00Z")]) {
      ({ item } = await invoke(f.client, f.scope, "feedback", {
        operationId: randomUUID(), itemId: item.id, base: item.revision, rating: 3, reviewedAt,
      }, ReviewMutationResultSchema));
    }
  }
  const parameters = await invoke(f.client, f.scope, "parameters.get", {}, ParameterVersionSchema);
  const request = { scope: f.scope, requestId: randomUUID(), contract: { id: "repa.review.parameters.optimize", version: "1" }, input: {} };
  const accepted = await f.client.call("capability.invoke", request);
  assert.equal(accepted.kind, "background");
  const finished = await until(() => f.client.call("request.get", { spaceId: f.space.id, requestId: request.requestId }),
    value => ["completed", "failed", "cancelled", "interrupted"].includes(value.status));
  assert.equal(finished.status, "completed", JSON.stringify(finished));
  assert("operation" in finished && finished.result?.value.kind === "inline");
  assert(Check(ReviewOptimizationResultSchema, finished.result.value.data));
  const result = finished.result.value.data;
  assert.equal(result.parameterVersion, parameters.version);
  assert.equal(result.feedbackCount, 16);
  assert.equal(result.trainingItems, 8);
  assert(result.status === "ready");
  assert.deepEqual(await invoke(f.client, f.scope, "get", { itemId: created.item.id }, ReviewItemSchema), second.item);
  assert.deepEqual(await invoke(f.client, f.scope, "parameters.get", {}, ParameterVersionSchema), parameters);
  await f.reopen();
  assert.deepEqual(await f.client.call("request.get", { spaceId: f.space.id, requestId: request.requestId }), finished);
  const replay = await f.client.call("capability.invoke", request);
  assert(replay.kind === "background");
  assert.deepEqual(replay.request, finished);
  const adopted = await invoke(f.client, f.scope, "parameters.set", {
    operationId: randomUUID(), base: result.parameterVersion, patch: { w: result.w },
  }, SetReviewParametersResultSchema);
  assert.equal(adopted.parameters.version, parameters.version + 1);
  assert.equal(adopted.recomputedItems, 8);
  const history = await invoke(f.client, f.scope, "history", { itemId: created.item.id }, ReviewHistoryResultSchema);
  assert.deepEqual(history.events, [first.event, second.event]);
});
