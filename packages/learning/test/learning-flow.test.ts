import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { Services } from "@repa/base/plugin";
import { parse } from "@repa/base/protocol";
import { PYTHON_BATCH, PythonBatchInputSchema } from "@repa/python-runner/protocol";
import { learningMenu } from "../src/flow-menu.js";
import type { Fact } from "../src/records-schema.js";
import { Replay } from "../src/replay.js";
import type { Question } from "../src/format/schema.js";
import { updateStudent } from "../src/student-model.js";
import { clientCapabilities, deliverySeq, learningFixture as fixture, start, topic } from "./fixtures/learning-session.js";

const stale = (error: unknown) => error instanceof Error && "code" in error && error.code === "stale_state";

test("第五题先判两连对；整节完成前不建立 topic 已学状态，多个 measures 不跨 KP", async (t) => {
  const definition = topic("t01", 2);
  const question = definition.kps[0]?.practice?.[0];
  assert.ok(question);
  question.measures = ["t01.k1", "t01.k2"];
  const f = await fixture(t, [definition, topic("t02", 1, ["t01"])]);
  await f.select();
  await f.advance();
  await f.advance();
  for (const correct of [false, true, false, true, true]) {
    await f.submit(correct);
    if (correct !== true || (await f.state()).task?.kps[0]?.attempts !== 5) {
      await f.advance();
    }
  }
  const task = (await f.state()).task;
  assert.equal(task?.kps[0]?.completed, true);
  assert.equal(task?.kps[1]?.attempts, 0);
  assert.deepEqual(await f.student(), {});
  const result = await f.finishLesson();
  assert.deepEqual(result.task?.phase, { stage: "completed", outcome: "passed" });
  assert.ok((await f.student()).t01);
  assert.equal((await f.student()).t02, undefined);
  assert.equal(result.menu?.candidates[0]?.topicIds[0], "t02");
  const frozen = await f.state();
  assert.deepEqual(await f.state(), frozen);
  await f.reopen();
  assert.deepEqual(await f.state(), frozen);
});

test("结构错误不计尝试；事前求助后正确保留判分但中断连对，事后求助不撤回结果", async (t) => {
  const f = await fixture(t);
  await f.select();
  await f.advance();
  await f.advance();
  const input = await f.input();
  const rejected = await f.call("submission.submit", { ...input, response: { ...input.response, answers: {} } });
  assert.equal(rejected.status, "rejected");
  assert.equal((await f.state()).task?.kps[0]?.attempts, 0);
  const seq = Number(input.deliveryId.slice(1));
  await f.session().write(() => [{ type: "help", delivery: seq }]);
  const receipt = await f.call("submission.submit", input);
  assert.equal(receipt.status, "recorded");
  if (receipt.status === "recorded") {
    assert.equal(receipt.submission.feedback?.verdict, "correct");
    assert.deepEqual(receipt.submission.feedback?.evidence, { status: "ineligible", reason: "作答前已获取帮助" });
  }
  assert.equal((await f.state()).task?.kps[0]?.consecutiveCorrect, 0);
  await f.session().write(() => [{ type: "help", delivery: seq }]);
  await f.advance();
  const duplicate = await f.call("submission.submit", input);
  assert.deepEqual(duplicate, receipt);
  await f.submit();
  await f.advance();
  await f.submit();
  assert.deepEqual((await f.state()).task?.phase, { stage: "completed", outcome: "passed" });
});

test("失败保留已过 KP，冷却期间提供其他任务并报告最早恢复时间", async (t) => {
  const f = await fixture(t, [topic("t01", 2)]);
  await f.select();
  await f.advance();
  await f.advance();
  await f.submit();
  await f.advance();
  await f.submit();
  await f.advance();
  await f.advance();
  await f.advance();
  for (let index = 0; index < 5; index++) {
    await f.submit(false);
    if (index < 4) {
      await f.advance();
    }
  }
  const failure = await f.state();
  assert.deepEqual(failure.task?.phase, { stage: "completed", outcome: "failed" });
  assert.equal(failure.menu?.candidates.length, 0);
  assert.equal(failure.menu?.availableAt, start + 48 * 3_600_000);
  f.time(start + 48 * 3_600_000);
  await f.select();
  assert.equal((await f.state()).task?.kps[0]?.completed, true);
  assert.equal((await f.state()).task?.kps[1]?.attempts, 0);
});

for (const [pattern, outcome] of [
  [[false, true, false, true, true], "passed"],
  [[true, true, false, true, false], "failed"],
] as const) {
  test(`隔天复习 ${pattern.map((entry) => (entry ? "对" : "错")).join("")} 得到 ${outcome}，结束后才释放反馈`, async (t) => {
    const f = await fixture(t, [topic("t01", 2)]);
    await f.select();
    await f.finishLesson();
    f.time(start + 86_400_000);
    await f.select("t01", "review");
    const order = (await f.state()).task?.kps.map((kp) => kp.kpId);
    assert.equal((await f.state()).restrictions.tutorAllowed, false);
    for (const [index, correct] of pattern.entries()) {
      const result = await f.submit(correct);
      assert.equal(result.status, "recorded");
      if (index < 4) {
        if (result.status === "recorded") {
          assert.equal(result.submission.feedback, undefined);
        }
        await f.advance();
      }
    }
    const result = await f.state();
    assert.deepEqual(result.task?.phase, { stage: "completed", outcome });
    assert.deepEqual(result.task?.deliveries.slice(0, 2).map((entry) => entry.kpId), order);
    assert.ok(result.task?.submissions.every((entry) => entry.feedback));
    assert.equal(result.restrictions.referenceContentAllowed, true);
    assert.equal((await f.student()).t01?.repNum, outcome === "passed" ? 1.6 : 0.6);
  });
}

for (const answers of [[], [true, false]]) {
  test(`复习中途关闭应用（${answers.length ? "答了一对一错" : "一题没答"}）：重开时不暂停，到截止时间按超时结束；没出的题不算错，学生模型不变，菜单照常提供这次复习`, async (t) => {
    const f = await fixture(t, [topic("t01", 2)]);
    await f.select();
    await f.finishLesson();
    f.time(start + 86_400_000);
    const learned = await f.student();
    await f.select("t01", "review");
    for (const correct of answers) {
      await f.submit(correct);
      await f.advance();
    }
    const started = await f.state();
    await f.reopen();
    assert.equal((await f.state()).task?.deadlineAt, started.task?.deadlineAt);
    // 关闭期间计时照走：过了截止时间再打开，复习已经结束，不会停在那里。
    f.time(start + 3 * 86_400_000);
    await f.reopen();
    const timedOut = await f.state();
    assert.deepEqual(timedOut.task?.phase, { stage: "completed", outcome: "timeout" });
    // 已答的两题不足以判定失败，余下的题没有证据：不更新学生模型，topic 照旧到期，重新安排复习。
    assert.deepEqual(await f.student(), learned);
    assert.deepEqual(timedOut.menu?.candidates.map((entry) => [entry.kind, entry.topicIds[0]]), [["review", "t01"]]);
    assert.equal(f.session().replay.fold().consecutiveReviews, 0);
    await f.reopen();
    assert.deepEqual(await f.student(), learned);
  });
}

test("从事实里去掉一份关键作答，同一时刻的新课资格随之改变，原始日志字节不变", async (t) => {
  const f = await fixture(t, [topic(), topic("t02", 1, ["t01"])]);
  await f.select();
  await f.finishLesson();
  const session = f.session();
  const bytes = await readFile(session.records.file);
  const replay = (facts: readonly Fact[]) => {
    const result = new Replay(session.course);
    for (const fact of facts) result.apply(fact);
    return result;
  };
  const facts = session.records.facts;
  const removed = facts.find((fact) => fact.type === "answered");
  assert.ok(removed?.type === "answered");
  const copy = facts.filter((fact) => !((fact.type === "answered" || fact.type === "graded") && fact.delivery === removed.delivery));
  const actual = learningMenu(session.course, replay(facts).fold(), start, "menu", () => true);
  const counterfactual = replay(copy);
  const alternative = learningMenu(session.course, counterfactual.fold(), start, "menu", () => true);
  assert.deepEqual(actual.candidates.map((entry) => entry.topicIds[0]), ["t02"]);
  assert.deepEqual(alternative.candidates.map((entry) => entry.topicIds[0]), ["t01"]);
  assert.equal(counterfactual.fold().student.t01, undefined);
  assert.deepEqual(replay(facts).fold().student, await f.student());
  assert.deepEqual(await readFile(session.records.file), bytes);
  if (process.env.REPA_LEARNING_EVIDENCE) {
    const parent = process.env.REPA_LEARNING_EVIDENCE;
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(path.join(parent, "counterfactual-"));
    await writeFile(path.join(directory, "original.jsonl"), bytes);
    await writeFile(path.join(directory, "counterfactual-facts.json"), JSON.stringify(copy, null, 2));
    await writeFile(
      path.join(directory, "comparison.json"),
      JSON.stringify({ decisionNow: start, removedDelivery: removed.delivery, actual, counterfactual: alternative }, null, 2),
    );
  }
});

test("公开选择项、排列块与表格格内选项换号，反馈映回相同 id，盘上记课程里的编号，数据行保留顺序", async (t) => {
  const definition = topic();
  const question = definition.kps[0]?.practice?.[0];
  assert.ok(question);
  question.slots = [
    { id: "choice", type: "choice", options: [{ id: "yes", content: "对" }, { id: "no", content: "错" }], key: "yes" },
    { id: "order", type: "order", items: [{ id: "first", content: "先" }, { id: "second", content: "后" }], key: ["first", "second"] },
    {
      id: "table",
      type: "table",
      columns: [{ id: "v", header: "数值", input: "bool" }],
      rows: [{ id: "row1", cells: { v: true } }, { id: "row2", cells: { v: false } }],
    },
  ];
  const f = await fixture(t, [definition]);
  await f.select();
  await f.advance();
  await f.advance();
  const input = await f.input();
  const delivery = (await f.state()).task?.deliveries[0];
  assert.ok(delivery);
  assert.equal(delivery.item.id.startsWith("t01"), false);
  const table = delivery.item.slots.find((slot) => slot.type === "table");
  assert.ok(table?.type === "table");
  assert.deepEqual(table.rows.map((row) => row.id), ["row1", "row2"]);
  assert.equal(JSON.stringify(delivery.item).includes('"id":"yes"'), false);
  const result = await f.call("submission.submit", input);
  assert.equal(result.status, "recorded");
  if (result.status === "recorded") {
    assert.equal(result.submission.feedback?.verdict, "correct");
    assert.deepEqual(result.submission.feedback?.slots?.choice?.expected, input.response.answers.choice);
  }
  const answered = f.session().records.facts.find((fact) => fact.type === "answered");
  assert.ok(answered?.type === "answered");
  assert.deepEqual(answered.answers.choice, { type: "choice", selected: ["yes"] });
  assert.deepEqual(answered.answers.order, { type: "order", items: ["first", "second"] });
  await f.advance();
  assert.equal((await f.state()).task?.deliveries.at(-1)?.repeated, true);
});

test("开放题只送本题与原答；服务失败和 unsure 不算错，重开后自动补判一次，显式恢复后推进一次", async (t) => {
  const definition = topic();
  const question = definition.kps[0]?.practice?.[0];
  assert.ok(question);
  question.slots = [{ id: "answer", type: "text", rubric: [{ id: "meaning", label: "说明相加含义。" }] }];
  const f = await fixture(t, [definition]);
  await f.select();
  await f.advance();
  await f.advance();
  f.models.expectStructured().fail(new Error("服务断开"));
  const input = await f.input();
  const failed = await f.call("submission.submit", input);
  assert.equal(failed.status, "recorded");
  if (failed.status === "recorded") {
    assert.deepEqual(failed.submission.processing, { status: "interrupted", reason: "service_failure" });
  }
  assert.equal((await f.state()).task?.kps[0]?.attempts, 0);
  assert.equal((await f.state()).task?.phase.stage, "recovery");
  // 本次会话已经试过：其他调用不再自动重试。
  await f.state();
  assert.equal(f.models.calls.length, 1);
  await f.reopen();
  const uncertain = f.models.expectStructured();
  uncertain.succeed({ verdict: "unsure", reason: "信息不足" });
  await f.state();
  await uncertain.requested;
  await f.settled();
  assert.equal(f.models.calls.length, 2);
  const queried = await f.call("submission.get", { submissionId: input.submissionId });
  assert.ok(queried.status === "found");
  assert.deepEqual(queried.submission.processing, { status: "interrupted", reason: "uncertain_grade" });
  assert.equal((await f.state()).task?.kps[0]?.attempts, 0);
  f.models.expectStructured().succeed({ verdict: "invalid" });
  await f.call("submission.resume", { submissionId: input.submissionId });
  assert.equal((await f.state()).task?.kps[0]?.attempts, 0);
  const completion = f.models.expectStructured();
  completion.succeed({ verdict: "correct", reason: "符合 rubric" });
  const result = await f.call("submission.resume", { submissionId: input.submissionId });
  const request = await completion.requested;
  assert.deepEqual(Object.keys(JSON.parse(request.prompt)).sort(), ["answer", "question", "reference", "rubric"]);
  assert.equal(result.status, "recorded");
  if (result.status === "recorded") {
    assert.equal(result.submission.feedback?.judge, "model");
  }
  assert.equal((await f.state()).task?.kps[0]?.attempts, 1);
  await f.call("submission.submit", input);
  assert.equal(f.models.calls.length, 4);
  assert.equal(f.session().records.facts.filter((entry) => entry.type === "answered").length, 1);
});

test("复习截止前收下的开放题作答没判出结果、而它判对就能通过时，截止后复习结束但不下结论、不记失败；补判后改为通过并以作答时间更新", async (t) => {
  const definition = topic();
  const review = definition.kps[0]?.review?.[0];
  assert.ok(review);
  review.slots = [{ id: "answer", type: "text", rubric: [{ id: "meaning", label: "说明相加含义" }] }];
  const f = await fixture(t, [definition]);
  await f.select();
  await f.finishLesson();
  f.time(start + 86_400_000);
  const learned = (await f.student()).t01;
  assert.ok(learned);
  await f.select("t01", "review");
  for (let index = 0; index < 2; index++) {
    f.models.expectStructured().succeed({ verdict: "correct", reason: "符合" });
    await f.submit();
    await f.advance();
  }
  f.models.expectStructured().fail(new Error("断开"));
  const receipt = await f.submit();
  assert.equal(receipt.status, "recorded");
  if (receipt.status !== "recorded") {
    return;
  }
  f.time(start + 86_400_000 + 600_000);
  const ended = await f.state();
  assert.deepEqual(ended.task?.phase, { stage: "completed", outcome: "unresolved" });
  assert.ok(ended.menu);
  assert.deepEqual((await f.student()).t01, learned);
  f.models.expectStructured().succeed({ verdict: "correct", reason: "符合" });
  await f.reopen();
  await f.state();
  await f.settled();
  assert.deepEqual((await f.state()).task?.phase, { stage: "completed", outcome: "passed" });
  assert.equal((await f.student()).t01?.lastRepetitionDay, receipt.submission.acceptedAt / 86_400_000);
});

test("历史申诉追加判分、保留原答和已选任务，失去先修的新课不能继续", async (t) => {
  const definition = topic();
  const question = definition.kps[0]?.practice?.[0];
  assert.ok(question);
  question.slots = [{ id: "answer", type: "text", rubric: [{ id: "meaning", label: "说明相加含义。" }] }];
  const f = await fixture(t, [definition, topic("t02", 1, ["t01"])]);
  await f.select("t01");
  f.models.expectStructured().succeed({ verdict: "correct", reason: "符合" });
  f.models.expectStructured().succeed({ verdict: "correct", reason: "符合" });
  await f.finishLesson();
  const original = (await f.state()).task?.submissions[0];
  assert.ok(original);
  const selected = await f.select("t02");
  const frozen = structuredClone(selected.task);
  f.models.expectStructured().succeed({ verdict: "incorrect", reason: "重新核对后不符合" });
  await f.call("submission.appeal", { submissionId: original.submissionId, expectedGradeRevision: 1, reason: "核对原答" });
  const appealed = await f.call("submission.get", { submissionId: original.submissionId });
  assert.equal(appealed.status, "found");
  if (appealed.status === "found") {
    assert.equal(appealed.submission.gradeRevision, 2);
    assert.deepEqual(appealed.submission.response, original.response);
    assert.equal(appealed.submission.feedback?.verdict, "incorrect");
  }
  const facts = f.session().records.facts;
  const seq = Number(original.deliveryId.slice(1));
  assert.equal(facts.filter((entry) => entry.type === "graded" && entry.delivery === seq).length, 2);
  assert.equal(facts.filter((entry) => entry.type === "appealed").length, 1);
  assert.deepEqual((await f.state()).task, frozen);
  assert.equal((await f.student()).t01, undefined);
  await f.reopen();
  assert.equal((await f.student()).t01, undefined);
  await assert.rejects(f.advance(), stale);
});

test("代码题：前端声明 python.run 才出题；一次提交只调用一次服务，期望值在同一次调用里先算；环境失败不算错，重开后自动补判", async (t) => {
  const definition = topic();
  const question = definition.kps[0]?.practice?.[0];
  assert.ok(question);
  question.slots = [
    {
      id: "answer",
      type: "code",
      language: "python",
      starter: "x=0",
      solution: "x=2",
      tests: [{ name: "a", expect: { x: "1 + 1" } }, { name: "b", expect: { x: "2" } }],
    },
  ];
  const calls: unknown[] = [];
  let fail = true;
  const services: Services = {
    async call(name, input) {
      assert.equal(name, "python.run");
      const batch = parse(PythonBatchInputSchema, input);
      calls.push(batch);
      if (fail) {
        throw new Error("执行环境不可用");
      }
      // 请求里有期望表达式（在学习者的程序之前求值），但没有参考解，也没有提交的编号。
      assert.deepEqual(batch.tests.map((test) => [test.id, test.program, test.captures]), [
        ["expected:0", "", ["1 + 1"]], ["expected:1", "", ["2"]], ["test:0", "x=2", ["x"]], ["test:1", "x=2", ["x"]],
      ]);
      return {
        protocol: PYTHON_BATCH,
        runtime: { pyodide: "314.0.7", python: "3.14.2", packages: {} },
        tests: batch.tests.map((entry) => ({
          id: entry.id,
          status: "completed",
          // 期望值是 2，学习者的程序算出 0。
          result: {
            stdout: "", error: null, doctest: [],
            captures: Object.fromEntries(entry.captures.map((capture) => [capture, { value: { t: "int", v: entry.program ? "0" : "2" } }])),
          },
        })),
      };
    },
  };
  const f = await fixture(t, [definition], { services });
  // 没有声明 python.run 的前端拿不到只有代码题的课；能否运行 Python 只看连接时的声明，不调用服务探测。
  assert.equal((await f.call("state.get", {}, { ...clientCapabilities, services: [] })).menu?.candidates.length, 0);
  assert.equal(calls.length, 0);
  await f.select();
  await f.advance();
  await f.advance();
  assert.equal(calls.length, 0);
  const input = await f.input();
  const failed = await f.call("submission.submit", input);
  assert.equal(failed.status, "recorded");
  assert.equal((await f.state()).task?.kps[0]?.attempts, 0);
  assert.equal(calls.length, 1);
  await f.reopen();
  assert.equal(calls.length, 1);
  fail = false;
  // 不能运行 Python 的前端来调用时不补判；声明了 python.run 的前端第一次调用时补判一次。
  await f.call("state.get", {}, { ...clientCapabilities, services: [] });
  await f.settled();
  assert.equal(calls.length, 1);
  await f.state();
  await f.settled();
  assert.equal(calls.length, 2);
  const recovered = await f.call("submission.resume", { submissionId: input.submissionId });
  assert.equal(calls.length, 2);
  assert.equal(recovered.status, "recorded");
  if (recovered.status === "recorded") {
    assert.equal(recovered.submission.feedback?.verdict, "incorrect");
  }
  assert.equal((await f.state()).task?.kps[0]?.attempts, 1);
  await f.call("submission.submit", input);
  assert.equal(calls.length, 2);
});

test("真实 py01 经插件方法完成并隔天复习，开放题判分使用隔离替身", async (t) => {
  const f = await fixture(t, [topic()], { bundled: true });
  await f.select("py01", "lesson");
  for (let index = 0; index < 20; index++) {
    f.models.expectStructured().succeed({ verdict: "correct", reason: "符合本题 rubric" });
  }
  const lesson = await f.finishLesson();
  assert.deepEqual(lesson.task?.phase, { stage: "completed", outcome: "passed" });
  f.time(start + 86_400_000);
  await f.select("py01", "review");
  for (let index = 0; index < 3; index++) {
    await f.submit();
    if (index < 2) {
      await f.advance();
    }
  }
  assert.deepEqual((await f.state()).task?.phase, { stage: "completed", outcome: "passed" });
  assert.ok((await f.student()).py01);
  if (process.env.REPA_LEARNING_EVIDENCE) {
    const parent = process.env.REPA_LEARNING_EVIDENCE;
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(path.join(parent, "py01-"));
    await writeFile(path.join(directory, "original.jsonl"), await readFile(f.session().records.file));
    await writeFile(path.join(directory, "summary.json"), JSON.stringify({
      source: "本地判分替身流程夹具",
      lessonTaskId: lesson.task?.taskId,
      reviewTaskId: (await f.state()).task?.taskId,
      student: await f.student(),
    }, null, 2));
  }
});

test("重试有推进不补救，原地卡住才补关键先修；补救失败后对应 topic 重教", async (t) => {
  const first = topic("t01");
  const later = topic("t02", 2, ["t01"]);
  for (const kp of later.kps) {
    kp.keyPrerequisites = ["t01"];
  }
  const f = await fixture(t, [first, later]);
  async function retryLesson() {
    for (let index = 0; index < 4; index++) {
      if ((await f.state()).menu?.candidates.some((entry) => entry.kind === "lesson" && entry.topicIds[0] === "t02")) {
        return f.select("t02");
      }
      await f.select("t01", "review");
      for (let question = 0; question < 3; question++) {
        await f.submit();
        if (question < 2) {
          await f.advance();
        }
      }
    }
    assert.fail("三次复习后应提供新课");
  }
  await f.select("t01");
  await f.finishLesson();
  await f.select("t02");
  await f.finishLesson([false]);
  assert.equal((await f.fold()).forced.size, 0);
  f.time(start + 48 * 3_600_000);
  await retryLesson();
  await f.advance();
  await f.advance();
  await f.submit();
  await f.advance();
  await f.submit();
  await f.advance();
  await f.advance();
  await f.advance();
  await f.finishLesson([false]);
  const progressed = await f.fold();
  assert.equal(progressed.failures.get("t02")?.kpId, "t02.k2");
  assert.equal(progressed.failures.get("t02")?.stuck, false);
  assert.equal(progressed.forced.size, 0);
  f.time(start + 96 * 3_600_000);
  await retryLesson();
  await f.finishLesson([false]);
  const stuck = await f.fold();
  assert.equal(stuck.failures.get("t02")?.stuck, true);
  assert.equal(stuck.forced.get("t01"), "review");
  await f.select("t01", "review");
  for (let index = 0; index < 5; index++) {
    await f.submit(false);
    if (index < 4) {
      await f.advance();
    }
  }
  assert.equal((await f.fold()).forced.get("t01"), "lesson");
  await f.select("t01", "lesson");
  assert.equal((await f.state()).task?.kps[0]?.completed, false);
  await f.finishLesson();
  assert.equal((await f.fold()).forced.size, 0);
});

test("菜单相近项不同列，刷新和任务前后保留候选身份；连续三次 review 后至少给出合法新课", async (t) => {
  const f = await fixture(t, [topic("t01"), topic("t02", 1, ["t01"]), topic("t03", 1, ["t01"]), topic("t04"), topic("t05")]);
  const initial = await f.state();
  assert.equal(initial.menu?.candidates.length, 3);
  assert.deepEqual(await f.state(), initial);
  await f.select("t01");
  await f.finishLesson();
  const menu = await f.state();
  assert.notEqual(menu.menu?.menuId, initial.menu?.menuId);
  assert.equal(menu.menu?.candidates[0]?.topicIds[0], "t02");
  for (const candidate of initial.menu?.candidates.filter((entry) => entry.topicIds[0] !== "t01") ?? []) {
    assert.equal(menu.menu?.candidates.find((entry) => entry.topicIds[0] === candidate.topicIds[0])?.id, candidate.id);
  }
  const siblings = menu.menu?.candidates.filter((entry) => ["t02", "t03"].includes(entry.topicIds[0] ?? ""));
  assert.equal(siblings?.length, 1);
  const fold = await f.fold();
  const decision = learningMenu(f.session().course, { ...fold, consecutiveReviews: 3 }, start + 4 * 86_400_000, "menu", () => true);
  assert.equal(decision.candidates[0]?.kind, "lesson");
});

test("申诉后判分失败不算错，重开后自动重判一次；仍失败时保留旧结果，显式恢复后追加新判分并拒绝陈旧版本", async (t) => {
  const definition = topic();
  const question = definition.kps[0]?.practice?.[0];
  assert.ok(question);
  question.slots = [{ id: "answer", type: "text", rubric: [{ id: "meaning", label: "解释含义" }] }];
  const f = await fixture(t, [definition, topic("t02")]);
  await f.select("t01");
  f.models.expectStructured().succeed({ verdict: "correct", reason: "符合" });
  f.models.expectStructured().succeed({ verdict: "correct", reason: "符合" });
  await f.finishLesson();
  const original = (await f.state()).task?.submissions[0];
  assert.ok(original);
  await f.select("t02");
  await f.finishLesson();
  f.models.expectStructured().fail(new Error("断线"));
  await f.call("submission.appeal", { submissionId: original.submissionId, expectedGradeRevision: 1, reason: "复核" });
  f.models.expectStructured().fail(new Error("仍然断线"));
  await f.reopen();
  await f.state();
  await f.settled();
  assert.equal(f.models.calls.length, 4);
  const queried = await f.call("submission.get", { submissionId: original.submissionId });
  assert.equal(queried.status, "found");
  if (queried.status === "found") {
    assert.deepEqual(queried.submission.processing, { status: "interrupted", reason: "service_failure" });
    assert.equal(queried.submission.feedback?.verdict, "correct");
  }
  assert.ok((await f.student()).t01);
  f.models.expectStructured().succeed({ verdict: "incorrect", reason: "不符合" });
  await f.call("submission.resume", { submissionId: original.submissionId });
  assert.equal((await f.student()).t01, undefined);
  assert.equal(f.session().records.facts.filter((entry) => entry.type === "appealed").length, 1);
  await assert.rejects(
    f.call("submission.appeal", { submissionId: original.submissionId, expectedGradeRevision: 1, reason: "旧请求" }),
    stale,
  );
});

test("受限开始先写下任务；中止路径失败后关闭重开，沿原 task.resume 开始计时", async (t) => {
  let failing = true;
  const f = await fixture(t, [topic()], {
    beforeRestricted: async () => {
      if (failing) {
        throw new Error("中止路径暂不可用");
      }
    },
  });
  await f.select();
  await f.finishLesson();
  f.time(start + 86_400_000);
  await assert.rejects(f.select("t01", "review"));
  const preparing = await f.state();
  assert.equal(preparing.task?.phase.stage, "preparing");
  assert.equal(preparing.task?.startedAt, null);
  assert.equal(preparing.restrictions.tutorAllowed, false);
  await f.reopen();
  const restored = await f.state();
  assert.equal(restored.task?.taskId, preparing.task?.taskId);
  assert.ok(restored.task);
  failing = false;
  const running = await f.call("task.resume", {
    taskId: restored.task.taskId,
    expectedRevision: restored.revision,
    expectedStage: "preparing",
  });
  assert.equal(running.task?.phase.stage, "awaiting_answer");
  assert.equal(running.task?.deadlineAt, start + 86_400_000 + 600_000);
});

test("两个菜单选择并发时只保留一个任务，迟到的选择不能覆盖已选择任务", async (t) => {
  const f = await fixture(t, [topic("t01"), topic("t02")]);
  const menu = (await f.state()).menu;
  assert.ok(menu);
  const results = await Promise.allSettled(
    menu.candidates.map((candidate) => f.call("menu.select", { menuId: menu.menuId, candidateId: candidate.id })),
  );
  assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(results.filter((entry) => entry.status === "rejected").length, 1);
  const selected = results.find((entry) => entry.status === "fulfilled");
  assert.ok(selected?.status === "fulfilled");
  assert.equal((await f.state()).task?.taskId, selected.value.task?.taskId);
});

test("前端一道题也显示不了时保留例题和当前任务，返回具体缺项", async (t) => {
  const f = await fixture(t);
  await f.select();
  await f.advance();
  const before = await f.state();
  assert.ok(before.task);
  await assert.rejects(
    f.call(
      "task.advance",
      { taskId: before.task.taskId, expectedRevision: before.revision, expectedStage: "example" },
      { interaction: { supports: [] }, services: [] },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error && error.code === "missing_capability");
      return true;
    },
  );
  assert.deepEqual(await f.state(), before);
  assert.equal((await f.state()).task?.deliveries.length, 0);
});

test("到期后直接中止复习先按超时结算，旧守卫被拒绝，不写事实；超时时只有一道答错的题，不足以判定失败，不更新学生模型", async (t) => {
  const f = await fixture(t);
  await f.select();
  await f.finishLesson();
  f.time(start + 86_400_000);
  await f.select("t01", "review");
  await f.submit(false);
  await f.advance();
  const current = await f.state();
  const task = current.task;
  assert.ok(task?.deadlineAt);
  const expected = await f.student();
  f.time(task.deadlineAt + 1);
  await assert.rejects(
    f.call("task.abort", { taskId: task.taskId, expectedRevision: current.revision, expectedStage: task.phase.stage }),
    stale,
  );
  assert.deepEqual((await f.state()).task?.phase, { stage: "completed", outcome: "timeout" });
  assert.deepEqual(await f.student(), expected);
  const revision = f.session().records.revision;
  await f.reopen();
  assert.deepEqual(await f.student(), expected);
  assert.equal(f.session().records.revision, revision);
});

test("后续 KP 反馈页申诉前一 KP 后拒绝倒带，保留原交付和反馈位置", async (t) => {
  const definition = topic("t01", 2);
  const question = definition.kps[0]?.practice?.[0];
  assert.ok(question);
  question.slots = [{ id: "answer", type: "text", rubric: [{ id: "meaning", label: "说明相加含义" }] }];
  const f = await fixture(t, [definition]);
  await f.select();
  await f.advance();
  await f.advance();
  f.models.expectStructured().succeed({ verdict: "correct", reason: "符合" });
  await f.submit();
  await f.advance();
  f.models.expectStructured().succeed({ verdict: "correct", reason: "符合" });
  await f.submit();
  const original = (await f.state()).task?.submissions[0];
  assert.ok(original);
  await f.advance();
  assert.equal((await f.state()).task?.phase.stage, "explanation");
  await f.advance();
  await f.advance();
  await f.submit(false);
  const before = (await f.state()).task;
  assert.equal(before?.deliveries.at(-1)?.kpId, "t01.k2");
  assert.equal(before?.phase.stage, "feedback");
  f.models.expectStructured().succeed({ verdict: "incorrect", reason: "复核不符合" });
  await f.call("submission.appeal", { submissionId: original.submissionId, expectedGradeRevision: 1, reason: "复核第一份原答" });
  assert.equal((await f.state()).task?.kps[0]?.completed, false);
  await assert.rejects(f.advance(), stale);
  assert.deepEqual((await f.state()).task?.deliveries, before?.deliveries);
  assert.deepEqual((await f.state()).task?.phase, before?.phase);
  await f.reopen();
  await assert.rejects(f.advance(), stale);
});

test("强制重教首次清除旧轮进度，失败重试保留本轮已过 KP 并从未过处计数", async (t) => {
  const later = topic("t02", 1, ["t01"]);
  const kp = later.kps[0];
  assert.ok(kp);
  kp.keyPrerequisites = ["t01"];
  const f = await fixture(t, [topic("t01", 2), later]);
  async function review(pattern: boolean[]) {
    for (const [index, correct] of pattern.entries()) {
      await f.submit(correct);
      if (index < pattern.length - 1) {
        await f.advance();
      }
    }
  }
  await f.select("t01");
  await f.finishLesson();
  await f.select("t02");
  await f.finishLesson([false]);
  f.time(start + 48 * 3_600_000);
  for (let index = 0; index < 3; index++) {
    if ((await f.state()).menu?.candidates.some((entry) => entry.kind === "lesson")) {
      break;
    }
    await f.select("t01", "review");
    await review([true, true, true]);
  }
  await f.select("t02", "lesson");
  await f.finishLesson([false]);
  await f.select("t01", "review");
  await review([false, false, false, false, false]);
  await f.select("t01", "lesson");
  assert.deepEqual((await f.state()).task?.kps.map((entry) => entry.completed), [false, false]);
  await f.advance();
  await f.advance();
  await f.submit();
  await f.advance();
  await f.submit();
  await f.advance();
  await f.advance();
  await f.advance();
  await review([false, false, false, false, false]);
  assert.deepEqual((await f.state()).task?.kps.map((entry) => entry.completed), [true, false]);
  await f.reopen();
  f.time(start + 96 * 3_600_000);
  const retried = await f.select("t01", "lesson");
  assert.deepEqual(retried.task?.kps.map((entry) => entry.completed), [true, false]);
  assert.deepEqual(retried.task?.kps.map((entry) => entry.attempts), [0, 0]);
  assert.equal(retried.task?.phase.stage, "explanation");
  if (retried.task?.phase.stage === "explanation") {
    assert.equal(retried.task.phase.page.ref.kpId, "t01.k2");
  }
  await f.finishLesson();
  assert.ok((await f.state()).task?.deliveries.every((entry) => entry.kpId === "t01.k2"));
  assert.equal((await f.fold()).forced.has("t01"), false);
});

test("冷却在当天到期后读取状态恢复菜单，不写事实；重复读取和重开不重抽候选", async (t) => {
  const f = await fixture(t);
  const failedAt = start + 12 * 3_600_000;
  const availableAt = failedAt + 48 * 3_600_000;
  f.time(failedAt);
  await f.select();
  await f.finishLesson([false]);
  assert.equal((await f.state()).menu?.availableAt, availableAt);
  f.time(availableAt - 3_600_000);
  const morning = await f.state();
  assert.deepEqual(morning.menu?.candidates, []);
  assert.deepEqual((await f.state()).menu, morning.menu);
  f.time(availableAt);
  const ready = await f.state();
  assert.deepEqual(ready.menu?.candidates.map((entry) => entry.topicIds[0]), ["t01"]);
  assert.equal(ready.menu?.availableAt, undefined);
  assert.equal(ready.menu?.menuId, morning.menu?.menuId);
  // 到时自然发生的变化不写事实，revision 不变。
  assert.equal(ready.revision, morning.revision);
  assert.deepEqual((await f.state()).menu, ready.menu);
  await f.reopen();
  assert.deepEqual((await f.state()).menu, ready.menu);
  assert.equal((await f.state()).revision, ready.revision);
});

for (const delay of [0, 600_000]) {
  test(`第五份及时原答判分延迟 ${delay} 毫秒仍按五次失败和接受时间更新`, async (t) => {
    const definition = topic();
    const question = definition.kps[0]?.review?.[0];
    assert.ok(question);
    question.slots = [{ id: "answer", type: "text", rubric: [{ id: "meaning", label: "说明相加含义" }] }];
    const f = await fixture(t, [definition]);
    await f.select();
    await f.finishLesson();
    const reviewStart = start + 86_400_000;
    f.time(reviewStart);
    await f.select("t01", "review");
    const student = await f.student();
    for (let index = 0; index < 4; index++) {
      await f.submit(false);
      await f.advance();
    }
    const acceptedAt = reviewStart + 60_000;
    f.time(acceptedAt);
    const pending = f.models.expectStructured();
    const work = f.submit();
    await pending.requested;
    f.time(acceptedAt + delay);
    pending.succeed({ verdict: "incorrect", reason: "不符合" });
    const receipt = await work;
    assert.equal(receipt.status, "recorded");
    assert.deepEqual((await f.state()).task?.phase, { stage: "completed", outcome: "failed" });
    const expected = updateStudent(f.session().course.graph, student, { topicId: "t01", outcome: "fail", quality: 1 }, acceptedAt);
    assert.deepEqual(await f.student(), expected);
    await f.reopen();
    assert.deepEqual(await f.student(), expected);
  });
}

test("交付的选项顺序与编号来自记在事实里的 seed，重开按 seed 重建同样的画面而不重新抽取", async (t) => {
  const definition = topic();
  const question = definition.kps[0]?.practice?.[0];
  assert.ok(question);
  const ids = ["index", "sample_id", "signal"];
  question.slots = [
    { id: "choice", type: "choice", key: "index", options: ids.map((id) => ({ id, content: id })) },
    { id: "order", type: "order", key: ids, items: ids.map((id) => ({ id, content: id })) },
    {
      id: "table",
      type: "table",
      columns: [{ id: "v", header: "列", input: { type: "choice", options: ids.map((id) => ({ id, label: id })) } }],
      rows: [{ id: "row", cells: { v: "index" } }],
    },
  ];
  const draws: unknown[][] = [];
  const random = t.mock.method(crypto, "randomInt", (...args: unknown[]) => {
    draws.push(args);
    return 7;
  });
  syncBuiltinESMExports();
  t.after(() => {
    random.mock.restore();
    syncBuiltinESMExports();
  });
  const f = await fixture(t, [definition]);
  await f.select();
  await f.advance();
  await f.advance();
  assert.deepEqual(draws, [[0, 0x1_0000_0000]]);
  const delivered = f.session().records.facts.find((fact) => fact.type === "delivered");
  assert.ok(delivered?.type === "delivered");
  assert.equal(delivered.seed, 7);
  const frozen = (await f.state()).task?.deliveries;
  assert.ok(frozen?.[0]);
  const order = frozen[0].item.slots.find((slot) => slot.type === "order");
  assert.ok(order?.type === "order");
  assert.equal(new Set(order.items.map((item) => item.id)).size, 3);
  assert.ok(order.items.every((item) => !ids.includes(item.id)));
  await f.reopen();
  assert.deepEqual((await f.state()).task?.deliveries, frozen);
  assert.equal(draws.length, 1);
  const record = f.session().replay.delivery(deliverySeq(frozen[0]));
  assert.ok(record);
  assert.deepEqual((await f.session().render(record)).delivery, frozen[0]);
  const receipt = await f.submit();
  assert.equal(receipt.status, "recorded");
  if (receipt.status === "recorded") {
    assert.equal(receipt.submission.feedback?.verdict, "correct");
  }
});

/** 一道排序题：要前端能显示排序作答位。 */
function orderQuestion(id: string): Question {
  return {
    id,
    body: "把两步排好。",
    explanation: "先算右边，再起名。",
    slots: [{ id: "answer", type: "order", items: [{ id: "right", content: "算出右边" }, { id: "name", content: "起名" }], key: ["right", "name"] }],
  };
}

/** 一道开放题：要由模型按 rubric 判分。 */
function openQuestion(id: string): Question {
  return {
    id,
    body: "说说 1 + 1 为什么等于 2。",
    explanation: "两个一。",
    slots: [{ id: "answer", type: "text", rubric: [{ id: "meaning", label: "说明相加的含义" }] }],
  };
}

const failed = (code: string) => (error: unknown) => error instanceof Error && "code" in error && error.code === code;

test("先筛掉前端显示不了的题再选题：课只出这个前端能显示的题；一道也显示不了的知识点所在的课不进这个前端的菜单", async (t) => {
  const first = topic("t01");
  const kp = first.kps[0];
  assert.ok(kp);
  kp.practice = [orderQuestion("t01.k1.q0"), ...(kp.practice ?? [])];
  const second = topic("t02");
  const only = second.kps[0];
  assert.ok(only);
  only.practice = [orderQuestion("t02.k1.q1")];
  const f = await fixture(t, [first, second]);
  const limited = { interaction: { supports: ["slot.text", "block.markdown"] }, services: [] };
  assert.deepEqual((await f.state()).menu?.candidates.map((entry) => entry.topicIds[0]).sort(), ["t01", "t02"]);
  const menu = (await f.call("state.get", {}, limited)).menu;
  assert.ok(menu?.candidates[0]);
  assert.deepEqual(menu.candidates.map((entry) => entry.topicIds[0]), ["t01"]);
  await f.call("menu.select", { menuId: menu.menuId, candidateId: menu.candidates[0].id }, limited);
  for (let step = 0; step < 2; step++) {
    const current = await f.call("state.get", {}, limited);
    assert.ok(current.task);
    await f.call("task.advance", { taskId: current.task.taskId, expectedRevision: current.revision, expectedStage: current.task.phase.stage }, limited);
  }
  // 排序题排在前面，也还没出过，但这个前端显示不了：出的是同一知识点的文字题，任务照常往下走。
  const task = (await f.call("state.get", {}, limited)).task;
  assert.equal(task?.phase.stage, "awaiting_answer");
  const delivery = task?.deliveries[0];
  assert.ok(delivery);
  assert.equal(f.session().replay.delivery(deliverySeq(delivery))?.questionId, "t01.k1.q1");
  assert.deepEqual(delivery.item.requires, ["block.markdown", "slot.text"]);
});

test("没有可用模型时不出开放题：课从同一知识点的其他题里选，只有开放题的知识点所在的课不进菜单；配好模型以后照常出", async (t) => {
  const first = topic("t01");
  const kp = first.kps[0];
  assert.ok(kp);
  kp.practice = [openQuestion("t01.k1.q0"), ...(kp.practice ?? [])];
  const second = topic("t02");
  const only = second.kps[0];
  assert.ok(only);
  only.practice = [openQuestion("t02.k1.q1")];
  const f = await fixture(t, [first, second]);
  f.models.setDefaultModel(undefined);
  assert.deepEqual((await f.state()).menu?.candidates.map((entry) => entry.topicIds[0]), ["t01"]);
  await f.select("t01");
  await f.advance();
  await f.advance();
  const delivery = (await f.state()).task?.deliveries[0];
  assert.ok(delivery);
  assert.equal(f.session().replay.delivery(deliverySeq(delivery))?.questionId, "t01.k1.q1");
  await f.finishLesson();
  assert.equal(f.models.calls.length, 0);
  assert.equal((await f.state()).menu?.candidates.length, 0);
  // 配好模型：只有开放题的课回到菜单，开放题照常交付。
  f.models.setDefaultModel({ provider: "test", id: "test" });
  await f.select("t02");
  await f.advance();
  await f.advance();
  const open = (await f.state()).task?.deliveries[0];
  assert.ok(open);
  assert.equal(f.session().replay.delivery(deliverySeq(open))?.questionId, "t02.k1.q1");
});

test("没有可用模型时不自动补判开放题，课里只剩开放题时报告 model_required 并保留任务；配好模型后的第一次调用才补判", async (t) => {
  const definition = topic("t01");
  const kp = definition.kps[0];
  assert.ok(kp);
  kp.practice = [openQuestion("t01.k1.q1")];
  const f = await fixture(t, [definition]);
  await f.select("t01");
  await f.advance();
  await f.advance();
  f.models.expectStructured().fail(new Error("断网"));
  const pending = await f.submit();
  assert.ok(pending.status === "recorded");
  assert.equal(f.models.calls.length, 1);
  // 模型没了（例如退出登录）再打开：开放题的作答等着，不去调用模型。
  f.models.setDefaultModel(undefined);
  await f.reopen();
  await f.state();
  await f.settled();
  assert.equal(f.models.calls.length, 1);
  const waiting = await f.call("submission.get", { submissionId: pending.submission.submissionId });
  assert.ok(waiting.status === "found");
  assert.deepEqual(waiting.submission.processing, { status: "interrupted", reason: "restart" });
  // 这个知识点只剩开放题：不出题，报告缺模型，任务原样保留，学习者可以中止。
  const before = await f.state();
  assert.equal(before.task?.phase.stage, "recovery");
  await assert.rejects(f.advance(), failed("model_required"));
  assert.deepEqual(await f.state(), before);
  // 配好模型：下一次调用在后台补判一次。
  f.models.setDefaultModel({ provider: "test", id: "test" });
  f.models.expectStructured().succeed({ verdict: "correct", reason: "说明了含义" });
  await f.state();
  await f.settled();
  assert.equal(f.models.calls.length, 2);
  const graded = await f.call("submission.get", { submissionId: pending.submission.submissionId });
  assert.ok(graded.status === "found");
  assert.deepEqual(graded.submission.processing, { status: "completed" });
});

for (const weight of [0.5, 0]) {
  test(`FIRe 按课程里的权重生效（权重 ${weight}）：学会覆盖它的 topic 时，到期的 topic ${weight ? "得到隐式复习，菜单不再出它的复习" : "不受影响，复习照旧"}`, async (t) => {
    const advanced = topic("t02");
    advanced.encompassings = [{ topic: "t01", weight }];
    const f = await fixture(t, [topic("t01"), advanced]);
    await f.select("t01");
    await f.finishLesson();
    const learned = (await f.student()).t01;
    assert.ok(learned);
    f.time(start + 86_400_000);
    const review = (entry: { kind: string; topicIds: string[] }) => entry.kind === "review" && entry.topicIds[0] === "t01";
    assert.ok((await f.state()).menu?.candidates.some(review));
    await f.select("t02");
    await f.finishLesson();
    const after = (await f.student()).t01;
    assert.ok(after);
    const menu = (await f.state()).menu;
    if (weight > 0) {
      // 一天后 t01 到期，信用按权重传过来：repNum 加上权重，memory 回到到期线以上。
      assert.equal(after.repNum, learned.repNum + weight);
      assert.equal(menu?.candidates.some(review), false);
    } else {
      assert.deepEqual(after, learned);
      assert.ok(menu?.candidates.some(review));
    }
    const student = await f.student();
    await f.reopen();
    assert.deepEqual(await f.student(), student);
  });
}

test("时钟回拨到上次学习之前时按零间隔继续：菜单照常给出，学完的课照常记入学生模型，重开以后状态相同", async (t) => {
  const f = await fixture(t, [topic("t01"), topic("t02")]);
  f.time(start + 86_400_000);
  await f.select("t01");
  await f.finishLesson();
  const learned = (await f.student()).t01;
  assert.ok(learned);
  // 时钟回拨一小时，早于 t01 上次更新的时刻：以前在这里报 model_time_conflict，学习就停住了。
  f.time(start + 86_400_000 - 3_600_000);
  assert.ok((await f.state()).menu?.candidates.some((entry) => entry.topicIds[0] === "t02"));
  await f.select("t02");
  await f.finishLesson();
  const student = await f.student();
  // 模型的时间不倒退：t02 记在最近一次更新的时刻，t01 不受影响。
  assert.equal(student.t02?.lastRepetitionDay, learned.lastRepetitionDay);
  assert.deepEqual(student.t01, learned);
  await f.reopen();
  assert.deepEqual(await f.student(), student);
});

test("课交给学生模型的质量按独立答对的比例计：一错两对通过的课比全对的课早到期", async (t) => {
  const f = await fixture(t, [topic("t01"), topic("t02")]);
  await f.select("t01");
  await f.finishLesson([false, true, true]);
  await f.select("t02");
  await f.finishLesson();
  const student = await f.student();
  assert.equal(student.t01?.repNum, 2 / 3);
  assert.equal(student.t01?.memory, 2 / 3);
  assert.equal(student.t02?.repNum, 1);
  assert.equal(student.t02?.memory, 1);
  f.time(start + 12 * 3_600_000);
  const menu = (await f.state()).menu;
  assert.ok(menu?.candidates.some((entry) => entry.kind === "review" && entry.topicIds[0] === "t01"));
  assert.equal(menu?.candidates.some((entry) => entry.kind === "review" && entry.topicIds[0] === "t02"), false);
});

for (const hidden of [false, true]) {
  test(hidden
    ? "到期的 topic 覆盖另外两个到期复习、而这个前端显示不了它的复习题时，菜单照样给出那两个复习，不被它压掉而空着"
    : "还没到期的 topic 以权重覆盖两个到期复习时，菜单照样给出这两个复习，不被它压掉而空着", async (t) => {
    const covering = topic("t03");
    covering.encompassings = [{ topic: "t01", weight: 0.5 }, { topic: "t02", weight: 0.5 }];
    if (hidden) {
      const kp = covering.kps[0];
      assert.ok(kp);
      kp.review = [orderQuestion("t03.k1.r1")];
    }
    const f = await fixture(t, [topic("t01"), topic("t02"), covering]);
    for (const id of ["t01", "t02"]) {
      await f.select(id);
      await f.finishLesson();
    }
    // 一天后 t01、t02 到期，学会覆盖它们的 t03，它们得到隐式复习。
    f.time(start + 86_400_000);
    await f.select("t03");
    await f.finishLesson();
    // 再过不到一天，t01、t02 又到期而 t03 还没有；再过一天半，三个都到期，t03 的复习题这个前端却显示不了。
    f.time(start + (hidden ? 2.5 : 1.9) * 86_400_000);
    const limited = { interaction: { supports: ["slot.text", "block.markdown"] }, services: [] };
    const reviews = (state: { menu: { candidates: { kind: string; topicIds: string[] }[] } | null }) =>
      state.menu?.candidates.map((entry) => [entry.kind, entry.topicIds[0]]).sort();
    assert.deepEqual(reviews(await f.call("state.get", {}, hidden ? limited : clientCapabilities)), [["review", "t01"], ["review", "t02"]]);
    if (hidden) {
      // 显示得了的前端照样只给 t03 的复习：做它就同时复习了另外两个。
      assert.deepEqual(reviews(await f.state()), [["review", "t03"]]);
    }
  });
}
