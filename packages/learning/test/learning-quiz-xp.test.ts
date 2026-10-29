import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { startServer } from "@repa/base";
import { RepaClient, RpcError } from "@repa/base/client";
import { createAgentRuntimeForTest } from "../../base/dist/agent/runtime.js";
import { ModelTestDriver } from "@repa/base/testing";
import { INTERACTION_CAPABILITIES, parse } from "@repa/base/protocol";
import { stringify } from "yaml";
import { connectLearning } from "../src/flow.js";
import { replayLearning, taskEvidence } from "../src/flow-state.js";
import { createLearningPlugin } from "../src/plugin.js";
import { learningMethods, type LearningInput, type LearningMethod, type LearningResult } from "../src/protocol.js";
import { updateProgress } from "../src/progress.js";
import type { Projection } from "../src/records-schema.js";
import type { LearningRecords } from "../src/records.js";
import type { Topic } from "../src/format/schema.js";
import type { ResolvedCourse } from "../src/course-sources.js";

const start = Date.UTC(2026, 9, 12, 12);
async function fixture(
  t: TestContext,
  openAnswer = false,
  count = 2,
  minutes = [60, 60, 25, 5, 31, 5],
  configure?: (topics: Topic[]) => void,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-quiz-xp-"));
  const directory = path.join(root, "course");
  await mkdir(path.join(directory, "topics"), { recursive: true });
  const topics: Topic[] = minutes.map((minutes, index) => {
    const id = `t${index}`;
    const question = (suffix: string) => ({
      id: `${id}.k1.${suffix}`,
      body: "1 + 1？",
      explanation: "两个一等于二。",
      slots: [{ id: "answer", type: "text" as const, key: "2" }],
    });
    return {
      id, title: id, minutes, status: "complete" as const, prerequisites: [], sources: [],
      kps: [{
        id: `${id}.k1`, title: "加法", lesson: "加法讲解", example: question("e1"),
        practice: [question("p1")], review: [question("r1")],
        quiz: Array.from({ length: count }, (_, number) => ({
          ...question(`q${number}`),
          ...(openAnswer ? { slots: [{ id: "answer", type: "text" as const, rubric: [{ id: "meaning", label: "含义正确" }] }] } : {}),
        })),
      }],
    };
  });
  configure?.(topics);
  const course = {
    id: "test", title: "测试", version: "1.0.0", language: "zh-CN", license: "Apache-2.0",
    runtime: { pyodide: "314.0.7", python: "3.14.2", packages: {} }, sources: {}, topics: topics.map((topic) => topic.id),
  };
  await writeFile(path.join(directory, "course.yaml"), stringify(course));
  for (const topic of topics) {
    await writeFile(path.join(directory, "topics", `${topic.id}.yaml`), stringify(topic, { aliasDuplicateObjects: false }));
  }
  let now = start;
  let records: LearningRecords | undefined;
  let resolved: ResolvedCourse | undefined;
  let failStart = false;
  const models = new ModelTestDriver();
  const plugin = createLearningPlugin({
    sources: [{ kind: "bundled", directory }], now: () => now,
    connect: async (log, loaded, host) => {
      records = log;
      resolved = loaded;
      return connectLearning(log, loaded, { ...host, models }, () => now, {
        beforeRestricted: async () => {
          if (failStart) {
            throw new Error("取消暂时失败");
          }
          await host.abortAgent("learning-tutor");
        },
      });
    },
  });
  let spaceRoot = path.join(root, "space");
  const agentDir = path.join(root, "home", "agent");
  await mkdir(agentDir, { recursive: true });
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"), modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false,
  });
  const runtime = await createAgentRuntimeForTest({ agentDir, modelRuntime });
  const server = await startServer({ home: path.join(root, "home"), runtime, plugins: [plugin], generalAgent: false });
  const connect = () => RepaClient.connect(server.connection, {
    capabilities: { interaction: { supports: [...INTERACTION_CAPABILITIES] }, services: [] },
  });
  let client = await connect();
  t.after(async () => {
    await client.close();
    await server.close();
    const evidence = process.env.REPA_LEARNING_EVIDENCE;
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      const saved = await mkdtemp(path.join(evidence, "quiz-final-"));
      await cp(spaceRoot, path.join(saved, "space"), { recursive: true });
      await cp(directory, path.join(saved, "course"), { recursive: true });
      await writeFile(path.join(saved, "case.txt"), t.name);
    }
    await rm(root, { recursive: true, force: true });
  });
  await client.call("space.create", { root: spaceRoot });
  async function call<M extends LearningMethod>(method: M, input: LearningInput<M>): Promise<LearningResult<M>> {
    const result = await client.call("plugin.call", { pluginId: "learning", method, input });
    return parse(learningMethods[method].result, result) as LearningResult<M>;
  }
  const state = () => call("state.get", {});
  async function select(kind: "lesson" | "review" | "quiz" | "retake", id?: string) {
    const current = await state();
    const candidate = current.menu?.candidates.find((entry) => entry.kind === kind && (!id || entry.topicIds.includes(id)));
    assert.ok(candidate, JSON.stringify(current.menu));
    assert.ok(current.menu);
    const input = { menuId: current.menu.menuId, candidateId: candidate.id };
    if (candidate.originalTaskId) {
      return call("quiz.retake", { ...input, originalTaskId: candidate.originalTaskId });
    }
    return call(kind === "quiz" ? "quiz.start" : "menu.select", input);
  }
  async function guard() {
    const current = await state();
    assert.ok(current.task);
    return { taskId: current.task.taskId, expectedRevision: current.revision, expectedStage: current.task.phase.stage };
  }
  async function input(index = -1, correct = true) {
    const task = (await state()).task;
    assert.ok(task);
    const delivery = task.deliveries.at(index);
    assert.ok(delivery);
    return {
      taskId: task.taskId, deliveryId: delivery.deliveryId, submissionId: delivery.submissionId,
      response: { item: { id: delivery.item.id, version: delivery.item.version }, answers: { answer: { type: "text" as const, text: correct ? "2" : "0" } } },
    };
  }
  const submit = async (index = -1, correct = true) => call("submission.submit", await input(index, correct));
  async function finishTask() {
    for (let step = 0; step < 20; step++) {
      const current = await state();
      if (current.task?.phase.stage === "completed") {
        return current;
      }
      if (current.task?.phase.stage === "awaiting_answer") {
        await submit();
      } else {
        await call("task.advance", await guard());
      }
    }
    throw new Error("任务未完成");
  }
  return {
    state, call, select, guard, input, submit, finishTask, models,
    qualify: async () => {
      for (const id of ["t0", "t1", "t2", "t3"]) {
        await select("lesson", id);
        await finishTask();
      }
    },
    answerRest: async () => {
      for (let index = 1; index < ((await state()).task?.deliveries.length ?? 0); index++) {
        await submit(index);
      }
    },
    time: (value: number) => { now = value; },
    failStart: (value: boolean) => { failStart = value; },
    log: () => {
      assert.ok(records);
      return records;
    },
    course: () => {
      assert.ok(resolved);
      return resolved;
    },
    disconnect: async () => {
      await client.close();
      client = await connect();
    },
    reopen: async (copy = false) => {
      await client.call("space.close", {});
      if (copy) {
        const target = path.join(root, "restored");
        await cp(spaceRoot, target, { recursive: true });
        spaceRoot = target;
        const evidence = process.env.REPA_LEARNING_EVIDENCE;
        if (evidence) {
          await mkdir(evidence, { recursive: true });
          await cp(target, await mkdtemp(path.join(evidence, "quiz-restored-")), { recursive: true });
        }
      }
      await client.call("space.open", { root: spaceRoot });
    },
  };
}

test("149／150 XP 触发一次测验，保留早期 topic；延后窗口允许当前课完成，门槛余量保留", async (t) => {
  const below = await fixture(t, false, 2, [60, 60, 29, 5, 31, 5]);
  for (const id of ["t0", "t1", "t2"]) {
    await below.select("lesson", id);
    await below.finishTask();
  }
  assert.equal((await below.state()).progress.totalXp, 149);
  assert.equal(below.log().current()?.xp?.pending, undefined);
  const f = await fixture(t);
  await f.qualify();
  const at150 = await f.state();
  assert.equal(at150.progress.totalXp, 150);
  assert.deepEqual(new Set(at150.menu?.candidates[0]?.topicIds), new Set(["t0", "t1", "t2", "t3"]));
  await f.select("lesson", "t4");
  await f.finishTask();
  assert.equal((await f.state()).progress.totalXp, 181);
  assert.deepEqual((await f.state()).menu?.candidates.map((entry) => entry.kind), ["quiz"]);
  await f.select("quiz");
  await f.submit(0);
  await f.answerRest();
  const guard = await f.guard();
  await f.call("quiz.finish", guard);
  const student = f.log().current()?.student;
  const rows = f.log().current()?.xp?.rewards.length;
  await f.call("quiz.finish", guard);
  assert.deepEqual(f.log().current()?.student, student);
  assert.equal(f.log().current()?.xp?.rewards.length, rows);
  assert.equal((await f.state()).progress.totalXp, 196);
  assert.equal(f.log().current()?.xp?.highWater, 181);
  assert.equal(f.log().current()?.xp?.consumed, 1);
  assert.equal((await f.state()).menu?.candidates.some((entry) => entry.kind === "retake"), false);
  await f.select("lesson", "t5");
  await f.finishTask();
  const sampled = f.log().current();
  assert.ok(sampled?.xp);
  sampled.xp.highWater = 300;
  updateProgress(sampled, taskEvidence(f.log().records), f.course(), start);
  assert.equal(sampled.xp.pending?.topicIds.length, 5);
  assert.ok(sampled.xp.pending?.topicIds.slice(0, 2).every((id) => ["t4", "t5"].includes(id)));
});

test("错题立即强制直接复习，成功后同 topics 换题重考；复制整个空间恢复测验与 XP", async (t) => {
  const f = await fixture(t);
  await f.qualify();
  const running = await f.select("quiz");
  assert.equal(running.restrictions.tutorAllowed, false);
  await assert.rejects(f.call("content.search", { query: "加法", offset: 0, limit: 10 }));
  const first = await f.input(0, false);
  await f.call("submission.submit", first);
  assert.equal((await f.state()).task?.submissions[0]?.feedback, undefined);
  const before = (await f.state()).task;
  await f.disconnect();
  assert.deepEqual((await f.state()).task, before);
  await f.reopen(true);
  assert.deepEqual((await f.state()).task, before);
  await f.call("submission.submit", first);
  await assert.rejects(f.call("submission.submit", { ...first, response: (await f.input(0)).response }));
  await f.answerRest();
  await f.call("quiz.finish", await f.guard());
  const failed = (await f.state()).task;
  const wrong = failed?.deliveries[0]?.topicId;
  assert.ok(wrong);
  const model = replayLearning(taskEvidence(f.log().records), f.course());
  assert.equal(model.forced.get(wrong), "review");
  assert.deepEqual((await f.state()).menu?.candidates.map((entry) => entry.kind), ["review"]);
  await f.select("review", wrong);
  await f.finishTask();
  assert.equal(replayLearning(taskEvidence(f.log().records), f.course()).forced.size, 0);
  const retake = await f.select("retake");
  assert.deepEqual(retake.task?.topicIds, failed?.topicIds);
  for (const delivery of retake.task?.deliveries ?? []) {
    const original = failed?.deliveries.find((entry) => entry.topicId === delivery.topicId);
    assert.ok(original);
    const digests = f.log().current()?.deliveries ?? {};
    assert.notEqual(f.log().snapshot(digests[delivery.deliveryId] ?? "")?.questionId,
      f.log().snapshot(digests[original.deliveryId] ?? "")?.questionId);
  }
  await f.submit(0);
  await f.answerRest();
  await f.call("quiz.finish", await f.guard());
  assert.equal((await f.state()).progress.totalXp, 181);
  assert.equal((await f.state()).task?.phase.stage, "completed");
  const restored = await f.state();
  await f.reopen();
  assert.deepEqual(await f.state(), restored);
});

test("准备失败沿受限入口重开，截止前接受的待判答案恢复后继续；截止点拒答且停机不暂停", async (t) => {
  const f = await fixture(t, true);
  await f.qualify();
  f.failStart(true);
  await assert.rejects(f.select("quiz"));
  assert.equal((await f.state()).task?.startedAt, null);
  await f.reopen();
  f.failStart(false);
  const running = await f.call("task.resume", await f.guard());
  const deadline = running.task?.deadlineAt;
  assert.ok(deadline);
  f.time(deadline - 1);
  f.models.expectStructured().fail(new Error("断线"));
  const accepted = await f.input(0);
  await f.call("submission.submit", accepted);
  const before = (await f.state()).task;
  f.time(deadline);
  await assert.rejects(f.submit(1));
  await f.reopen();
  assert.deepEqual((await f.state()).task?.deliveries, before?.deliveries);
  assert.equal((await f.state()).task?.deadlineAt, deadline);
  assert.equal((await f.state()).task?.submissions[0]?.acceptedAt, deadline - 1);
  f.models.expectStructured().succeed({ verdict: "correct", reason: "正确" });
  await f.call("submission.resume", { submissionId: accepted.submissionId });
  assert.deepEqual((await f.state()).task?.phase, { stage: "completed", outcome: "timeout" });
  assert.equal((await f.state()).progress.totalXp, 153);
  assert.equal(f.models.calls.length, 2);
  const student = f.log().current()?.student;
  f.time(deadline + 86_400_000);
  await f.reopen();
  assert.deepEqual(f.log().current()?.student, student);
  assert.equal((await f.state()).progress.totalXp, 153);
});

test("重判以差额保留原奖励与已现门槛；日目标持久化，ETA 含零学习日", async (t) => {
  const f = await fixture(t);
  await f.qualify();
  const current = f.log().current();
  assert.ok(current);
  const evidence = taskEvidence(f.log().records);
  const old = structuredClone<Projection>({
    state: current.state,
    student: current.student,
    deliveries: current.deliveries,
  });
  updateProgress(old, evidence, f.course(), start + 10 * 86_400_000, () => false);
  assert.equal(old.state.progress.todayXp, 0);
  assert.equal(old.state.progress.totalXp, 150);
  assert.ok(old.xp);
  const seed = old.xp.pending?.seed;
  assert.deepEqual(old.xp.pending?.topicIds, []);
  updateProgress(old, evidence, f.course(), start);
  assert.equal(old.xp.pending?.seed, seed);
  assert.equal(old.xp.pending?.topicIds.length, 4);
  const first = evidence[0]?.attempts[0];
  assert.ok(first?.grade);
  first.grade.feedback.verdict = "incorrect";
  updateProgress(current, evidence, f.course(), start);
  assert.equal(current.xp?.rewards.at(-1)?.xp, -60);
  assert.equal(current.xp?.highWater, 150);
  assert.ok(current.xp?.pending);
  const count = current.xp?.rewards.length;
  updateProgress(current, evidence, f.course(), start);
  assert.equal(current.xp?.rewards.length, count);
  const xp = current.xp;
  assert.ok(xp);
  xp.rewards.push(...[1, 2, 3].map((days) => ({ taskId: "daily", xp: 7, at: start - days * 86_400_000, ruleVersion: "repa-xp-v1" })));
  updateProgress(current, evidence, f.course(), start);
  assert.equal(current.state.progress.etaDays, (60 + 31 + 5) * 1.5 / 3);
  await f.call("progress.setGoal", { dailyGoalXp: 35 });
  await f.reopen();
  assert.equal((await f.call("progress.get", {})).progress.dailyGoalXp, 35);
  assert.ok((await readFile(f.log().file, "utf8")).includes("repa-xp-v1"));
});

for (const failingReview of [false, true]) {
  test(`单题库存补救${failingReview ? "失败转重教" : "成功但不能原题重考"}，停机过期查询只结算一次`, async (t) => {
    const f = await fixture(t, false, 1);
    await f.qualify();
    const running = await f.select("quiz");
    assert.ok(running.task?.deadlineAt);
    f.time(running.task.deadlineAt + 1);
    await f.reopen();
    assert.deepEqual((await f.state()).task?.phase, { stage: "completed", outcome: "timeout" });
    assert.equal((await f.state()).progress.totalXp, 150);
    const student = f.log().current()?.student;
    await f.reopen();
    assert.deepEqual(f.log().current()?.student, student);
    const wrong = running.task.topicIds[0];
    assert.ok(wrong);
    await f.select("review", wrong);
    if (failingReview) {
      for (let index = 0; index < 5; index++) {
        await f.submit(-1, false);
        if (index < 4) {
          await f.call("task.advance", await f.guard());
        }
      }
      assert.equal(replayLearning(taskEvidence(f.log().records), f.course()).forced.get(wrong), "lesson");
      return;
    }
    await f.finishTask();
    for (let index = 1; index < running.task.topicIds.length; index++) {
      await f.select("review", running.task.topicIds[index]);
      await f.finishTask();
    }
    await assert.rejects(f.select("retake"), (error: unknown) =>
      error instanceof RpcError && error.data !== null && typeof error.data === "object"
        && "code" in error.data && error.data.code === "insufficient_items",
    );
    assert.equal((await f.state()).task?.phase.stage, "preparing");
    assert.equal((await f.state()).task?.startedAt, null);
    await f.call("task.abort", await f.guard());
    assert.ok((await f.state()).menu?.candidates.some((entry) => entry.kind === "retake"));
  });
}

test("两份及时原答并发判分，交卷等待全部采用；申诉只追加测验奖励差额", async (t) => {
  const f = await fixture(t, true);
  await f.qualify();
  await f.select("quiz");
  const left = f.models.expectStructured();
  const right = f.models.expectStructured();
  try {
    const first = f.submit(0).catch(() => null);
    await left.requested;
    const second = f.submit(1).catch(() => null);
    await right.requested;
    const accepted = (await f.state()).task?.submissions;
    assert.ok(accepted?.[0] && accepted[1]);
    await f.disconnect();
    await assert.rejects(f.call("quiz.finish", await f.guard()));
    left.succeed({ verdict: "correct", reason: "正确" });
    await f.call("submission.resume", { submissionId: accepted[0].submissionId });
    await first;
    right.succeed({ verdict: "incorrect", reason: "错误" });
    const receipt = await f.call("submission.resume", { submissionId: accepted[1].submissionId });
    await second;
    await f.call("quiz.finish", await f.guard());
    assert.equal((await f.state()).progress.totalXp, 153);
    assert.equal(receipt.status, "recorded");
    if (receipt.status !== "recorded") {
      return;
    }
    f.models.expectStructured().succeed({ verdict: "correct", reason: "重判正确" });
    await f.call("submission.appeal", {
      submissionId: receipt.submission.submissionId, expectedGradeRevision: 1, reason: "复核",
    });
    assert.equal((await f.state()).progress.totalXp, 157);
    assert.deepEqual(f.log().current()?.xp?.rewards.filter((row) => row.taskId === receipt.submission.taskId)
      .map((row) => row.xp), [3, 4]);
  } finally {
    left.fail(new Error("测试结束"));
    right.fail(new Error("测试结束"));
  }
});


for (const missingPrerequisite of [false, true]) {
  test(`历史 lesson 重判失去已学状态后，测验补救转为可开始的 lesson${missingPrerequisite ? "并先补缺失先修" : ""}`, async (t) => {
    const f = await fixture(t, false, 2, undefined, (topics) => {
      for (const topic of topics.slice(0, missingPrerequisite ? 2 : 1)) {
        const question = topic.kps[0]?.practice?.[0];
        assert.ok(question);
        question.slots = [{ id: "answer", type: "text", rubric: [{ id: "meaning", label: "含义正确" }] }];
      }
      if (missingPrerequisite) {
        const dependent = topics[1];
        assert.ok(dependent);
        dependent.prerequisites = ["t0"];
        const prerequisite = topics[0]?.kps[0];
        assert.ok(prerequisite);
        prerequisite.quiz = [];
      }
    });
    const correctLesson = () => {
      f.models.expectStructured().succeed({ verdict: "correct", reason: "正确" });
      f.models.expectStructured().succeed({ verdict: "correct", reason: "正确" });
    };
    correctLesson();
    if (missingPrerequisite) {
      correctLesson();
    }
    await f.qualify();
    const originals = taskEvidence(f.log().records).filter((entry) =>
      entry.task.kind === "lesson" && ["t0", "t1"].includes(entry.task.topicIds[0] ?? ""),
    );
    const target = missingPrerequisite ? "t1" : "t0";
    const running = await f.select("quiz");
    for (const [index, delivery] of (running.task?.deliveries ?? []).entries()) {
      await f.submit(index, delivery.topicId !== target);
    }
    await f.call("quiz.finish", await f.guard());
    assert.equal(replayLearning(taskEvidence(f.log().records), f.course()).forced.get(target), "review");
    for (const id of missingPrerequisite ? ["t1", "t0"] : ["t0"]) {
      const submission = originals.find((entry) => entry.task.topicIds[0] === id)?.attempts[0]?.submission;
      assert.ok(submission);
      f.models.expectStructured().succeed({ verdict: "incorrect", reason: "重判错误" });
      await f.call("submission.appeal", {
        submissionId: submission.submissionId,
        expectedGradeRevision: 1,
        reason: "复核历史课内关键答案",
      });
    }
    const model = replayLearning(taskEvidence(f.log().records), f.course());
    assert.equal(model.student[target], undefined);
    assert.equal(model.forced.get(target), "lesson");
    assert.deepEqual((await f.state()).menu?.candidates.map((entry) => [entry.kind, entry.topicIds[0]]), [["lesson", "t0"]]);
    await f.reopen();
    await f.select("lesson", "t0");
    correctLesson();
    await f.finishTask();
    if (missingPrerequisite) {
      await f.select("lesson", "t1");
      correctLesson();
      await f.finishTask();
    }
    assert.equal(replayLearning(taskEvidence(f.log().records), f.course()).forced.size, 0);
    assert.ok(f.log().current()?.student[target]);
  });
}

for (const kind of ["review", "quiz", "retake"] as const) {
  for (const preparing of [true, false]) {
    test(`${kind} ${preparing ? "准备中" : "作答中"}，历史提交的查询、重试、恢复和申诉均隐藏反馈与题解`, async (t) => {
      const f = await fixture(t);
      await f.qualify();
      if (kind === "retake") {
        const quiz = await f.select("quiz");
        const wrong = quiz.task?.deliveries[0]?.topicId;
        assert.ok(wrong);
        await f.submit(0, false);
        await f.answerRest();
        await f.call("quiz.finish", await f.guard());
        await f.select("review", wrong);
        await f.finishTask();
      } else if (kind === "review") {
        f.time(start + 86_400_000);
      }
      const history = taskEvidence(f.log().records).map((entry) => entry.task.submissions[0]).filter(
        (entry) => entry !== undefined,
      );
      assert.ok(history.length);
      for (const submission of history) {
        const result = await f.call("submission.get", { submissionId: submission.submissionId });
        assert.equal(result.status, "found");
        if (result.status === "found") {
          assert.ok(result.submission.feedback);
          assert.ok(result.submission.explanation);
        }
      }
      f.failStart(preparing);
      if (preparing) {
        await assert.rejects(f.select(kind));
      } else {
        await f.select(kind);
      }
      assert.equal((await f.state()).restrictions.referenceContentAllowed, false);
      for (const original of history) {
        const queried = await f.call("submission.get", { submissionId: original.submissionId });
        assert.equal(queried.status, "found");
        if (queried.status !== "found") {
          assert.fail("历史提交必须仍可恢复身份和原答");
        }
        const retried = await f.call("submission.submit", {
          taskId: original.taskId,
          deliveryId: original.deliveryId,
          submissionId: original.submissionId,
          response: original.response,
        });
        const resumed = await f.call("submission.resume", { submissionId: original.submissionId });
        const appealed = await f.call("submission.appeal", {
          submissionId: original.submissionId,
          expectedGradeRevision: original.gradeRevision,
          reason: "受限任务中重判历史原答",
        });
        for (const receipt of [queried, retried, resumed, appealed]) {
          assert.ok(receipt.status === "found" || receipt.status === "recorded");
          assert.equal(receipt.submission.feedback, undefined);
          assert.equal(receipt.submission.explanation, undefined);
          assert.equal(receipt.submission.submissionId, original.submissionId);
          assert.deepEqual(receipt.submission.response, original.response);
          assert.equal(receipt.submission.processing.status, "completed");
        }
        assert.ok(f.log().submission(original.submissionId)?.feedback);
        assert.ok(f.log().submission(original.submissionId)?.explanation);
      }
      await f.reopen();
      const stillRestricted = await f.call("submission.get", { submissionId: history[0]?.submissionId ?? "" });
      assert.ok(stillRestricted.status === "found" && stillRestricted.submission.feedback === undefined);
      await f.call("task.abort", await f.guard());
      for (const original of history) {
        const visible = await f.call("submission.get", { submissionId: original.submissionId });
        assert.ok(visible.status === "found" && visible.submission.feedback && visible.submission.explanation);
      }
    });
  }
}

for (const legacyPreparation of [false, true]) {
  test(`测验准备失败并中止后保留耗尽的延后窗口与原候选${legacyPreparation ? "，兼容旧准备记录" : ""}`, async (t) => {
    const f = await fixture(t);
    await f.qualify();
    const pending = structuredClone(f.log().current()?.xp?.pending);
    assert.ok(pending);
    await f.select("lesson", "t4");
    await f.finishTask();
    assert.equal(f.log().current()?.xp?.highWater, 181);
    assert.deepEqual((await f.state()).menu?.candidates.map((entry) => entry.kind), ["quiz"]);
    f.failStart(true);
    await assert.rejects(f.select("quiz"));
    if (legacyPreparation) {
      await f.log().checkpoint(f.log().revision, (current, now) => {
        assert.ok(current?.xp);
        delete current.xp.pending;
        return {
          projection: current,
          decision: {
            policyVersion: "repa-flow-v2", now, seed: pending.seed,
            candidates: [], selected: pending.id, scores: {},
          },
        };
      });
    }
    await f.reopen();
    await f.call("task.abort", await f.guard());
    assert.deepEqual(f.log().current()?.xp?.pending, pending);
    assert.equal(f.log().current()?.xp?.consumed, 0);
    assert.deepEqual((await f.state()).menu?.candidates.map((entry) => entry.kind), ["quiz"]);
    await assert.rejects(f.select("quiz"));
    await f.call("task.abort", await f.guard());
    assert.deepEqual(f.log().current()?.xp?.pending, pending);
    f.failStart(false);
    const running = await f.select("quiz");
    assert.deepEqual(running.task?.topicIds, pending.topicIds);
    assert.equal(f.log().current()?.xp?.pending, undefined);
    assert.equal(f.log().current()?.xp?.consumed, 1);
  });
}

test("历史申诉判分在测验开始后返回，响应按返回时的受限任务隐藏参考内容", async (t) => {
  const f = await fixture(t, false, 2, undefined, (topics) => {
    const question = topics[0]?.kps[0]?.practice?.[0];
    assert.ok(question);
    question.slots = [{ id: "answer", type: "text", rubric: [{ id: "meaning", label: "含义正确" }] }];
  });
  for (let index = 0; index < 2; index++) {
    f.models.expectStructured().succeed({ verdict: "correct", reason: "正确" });
  }
  await f.qualify();
  const original = taskEvidence(f.log().records)[0]?.task.submissions[0];
  assert.ok(original);
  const pending = f.models.expectStructured();
  try {
    const work = f.call("submission.appeal", {
      submissionId: original.submissionId,
      expectedGradeRevision: 1,
      reason: "判分返回前切换任务",
    });
    await pending.requested;
    await f.select("quiz");
    pending.succeed({ verdict: "correct", reason: "正确" });
    const receipt = await work;
    assert.ok(receipt.status === "recorded");
    assert.equal(receipt.submission.feedback, undefined);
    assert.equal(receipt.submission.explanation, undefined);
    assert.ok(f.log().submission(original.submissionId)?.feedback);
  } finally {
    pending.fail(new Error("测试结束"));
  }
});
