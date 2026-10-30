import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { startServer } from "@repa/base";
import { RepaClient, RpcError } from "@repa/base/client";
import type { Plugin } from "@repa/base/plugin";
import { createAgentRuntimeForTest } from "../../base/dist/agent/runtime.js";
import { ModelTestDriver } from "@repa/base/testing";
import { INTERACTION_CAPABILITIES, parse } from "@repa/base/protocol";
import { stringify } from "yaml";
import { connectLearning } from "../src/flow.js";
import { createLearningPlugin } from "../src/plugin.js";
import { progressView, sampleTopics } from "../src/progress.js";
import { learningMethods, type LearningInput, type LearningMethod, type LearningResult } from "../src/protocol.js";
import type { Replay } from "../src/replay.js";
import type { LearningSession } from "../src/session.js";
import type { Topic } from "../src/format/schema.js";

const start = Date.UTC(2026, 9, 12, 12);
async function fixture(
  t: TestContext,
  openAnswer = false,
  count = 2,
  minutes = [60, 60, 25, 5, 31, 5],
  configure?: (topics: Topic[]) => void,
) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-quiz-xp-")));
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
  let session: LearningSession | undefined;
  let failStart = false;
  const models = new ModelTestDriver();
  const learning = createLearningPlugin({
    sources: [{ kind: "bundled", directory }], now: () => now,
    connect: async (opened, host) => {
      session = opened;
      return connectLearning(opened, {
        beforeRestricted: async () => {
          if (failStart) {
            throw new Error("取消暂时失败");
          }
          await host.abortAgent("learning-tutor");
        },
      });
    },
  });
  // 判分的模型边界换成离线替身；其余宿主能力照用真实的。
  const plugin: Plugin = { ...learning, open: (host) => learning.open({ ...host, models }) };
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
  const learningSession = () => {
    assert.ok(session);
    return session;
  };
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
    session: learningSession,
    replay: () => learningSession().replay,
    fold: async () => {
      await learningSession().view();
      return learningSession().replay.fold();
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
  assert.equal(below.replay().pending, undefined);
  const f = await fixture(t);
  await f.qualify();
  const at150 = await f.state();
  assert.equal(at150.progress.totalXp, 150);
  assert.deepEqual(new Set(at150.menu?.candidates[0]?.topicIds), new Set(["t0", "t1", "t2", "t3"]));
  // 代价关卡：测验出现时扫描一遍历史选题，之后读取和作答都不再扫描。
  assert.equal(f.replay().samplings, 1);
  await f.select("lesson", "t4");
  await f.finishTask();
  assert.equal((await f.state()).progress.totalXp, 181);
  assert.equal(f.replay().samplings, 1);
  assert.deepEqual((await f.state()).menu?.candidates.map((entry) => entry.kind), ["quiz"]);
  await f.select("quiz");
  await f.submit(0);
  await f.answerRest();
  const guard = await f.guard();
  await f.call("quiz.finish", guard);
  const fold = await f.fold();
  const rows = f.replay().awards.length;
  await f.call("quiz.finish", guard);
  assert.deepEqual(await f.fold(), fold);
  assert.equal(f.replay().awards.length, rows);
  assert.equal((await f.state()).progress.totalXp, 196);
  assert.equal(f.replay().trigger, 181);
  assert.equal(f.replay().consumed, 1);
  assert.equal((await f.state()).menu?.candidates.some((entry) => entry.kind === "retake"), false);
  await f.select("lesson", "t5");
  await f.finishTask();
  const topics = sampleTopics(f.replay().tasks, await f.fold(), f.session().course, 2);
  assert.equal(topics.length, 5);
  assert.ok(topics.slice(0, 2).every((id) => ["t4", "t5"].includes(id)));
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
  assert.equal((await f.fold()).forced.get(wrong), "review");
  assert.deepEqual((await f.state()).menu?.candidates.map((entry) => entry.kind), ["review"]);
  await f.select("review", wrong);
  await f.finishTask();
  assert.equal((await f.fold()).forced.size, 0);
  const retake = await f.select("retake");
  assert.deepEqual(retake.task?.topicIds, failed?.topicIds);
  const question = (id: string) => f.replay().delivery(Number(id.slice(1)))?.questionId;
  for (const delivery of retake.task?.deliveries ?? []) {
    const original = failed?.deliveries.find((entry) => entry.topicId === delivery.topicId);
    assert.ok(original);
    assert.notEqual(question(delivery.deliveryId), question(original.deliveryId));
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

test("准备失败沿受限入口重开；截止前收下的开放题作答没判出结果时测验照样按时结束，重开补判后结果与 XP 随之更新", async (t) => {
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
  assert.deepEqual((await f.state()).task?.phase, { stage: "completed", outcome: "timeout" });
  assert.equal((await f.state()).progress.totalXp, 150);
  f.models.expectStructured().succeed({ verdict: "correct", reason: "正确" });
  await f.reopen();
  assert.deepEqual((await f.state()).task?.deliveries, before?.deliveries);
  assert.equal((await f.state()).task?.deadlineAt, deadline);
  assert.equal((await f.state()).task?.submissions[0]?.acceptedAt, deadline - 1);
  await f.session().idle();
  assert.deepEqual((await f.state()).task?.phase, { stage: "completed", outcome: "timeout" });
  assert.equal((await f.state()).progress.totalXp, 153);
  assert.equal(f.models.calls.length, 2);
  const fold = await f.fold();
  f.time(deadline + 86_400_000);
  await f.reopen();
  assert.deepEqual((await f.fold()).student, fold.student);
  assert.equal((await f.state()).progress.totalXp, 153);
});

test("重判使课失去已学状态时 XP 不收回、已出现的测验门槛保留；日目标持久化，ETA 含零学习日", async (t) => {
  const f = await fixture(t, false, 2, undefined, (topics) => {
    const question = topics[0]?.kps[0]?.practice?.[0];
    assert.ok(question);
    question.slots = [{ id: "answer", type: "text", rubric: [{ id: "meaning", label: "含义正确" }] }];
  });
  f.models.expectStructured().succeed({ verdict: "correct", reason: "正确" });
  f.models.expectStructured().succeed({ verdict: "correct", reason: "正确" });
  await f.qualify();
  assert.equal((await f.state()).progress.totalXp, 150);
  const pending = structuredClone(f.replay().pending);
  assert.ok(pending);
  const lesson = f.replay().tasks.find((task) => task.topicIds[0] === "t0");
  const delivery = lesson?.answered[0];
  assert.ok(delivery);
  f.models.expectStructured().succeed({ verdict: "incorrect", reason: "复核不符" });
  await f.call("submission.appeal", { submissionId: `s${delivery.seq}`, expectedGradeRevision: 1, reason: "复核" });
  assert.equal((await f.fold()).student.t0, undefined);
  assert.equal((await f.state()).progress.totalXp, 150);
  assert.deepEqual(f.replay().pending, pending);
  await f.call("progress.setGoal", { dailyGoalXp: 35 });
  await f.reopen();
  assert.equal((await f.call("progress.get", {})).progress.dailyGoalXp, 35);
  assert.equal((await f.state()).progress.totalXp, 150);
  assert.ok((await readFile(path.join(f.session().records.file), "utf8")).includes('"type":"goal","xp":35'));
  // 近七个自然日里三天各得 7 XP：平均 3 XP，剩余 t0、t4、t5 三节课。
  const awards = [1, 2, 3].map((days) => ({ task: 1, xp: 7, at: start - days * 86_400_000, quiz: false }));
  const replay = { awards, total: 21, goal: undefined } as unknown as Replay;
  const progress = progressView(replay, await f.fold(), f.session().course, start, "UTC");
  assert.equal(progress.etaDays, (60 + 31 + 5) * 1.5 / 3);
  assert.equal(progressView({ awards: awards.slice(0, 2), total: 14, goal: undefined } as unknown as Replay, await f.fold(), f.session().course, start, "UTC").etaDays, null);
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
    const student = (await f.fold()).student;
    await f.reopen();
    assert.deepEqual((await f.fold()).student, student);
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
      assert.equal((await f.fold()).forced.get(wrong), "lesson");
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

test("两题还在判分、两题没答时交卷：没答的算失败并强制复习，待判的不算对错；判分回来后结论与 XP 随之更新，申诉只追加奖励差额", async (t) => {
  const f = await fixture(t, true);
  await f.qualify();
  const learned = (await f.fold()).student;
  await f.select("quiz");
  const topics = (await f.state()).task?.deliveries.map((delivery) => delivery.topicId) ?? [];
  const [leftTopic, rightTopic, ...unanswered] = topics;
  assert.ok(leftTopic && rightTopic && unanswered.length === 2);
  const forced = (ids: string[]) => ids.map((id) => [id, "review"]).sort();
  const left = f.models.expectStructured();
  const right = f.models.expectStructured();
  try {
    const first = f.submit(0).catch(() => null);
    await left.requested;
    const second = f.submit(1).catch(() => null);
    await right.requested;
    const accepted = (await f.state()).task?.submissions;
    assert.ok(accepted?.[0] && accepted[1]);
    assert.ok(accepted.every((entry) => entry.processing.status === "pending"));
    await f.disconnect();
    // 交卷不等判分。没答的两题是失败的证据：测验失败，这两个 topic 强制复习。
    // 还在判分的两题尚无证据，不算对也不算错：学生模型里这两个 topic 不变，也不强制复习。
    await f.call("quiz.finish", await f.guard());
    assert.deepEqual((await f.state()).task?.phase, { stage: "completed", outcome: "failed" });
    assert.equal((await f.state()).progress.totalXp, 150);
    const ended = await f.fold();
    assert.deepEqual([...ended.forced].sort(), forced(unanswered));
    assert.deepEqual(ended.student[leftTopic], learned[leftTopic]);
    assert.deepEqual(ended.student[rightTopic], learned[rightTopic]);
    left.succeed({ verdict: "correct", reason: "正确" });
    right.succeed({ verdict: "incorrect", reason: "错误" });
    await first;
    await second;
    await f.session().idle();
    // 判分回来：答对的记一次通过，答错的也强制复习。
    const graded = await f.fold();
    assert.deepEqual([...graded.forced].sort(), forced([...unanswered, rightTopic]));
    assert.notDeepEqual(graded.student[leftTopic], learned[leftTopic]);
    assert.equal((await f.state()).progress.totalXp, 153);
    const receipt = await f.call("submission.get", { submissionId: accepted[1].submissionId });
    assert.ok(receipt.status === "found");
    f.models.expectStructured().succeed({ verdict: "correct", reason: "重判正确" });
    await f.call("submission.appeal", {
      submissionId: receipt.submission.submissionId, expectedGradeRevision: 1, reason: "复核",
    });
    assert.equal((await f.state()).progress.totalXp, 157);
    assert.deepEqual([...(await f.fold()).forced].sort(), forced(unanswered));
    const quiz = Number(receipt.submission.taskId.slice(1));
    assert.deepEqual(f.replay().awards.filter((award) => award.task === quiz).map((award) => award.xp), [3, 4]);
  } finally {
    left.fail(new Error("测试结束"));
    right.fail(new Error("测试结束"));
  }
});

test("各题都答了而判分全部中断时交卷：测验结束但不下结论，学生模型不变、不强制补救、菜单照常提供；补判以后才得出结论", async (t) => {
  const f = await fixture(t, true);
  await f.qualify();
  const learned = (await f.fold()).student;
  const running = await f.select("quiz");
  const topics = running.task?.deliveries.map((delivery) => delivery.topicId) ?? [];
  assert.equal(topics.length, 4);
  for (const index of topics.keys()) {
    f.models.expectStructured().fail(new Error("断网"));
    const receipt = await f.submit(index);
    assert.ok(receipt.status === "recorded");
    assert.deepEqual(receipt.submission.processing, { status: "interrupted", reason: "service_failure" });
  }
  await f.call("quiz.finish", await f.guard());
  const ended = await f.state();
  assert.deepEqual(ended.task?.phase, { stage: "completed", outcome: "unresolved" });
  assert.equal(ended.restrictions.kind, "none");
  assert.ok(ended.menu?.candidates.length);
  assert.equal(ended.progress.totalXp, 150);
  assert.deepEqual((await f.fold()).student, learned);
  assert.equal((await f.fold()).forced.size, 0);
  // 重开后第一次调用自动补判。四题都对，测验通过，每个 topic 记一次通过，XP 补发 15。
  for (let index = 0; index < topics.length; index++) {
    f.models.expectStructured().succeed({ verdict: "correct", reason: "正确" });
  }
  await f.reopen();
  await f.state();
  await f.session().idle();
  const graded = await f.state();
  assert.deepEqual(graded.task?.phase, { stage: "completed", outcome: "passed" });
  assert.equal(graded.progress.totalXp, 165);
  const student = (await f.fold()).student;
  for (const id of topics) {
    assert.notDeepEqual(student[id], learned[id]);
  }
  assert.equal((await f.fold()).forced.size, 0);
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
    const originals = f.replay().tasks.filter((task) => task.kind === "lesson" && ["t0", "t1"].includes(task.topicIds[0] ?? ""));
    const target = missingPrerequisite ? "t1" : "t0";
    const running = await f.select("quiz");
    for (const [index, delivery] of (running.task?.deliveries ?? []).entries()) {
      await f.submit(index, delivery.topicId !== target);
    }
    await f.call("quiz.finish", await f.guard());
    assert.equal((await f.fold()).forced.get(target), "review");
    for (const id of missingPrerequisite ? ["t1", "t0"] : ["t0"]) {
      const delivery = originals.find((task) => task.topicIds[0] === id)?.answered[0];
      assert.ok(delivery);
      f.models.expectStructured().succeed({ verdict: "incorrect", reason: "重判错误" });
      await f.call("submission.appeal", { submissionId: `s${delivery.seq}`, expectedGradeRevision: 1, reason: "复核历史课内关键答案" });
    }
    const fold = await f.fold();
    assert.equal(fold.student[target], undefined);
    assert.equal(fold.forced.get(target), "lesson");
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
    assert.equal((await f.fold()).forced.size, 0);
    assert.ok((await f.fold()).student[target]);
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
      const history = [];
      for (const task of f.replay().tasks) {
        const delivery = task.answered[0];
        if (delivery) history.push(await f.session().submission(delivery));
      }
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
        const delivery = f.replay().delivery(Number(original.deliveryId.slice(1)));
        assert.ok(delivery);
        const internal = await f.session().submission(delivery);
        assert.ok(internal.feedback && internal.explanation);
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

test("测验准备失败并中止后保留耗尽的延后窗口与原候选", async (t) => {
  const f = await fixture(t);
  await f.qualify();
  const pending = structuredClone(f.replay().pending);
  assert.ok(pending);
  await f.select("lesson", "t4");
  await f.finishTask();
  assert.equal(f.replay().trigger, 181);
  assert.deepEqual((await f.state()).menu?.candidates.map((entry) => entry.kind), ["quiz"]);
  f.failStart(true);
  await assert.rejects(f.select("quiz"));
  await f.reopen();
  await f.call("task.abort", await f.guard());
  assert.deepEqual(f.replay().pending, pending);
  assert.equal(f.replay().consumed, 0);
  assert.deepEqual((await f.state()).menu?.candidates.map((entry) => entry.kind), ["quiz"]);
  await assert.rejects(f.select("quiz"));
  await f.call("task.abort", await f.guard());
  assert.deepEqual(f.replay().pending, pending);
  f.failStart(false);
  const running = await f.select("quiz");
  assert.deepEqual(running.task?.topicIds, pending.topicIds);
  assert.equal(f.replay().pending, undefined);
  assert.equal(f.replay().consumed, 1);
});

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
  const delivery = f.replay().tasks[0]?.answered[0];
  assert.ok(delivery);
  const pending = f.models.expectStructured();
  try {
    const work = f.call("submission.appeal", {
      submissionId: `s${delivery.seq}`,
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
    assert.ok((await f.session().submission(delivery)).feedback);
  } finally {
    pending.fail(new Error("测试结束"));
  }
});
