import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import test, { type TestContext } from "node:test";
import { callLearning, startLearningServer, ContextViewSchema } from "@repa/learning";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  ReviewHistoryResultSchema, ReviewItemSchema, ReviewMutationResultSchema,
  ParameterVersionSchema, SubmitFeedbackInputSchema,
} from "@repa/review/protocol";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { RepaClient, RpcError } from "repa";
import { ContentInfoSchema, ResourceRefSchema } from "../src/content/schema.js";
import { methods, type CapabilityScope } from "../src/protocol.js";

// 原始快照由 ca8345e64 的独立 npm 安装经公开 API 创建，不由新版存储器伪造旧格式。
// Pi 使用本地 faux provider；包含真实工具历史、SQLite 反馈/更正/参数和历史去重回执。
const FixtureSchema = Type.Object({
  sourceCommit: Type.String(),
  entries: Type.Array(Type.Object({ path: Type.String(), mode: Type.Integer(), bytes: Type.Optional(Type.String()) })),
  expected: Type.Object({
    spaceId: Type.String(), key: Type.Object({ spaceId: Type.String(), sessionId: Type.String() }),
    requestId: Type.String(), editId: Type.String(), text: Type.String(),
    note: ContentInfoSchema, material: ContentInfoSchema, resource: ResourceRefSchema,
    feedbackInput: SubmitFeedbackInputSchema, feedback: ReviewMutationResultSchema,
    review: ReviewItemSchema, history: ReviewHistoryResultSchema, parameters: ParameterVersionSchema,
    sessionHistory: methods["session.history"].result,
    context: ContextViewSchema,
  }),
});

const code = (expected: string) => (error: unknown) =>
  error instanceof RpcError && typeof error.data === "object" && error.data !== null &&
  "code" in error.data && error.data.code === expected;

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-upgrade-"));
  const source = path.join(root, "backup");
  const agentDir = path.join(root, "agent");
  const closers: Array<() => Promise<void>> = [];
  t.after(async () => {
    try { await Promise.all(closers.map(close => close())); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  const raw: unknown = JSON.parse(gunzipSync(await readFile(new URL("./fixtures/upgrade-ca8345e64.json.gz", import.meta.url))).toString("utf8"));
  assert(Check(FixtureSchema, raw));
  assert.match(raw.sourceCommit, /^ca8345e64/);
  await mkdir(source);
  for (const entry of raw.entries) {
    assert(!path.isAbsolute(entry.path) && !entry.path.split("/").includes(".."));
    const target = path.join(source, entry.path);
    if (entry.bytes === undefined) await mkdir(target, { recursive: true });
    else await writeFile(target, Buffer.from(entry.bytes, "hex"));
    await chmod(target, entry.mode);
  }
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"],
    retry: { enabled: false }, compaction: { enabled: false },
  }));
  const faux = fauxProvider({ api: "upgrade-test", provider: "upgrade-test", tokensPerSecond: 0,
    models: [{ id: "test", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 2048 }] });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const start = async () => {
    const server = await startLearningServer({ agentDir, appDirectory: path.join(root, "app"),
      modelOverride: { modelRuntime, model: faux.getModel() } });
    let client: RepaClient | undefined;
    const close = async () => {
      await server.close("cancel");
      await client?.close();
    };
    closers.push(close);
    client = await RepaClient.connect(server.connection);
    return { client, close };
  };
  const restore = async (client: RepaClient, name: string, backup = source) => {
    const result = await client.call("space.restore", { source: backup, destination: path.join(root, name), operationId: randomUUID() });
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert(result.participants.some(owner => owner.id === "repa-review" && owner.version === "1"));
    return result.destination;
  };
  return { root, source, expected: raw.expected, faux, start, restore };
}

async function invoke(client: RepaClient, scope: CapabilityScope, name: string, input: unknown) {
  const result = await client.call("capability.invoke", { scope, requestId: randomUUID(),
    contract: { id: `repa.review.${name}`, version: "1" }, input });
  assert(result.kind === "inline");
  return result.result;
}

async function assertHistory(client: RepaClient, expected: Awaited<ReturnType<typeof fixture>>["expected"]) {
  const scope = { kind: "space" as const, spaceId: expected.spaceId };
  assert.equal((await client.readText(expected.note.target)).text, expected.text);
  assert.deepEqual(await invoke(client, scope, "get", { itemId: expected.review.id }), expected.review);
  assert.deepEqual(await invoke(client, scope, "history", { itemId: expected.review.id }), expected.history);
  assert.deepEqual(await invoke(client, scope, "parameters.get", {}), expected.parameters);
  assert.deepEqual(await invoke(client, scope, "feedback", expected.feedbackInput), expected.feedback);
  assert.deepEqual(await invoke(client, scope, "history", { itemId: expected.review.id }), expected.history);
  assert.equal(await (await client.resource(expected.resource)).text(), "旧版练习附件\n");
  assert.equal((await callLearning(client, "context.preview", { spaceId: expected.spaceId })).text, expected.context.text);
  assert.deepEqual((await client.call("session.history", expected.key)).messages, expected.sessionHistory.messages);
  const request = await client.call("request.get", { spaceId: expected.spaceId, requestId: expected.requestId });
  assert.equal(request.status, "completed");
}

test("历史构建的快照升级后保留学习事实与回执，并接续旧会话、内容和复习数据库", async (t) => {
  const f = await fixture(t);
  const first = await f.start();
  const directory = await f.restore(first.client, "space");
  const space = await first.client.call("space.open", { path: directory });
  assert.equal(space.id, f.expected.spaceId);
  await assertHistory(first.client, f.expected);
  f.faux.setResponses([context => {
    assert(JSON.stringify(context.messages).includes("需要提示"));
    assert(JSON.stringify(context.messages).includes("learning.md"));
    return fauxAssistantMessage("接续原有对话和学习语境。");
  }]);
  const accepted = await first.client.call("session.submit", { target: f.expected.key, requestId: randomUUID(),
    input: { parts: [{ kind: "text", text: "继续上次的练习。" }] }, dispatch: { kind: "start" } });
  assert(accepted.runId);
  const deadline = Date.now() + 15_000;
  for (;;) {
    const run = await first.client.call("run.get", { spaceId: space.id, runId: accepted.runId });
    if (["completed", "failed", "cancelled", "interrupted"].includes(run.status)) {
      assert.equal(run.status, "completed", JSON.stringify(run));
      break;
    }
    assert(Date.now() < deadline, JSON.stringify(run));
    await delay(10);
  }
  const scope = { kind: "space" as const, spaceId: space.id };
  const feedback = await invoke(first.client, scope, "feedback", { operationId: randomUUID(),
    itemId: f.expected.review.id, base: f.expected.review.revision, rating: 4, response: "独立区分水位升降和水的运动。" });
  assert(Check(ReviewMutationResultSchema, feedback));
  assert.equal(feedback.item.card.reps, f.expected.review.card.reps + 1);
  await first.client.call("operation.undo", { spaceId: space.id, operationId: f.expected.editId, undoOperationId: randomUUID() });
  const revertedText = f.expected.text.replace("实际作答：水位升降与水的流动；需要提示。", "等待作答。");
  assert.equal((await first.client.readText(f.expected.note.target)).text, revertedText);
  const result = await first.client.call("content.applyPatch", { spaceId: space.id, operationId: randomUUID(),
    patch: "*** Begin Patch\n*** Add File: url-material.md\n+新版来源材料。\n*** End Patch",
    registrations: [{ path: "url-material.md", role: "material", origin: { kind: "url", url: "https://example.com/tides" } }] });
  const material = result.contents[0];
  assert(material?.origin?.kind === "url");
  const history = await first.client.call("session.history", f.expected.key);
  assert.deepEqual(history.messages.slice(0, f.expected.sessionHistory.messages.length), f.expected.sessionHistory.messages);
  assert(history.messages.some(message => message.role === "user" && JSON.stringify(message).includes("继续上次的练习。")));
  assert(history.messages.some(message => message.role === "assistant" && JSON.stringify(message).includes("接续原有对话和学习语境。")));
  await first.close();
  const second = await f.start();
  await second.client.call("space.open", { path: directory });
  assert.deepEqual(await invoke(second.client, scope, "get", { itemId: feedback.item.id }), feedback.item);
  assert.deepEqual((await second.client.call("session.history", f.expected.key)).messages, history.messages);
  assert.equal((await second.client.readText(f.expected.note.target)).text, revertedText);
  assert.deepEqual((await second.client.call("content.get", { target: material.target })).origin, material.origin);
});

test("历史插件数据库为未知版本或已损坏时拒绝调用，失败后从旧快照恢复并继续使用", async (t) => {
  const f = await fixture(t);
  const first = await f.start();
  const directory = await f.restore(first.client, "damaged");
  const databaseFile = path.join(directory, ".repa/plugins/repa-review/reviews.sqlite");
  const database = new DatabaseSync(databaseFile);
  try { database.exec("PRAGMA user_version = 99"); } finally { database.close(); }
  const bytes = await readFile(databaseFile);
  const space = await first.client.call("space.open", { path: directory });
  const scope = { kind: "space" as const, spaceId: space.id };
  await assert.rejects(invoke(first.client, scope, "get", { itemId: f.expected.review.id }), code("review_schema_unsupported"));
  assert.deepEqual(await readFile(databaseFile), bytes);
  assert.equal((await first.client.readText(f.expected.note.target)).text, f.expected.text);
  await first.close();
  // 只改隔离副本；保留原快照，损坏的数据库不能被初始化成空库。
  await writeFile(databaseFile, "损坏的数据库\n");
  const second = await f.start();
  await second.client.call("space.open", { path: directory });
  await assert.rejects(invoke(second.client, scope, "get", { itemId: f.expected.review.id }));
  assert.equal(await readFile(databaseFile, "utf8"), "损坏的数据库\n");
  await second.close();
  const recovered = await f.start();
  const restored = await f.restore(recovered.client, "restored");
  await recovered.client.call("space.open", { path: restored });
  await assertHistory(recovered.client, f.expected);
  const feedback = await invoke(recovered.client, scope, "feedback", { operationId: randomUUID(),
    itemId: f.expected.review.id, base: f.expected.review.revision, rating: 3 });
  assert(Check(ReviewMutationResultSchema, feedback));
  assert.equal(feedback.item.revision, f.expected.review.revision + 1);
});

test("旧快照校验失败不发布目标，修复来源后以新操作恢复，失败回执不被重写为成功", async (t) => {
  const f = await fixture(t);
  const { client } = await f.start();
  const damaged = path.join(f.root, "bad-backup");
  await cp(f.source, damaged, { recursive: true });
  await writeFile(path.join(damaged, "data/learning.md"), "意外改动\n");
  const input = { source: damaged, destination: path.join(f.root, "result"), operationId: randomUUID() };
  const failed = await client.call("space.restore", input);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error?.code, "invalid_snapshot");
  await assert.rejects(readFile(path.join(input.destination, "learning.md")), { code: "ENOENT" });
  await cp(path.join(f.source, "data/learning.md"), path.join(damaged, "data/learning.md"));
  assert.deepEqual(await client.call("space.restore", input), failed);
  const restored = await client.call("space.restore", { ...input, operationId: randomUUID() });
  assert.equal(restored.status, "completed", JSON.stringify(restored));
  await client.call("space.open", { path: restored.destination });
  await assertHistory(client, f.expected);
});
