/**
 * 学习记录只记事实：答案改正后的重判、没有证据时不阻塞、从事实重算状态、归属改变不换版本，
 * 以及每次作答写入的字节数和重算次数这两道代价关卡。
 */
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import test from "node:test";
import type { Fact } from "../src/records-schema.js";
import { Replay } from "../src/replay.js";
import { learningFixture as fixture, start, topic } from "./fixtures/learning-session.js";

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

test("题目的知识点归属改变时题目版本不变，过去的作答照样对得上，不重判，状态不变", async (t) => {
  const f = await fixture(t, [topic("t01"), topic("t02")]);
  await f.select("t01");
  await f.finishLesson();
  const before = await f.state();
  const count = graded(f).length;
  const changed = topic("t01");
  const question = changed.kps[0]?.practice?.[0];
  assert.ok(question);
  question.measures = ["t01.k1"];
  question.uses = ["t02.k1"];
  await f.writeTopics([changed, topic("t02")]);
  await f.reopen();
  assert.deepEqual(await f.state(), before);
  assert.equal(graded(f).length, count);
  const versions = await f.session().course.versionsOf("t01.k1.q1");
  assert.ok(versions);
  assert.ok(graded(f).every((fact) => fact.version === versions.question));
});

test("代价关卡：每次作答只写交付、作答、判分三条事实，字节数有上限且不随历史增长", async (t) => {
  // 上限由事实的构成推出：三条事实的序号、时间与引用，题目 id（最多 120 字符），两个 sha256 版本，
  // 一个作答位的判分结论。学习者的作答和模型给的理由另计，它们本身有长度上限。
  const fixedLimit = 640;
  const definition = topic("t01", 3);
  const open = definition.kps[2]?.practice?.[0];
  assert.ok(open);
  open.slots = [{ id: "answer", type: "text", rubric: [{ id: "meaning", label: "说明相加的含义" }] }];
  const f = await fixture(t, [definition, topic("t02", 3, ["t01"]), topic("t03", 3, ["t02"])]);
  const size = async () => (await stat(f.session().records.file)).size;
  const sizes: number[] = [];
  for (const id of ["t01", "t02", "t03"]) {
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
        const payload = written.reduce((sum, fact) => {
          if (fact.type === "answered") return sum + Buffer.byteLength(JSON.stringify(fact.answers));
          if (fact.type === "graded") return sum + Object.values(fact.slots).reduce((total, slot) => total + Buffer.byteLength(slot.reason ?? ""), 0);
          return sum;
        }, 0);
        const bytes = (await size()) - before;
        assert.ok(bytes - payload <= fixedLimit, `一次作答写入 ${bytes} 字节，作答与理由 ${payload} 字节`);
        sizes.push(bytes - payload);
      } else {
        await f.advance();
      }
    }
  }
  assert.equal(sizes.length, 18);
  // 第一份和最后一份作答的固定部分只差序号多出来的几位数。
  assert.ok(Math.abs((sizes.at(-1) ?? 0) - (sizes[0] ?? 0)) <= 12, JSON.stringify(sizes));
});

test("代价关卡：作答和任务结束都增量更新，重判更早任务的作答才整段重算一次；打开空间时每条事实只重放一次", async (t) => {
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
  // 申诉重判 t01 的作答：它属于更早的任务，之后的学习状态整段重算一次，重复读取不再重算。
  f.models.expectStructured().succeed({ verdict: "correct", reason: "复核仍然符合" });
  await f.call("submission.appeal", { submissionId: original.submissionId, expectedGradeRevision: 1, reason: "复核" });
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
