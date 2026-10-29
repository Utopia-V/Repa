import assert from "node:assert/strict";
import test from "node:test";

import { build } from "esbuild";
import { Value } from "typebox/value";
import { canRender, parse } from "@repa/base/protocol";
import {
  ContentPageSchema, LearningEventSchema, LearningStateSchema, SubmissionReceiptSchema,
  learningMethods, missingDeliveryCapabilities,
  readLearningError, readLearningEvent, readLearningResult,
} from "../src/protocol.js";
import { sameValue } from "../src/check/values.js";
import { accepted, delivery, lesson, now, page, recoveryTrace } from "./fixtures/learning-contract.js";

const capabilities = { interaction: { supports: ["block.markdown", "slot.code"] }, services: ["python.run"] };

test("同一提交的待判与重连夹具保留身份和原答，画面可以独立读取", () => {
  const trace = recoveryTrace();
  for (const state of trace) {
    assert.ok(Value.Check(LearningStateSchema, state));
    assert.deepEqual(readLearningResult("state.get", state), { ok: true, value: state });
  }
  const submissions = trace.slice(1, 5).flatMap((state) => state.task?.submissions ?? []);
  assert.deepEqual(submissions.map((entry) => entry.submissionId), Array(4).fill(accepted.submissionId));
  assert.ok(submissions.every((entry) => sameValue(entry.response, accepted.response)));
  assert.deepEqual(submissions.map((entry) => entry.processing.status), ["pending", "interrupted", "completed", "completed"]);
  for (const entry of [accepted, ...submissions]) {
    const receipt = { status: "recorded", submission: entry };
    assert.ok(Value.Check(SubmissionReceiptSchema, receipt));
    assert.deepEqual(readLearningResult("submission.submit", receipt), { ok: true, value: receipt });
  }
  const absent = { status: "absent", submissionId: accepted.submissionId, revision: 1 };
  assert.deepEqual(readLearningResult("submission.get", absent), { ok: true, value: absent });
  const found = { status: "found", submission: accepted, revision: 2 };
  assert.deepEqual(readLearningResult("submission.get", found), { ok: true, value: found });
  assert.equal(Value.Check(learningMethods["submission.resume"].input, { submissionId: accepted.submissionId }), true);
  const rejected = { status: "rejected", submissionId: accepted.submissionId, processing: { status: "not_accepted" }, problems: [{ message: "缺少作答" }] };
  assert.deepEqual(readLearningResult("submission.submit", rejected), { ok: true, value: rejected });
});

test("推进契约要求阶段与 revision，陈旧菜单和其他故障可携底座错误细节", () => {
  const state = lesson();
  const advance = { taskId: accepted.taskId, expectedStage: "feedback", expectedRevision: state.revision };
  assert.deepEqual(parse(learningMethods["task.advance"].input, advance), advance);
  assert.equal(Value.Check(learningMethods["task.advance"].input, { ...advance, expectedRevision: "1" }), false);
  assert.equal(Value.Check(learningMethods["menu.select"].input, { menuId: "menu-2", candidateId: "candidate-quiz" }), true);
  for (const details of [
    { reason: "invalid_structure", problems: [{ slot: "s1", message: "缺少作答" }] },
    { reason: "stale", state }, { reason: "payload_conflict", submissionId: accepted.submissionId },
    { reason: "missing_capability", taskId: accepted.taskId, missing: ["python.run"] },
    { reason: "restricted", taskId: "quiz-1", stage: "preparing" },
    { reason: "service_failure", service: "python.run", retryable: true },
  ]) assert.deepEqual(readLearningError({ ...details, future: true }), { ok: true, value: details });
  assert.equal(readLearningError({ reason: "stale", state: { ...state, revision: "1" } }).ok, false);
});

test("严格发送拒绝私有字段，作答前与受限测验恢复数据均不含参考答案", () => {
  const trace = recoveryTrace();
  for (const state of [trace[0], trace[1], trace[2], trace[5], trace[6]]) {
    const text = JSON.stringify(state);
    for (const key of ["solution", "explanation", "rubric", "key", "expected", "internalIdMap", "feedback"]) {
      assert.equal(text.includes(`"${key}":`), false, key);
    }
  }
  const state = lesson();
  assert.equal(Value.Check(LearningStateSchema, { ...state, future: true }), false);
  assert.equal(Value.Check(LearningStateSchema, { ...state, revision: "1" }), false);
  const privateItem = { ...delivery.item, solution: "不要外发" };
  assert.equal(Value.Check(LearningStateSchema, { ...state, task: { ...state.task, deliveries: [{ ...delivery, item: privateItem }] } }), false);
  const quiz = trace[6];
  assert.ok(quiz?.task);
  assert.deepEqual(quiz.restrictions, { kind: "quiz", tutorAllowed: false, referenceContentAllowed: false });
  assert.equal(quiz.task.deadlineAt, now + 910_000);
  assert.equal(quiz.task.submissions.length, 1);
  assert.ok(trace.at(-1)?.task?.submissions[0]?.feedback);
  const dontKnow = { ...accepted.response, dontKnow: true, answers: {} };
  assert.ok(Value.Check(learningMethods["submission.submit"].input, { ...accepted, response: dontKnow }) === false);
  assert.ok(Value.Check(learningMethods["submission.submit"].input, {
    taskId: accepted.taskId, deliveryId: delivery.deliveryId, submissionId: accepted.submissionId, response: dontKnow,
  }));
});

test("宽松读取保留可用字段，错误类型或未知阶段读取失败，未知题型留下缺能力标记", () => {
  const state = lesson();
  assert.deepEqual(readLearningResult("state.get", { ...state, future: true }), { ok: true, value: state });
  assert.deepEqual(readLearningResult("state.get", { ...state, revision: "1" }), { ok: false, path: "/revision" });
  assert.equal(readLearningResult("state.get", { ...state, task: { ...state.task, phase: { stage: "future" } } }).ok, false);
  const newItem = { ...delivery.item, requires: [], slots: [...delivery.item.slots, { id: "new", type: "drawing" }] };
  const read = readLearningResult("state.get", { ...state, task: { ...state.task, deliveries: [{ ...delivery, item: newItem }] } });
  assert.ok(read.ok && read.value.task);
  const restored = read.value.task.deliveries[0];
  assert.ok(restored);
  assert.ok(restored.item.requires.includes("slot.drawing"));
  assert.equal(canRender(capabilities.interaction, restored.item), false);
  assert.deepEqual(missingDeliveryCapabilities(capabilities, restored), ["slot.drawing"]);
  const skipped = { ...delivery, deliveryId: "future-delivery", mode: "future" };
  const remaining = readLearningResult("state.get", { ...state, task: { ...state.task, deliveries: [skipped, delivery] } });
  assert.ok(remaining.ok && remaining.value.task);
  assert.deepEqual(remaining.value.task.deliveries, [delivery]);
  const event = { type: "learning.changed", revision: 3, taskId: accepted.taskId, menuId: null, submissionId: accepted.submissionId };
  assert.ok(Value.Check(LearningEventSchema, event));
  assert.deepEqual(readLearningEvent({ ...event, future: true }), { ok: true, value: event });
  assert.equal(Value.Check(LearningEventSchema, { ...event, feedback: {} }), false);
  assert.equal(readLearningEvent({ ...event, revision: "3" }).ok, false);
});

test("代码题同时检查渲染与 python.run，参考内容带版本、块范围和原学习位置", () => {
  assert.deepEqual(missingDeliveryCapabilities(capabilities, delivery), []);
  assert.deepEqual(missingDeliveryCapabilities({ ...capabilities, services: [] }, { ...delivery, requiresServices: [] }), ["python.run"]);
  assert.deepEqual(missingDeliveryCapabilities(undefined, delivery), ["block.markdown", "python.run", "slot.code"]);
  assert.ok(Value.Check(ContentPageSchema, page));
  assert.deepEqual(readLearningResult("content.read", [page]), { ok: true, value: [page] });
  assert.ok(Value.Check(learningMethods["content.read"].input, { refs: [page.ref], offset: 0, limit: 1 }));
  assert.equal(Value.Check(learningMethods["content.read"].input, { refs: Array(9).fill(page.ref), offset: 0, limit: 1 }), false);
  assert.deepEqual(readLearningResult("content.open", { openedAt: now }), { ok: true, value: { openedAt: now } });
  assert.equal(page.origin.taskId, accepted.taskId);
  const ended = recoveryTrace().at(-1);
  assert.ok(ended?.restrictions.referenceContentAllowed);
  const search = { hits: [{ ref: page.ref, title: "列表推导式", snippet: "逐个计算", origin: page.origin }], nextOffset: null };
  assert.deepEqual(readLearningResult("content.search", search), { ok: true, value: search });
});

test("讲解、例题、中止和 review 使用同一任务画面，隔离模型的来源不代替证据资格", () => {
  const state = lesson();
  for (const phase of [{ stage: "explanation", page }, { stage: "example", page }, { stage: "aborted", reason: "主动结束" }]) {
    assert.ok(Value.Check(LearningStateSchema, { ...state, task: { ...state.task, phase } }));
  }
  const feedback = { item: accepted.response.item, verdict: "correct", judge: "model", evidence: { status: "eligible" } };
  const receipt = { status: "recorded", submission: { ...accepted, processing: { status: "completed" }, feedback } };
  assert.deepEqual(readLearningResult("submission.submit", receipt), { ok: true, value: receipt });
  const review = { ...state, task: { ...state.task, kind: "review", deliveries: [{ ...delivery, mode: "review" }] } };
  assert.ok(Value.Check(LearningStateSchema, review));
});

test("公开协议独立构建成浏览器 ESM，只加载 TypeBox 与底座协议且不带 Node 内建模块", async () => {
  const result = await build({ entryPoints: ["src/protocol.ts"], bundle: true, platform: "browser", format: "esm", write: false, metafile: true });
  assert.ok(result.outputFiles[0]?.text.includes("readLearningResult"));
  assert.ok(Object.keys(result.metafile.inputs).every((file) => !file.includes("/pi-") && !file.endsWith("/client.ts")));
  assert.equal(Object.values(result.metafile.outputs).flatMap((output) => output.imports).length, 0);
});
