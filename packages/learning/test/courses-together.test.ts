/**
 * 两门课并存：一份菜单、按人累计的测验与它的选课、全局的强制补救。甲（键 jia）、乙（键 yi）两门课的 topic 与题目编号完全相同（t01、t01.k1.q1……），
 * 题面不同，点开的候选出的是哪门课的题一看便知。不经底座，直接在一份学习记录上打开学习会话和教学方法。
 */
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { Host, PluginMethod } from "@repa/base/plugin";
import { INTERACTION_CAPABILITIES } from "@repa/base/protocol";
import { ModelTestDriver } from "@repa/base/testing";
import { scoped } from "../src/course-key.js";
import type { ResolvedCourse } from "../src/course-sources.js";
import { connectLearning } from "../src/flow.js";
import type { Question, Topic } from "../src/format/schema.js";
import { QUIZ_EVERY_XP } from "../src/parameters.js";
import type { LearningInput, LearningMethod, LearningResult, LearningState } from "../src/protocol.js";
import { LearningRecords } from "../src/records.js";
import type { PendingQuiz } from "../src/replay.js";
import { LearningSession } from "../src/session.js";
import { DAY_MS } from "../src/student-model.js";
import { course as baseCourse, referenceAnswer, start } from "./fixtures/learning-session.js";

const capabilities = { interaction: { supports: [...INTERACTION_CAPABILITIES] }, services: [] };

/** 一道填空题，标准答案是 2；题面带上课名，看得出出自哪门课。 */
function question(id: string, course: string): Question {
  return { id, body: `${course}：一加一？`, explanation: "二。", slots: [{ id: "answer", type: "text", key: "2" }] };
}

/** 一节 60 分钟的课（全对得 60 XP）：一个知识点，两道练习、三道复习；quiz 为真时另有一道测验题。 */
function unit(id: string, course: string, quiz = true, prerequisites: string[] = []): Topic {
  const kp = `${id}.k1`;
  return {
    id, title: `${course}${id}`, status: "complete", minutes: 60, prerequisites, sources: [],
    kps: [{
      id: kp, title: `${course}${kp}`, lesson: "讲解",
      example: question(`${kp}.e1`, course),
      practice: [question(`${kp}.q1`, course), question(`${kp}.q2`, course)],
      review: [question(`${kp}.r1`, course), question(`${kp}.r2`, course), question(`${kp}.r3`, course)],
      ...(quiz ? { quiz: [question(`${kp}.x1`, course)] } : {}),
    }],
  };
}

function resolved(id: string, topics: Topic[]): ResolvedCourse {
  return {
    course: { ...baseCourse, id, title: id, topics: topics.map((topic) => topic.id) },
    topics,
    origins: Object.fromEntries(topics.map((topic) => [topic.id, { source: id, basedOn: baseCourse.version }])),
  };
}

/** 两门课的会话：甲、乙的 topic 与题号相同。quiz 指明哪门课有测验题。时钟可拨。 */
async function fixture(t: TestContext, options: { quiz?: { 甲: boolean; 乙: boolean }; topics?: string[] } = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-courses-together-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const quiz = options.quiz ?? { 甲: true, 乙: true };
  const ids = options.topics ?? ["t01", "t02", "t03"];
  const courses = [
    { key: "jia", resolved: resolved("jia", ids.map((id) => unit(id, "甲", quiz.甲))) },
    { key: "yi", resolved: resolved("yi", ids.map((id) => unit(id, "乙", quiz.乙))) },
  ];
  let now = start;
  const records = await LearningRecords.open(path.join(directory, "records.jsonl"), () => now);
  const host = {
    now: () => now,
    models: new ModelTestDriver(),
    services: { call: async () => { throw new Error("没有前端服务"); } },
    emit: () => {},
  } as unknown as Host;
  const session = await LearningSession.open(records, courses, host);
  const { methods } = await connectLearning(session);
  t.after(() => session.retire());
  async function call<M extends LearningMethod>(name: M, input: LearningInput<M>): Promise<LearningResult<M>> {
    const method: PluginMethod | undefined = methods?.[name];
    if (!method) throw new Error(`缺少方法 ${name}`);
    return method.invoke(input, { caller: { capabilities } }) as Promise<LearningResult<M>>;
  }
  const state = () => call("state.get", {}) as Promise<LearningState>;
  /** 选菜单里这门课的这一项。 */
  async function select(course: string, kind: string, topic?: string) {
    const current = await state();
    const candidate = current.menu?.candidates.find((entry) => entry.course === course && entry.kind === kind && (topic === undefined || entry.topicIds[0] === topic));
    assert.ok(current.menu && candidate, `菜单里没有 ${course} 的 ${kind} ${topic ?? ""}：${JSON.stringify(current.menu?.candidates)}`);
    return call("menu.select", { menuId: current.menu.menuId, candidateId: candidate.id });
  }
  /** 做完当前任务，作答按参考答案；wrong 里的题答错。 */
  async function finish(wrong: (question: string) => boolean = () => false) {
    for (let step = 0; step < 40; step++) {
      const current = await state();
      const task = current.task;
      assert.ok(task);
      if (task.phase.stage === "completed") return current;
      const quiz = task.kind === "quiz" || task.kind === "retake";
      if (quiz && task.deliveries.length > 0 && task.deliveries.every((entry) => task.submissions.some((item) => item.deliveryId === entry.deliveryId))) {
        await call("quiz.finish", { taskId: task.taskId, expectedRevision: current.revision, expectedStage: task.phase.stage });
        continue;
      }
      if (task.phase.stage === "awaiting_answer") {
        const deliveryId = task.phase.deliveryId;
        const delivery = task.deliveries.find((entry) => entry.deliveryId === deliveryId);
        assert.ok(delivery);
        const questionId = session.replay.delivery(Number(delivery.deliveryId.slice(1)))?.questionId ?? "";
        const response = await referenceAnswer(session, delivery);
        await call("submission.submit", {
          taskId: task.taskId, deliveryId: delivery.deliveryId, submissionId: delivery.submissionId,
          response: wrong(questionId) ? { ...response, answers: { answer: { type: "text", text: "3" } } } : response,
        });
        continue;
      }
      await call("task.advance", { taskId: task.taskId, expectedRevision: current.revision, expectedStage: task.phase.stage });
    }
    throw new Error("任务没有做完");
  }
  return { session, records, call, state, select, finish, time: (value: number) => { now = value; }, now: () => now };
}

test("一份菜单：两门课各自的新课都在；点开的候选出的是那门课的题；今日 XP、累计 XP 是两门之和，进度按课分别算", async (t) => {
  const f = await fixture(t);
  const first = await f.state();
  // 菜单不被一门课占满：两门课的第一节新课都在。
  const shown = first.menu?.candidates.map((entry) => `${entry.course}:${entry.kind}:${entry.topicIds[0]}`) ?? [];
  assert.ok(shown.includes("jia:lesson:t01") && shown.includes("yi:lesson:t01"), shown.join("、"));
  await f.select("yi", "lesson", "t01");
  await f.call("task.advance", { taskId: (await f.state()).task?.taskId ?? "", expectedRevision: (await f.state()).revision, expectedStage: "explanation" });
  const example = await f.state();
  await f.call("task.advance", { taskId: example.task?.taskId ?? "", expectedRevision: example.revision, expectedStage: "example" });
  const asked = await f.state();
  assert.equal(asked.task?.course, "yi");
  // 题号与甲的一样（t01.k1.q1），题面是乙的。
  const delivered = asked.task?.deliveries[0];
  assert.ok(delivered);
  assert.equal(f.session.replay.delivery(Number(delivered.deliveryId.slice(1)))?.questionId, "t01.k1.q1");
  assert.match(JSON.stringify(delivered.item.body), /乙：一加一/u);
  await f.finish();
  await f.select("jia", "lesson", "t01");
  const done = await f.finish();
  assert.equal(done.progress.todayXp, 120);
  assert.equal(done.progress.totalXp, 120);
  assert.deepEqual(done.courses.map((entry) => [entry.key, entry.completedTopics, entry.totalTopics]), [["jia", 1, 3], ["yi", 1, 3]]);
  // 学生模型里两门课的 t01 是两个 topic。
  const student = f.session.replay.fold().student;
  assert.ok(student[scoped("jia", "t01")] && student[scoped("yi", "t01")]);
});

test(`两门课的非测验 XP 合计跨过 ${QUIZ_EVERY_XP} 触发测验：一场只从一门课出题，取本窗口 XP 增量最多的那门`, async (t) => {
  const f = await fixture(t);
  await f.select("jia", "lesson", "t01");
  await f.finish();
  await f.select("yi", "lesson", "t01");
  await f.finish();
  assert.equal(f.session.replay.pending, undefined, "120 XP 还不到门槛");
  await f.select("yi", "lesson", "t02");
  await f.finish();
  // 甲 60、乙 120：乙增量最多，题单出自乙。
  const pending = f.session.replay.pending as { course: string; topicIds: string[] } | undefined;
  assert.equal(pending?.course, "yi");
  assert.deepEqual(new Set(pending?.topicIds), new Set(["t01", "t02"]));
  const quiz = (await f.state()).menu?.candidates.find((entry) => entry.kind === "quiz");
  assert.equal(quiz?.course, "yi");
});

test("增量相同时取最近有作答的那门课；窗口从上一场确定题单时算起", async (t) => {
  const f = await fixture(t);
  await f.select("yi", "lesson", "t01");
  await f.finish();
  await f.select("jia", "lesson", "t01");
  await f.finish();
  await f.select("yi", "lesson", "t02");
  await f.finish();
  // 第一场：乙 120、甲 60，出自乙；题单确定时窗口重新起算。
  assert.equal(f.session.replay.pending?.course, "yi");
  await f.select("yi", "quiz");
  await f.finish();
  assert.equal(f.session.replay.pending, undefined);
  // 新窗口里乙、甲各 60（合计到 300 的第二道门槛），并列；乙先学、甲后学，最近有作答的是甲。
  await f.select("yi", "lesson", "t03");
  await f.finish();
  await f.select("jia", "lesson", "t02");
  await f.finish();
  const second = f.session.replay.pending as PendingQuiz | undefined;
  assert.equal(second?.n, 2);
  assert.equal(second?.course, "jia");
});

test("被选的课没有可考的题：在有可考内容的课里选，即使它的增量少", async (t) => {
  const f = await fixture(t, { quiz: { 甲: false, 乙: true } });
  await f.select("jia", "lesson", "t01");
  await f.finish();
  await f.select("jia", "lesson", "t02");
  await f.finish();
  await f.select("yi", "lesson", "t01");
  await f.finish();
  // 甲 120、乙 60，但甲没有测验题：题单出自乙。
  assert.equal(f.session.replay.pending?.course, "yi");
  assert.deepEqual(f.session.replay.pending?.topicIds, ["t01"]);
});

test("所有课都没有可考的题：保留门槛，不消费场次，也不挡别的学习任务", async (t) => {
  const f = await fixture(t, { quiz: { 甲: false, 乙: false } });
  for (const [course, topic] of [["jia", "t01"], ["yi", "t01"], ["jia", "t02"]] as const) {
    await f.select(course, "lesson", topic);
    await f.finish();
  }
  const pending = f.session.replay.pending;
  assert.ok(pending, "到了门槛");
  assert.deepEqual(pending.topicIds, []);
  assert.equal(f.session.replay.consumed, 0);
  const state = await f.state();
  assert.ok(!state.menu?.candidates.some((entry) => entry.kind === "quiz"));
  assert.ok(state.menu && state.menu.candidates.length > 0, "菜单照常给课");
});

test("延后与准备中中止不另起窗口：题单与它的课不变，重开也不重选", async (t) => {
  const f = await fixture(t);
  await f.select("jia", "lesson", "t01");
  await f.finish();
  await f.select("yi", "lesson", "t01");
  await f.finish();
  await f.select("jia", "lesson", "t02");
  await f.finish();
  const formed = structuredClone(f.session.replay.pending);
  assert.equal(formed?.course, "jia");
  // 延后：先学乙的一节，乙的增量此刻比甲大，题单照旧。
  await f.select("yi", "lesson", "t02");
  await f.finish();
  assert.deepEqual(f.session.replay.pending, formed);
  // 开始测验，在准备中中止：场次退回，题单照旧。
  await f.select("jia", "quiz");
  const preparing = await f.state();
  if (preparing.task?.phase.stage === "preparing") {
    await f.call("task.abort", { taskId: preparing.task.taskId, expectedRevision: preparing.revision, expectedStage: "preparing" });
    assert.equal(f.session.replay.pending?.course, "jia");
    assert.deepEqual(f.session.replay.pending?.topicIds, formed?.topicIds);
  }
  // 重开：从同一份学习记录重放出同样的题单。
  const reopened = await LearningSession.open(f.records, [...f.session.courses.values()].map(({ key, resolved: course }) => ({ key, resolved: course })), f.session.host);
  t.after(() => reopened.retire());
  assert.deepEqual(reopened.replay.pending?.course, f.session.replay.pending?.course);
  assert.deepEqual(reopened.replay.pending?.topicIds, f.session.replay.pending?.topicIds);
});

test("任何一门课的强制补救出现时，菜单只剩它：测验里乙的题答错，甲的新课也不给", async (t) => {
  const f = await fixture(t);
  await f.select("yi", "lesson", "t01");
  await f.finish();
  await f.select("yi", "lesson", "t02");
  await f.finish();
  await f.select("jia", "lesson", "t01");
  await f.finish();
  assert.equal(f.session.replay.pending?.course, "yi");
  await f.select("yi", "quiz");
  await f.finish((id) => id === "t01.k1.x1");
  const fold = f.session.replay.fold();
  assert.equal(fold.forced.get(scoped("yi", "t01")), "review");
  const state = await f.state();
  assert.deepEqual(state.menu?.candidates.map((entry) => `${entry.course}:${entry.kind}:${entry.topicIds[0]}`), ["yi:review:t01"]);
});

test("跨日补判：昨天的作答今天才判出，奖励记在今天，归那项任务所属的课", async (t) => {
  const f = await fixture(t);
  await f.select("yi", "lesson", "t01");
  const task = (await f.state()).task;
  assert.ok(task);
  // 不经教学方法，按事实直接写下：讲解、例题、两道题都答了而还没判。
  const seq = Number(task.taskId.slice(1));
  const seen = `sha256:${"0".repeat(64)}`;
  const facts = await f.records.write(() => [
    { type: "delivered", task: seq, question: "t01.k1.q1", seed: 1 },
    { type: "delivered", task: seq, question: "t01.k1.q2", seed: 2 },
  ]);
  const [first, second] = facts;
  assert.ok(first && second);
  await f.records.write(() => [
    { type: "answered", delivery: first.seq, seen, answers: { answer: { type: "text", text: "2" } } },
    { type: "answered", delivery: second.seq, seen, answers: { answer: { type: "text", text: "2" } } },
  ]);
  f.time(start + DAY_MS + 3_600_000);
  await f.records.write(() => [
    { type: "graded", delivery: first.seq, version: seen, verdict: "correct", slots: { answer: { verdict: "correct" } } },
    { type: "graded", delivery: second.seq, version: seen, verdict: "correct", slots: { answer: { verdict: "correct" } } },
  ]);
  const award = f.session.replay.awards.at(-1);
  assert.ok(award);
  assert.equal(award.at, f.now());
  assert.equal(f.session.replay.task(award.task)?.course, "yi");
  assert.equal((await f.state()).progress.todayXp, 60);
});
