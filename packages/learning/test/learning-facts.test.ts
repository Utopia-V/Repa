/**
 * 学习记录只记事实：答案或运行前导改正后的重判、没有证据时不阻塞也不下结论、从事实重算状态、归属改变不换版本，
 * 以及每次作答写入的字节数和重算次数这两道代价关卡。
 */
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { Services } from "@repa/base/plugin";
import { parse } from "@repa/base/protocol";
import { DEFAULT_MODEL_CONFIG, isDue, type ModelConfig } from "@repa/learning-model";
import { describeRuntime, SandboxRunner } from "@repa/python-runner";
import { PYTHON_BATCH, PythonBatchInputSchema } from "@repa/python-runner/protocol";
import { Value } from "typebox/value";
import { CodeSlotSchema, IdSchema, KpIdSchema, QuestionIdSchema, TopicIdSchema, type Topic } from "../src/format/schema.js";
import { FactSchema, GradedSlotSchema, type Fact } from "../src/records-schema.js";
import { Replay } from "../src/replay.js";
import { DAY_MS } from "../src/student-model.js";
import { RUNTIME, runtimeUnavailable } from "./demo-course.js";
import { skipUnavailableEnvironment } from "./environment.js";
import { course, learningFixture as fixture, start, topic } from "./fixtures/learning-session.js";

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** 用指定文字作答当前这道文字题。 */
async function answer(f: Fixture, text: string) {
  const input = await f.input();
  return f.call("submission.submit", { ...input, response: { item: input.response.item, answers: { answer: { type: "text", text } } } });
}

/** 某项任务里各份作答的最新判分。 */
function verdicts(f: Fixture, taskId: string) {
  const task = f.session().replay.task(Number(taskId.slice(1)));
  assert.ok(task);
  return task.answered.map((delivery) => delivery.grades.at(-1)?.verdict);
}

const graded = (f: Fixture) => f.session().records.facts.filter((fact) => fact.type === "graded");

/** 课程格式允许的最长 id：topic id 32 字符，它下面的知识点 id 可到 40 字符、题目 id 可到 48 字符；作答位 id 120 字符。 */
const LONG_TOPIC = "long".padEnd(32, "0");
const LONG_QUESTION = `${LONG_TOPIC}.k100000.q100000`;
const LONG_SLOT = "a".repeat(120);
/** 按测试判的作答位最多有多少个测试。 */
const MAX_TESTS = 20;

/**
 * 一次作答写下的三条事实里，除作答和模型理由以外的字节数，含每行的换行。作答和理由本身有长度上限，另计。
 * 序号、时间和引用的位数随历史变长，seed 的位数随机：这些数都按最长的写法计，结果只取决于事实的构成。
 */
function fixedBytes(facts: readonly Fact[]): number {
  let bytes = 0;
  for (const fact of facts) {
    const widest: Record<string, unknown> = { ...fact, seq: Number.MAX_SAFE_INTEGER, at: Number.MAX_SAFE_INTEGER };
    for (const key of ["task", "delivery"]) {
      if (key in widest) widest[key] = Number.MAX_SAFE_INTEGER;
    }
    if ("seed" in widest) widest.seed = 0xffff_ffff;
    bytes += Buffer.byteLength(`${JSON.stringify(widest)}\n`);
    if (fact.type === "answered") {
      bytes -= Buffer.byteLength(JSON.stringify(fact.answers));
    }
    if (fact.type === "graded") {
      for (const slot of Object.values(fact.slots)) {
        // 只减去理由的内容，键名和引号仍算固定部分。
        if (slot.reason !== undefined) bytes -= Buffer.byteLength(JSON.stringify(slot.reason)) - 2;
      }
    }
  }
  return bytes;
}

/**
 * 单作答位的题一次作答，固定部分最多有多少字节：各字段取格式允许的最长值，拼出交付、作答、判分三条事实，再按 fixedBytes 计。
 * 题目 id 与作答位 id 取课程格式的长度上限，对错取最长的写法；按测试判的作答位有 MAX_TESTS 个测试，判分事实里每个测试记一个
 * 最长的结论。说「不会」的作答不运行测试，dontKnow 标记与测试结果不会同时出现，取更长的测试一边。
 */
function fixedLimit(): number {
  // TypeBox 的静态类型里没有长度和数量上限，从 schema 对象上读。
  const bound = (schema: object, key: "maxLength" | "maxItems"): unknown => Reflect.get(schema, key);
  assert.equal(LONG_TOPIC.length, bound(TopicIdSchema, "maxLength"));
  assert.equal(`${LONG_TOPIC}.k100000`.length, bound(KpIdSchema, "maxLength"));
  assert.equal(LONG_QUESTION.length, bound(QuestionIdSchema, "maxLength"));
  assert.equal(LONG_SLOT.length, bound(IdSchema, "maxLength"));
  assert.equal(MAX_TESTS, bound(CodeSlotSchema.properties.tests, "maxItems"));
  assert.ok(Value.Check(QuestionIdSchema, LONG_QUESTION) && Value.Check(IdSchema, LONG_SLOT));
  const longest = <T extends string>(values: readonly T[]) => values.reduce((a, b) => (b.length > a.length ? b : a));
  const verdict = longest(GradedSlotSchema.properties.verdict.enum);
  const status = longest(GradedSlotSchema.properties.tests.items.enum);
  const version = `sha256:${"0".repeat(64)}`;
  const facts: Fact[] = [
    { seq: 1, at: 0, type: "delivered", task: 1, question: LONG_QUESTION, seed: 0 },
    { seq: 2, at: 0, type: "answered", delivery: 1, seen: version, answers: {} },
    {
      seq: 3, at: 0, type: "graded", delivery: 1, version, verdict,
      slots: { [LONG_SLOT]: { verdict, tests: Array.from({ length: MAX_TESTS }, () => status) } },
    },
  ];
  assert.ok(facts.every((fact) => Value.Check(FactSchema, fact)));
  return fixedBytes(facts);
}

/** 一个知识点、练习是一道代码题的 topic；number 决定知识点和题目 id 的长度。每个测试都要求 x 等于 2。 */
function codeTopic(id: string, number: string, slot: string, tests: number, solution: string): Topic {
  const kpId = `${id}.k${number}`;
  return {
    id,
    title: id,
    status: "complete",
    minutes: 5,
    prerequisites: [],
    sources: [],
    kps: [{
      id: kpId,
      title: kpId,
      lesson: "讲解",
      example: { id: `${kpId}.e${number}`, body: "一加一？", explanation: "二。", slots: [{ id: "answer", type: "text", key: "2" }] },
      practice: [{
        id: `${kpId}.q${number}`,
        body: "让 `x` 等于 2。",
        explanation: "`x = 2`",
        slots: [{
          id: slot, type: "code", language: "python", starter: "x = 0", solution,
          tests: Array.from({ length: tests }, (_, index) => ({ name: `第 ${index + 1} 个测试`, expect: { x: "2" } })),
        }],
      }],
    }],
  };
}

/** 代码题的执行方替身：期望值和程序算出的值都是 2；程序永不结束时第一个测试超时，整批就此停下，余下的都不运行。 */
const fakePython: Services = {
  async call(name, input) {
    assert.equal(name, "python.run");
    const { tests } = parse(PythonBatchInputSchema, input);
    let stopped = false;
    return {
      protocol: PYTHON_BATCH,
      runtime: { pyodide: course.runtime.pyodide, python: course.runtime.python, packages: {} },
      tests: tests.map((entry) => {
        if (stopped) {
          return { id: entry.id, status: "not_run" };
        }
        if (entry.program.includes("while True")) {
          stopped = true;
          return { id: entry.id, status: "timeout", phase: "program" };
        }
        const captures = Object.fromEntries(entry.captures.map((capture) => [capture, { value: { t: "int", v: "2" } }]));
        return { id: entry.id, status: "completed", result: { stdout: "", error: null, doctest: [], captures } };
      }),
    };
  },
};

/** 判分用的前端替身：python.run 交给一个 Node 沙箱，按同一约定运行，代替页面的 Worker。 */
async function sandboxPython(t: TestContext): Promise<Services> {
  const runner = new SandboxRunner({ assets: await describeRuntime(RUNTIME) });
  t.after(() => runner.close());
  return {
    async call(name, input) {
      assert.equal(name, "python.run");
      const { tests } = parse(PythonBatchInputSchema, input);
      return { protocol: PYTHON_BATCH, runtime: await runner.start(), tests: await runner.runTests(tests) };
    },
  };
}

test("改正一道题的答案后，过去的作答自动按新答案重判，对错两个方向都生效，学习状态随之变化，XP 不减少", async (t) => {
  const f = await fixture(t, [topic("t01"), topic("t02")]);
  await f.select("t01");
  await f.advance();
  await f.advance();
  // 第一次答 3，按标准答案 2 判错；后两次答 2，两连对通过，独立正确 2/3，得 floor(5 × 2/3) = 3 XP。
  await answer(f, "3");
  await f.advance();
  await answer(f, "2");
  await f.advance();
  await answer(f, "2");
  const lesson = await f.state();
  assert.deepEqual(lesson.task?.phase, { stage: "completed", outcome: "passed" });
  assert.equal(lesson.progress.totalXp, 3);
  const taskId = lesson.task?.taskId;
  assert.ok(taskId);
  await f.select("t02");
  await f.finishLesson();
  assert.equal((await f.state()).progress.totalXp, 8);
  const before = graded(f).length;

  // 作者把答案改成 2 或 3 都对：题面不变，三份作答在打开空间时按新答案重判。错改对，XP 按新的比例补发差额。
  const accepting = topic("t01");
  const practice = accepting.kps[0]?.practice?.[0];
  assert.ok(practice);
  practice.slots = [{ id: "answer", type: "text", key: ["2", "3"] }];
  await f.writeTopics([accepting, topic("t02")]);
  await f.reopen();
  assert.equal(graded(f).length, before + 3);
  assert.deepEqual(verdicts(f, taskId), ["correct", "correct", "correct"]);
  assert.ok((await f.student()).t01);
  assert.equal((await f.state()).progress.totalXp, 10);

  // 再改成只有 3 对：后两份改判为错，t01 的课不再通过，菜单重新提供这节课；已经给出的 XP 不收回。
  const strict = topic("t01");
  const only = strict.kps[0]?.practice?.[0];
  assert.ok(only);
  only.slots = [{ id: "answer", type: "text", key: "3" }];
  await f.writeTopics([strict, topic("t02")]);
  await f.reopen();
  assert.deepEqual(verdicts(f, taskId), ["correct", "incorrect", "incorrect"]);
  assert.equal((await f.student()).t01, undefined);
  assert.ok((await f.student()).t02);
  const after = await f.state();
  assert.equal(after.progress.totalXp, 10);
  assert.ok(after.menu?.candidates.some((entry) => entry.kind === "lesson" && entry.topicIds[0] === "t01"));
  // 新判分追加在后面，旧判分保留；同一个答案版本只判一次，再打开不重判。
  const history = graded(f).filter((fact) => f.session().replay.delivery(fact.delivery)?.task.seq === Number(taskId.slice(1)));
  assert.equal(history.length, 9);
  assert.equal(new Set(history.map((fact) => fact.version)).size, 3);
  const count = graded(f).length;
  await f.reopen();
  await f.state();
  assert.equal(graded(f).length, count);
});

test("只改课程的运行前导时题面版本不变、题目版本改变，过去的代码题作答按新的前导自动重判", async (t) => {
  const reason = await runtimeUnavailable();
  if (reason) return skipUnavailableEnvironment(t, reason);
  // 测试的期望表达式用到前导里的常量：作者改正这个常量以后，题面没变，判分依据变了。
  const definition = topic("t01");
  const question = definition.kps[0]?.practice?.[0];
  assert.ok(question);
  question.slots = [{
    id: "answer", type: "code", language: "python", starter: "x = 0", solution: "x = ANSWER",
    tests: [{ name: "x 等于答案", expect: { x: "ANSWER" } }],
  }];
  const f = await fixture(t, [definition], { services: await sandboxPython(t), runtime: { ...RUNTIME, prelude: "ANSWER = 3\n" } });
  await f.select("t01");
  await f.advance();
  await f.advance();
  const input = await f.input();
  const receipt = await f.call("submission.submit", {
    ...input,
    response: { item: input.response.item, answers: { answer: { type: "code", code: "x = 3" } } },
  });
  assert.ok(receipt.status === "recorded");
  assert.equal(receipt.submission.feedback?.verdict, "correct");
  const before = await f.session().course.versionsOf(question.id);
  assert.ok(before);

  await f.writePrelude("ANSWER = 4\n");
  await f.reopen();
  await f.state();
  await f.settled();
  const after = await f.session().course.versionsOf(question.id);
  assert.ok(after);
  assert.equal(after.item, before.item);
  assert.notEqual(after.question, before.question);
  assert.deepEqual(graded(f).map((fact) => [fact.verdict, fact.version]), [["correct", before.question], ["incorrect", after.question]]);
  assert.equal((await f.state()).task?.submissions[0]?.feedback?.verdict, "incorrect");
});

test("申诉使更早一轮课的知识点改判为错时，正在进行的重试按重算后的继承进度计算，与学生模型和菜单一致；XP 不收回", async (t) => {
  const definition = topic("t01", 2);
  const first = definition.kps[0]?.practice?.[0];
  assert.ok(first);
  first.slots = [{ id: "answer", type: "text", rubric: [{ id: "meaning", label: "说明相加的含义" }] }];
  const f = await fixture(t, [definition]);
  // 第一轮：KP1 两连对通过，KP2 五次都说不会，课失败。
  f.models.expectStructured().succeed({ verdict: "correct", reason: "说明了含义" });
  f.models.expectStructured().succeed({ verdict: "correct", reason: "说明了含义" });
  await f.select("t01");
  const failed = await f.finishLesson([true, true, false, false, false, false, false]);
  assert.deepEqual(failed.task?.phase, { stage: "completed", outcome: "failed" });
  const key = f.session().replay.current?.answered[1];
  assert.ok(key);
  // 冷却以后重试：继承已过的 KP1，只练 KP2，两连对通过。
  f.time(start + 49 * 3_600_000);
  await f.select("t01");
  const passed = await f.finishLesson();
  assert.deepEqual(passed.task?.phase, { stage: "completed", outcome: "passed" });
  assert.ok((await f.student()).t01);
  const xp = passed.progress.totalXp;

  // 申诉把第一轮使 KP1 两连对的那份作答改判为错：第一轮的 KP1 不再通过，重试的课也就继承不到它。
  // 重试的课回到进行中，学生模型里没有这节课的已学状态，菜单不出现；已经给出的 XP 不收回。
  f.models.expectStructured().succeed({ verdict: "incorrect", reason: "复核不符" });
  await f.call("submission.appeal", { submissionId: `s${key.seq}`, expectedGradeRevision: 1, reason: "复核" });
  const after = await f.state();
  assert.deepEqual(after.task?.kps.map((kp) => kp.completed), [false, true]);
  assert.equal(after.task?.phase.stage, "feedback");
  assert.equal(after.menu, null);
  assert.equal((await f.student()).t01, undefined);
  assert.deepEqual((await f.fold()).lessons.get("t01")?.map((kp) => kp.completed), [false, false]);
  assert.equal(after.progress.totalXp, xp);
});

for (const count of [2, 1]) {
  const title = count === 2
    ? "上一轮课的待判作答补判为对，使正在进行的课继承到已完成的知识点：这节课随后通过时照常结算 XP，重开空间结果相同"
    : "上一轮课的待判作答补判为对，使正在进行的课当场通过：此刻就结算 XP，只重算一次，重开空间结果相同";
  test(title, async (t) => {
    const definition = topic("t01", count);
    const question = definition.kps[0]?.practice?.[0];
    assert.ok(question);
    question.slots = [{ id: "answer", type: "text", rubric: [{ id: "meaning", label: "说明相加的含义" }] }];
    const f = await fixture(t, [definition]);
    // 上一轮：KP1 答对一题，第二题判分中断，随后中止；这时 KP1 还没有两连对。
    await f.select("t01");
    await f.advance();
    await f.advance();
    f.models.expectStructured().succeed({ verdict: "correct", reason: "说明了含义" });
    await f.submit();
    await f.advance();
    f.models.expectStructured().fail(new Error("断网"));
    const pending = await f.submit();
    assert.ok(pending.status === "recorded");
    const aborted = await f.state();
    assert.ok(aborted.task);
    await f.call("task.abort", { taskId: aborted.task.taskId, expectedRevision: aborted.revision, expectedStage: aborted.task.phase.stage });
    // 新一轮：继承的 KP1 尚未完成，先答对 KP1 一题。
    await f.select("t01");
    const lesson = Number((await f.state()).task?.taskId.slice(1));
    await f.advance();
    await f.advance();
    f.models.expectStructured().succeed({ verdict: "correct", reason: "说明了含义" });
    await f.submit();
    // 上一轮的待判作答补判为对：上一轮的 KP1 两连对，新一轮继承到已完成的 KP1。
    f.time(start + 60_000);
    const recomputations = f.session().replay.recomputations;
    f.models.expectStructured().succeed({ verdict: "correct", reason: "说明了含义" });
    await f.call("submission.resume", { submissionId: pending.submission.submissionId });
    const awards = (task: number) => f.session().replay.awards.filter((award) => award.task === task).map((award) => [award.xp, award.at]);
    if (count === 2) {
      assert.equal((await f.state()).task?.kps[0]?.completed, true);
      assert.deepEqual(awards(lesson), []);
      await f.finishLesson();
    } else {
      // 只有一个知识点：补判当场完成了这节课，此刻结算，不等下一项任务。这一步只重算一次。
      assert.equal(f.session().replay.recomputations - recomputations, 1);
    }
    const passed = await f.state();
    assert.deepEqual(passed.task?.phase, { stage: "completed", outcome: "passed" });
    assert.deepEqual(awards(lesson), [[5, start + 60_000]]);
    const total = passed.progress.totalXp;
    assert.equal(total, count === 2 ? 5 : 10);
    const all = structuredClone(f.session().replay.awards);
    await f.reopen();
    assert.deepEqual((await f.state()).task?.phase, { stage: "completed", outcome: "passed" });
    assert.equal((await f.state()).progress.totalXp, total);
    assert.deepEqual(f.session().replay.awards, all);
  });
}

test("判分失败或模型没有把握时任务照样往下走、不计失败，可以中止；下次打开自动补判，学习状态随之重算", async (t) => {
  const definition = topic("t01");
  const question = definition.kps[0]?.practice?.[0];
  assert.ok(question);
  question.slots = [{ id: "answer", type: "text", rubric: [{ id: "meaning", label: "说明相加的含义" }] }];
  const f = await fixture(t, [definition]);
  await f.select();
  await f.advance();
  await f.advance();
  f.models.expectStructured().fail(new Error("断网"));
  const failed = await f.submit();
  assert.ok(failed.status === "recorded");
  assert.deepEqual(failed.submission.processing, { status: "interrupted", reason: "service_failure" });
  assert.equal((await f.state()).task?.phase.stage, "recovery");
  // 不阻塞：从恢复阶段继续下一题。
  assert.equal((await f.advance()).task?.phase.stage, "awaiting_answer");
  f.models.expectStructured().succeed({ verdict: "unsure", reason: "看不出来" });
  const unsure = await f.submit();
  assert.ok(unsure.status === "recorded");
  assert.deepEqual(unsure.submission.processing, { status: "interrupted", reason: "uncertain_grade" });
  await f.advance();
  f.models.expectStructured().succeed({ verdict: "correct", reason: "说明了含义" });
  await f.submit();
  // 没有证据的两份既不算对也不算错：只有第三份计一次尝试。
  assert.deepEqual((await f.state()).task?.kps[0], { kpId: "t01.k1", attempts: 1, consecutiveCorrect: 1, completed: false });
  const current = await f.state();
  assert.ok(current.task);
  const aborted = await f.call("task.abort", { taskId: current.task.taskId, expectedRevision: current.revision, expectedStage: current.task.phase.stage });
  assert.equal(aborted.task?.phase.stage, "aborted");
  assert.equal((await f.student()).t01, undefined);
  // 下次打开后的第一次调用自动补判这两份；按作答顺序重算，前两份就已两连对，这节课改为通过。
  f.models.expectStructured().succeed({ verdict: "correct", reason: "说明了含义" });
  f.models.expectStructured().succeed({ verdict: "correct", reason: "说明了含义" });
  await f.reopen();
  await f.state();
  await f.settled();
  assert.equal(f.models.calls.length, 5);
  assert.deepEqual((await f.state()).task?.phase, { stage: "completed", outcome: "passed" });
  assert.ok((await f.student()).t01);
});

test("复习到截止时间时，没判出结果的作答和没出的题都判对也不能让复习通过：已有失败的证据，按超时结束并记一次失败", async (t) => {
  const definition = topic("t01");
  const review = definition.kps[0]?.review?.[0];
  assert.ok(review);
  review.slots = [{ id: "answer", type: "text", rubric: [{ id: "meaning", label: "说明相加的含义" }] }];
  const f = await fixture(t, [definition]);
  await f.select("t01");
  await f.finishLesson();
  f.time(start + 86_400_000);
  const learned = (await f.student()).t01;
  assert.ok(learned);
  await f.select("t01", "review");
  // 前三题说不会，当场判错；第四题的判分中断。就算它和还没出的第五题都对，也只有两题对，到截止时间就不可能通过了。
  for (let index = 0; index < 3; index++) {
    await f.submit(false);
    await f.advance();
  }
  f.models.expectStructured().fail(new Error("断网"));
  const receipt = await f.submit();
  assert.ok(receipt.status === "recorded");
  assert.equal(receipt.submission.processing.status, "interrupted");
  const deadline = (await f.state()).task?.deadlineAt;
  assert.ok(deadline);
  f.time(deadline);
  assert.deepEqual((await f.state()).task?.phase, { stage: "completed", outcome: "timeout" });
  assert.notDeepEqual((await f.student()).t01, learned);
  assert.ok(((await f.student()).t01?.repNum ?? 0) < learned.repNum);
});

test("只把事实文件和格式标记搬到新空间，打开后从事实重算出相同的状态", async (t) => {
  const f = await fixture(t, [topic("t01", 2), topic("t02", 1, ["t01"])]);
  await f.select("t01");
  await f.finishLesson([true, false, true, true]);
  await f.select("t02");
  await f.finishLesson();
  f.time(start + 86_400_000);
  await f.select("t01", "review");
  await f.submit();
  await f.advance();
  await f.submit(false);
  await f.call("progress.setGoal", { dailyGoalXp: 40 });
  const state = await f.state();
  const fold = await f.fold();
  const awards = structuredClone(f.session().replay.awards);
  const facts: readonly Fact[] = [...f.session().records.facts];
  assert.deepEqual(await f.relocate(), ["format.json", "records.jsonl"]);
  assert.deepEqual(await f.state(), state);
  assert.deepEqual(await f.fold(), fold);
  assert.deepEqual(f.session().replay.awards, awards);
  // 不经插件，直接把事实交给重放也得到同样的学习状态。
  const replay = new Replay(f.session().course);
  for (const fact of facts) replay.apply(fact);
  replay.settle(start + 86_400_000);
  assert.deepEqual(replay.fold(), fold);
  assert.deepEqual(replay.awards, awards);
});

test("换一组学生模型参数重放同一份事实，得出不同的预测；插件使用的那一组与打开空间时的结果相同", async (t) => {
  const f = await fixture(t, [topic("t01"), topic("t02")]);
  await f.select("t01");
  await f.finishLesson();
  f.time(start + DAY_MS);
  await f.select("t01", "review");
  for (let index = 0; index < 3; index++) {
    await f.submit();
    if (index < 2) await f.advance();
  }
  assert.deepEqual((await f.state()).task?.phase, { stage: "completed", outcome: "passed" });
  const facts: readonly Fact[] = [...f.session().records.facts];
  const replay = (model?: ModelConfig) => {
    const result = new Replay(f.session().course, model);
    for (const fact of facts) result.apply(fact);
    return result.fold().student;
  };
  assert.deepEqual(replay(), await f.student());
  // 间隔增长更快的一组参数：同样的作答，复习以后的理想间隔更长，第三天按它不到期，按默认参数已经到期。
  const slower: ModelConfig = { ...DEFAULT_MODEL_CONFIG, intervalBase: 3 };
  const base = replay().t01;
  const other = replay(slower).t01;
  assert.ok(base && other);
  assert.ok(other.interval > base.interval);
  const later = (start + 3 * DAY_MS) / DAY_MS;
  assert.equal(isDue(base, later), true);
  assert.equal(isDue(other, later, slower), false);
});

test("题目的知识点归属改变时题目版本不变，过去的作答照样对得上，不重判，状态不变", async (t) => {
  const f = await fixture(t, [topic("t01", 2), topic("t02")]);
  await f.select("t01");
  await f.finishLesson();
  const before = await f.state();
  const count = graded(f).length;
  const changed = topic("t01", 2);
  const question = changed.kps[0]?.practice?.[0];
  assert.ok(question);
  question.measures = ["t01.k1", "t01.k2"];
  await f.writeTopics([changed, topic("t02")]);
  await f.reopen();
  assert.deepEqual(await f.state(), before);
  assert.equal(graded(f).length, count);
  for (const fact of graded(f)) {
    const delivery = f.session().replay.delivery(fact.delivery);
    assert.ok(delivery);
    assert.equal(fact.version, (await f.session().course.versionsOf(delivery.questionId))?.question);
  }
});

test("代价关卡：每次作答只写交付、作答、判分三条事实；固定部分不超过按事实构成算出的上限，也不随历史增长", async (t) => {
  const limit = fixedLimit();
  // 样本有文字题、开放题（t01 第三个知识点）和两道代码题：t04 的只有一个测试；最长的那道题目 id 和作答位 id 都取格式上限，
  // 有 MAX_TESTS 个测试，参考答案永不结束，替身执行方让第一个测试超时、余下的不运行，判分事实里每个测试的结论都是最长的写法。
  const definition = topic("t01", 3);
  const open = definition.kps[2]?.practice?.[0];
  assert.ok(open);
  open.slots = [{ id: "answer", type: "text", rubric: [{ id: "meaning", label: "说明相加的含义" }] }];
  const code = [codeTopic("t04", "1", "answer", 1, "x = 2"), codeTopic(LONG_TOPIC, "100000", LONG_SLOT, MAX_TESTS, "while True:\n    pass")];
  const f = await fixture(t, [definition, topic("t02", 3, ["t01"]), topic("t03", 3, ["t02"]), ...code], { services: fakePython });
  const size = async () => (await stat(f.session().records.file)).size;
  const samples: { question: string; bytes: number }[] = [];
  for (const id of ["t01", "t02", "t03", "t04", LONG_TOPIC]) {
    await f.select(id);
    for (let step = 0; step < 60; step++) {
      const current = await f.state();
      const stage = current.task?.phase.stage;
      if (stage === "completed") break;
      const before = await size();
      const facts = f.session().records.revision;
      if (stage === "example" || (stage === "feedback" && !current.task?.kps.find((kp) => kp.kpId === current.task?.deliveries.at(-1)?.kpId)?.completed)) {
        await f.advance();
        f.models.expectStructured().succeed({ verdict: "correct", reason: "说明了相加的含义" });
        const receipt = await f.submit();
        assert.ok(receipt.status === "recorded");
        const written = f.session().records.facts.slice(facts);
        assert.deepEqual(written.map((fact) => fact.type), ["delivered", "answered", "graded"]);
        // 计算的就是写进日志的这三行。
        assert.equal((await size()) - before, written.reduce((sum, fact) => sum + Buffer.byteLength(`${JSON.stringify(fact)}\n`), 0));
        const delivered = written[0];
        assert.ok(delivered?.type === "delivered");
        samples.push({ question: delivered.question, bytes: fixedBytes(written) });
      } else {
        await f.advance();
      }
    }
  }
  for (const sample of samples) {
    assert.ok(sample.bytes <= limit, `${sample.question} 一次作答的固定部分 ${sample.bytes} 字节，上限 ${limit} 字节`);
  }
  // 上限就是这样一次作答实际写下的构成：最长的那道代码题每次作答都正好达到它。
  const longest = samples.filter((sample) => sample.question === LONG_QUESTION);
  assert.equal(longest.length, 5);
  assert.ok(longest.every((sample) => sample.bytes === limit), JSON.stringify(longest));
  // 构成相同的作答写在历史的哪个位置都一样：t01 开头的文字题和 t03 末尾的文字题，固定部分相同。
  const text = samples.filter((sample) => /^t0[123]\.k[123]\.q1$/.test(sample.question) && sample.question !== "t01.k3.q1");
  assert.equal(text.length, 16);
  assert.equal(new Set(text.map((sample) => sample.bytes)).size, 1);
  assert.equal(samples.length, 25);
});

test("代价关卡：作答和任务结束都增量更新，重判改了更早任务作答的对错才整段重算一次；打开空间时每条事实只重放一次", async (t) => {
  const definition = topic("t01");
  const question = definition.kps[0]?.practice?.[0];
  assert.ok(question);
  question.slots = [{ id: "answer", type: "text", rubric: [{ id: "meaning", label: "说明相加的含义" }] }];
  const f = await fixture(t, [definition, topic("t02"), topic("t03")]);
  f.models.expectStructured().succeed({ verdict: "correct", reason: "符合" });
  f.models.expectStructured().succeed({ verdict: "correct", reason: "符合" });
  await f.select("t01");
  await f.finishLesson();
  const original = (await f.state()).task?.submissions[0];
  assert.ok(original);
  await f.select("t02");
  await f.finishLesson();
  assert.equal(f.session().replay.recomputations, 0);
  // 申诉重判 t01 的作答，结论没变：证据不变，学习状态不过期，不重算。
  f.models.expectStructured().succeed({ verdict: "correct", reason: "复核仍然符合" });
  await f.call("submission.appeal", { submissionId: original.submissionId, expectedGradeRevision: 1, reason: "复核" });
  await f.state();
  assert.equal(f.session().replay.recomputations, 0);
  // 再申诉，改判为错：它属于更早的任务，之后的学习状态整段重算一次，重复读取不再重算。
  f.models.expectStructured().succeed({ verdict: "incorrect", reason: "复核不符" });
  await f.call("submission.appeal", { submissionId: original.submissionId, expectedGradeRevision: 2, reason: "再复核" });
  await f.state();
  await f.state();
  assert.equal(f.session().replay.recomputations, 1);
  await f.select("t03");
  await f.finishLesson();
  assert.equal(f.session().replay.recomputations, 1);
  const facts = f.session().records.revision;
  await f.reopen();
  await f.state();
  assert.equal(f.session().replay.applied, facts);
  assert.equal(f.session().replay.recomputations, 1);
});
