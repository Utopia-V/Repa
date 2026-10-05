import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CapabilitySource } from "repa/plugin";
import { RepaFault } from "repa/protocol";
import { Check } from "typebox/value";
import { ReviewStore } from "../src/store.js";
import { createCard, defaultParameters, rebuild, schedule } from "../src/fsrs.js";
import { FeedbackEventSchema, type FeedbackEvent } from "../src/schema.js";

const start = Date.parse("2026-06-01T08:00:00Z");
const day = 86400000;
const actor: CapabilitySource = { kind: "client", hostId: "test-client" };
const agent: CapabilitySource = {
  kind: "agent", spaceId: "space", sessionId: "session", runId: "run", requestId: "request",
};

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-review-"));
  const file = path.join(directory, "review.sqlite");
  let now = start;
  const stores: ReviewStore[] = [];
  function open() {
    const store = new ReviewStore(file, () => now);
    stores.push(store);
    return store;
  }
  function close(store: ReviewStore) {
    store.close();
    stores.splice(stores.indexOf(store), 1);
  }
  t.after(async () => {
    for (const store of stores) store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { file, store: open(), open, close, time: (value: number) => { now = value; } };
}

function fault(code: string) {
  return (error: unknown) => error instanceof RepaFault && error.code === code;
}

function feedbackEvent(event: unknown): FeedbackEvent {
  assert(Check(FeedbackEventSchema, event));
  return event;
}

test("冷启动使用默认参数，跨天重开保留真实反馈和到期状态", async (t) => {
  const f = await fixture(t);
  const initial = f.store.parameters();
  assert.deepEqual(initial.parameters, defaultParameters());
  assert.equal(initial.version, 1);
  const item = f.store.create({ operationId: "create", prompt: "提示", answer: "解释", sources: [{ contentId: "source", revision: "v1" }] }, actor).item;
  assert.deepEqual(item.card, createCard(start));
  f.time(start + day);
  const input = { operationId: "feedback", itemId: item.id, base: item.revision, rating: 3 as const, response: "真实作答" };
  const result = f.store.feedback(input, agent);
  const expected = schedule(item.card, 3, start + day, initial.parameters);
  assert.deepEqual(result.item.card, expected.card);
  const event = feedbackEvent(result.event);
  assert.deepEqual(event.result, expected);
  assert.deepEqual(event.recordedBy, agent);
  assert.deepEqual(event.sources, item.sources);
  assert.equal(event.response, "真实作答");
  f.close(f.store);
  f.time(start + day * 2);
  const reopened = f.open();
  assert.deepEqual(reopened.get(item.id), result.item);
  assert.deepEqual(reopened.feedback(input, agent), result);
  assert.deepEqual(reopened.history({ itemId: item.id }).events, [event]);
  assert.equal(reopened.list({ dueBefore: result.item.dueAt - 1 }).items.length, 0);
  assert.equal(reopened.list({ dueBefore: result.item.dueAt }).items.length, 1);
});

test("相同操作重传返回原结果，竞争修订与复用操作标识不再次计入", async (t) => {
  const f = await fixture(t);
  const create = { operationId: "create", prompt: "提示" };
  const item = f.store.create(create, actor).item;
  assert.deepEqual(f.store.create({ prompt: "提示", operationId: "create" }, actor).item, item);
  const other = f.open();
  const input = { operationId: "first", itemId: item.id, base: 1, rating: 3 as const };
  const first = f.store.feedback(input, actor);
  assert.deepEqual(other.feedback(input, actor), first);
  assert.throws(() => other.feedback({ ...input, operationId: "second" }, actor), fault("review_conflict"));
  assert.throws(() => other.feedback({ ...input, rating: 1 }, actor), fault("review_operation_conflict"));
  assert.throws(() => other.setStatus({ operationId: "first", itemId: item.id, base: 2, paused: true }, actor), fault("review_operation_conflict"));
  assert.equal(f.store.history({ itemId: item.id }).events.length, 1);
  assert.equal(f.store.get(item.id).revision, 2);
});

test("更正追加事实，最后更正解释有效反馈且原事件和原 receipt 不改", async (t) => {
  const f = await fixture(t);
  const item = f.store.create({ operationId: "create", prompt: "提示" }, actor).item;
  const input = { operationId: "feedback", itemId: item.id, base: 1, rating: 1 as const, reviewedAt: start };
  const first = f.store.feedback(input, actor);
  const event = feedbackEvent(first.event);
  const manualDueAt = start + day * 30;
  const manual = f.store.setSchedule({ operationId: "schedule", itemId: item.id, base: 2, dueAt: manualDueAt }, actor);
  const correction = f.store.correct({ operationId: "correct", itemId: item.id, base: manual.item.revision, feedbackId: event.id,
    correction: { kind: "replace", rating: 4, reviewedAt: start + day }, reason: "评分录错" }, actor);
  assert.deepEqual(correction.item.card, rebuild(start, [{ rating: 4, review: start + day }], f.store.parameters().parameters).card);
  assert.equal(correction.recomputedReviews, 1);
  assert.equal(correction.item.dueAt, manualDueAt);
  const removed = f.store.correct({ operationId: "void", itemId: item.id, base: correction.item.revision, feedbackId: event.id,
    correction: { kind: "void" }, reason: "实际未复习" }, actor);
  assert.deepEqual(removed.item.card, createCard(start));
  assert.equal(removed.recomputedReviews, 0);
  const restored = f.store.correct({ operationId: "restore", itemId: item.id, base: removed.item.revision, feedbackId: event.id,
    correction: { kind: "replace", rating: 3, reviewedAt: start }, reason: "核对后确认已作答" }, actor);
  assert.equal(restored.recomputedReviews, 1);
  assert.deepEqual(f.store.feedback(input, actor), first);
  const history = f.store.history({ itemId: item.id, limit: 2 });
  assert.deepEqual(history.events[0], event);
  assert.equal(history.next, 2);
  assert.deepEqual(f.store.history({ itemId: item.id, after: history.next }).events.map((entry) => entry.kind), ["correction", "correction"]);
});

test("回填创建前的实际复习按发生时间重算，当次结果与当前估计分别保存", async (t) => {
  const f = await fixture(t);
  const item = f.store.create({ operationId: "create", prompt: "提示", sources: [{ contentId: "original" }] }, actor).item;
  f.time(start + day * 10);
  const first = f.store.feedback({ operationId: "first", itemId: item.id, base: 1, rating: 3, reviewedAt: start + day * 5 }, actor);
  const earlier = start - day * 5;
  const late = f.store.feedback({ operationId: "late", itemId: item.id, base: 2, rating: 4, reviewedAt: earlier,
    sources: [{ contentId: "late-source" }] }, agent);
  const parameters = f.store.parameters().parameters;
  assert.deepEqual(late.item.card, rebuild(earlier, [{ rating: 4, review: earlier }, { rating: 3, review: start + day * 5 }], parameters).card);
  const event = feedbackEvent(late.event);
  assert.deepEqual(event.result, schedule(createCard(earlier), 4, earlier, parameters));
  assert.equal(event.recordedAt, start + day * 10);
  assert.equal(event.reviewedAt, earlier);
  assert.deepEqual(event.sources, [{ contentId: "late-source" }]);
  assert.equal(late.item.createdAt, start);
  assert.deepEqual(f.store.history({ itemId: item.id }).events[0], first.event);
  const beforeCreation = f.store.create({ operationId: "create-older", prompt: "早已学过" }, actor).item;
  const older = f.store.feedback({ operationId: "older", itemId: beforeCreation.id, base: 1, rating: 2, reviewedAt: earlier }, actor);
  assert.deepEqual(older.item.card, schedule(createCard(earlier), 2, earlier, parameters).card);
});

test("暂停只筛选到期列表，人工到期可清除且下一次真实反馈回到算法安排", async (t) => {
  const f = await fixture(t);
  const item = f.store.create({ operationId: "create", prompt: "提示" }, actor).item;
  const scheduled = f.store.setSchedule({ operationId: "schedule", itemId: item.id, base: 1, dueAt: start + day * 30 }, actor);
  assert.deepEqual(scheduled.item.card, item.card);
  const paused = f.store.setStatus({ operationId: "pause", itemId: item.id, base: 2, paused: true }, actor);
  assert.equal(f.store.list({}).items.length, 0);
  assert.deepEqual(f.store.list({ paused: true }).items, [paused.item]);
  const cleared = f.store.setSchedule({ operationId: "clear", itemId: item.id, base: 3, dueAt: null }, actor);
  assert.equal(cleared.item.manualDueAt, undefined);
  assert.equal(cleared.item.dueAt, cleared.item.card.due);
  const manual = f.store.setSchedule({ operationId: "reschedule", itemId: item.id, base: 4, dueAt: start + day }, actor);
  const feedback = f.store.feedback({ operationId: "feedback", itemId: item.id, base: manual.item.revision, rating: 3 }, actor);
  assert.equal(feedback.item.manualDueAt, undefined);
  assert.equal(feedback.item.dueAt, feedback.item.card.due);
  assert.equal(feedback.item.paused, true);
  assert.equal(f.store.history({ itemId: item.id }).events.length, 1);
});

test("参数修改重建所有当前估计，保留旧版本、人工到期和原反馈结果", async (t) => {
  const f = await fixture(t);
  const item = f.store.create({ operationId: "create", prompt: "提示" }, actor).item;
  const empty = f.store.create({ operationId: "create-empty", prompt: "还没复习" }, actor).item;
  const original = f.store.feedback({ operationId: "feedback", itemId: item.id, base: 1, rating: 4 }, actor);
  const manualDueAt = start + day * 70;
  const manual = f.store.setSchedule({ operationId: "manual", itemId: item.id, base: 2, dueAt: manualDueAt }, actor);
  const previous = f.store.parameters();
  f.time(start + day);
  const input = { operationId: "parameters", base: 1, patch: { request_retention: 0.95, enable_fuzz: false } };
  const result = f.store.setParameters(input, actor);
  assert.equal(result.recomputedItems, 2);
  assert.equal(result.parameters.version, 2);
  const current = f.store.get(item.id);
  assert.equal(current.revision, manual.item.revision + 1);
  assert.equal(current.parameterVersion, 2);
  assert.equal(current.dueAt, manualDueAt);
  assert.deepEqual(current.card, rebuild(start, [{ rating: 4, review: start }], result.parameters.parameters).card);
  assert.equal(f.store.get(empty.id).revision, 2);
  assert.deepEqual(f.store.parameters(1), previous);
  assert.deepEqual(f.store.history({ itemId: item.id }).events, [original.event]);
  assert.deepEqual(f.store.setParameters(input, actor), result);
  assert.throws(() => f.store.setParameters({ ...input, operationId: "stale" }, actor), fault("review_conflict"));
});

test("到期列表按 dueAt 与 id 键集分页，不因相同到期时间漏项", async (t) => {
  const f = await fixture(t);
  const created = Array.from({ length: 53 }, (_, index) => f.store.create({ operationId: `create-${index}`, prompt: `提示 ${index}` }, actor).item);
  const first = f.store.list({});
  assert.equal(first.items.length, 50);
  assert(first.next);
  const second = f.store.list({ after: first.next });
  assert.equal(second.items.length, 3);
  assert.equal(second.next, undefined);
  assert.deepEqual([...first.items, ...second.items].map((item) => item.id), created.map((item) => item.id).sort());
});

test("事务中 receipt 保存失败回滚全部写入，重开后能重试同一操作", async (t) => {
  const f = await fixture(t);
  const item = f.store.create({ operationId: "create", prompt: "提示" }, actor).item;
  const database = new DatabaseSync(f.file);
  t.after(() => database.close());
  database.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON operation_receipts WHEN NEW.operation_id = 'feedback' BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
  const input = { operationId: "feedback", itemId: item.id, base: 1, rating: 3 as const };
  assert.throws(() => f.store.feedback(input, actor));
  assert.deepEqual(f.store.get(item.id), item);
  assert.deepEqual(f.store.history({ itemId: item.id }).events, []);
  database.exec("DROP TRIGGER fail_receipt");
  f.close(f.store);
  const reopened = f.open();
  const result = reopened.feedback(input, actor);
  assert.equal(result.item.revision, 2);
  assert.equal(reopened.history({ itemId: item.id }).events.length, 1);
});

test("不支持的数据库版本拒绝打开，不覆盖已有版本或内容", async (t) => {
  const f = await fixture(t);
  const item = f.store.create({ operationId: "create", prompt: "提示" }, actor).item;
  f.close(f.store);
  const database = new DatabaseSync(f.file);
  t.after(() => database.close());
  database.exec("PRAGMA user_version = 99");
  assert.throws(() => new ReviewStore(f.file), fault("review_schema_unsupported"));
  assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 99);
  assert.equal(database.prepare("SELECT id FROM items").get()?.id, item.id);
});

test("参数重算部分失败时版本与全部项目一起回滚，旧参数仍可继续使用", async (t) => {
  const f = await fixture(t);
  const first = f.store.create({ operationId: "first", prompt: "提示一" }, actor).item;
  const second = f.store.create({ operationId: "second", prompt: "提示二" }, actor).item;
  const initial = f.store.parameters();
  const database = new DatabaseSync(f.file);
  t.after(() => database.close());
  database.exec("CREATE TRIGGER fail_update BEFORE UPDATE ON items BEGIN SELECT RAISE(ABORT, 'test update failure'); END;");
  const input = { operationId: "parameters", base: 1, patch: { request_retention: 0.95 } };
  assert.throws(() => f.store.setParameters(input, actor));
  assert.deepEqual(f.store.parameters(), initial);
  assert.throws(() => f.store.parameters(2), fault("review_parameters_not_found"));
  assert.deepEqual(f.store.get(first.id), first);
  assert.deepEqual(f.store.get(second.id), second);
  database.exec("DROP TRIGGER fail_update");
  f.close(f.store);
  const reopened = f.open();
  assert.equal(reopened.setParameters(input, actor).recomputedItems, 2);
  assert.equal(reopened.get(first.id).parameterVersion, 2);
  assert.equal(reopened.get(second.id).parameterVersion, 2);
});

test("持久 JSON 损坏作为错误报告，不当作不存在或默认数据", async (t) => {
  const f = await fixture(t);
  const item = f.store.create({ operationId: "create", prompt: "提示" }, actor).item;
  const database = new DatabaseSync(f.file);
  t.after(() => database.close());
  database.prepare("UPDATE items SET data = ? WHERE id = ?").run("{ broken", item.id);
  assert.throws(() => f.store.get(item.id), fault("review_data_invalid"));
  assert.throws(() => f.store.list({}), fault("review_data_invalid"));
  database.prepare("UPDATE items SET data = ? WHERE id = ?").run(JSON.stringify({ ...item, unexpected: true }), item.id);
  assert.throws(() => f.store.get(item.id), fault("review_data_invalid"));
});

test("训练快照只读导出有效实际事实，保留暂停项并应用最后更正", async (t) => {
  const f = await fixture(t);
  const paused = f.store.create({ operationId: "create-paused", prompt: "私人提示", answer: "私人答案" }, actor).item;
  const empty = f.store.create({ operationId: "create-empty", prompt: "尚未复习" }, actor).item;
  const first = f.store.feedback({ operationId: "first", itemId: paused.id, base: 1, rating: 1, reviewedAt: start + day }, actor);
  const second = f.store.feedback({ operationId: "second", itemId: paused.id, base: 2, rating: 3, reviewedAt: start }, agent);
  const third = f.store.feedback({ operationId: "third", itemId: paused.id, base: 3, rating: 4, reviewedAt: start }, actor);
  const firstId = feedbackEvent(first.event).id;
  const secondId = feedbackEvent(second.event).id;
  f.store.correct({ operationId: "void-first", itemId: paused.id, base: 4, feedbackId: firstId,
    correction: { kind: "void" }, reason: "撤回错录" }, actor);
  f.store.correct({ operationId: "replace-second", itemId: paused.id, base: 5, feedbackId: secondId,
    correction: { kind: "replace", rating: 2, reviewedAt: start - day }, reason: "核对实际评分和日期" }, actor);
  f.store.correct({ operationId: "replace-second-again", itemId: paused.id, base: 6, feedbackId: secondId,
    correction: { kind: "replace", rating: 3, reviewedAt: start }, reason: "以最后核对结果为准" }, actor);
  f.store.setStatus({ operationId: "pause", itemId: paused.id, base: 7, paused: true }, actor);
  f.store.setParameters({ operationId: "parameters", base: 1, patch: { request_retention: 0.95 } }, actor);
  const beforeItem = f.store.get(paused.id);
  const beforeHistory = f.store.history({ itemId: paused.id });
  const snapshot = f.store.trainingSnapshot();
  assert.deepEqual(snapshot, {
    parameters: f.store.parameters(),
    items: [
      { id: paused.id, reviews: [{ rating: 3, review: start }, { rating: 4, review: start }] },
      { id: empty.id, reviews: [] },
    ].sort((a, b) => a.id.localeCompare(b.id)),
  });
  assert.equal(snapshot.parameters.version, 2);
  assert.deepEqual(f.store.get(paused.id), beforeItem);
  assert.deepEqual(f.store.history({ itemId: paused.id }), beforeHistory);
  assert.deepEqual(beforeHistory.events.slice(0, 3), [first.event, second.event, third.event]);
});

test("维护已有复习项保留记忆、历史和人工安排，重传与重开沿用修改结果", async (t) => {
  const f = await fixture(t);
  const created = f.store.create({ operationId: "create", prompt: "旧题目", answer: "旧答案", sources: [{ contentId: "source", revision: "v1" }] }, actor).item;
  const feedback = f.store.feedback({ operationId: "feedback", itemId: created.id, base: created.revision, rating: 3 }, actor);
  const event = feedbackEvent(feedback.event);
  const corrected = f.store.correct({ operationId: "correct", itemId: created.id, base: feedback.item.revision,
    feedbackId: event.id, correction: { kind: "replace", rating: 2, reviewedAt: start }, reason: "答对但费力" }, actor);
  const scheduled = f.store.setSchedule({ operationId: "schedule", itemId: created.id, base: corrected.item.revision, dueAt: start + day * 30 }, actor);
  const paused = f.store.setStatus({ operationId: "pause", itemId: created.id, base: scheduled.item.revision, paused: true }, actor).item;
  const history = f.store.history({ itemId: created.id });
  f.time(start + day);
  const input = { operationId: "update", itemId: created.id, base: paused.revision,
    patch: { prompt: "新题目", answer: "新答案", sources: [{ contentId: "source", revision: "v2" }] } };
  const updated = f.store.update(input, actor);
  assert.deepEqual(updated, { item: { ...paused, ...input.patch, revision: paused.revision + 1, updatedAt: start + day } });
  assert.deepEqual(f.store.history({ itemId: created.id }), history);
  assert.deepEqual(f.store.update(input, actor), updated);
  assert.throws(() => f.store.update({ ...input, operationId: "stale" }, actor), fault("review_conflict"));
  assert.throws(() => f.store.update({ ...input, patch: { prompt: "另一题" } }, actor), fault("review_operation_conflict"));
  const partial = f.store.update({ operationId: "partial", itemId: created.id, base: updated.item.revision, patch: { prompt: "更清楚的题目" } }, actor);
  assert.deepEqual(partial.item, { ...updated.item, prompt: "更清楚的题目", revision: updated.item.revision + 1 });
  const next = f.store.feedback({ operationId: "next-feedback", itemId: created.id, base: partial.item.revision, rating: 3 }, actor);
  assert.deepEqual(feedbackEvent(next.event).sources, input.patch.sources);
  assert.deepEqual(f.store.history({ itemId: created.id }).events.slice(0, 2), history.events);
  const cleared = f.store.update({ operationId: "clear", itemId: created.id, base: next.item.revision, patch: { answer: null, sources: [] } }, actor);
  const { answer: _answer, ...withoutAnswer } = next.item;
  assert.deepEqual(cleared.item, { ...withoutAnswer, sources: [], revision: next.item.revision + 1 });
  f.close(f.store);
  const reopened = f.open();
  assert.deepEqual(reopened.get(created.id), cleared.item);
  assert.deepEqual(reopened.update(input, actor), updated);
  assert.deepEqual(reopened.history({ itemId: created.id }).events, [...history.events, next.event]);
});
