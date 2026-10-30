import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import type { Services } from "@repa/base/plugin";
import { createSpace, openPluginHost, openSpace } from "@repa/base";
import { ModelTestDriver } from "@repa/base/testing";
import { INTERACTION_CAPABILITIES, parse, type ClientCapabilities } from "@repa/base/protocol";
import { PYTHON_BATCH, PythonBatchInputSchema } from "@repa/python-runner/protocol";
import { stringify } from "yaml";
import { expectedBinding, runnerVersion, type Expected } from "../src/python-execution.js";
import { createLearningPlugin } from "../src/plugin.js";
import {
  learningMethods,
  type LearningInput,
  type LearningMethod,
  type LearningResult,
} from "../src/protocol.js";
import { referenceResponse, topicQuestions } from "../src/check/items.js";
import { mapAnswer } from "../src/delivery.js";
import { connectLearning } from "../src/flow.js";
import { graphFor, replayLearning, taskEvidence } from "../src/flow-state.js";
import { learningMenu } from "../src/flow-menu.js";
import { updateStudent } from "../src/student-model.js";
import { LearningRecords } from "../src/records.js";
import type { Course, Question, Topic } from "../src/format/schema.js";
import type { ResolvedCourse } from "../src/course-sources.js";

const start = 1_792_454_400_000;
const clientCapabilities: ClientCapabilities = {
  interaction: { supports: [...INTERACTION_CAPABILITIES] },
  services: ["python.run"],
};
const course: Course = {
  id: "test",
  title: "测试",
  version: "1.0.0",
  language: "zh-CN",
  license: "Apache-2.0",
  runtime: { pyodide: "314.0.7", python: "3.14.2", packages: {} },
  sources: {},
  topics: [],
};
function topic(id = "t01", count = 1, prerequisites: string[] = []): Topic {
  return {
    id,
    title: id,
    status: "complete",
    minutes: 5,
    prerequisites,
    sources: [],
    kps: Array.from({ length: count }, (_, index) => {
      const kpId = `${id}.k${index + 1}`;
      const question: Question = {
        id: `${kpId}.q1`,
        body: "一加一？",
        explanation: "二。",
        slots: [{ id: "answer", type: "text", key: "2" }],
      };
      return {
        id: kpId,
        title: kpId,
        lesson: "讲解",
        example: { ...question, id: `${kpId}.e1` },
        practice: [question],
        review: [{ ...question, id: `${kpId}.r1` }],
      };
    }),
  };
}
async function fixture(
  t: TestContext,
  topics = [topic()],
  bundled = false,
  services?: Services,
  beforeRestricted?: () => Promise<void>,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-learning-flow-"));
  const directory = path.join(root, "course");
  await mkdir(path.join(directory, "topics"), { recursive: true });
  const manifest = { ...course, topics: topics.map((entry) => entry.id) };
  await writeFile(path.join(directory, "course.yaml"), stringify(manifest));
  for (const entry of topics) {
    await writeFile(
      path.join(directory, "topics", `${entry.id}.yaml`),
      stringify(entry, { aliasDuplicateObjects: false }),
    );
  }
  const expected: Record<string, Expected> = {};
  for (const definition of topics) {
    for (const { question } of topicQuestions(definition)) {
      expected[question.id] = {
        binding: await expectedBinding(question, definition, manifest.runtime, await runnerVersion()),
        values: Object.fromEntries(
          question.slots
            .filter((slot) => slot.type === "code")
            .map((slot) => [slot.id, slot.type === "code" ? slot.tests.map(() => ({ x: { t: "int", v: "2" } })) : []]),
        ),
      };
    }
  }
  await writeFile(path.join(directory, "expected.json"), JSON.stringify(expected));
  let now = start;
  let log: LearningRecords | undefined;
  const resolved: ResolvedCourse = { course: manifest, topics, origins: {} };
  const models = new ModelTestDriver();
  const plugin = createLearningPlugin({
    sources: [
      {
        kind: "bundled",
        directory: bundled ? fileURLToPath(new URL("../courses/python", import.meta.url)) : directory,
      },
    ],
    now: () => now,
    connect: async (records, loaded, host) => {
      log = records;
      return connectLearning(records, loaded, host, () => now, { beforeRestricted });
    },
  });
  let space = await createSpace(path.join(root, "space"), { watch: false });
  let host = await openPluginHost({
    space,
    plugins: [plugin],
    models,
    ...(services ? { services } : {}),
    emit: () => {},
    onError: (error) => {
      throw error;
    },
  });
  t.after(async () => {
    await host.close();
    await space.close();
    await rm(root, { recursive: true, force: true });
  });
  const call = async <M extends LearningMethod>(
    method: M,
    input: LearningInput<M>,
    capabilities = clientCapabilities,
  ): Promise<LearningResult<M>> => {
    // 与生产处理器一致先检查返回值，再在测试边界恢复方法泛型。
    return parse(
      learningMethods[method].result,
      await host.call("learning", method, input, { capabilities }),
    ) as LearningResult<M>;
  };
  const state = () => call("state.get", {});
  async function advance() {
    const current = await state();
    const task = current.task;
    assert.ok(task);
    return call("task.advance", {
      taskId: task.taskId,
      expectedRevision: current.revision,
      expectedStage: task.phase.stage,
    });
  }
  async function select(id?: string, kind?: "lesson" | "review") {
    const current = await state();
    const candidate = current.menu?.candidates.find(
      (entry) => (!id || entry.topicIds[0] === id) && (!kind || entry.kind === kind),
    );
    assert.ok(candidate, JSON.stringify(current.menu));
    assert.ok(current.menu);
    return call("menu.select", { menuId: current.menu.menuId, candidateId: candidate.id });
  }
  async function input(correct = true) {
    const current = await state();
    const task = current.task;
    assert.ok(task);
    assert.equal(task.phase.stage, "awaiting_answer");
    const delivery = task.deliveries.at(-1);
    assert.ok(delivery);
    const snapshot = log?.snapshot(log.current()?.deliveries[delivery.deliveryId] ?? "");
    assert.ok(snapshot);
    const question = topicQuestions(snapshot.topic).find(
      (entry) => entry.question.id === snapshot.questionId,
    )?.question;
    assert.ok(question);
    const response = referenceResponse(question, delivery.item);
    for (const slot of delivery.item.slots) {
      const answer = response.answers[slot.id];
      if (answer) {
        response.answers[slot.id] = mapAnswer(answer, slot, snapshot.idMap, true);
      }
    }
    if (!correct) {
      return {
        taskId: task.taskId,
        deliveryId: delivery.deliveryId,
        submissionId: delivery.submissionId,
        response: { item: response.item, answers: {}, dontKnow: true as const },
      };
    }
    return { taskId: task.taskId, deliveryId: delivery.deliveryId, submissionId: delivery.submissionId, response };
  }
  async function submit(correct = true) {
    return call("submission.submit", await input(correct));
  }
  async function finishLesson(pattern: boolean[] = [true, true]) {
    let current = await state();
    let index = 0;
    while (current.task && !["completed", "aborted"].includes(current.task.phase.stage)) {
      if (current.task.phase.stage === "awaiting_answer") {
        await submit(pattern[index++ % pattern.length] ?? true);
      } else {
        await advance();
      }
      current = await state();
      assert.ok(index < 50);
    }
    return current;
  }
  return {
    root,
    resolved,
    models,
    call,
    state,
    select,
    advance,
    submit,
    input,
    finishLesson,
    log: () => {
      assert.ok(log);
      return log;
    },
    time: (value: number) => {
      now = value;
    },
    async reopen() {
      await host.close();
      await space.close();
      space = await openSpace(path.join(root, "space"), { watch: false });
      host = await openPluginHost({
        space,
        plugins: [plugin],
        models,
        ...(services ? { services } : {}),
        emit: () => {},
        onError: (error) => {
          throw error;
        },
      });
    },
  };
}

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
    if (correct !== true || f.log().current()?.state.task?.kps[0]?.attempts !== 5) {
      await f.advance();
    }
  }
  assert.equal(f.log().current()?.state.task?.kps[0]?.completed, true);
  assert.equal(f.log().current()?.state.task?.kps[1]?.attempts, 0);
  assert.deepEqual(f.log().current()?.student, {});
  const result = await f.finishLesson();
  assert.deepEqual(result.task?.phase, { stage: "completed", outcome: "passed" });
  assert.ok(f.log().current()?.student.t01);
  assert.equal(f.log().current()?.student.t02, undefined);
  assert.equal(result.menu?.candidates[0]?.topicIds[0], "t02");
  const frozen = await f.state();
  assert.deepEqual(await f.state(), frozen);
  await f.reopen();
  assert.deepEqual(await f.state(), frozen);
});

test("结构错误不计尝试；事前辅助后正确保留判分但中断连对，事后帮助不撤回结果", async (t) => {
  const f = await fixture(t);
  await f.select();
  await f.advance();
  await f.advance();
  const input = await f.input();
  const rejected = await f.call("submission.submit", { ...input, response: { ...input.response, answers: {} } });
  assert.equal(rejected.status, "rejected");
  assert.equal(f.log().current()?.state.task?.kps[0]?.attempts, 0);
  const task = (await f.state()).task;
  assert.ok(task);
  const ref = {
    courseId: "test",
    topicId: "t01",
    kpId: "t01.k1",
    id: "help",
    version: input.response.item.version,
    kind: "kp" as const,
  };
  await f.log().viewed({ taskId: task.taskId, deliveryId: input.deliveryId, action: "help_before", ref });
  const receipt = await f.call("submission.submit", input);
  assert.equal(receipt.status, "recorded");
  if (receipt.status === "recorded") {
    assert.equal(receipt.submission.feedback?.verdict, "correct");
  }
  assert.equal(f.log().current()?.state.task?.kps[0]?.consecutiveCorrect, 0);
  await f.log().viewed({ taskId: task.taskId, deliveryId: input.deliveryId, action: "help_after", ref });
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
  test(`隔天复习 ${pattern
    .map((entry) => (entry ? "对" : "错"))
    .join("")} 得到 ${outcome}，结束后才释放反馈`, async (t) => {
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
    assert.deepEqual(
      result.task?.deliveries.slice(0, 2).map((entry) => entry.kpId),
      order,
    );
    assert.ok(result.task?.submissions.every((entry) => entry.feedback));
    assert.equal(result.restrictions.referenceContentAllowed, true);
    assert.equal(f.log().current()?.student.t01?.repNum, outcome === "passed" ? 1.6 : 0.6);
  });
}

test("复习关闭重开不暂停，超时无作答只更新一次", async (t) => {
  const f = await fixture(t);
  await f.select();
  await f.finishLesson();
  f.time(start + 86_400_000);
  await f.select("t01", "review");
  const started = await f.state();
  await f.reopen();
  assert.equal((await f.state()).task?.deadlineAt, started.task?.deadlineAt);
  f.time(start + 3 * 86_400_000);
  const timedOut = await f.state();
  assert.deepEqual(timedOut.task?.phase, { stage: "completed", outcome: "timeout" });
  const student = f.log().current()?.student;
  assert.equal(student?.t01?.lastRepetitionDay, (start + 86_400_000 + 600_000) / 86_400_000);
  await f.reopen();
  assert.deepEqual(f.log().current()?.student, student);
});

test("去掉一份关键原答的证据副本改变同一时刻的新课资格，原始日志字节不变", async (t) => {
  const f = await fixture(t, [topic(), topic("t02", 1, ["t01"])]);
  await f.select();
  await f.finishLesson();
  const bytes = await readFile(f.log().file);
  const evidence = taskEvidence(f.log().records);
  const actual = learningMenu(f.resolved, evidence, start, null, () => true);
  const removed = evidence[0]?.attempts[0]?.submission.submissionId;
  assert.ok(removed);
  const copy = f
    .log()
    .records.filter(
      (record) =>
        !(record.type === "accepted" && record.submission.submissionId === removed) &&
        !(record.type === "graded" && record.submissionId === removed),
    );
  const counterfactual = taskEvidence(copy);
  const alternative = learningMenu(f.resolved, counterfactual, start, null, () => true);
  assert.deepEqual(
    actual.menu.candidates.map((entry) => entry.topicIds[0]),
    ["t02"],
  );
  assert.deepEqual(alternative.menu.candidates, []);
  assert.equal(alternative.menu.availableAt, start + 48 * 3_600_000);
  assert.deepEqual(actual.model.student, f.log().current()?.student);
  assert.deepEqual(await readFile(f.log().file), bytes);
  assert.deepEqual(graphFor(f.resolved).encompassings, []);
  assert.equal(replayLearning(counterfactual, f.resolved).student.t01, undefined);
  if (process.env.REPA_LEARNING_EVIDENCE) {
    const parent = process.env.REPA_LEARNING_EVIDENCE;
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(path.join(parent, "counterfactual-"));
    await writeFile(path.join(directory, "original.jsonl"), bytes);
    await writeFile(path.join(directory, "counterfactual-records.json"), JSON.stringify(copy, null, 2));
    await writeFile(
      path.join(directory, "comparison.json"),
      JSON.stringify(
        { decisionNow: start, removedSubmissionId: removed, actual: actual.menu, counterfactual: alternative.menu },
        null,
        2,
      ),
    );
  }
});

test("公开选择项、排列块与表格格内选项换号，反馈映回相同 id，数据行保留顺序", async (t) => {
  const definition = topic();
  const question = definition.kps[0]?.practice?.[0];
  assert.ok(question);
  question.slots = [
    {
      id: "choice",
      type: "choice",
      options: [
        { id: "yes", content: "对" },
        { id: "no", content: "错" },
      ],
      key: "yes",
    },
    {
      id: "order",
      type: "order",
      items: [
        { id: "first", content: "先" },
        { id: "second", content: "后" },
      ],
      key: ["first", "second"],
    },
    {
      id: "table",
      type: "table",
      columns: [{ id: "v", header: "数值", input: "bool" }],
      rows: [
        { id: "row1", cells: { v: true } },
        { id: "row2", cells: { v: false } },
      ],
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
  assert.deepEqual(
    table.rows.map((row) => row.id),
    ["row1", "row2"],
  );
  assert.equal(JSON.stringify(delivery.item).includes('"id":"yes"'), false);
  const result = await f.call("submission.submit", input);
  assert.equal(result.status, "recorded");
  if (result.status === "recorded") {
    assert.equal(result.submission.feedback?.verdict, "correct");
    assert.deepEqual(
      result.submission.feedback?.slots?.choice?.expected,
      input.response.answers["choice" as keyof typeof input.response.answers],
    );
  }
  await f.advance();
  assert.equal((await f.state()).task?.deliveries.at(-1)?.repeated, true);
});

test("开放题只送本题与原答；服务失败和 unsure 不计失败，显式恢复后推进一次", async (t) => {
  const definition = topic();
  const question = definition.kps[0]?.practice?.[0];
  assert.ok(question);
  question.slots = [{ id: "answer", type: "text", rubric: [{ id: "meaning", label: "说明相加含义。" }] }];
  const f = await fixture(t, [definition]);
  await f.select();
  await f.advance();
  await f.advance();
  const failure = f.models.expectStructured();
  failure.fail(new Error("服务断开"));
  const input = await f.input();
  const failed = await f.call("submission.submit", input);
  assert.equal(failed.status, "recorded");
  if (failed.status === "recorded") {
    assert.deepEqual(failed.submission.processing, { status: "interrupted", reason: "service_failure" });
  }
  assert.equal(f.log().current()?.state.task?.kps[0]?.attempts, 0);
  await f.reopen();
  assert.equal(f.models.calls.length, 1);
  const uncertain = f.models.expectStructured();
  uncertain.succeed({ verdict: "unsure", reason: "信息不足" });
  await f.call("submission.resume", { submissionId: input.submissionId });
  assert.equal(f.log().current()?.state.task?.kps[0]?.attempts, 0);
  f.models.expectStructured().succeed({ verdict: "invalid" });
  await f.call("submission.resume", { submissionId: input.submissionId });
  assert.equal(f.log().current()?.state.task?.kps[0]?.attempts, 0);
  const completion = f.models.expectStructured();
  completion.succeed({ verdict: "correct", reason: "符合 rubric" });
  const result = await f.call("submission.resume", { submissionId: input.submissionId });
  const request = await completion.requested;
  assert.deepEqual(Object.keys(JSON.parse(request.prompt)).sort(), ["answer", "question", "reference", "rubric"]);
  assert.equal(result.status, "recorded");
  if (result.status === "recorded") {
    assert.equal(result.submission.feedback?.judge, "model");
  }
  assert.equal(f.log().current()?.state.task?.kps[0]?.attempts, 1);
  await f.call("submission.submit", input);
  assert.equal(f.models.calls.length, 4);
  assert.equal(f.log().records.filter((entry) => entry.type === "accepted").length, 1);
});

test("复习截止前收下的待判开放答案，截止后恢复仍参与通过判定", async (t) => {
  const definition = topic();
  const review = definition.kps[0]?.review?.[0];
  assert.ok(review);
  review.slots = [{ id: "answer", type: "text", rubric: [{ id: "meaning", label: "说明相加含义" }] }];
  const f = await fixture(t, [definition]);
  await f.select();
  await f.finishLesson();
  f.time(start + 86_400_000);
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
  await f.reopen();
  assert.equal((await f.state()).task?.phase.stage, "recovery");
  f.models.expectStructured().succeed({ verdict: "correct", reason: "符合" });
  await f.call("submission.resume", { submissionId: receipt.submission.submissionId });
  assert.deepEqual((await f.state()).task?.phase, { stage: "completed", outcome: "passed" });
  assert.equal(f.log().current()?.student.t01?.lastRepetitionDay, receipt.submission.acceptedAt / 86_400_000);
});

test("历史申诉追加采用判分、保留原答和已选任务，恢复后旧画面不能继续失去资格的新课", async (t) => {
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
  await f.call("submission.appeal", {
    submissionId: original.submissionId,
    expectedGradeRevision: 1,
    reason: "核对原答",
  });
  const appealed = await f.call("submission.get", { submissionId: original.submissionId });
  assert.equal(appealed.status, "found");
  if (appealed.status === "found") {
    assert.equal(appealed.submission.gradeRevision, 2);
    assert.deepEqual(appealed.submission.response, original.response);
    assert.equal(appealed.submission.feedback?.verdict, "incorrect");
  }
  assert.equal(f.log().records.filter((entry) => entry.type === "graded").length, 2);
  assert.equal(f.log().records.filter((entry) => entry.type === "regraded").length, 1);
  assert.deepEqual((await f.state()).task, frozen);
  assert.equal(f.log().current()?.student.t01, undefined);
  await f.reopen();
  assert.equal(f.log().current()?.student.t01, undefined);
  await assert.rejects(
    f.advance(),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "stale_state",
  );
});

test("代码题整批只调用一次服务，缺旧版服务时跳过；环境失败可恢复，代码测试失败才计尝试", async (t) => {
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
      tests: [
        { name: "a", expect: { x: "2" } },
        { name: "b", expect: { x: "2" } },
      ],
    },
  ];
  const calls: unknown[] = [];
  let ready = false;
  let fail = true;
  const services: Services = {
    async call(name, input) {
      assert.equal(name, "python.run");
      if (!ready) {
        return { stdout: "", error: null, captures: {}, doctest: [] };
      }
      if (typeof input === "object" && input !== null && "kind" in input && input.kind === "capabilities") {
        return {
          protocol: PYTHON_BATCH,
          runtime: course.runtime,
          runner: await runnerVersion(),
          freshInterpreter: true,
        };
      }
      const batch = parse(PythonBatchInputSchema, input);
      calls.push(batch);
      if (fail) {
        throw new Error("执行环境不可用");
      }
      assert.equal(JSON.stringify(batch).includes('"expect"'), false);
      assert.equal(JSON.stringify(batch).includes('"solution"'), false);
      return {
        protocol: PYTHON_BATCH,
        submissionId: batch.submissionId,
        gradeRevision: batch.gradeRevision,
        runtime: batch.runtime,
        runner: batch.runner,
        freshInterpreter: true,
        tests: batch.tests.map((entry) => ({
          id: entry.id,
          status: "completed",
          result: { stdout: "", error: null, captures: { x: { value: { t: "int", v: "0" } } }, doctest: [] },
        })),
      };
    },
  };
  const f = await fixture(t, [definition], false, services);
  assert.equal((await f.state()).menu?.candidates.length, 0);
  ready = true;
  await f.select();
  await f.advance();
  await f.advance();
  const input = await f.input();
  const failed = await f.call("submission.submit", input);
  assert.equal(failed.status, "recorded");
  assert.equal(f.log().current()?.state.task?.kps[0]?.attempts, 0);
  assert.equal(calls.length, 1);
  await f.reopen();
  assert.equal(calls.length, 1);
  fail = false;
  const recovered = await f.call("submission.resume", { submissionId: input.submissionId });
  assert.equal(calls.length, 2);
  assert.equal(recovered.status, "recorded");
  if (recovered.status === "recorded") {
    assert.equal(recovered.submission.feedback?.verdict, "incorrect");
  }
  assert.equal(f.log().current()?.state.task?.kps[0]?.attempts, 1);
  await f.call("submission.submit", input);
  assert.equal(calls.length, 2);
});

test("真实 py01 经插件方法完成并隔天复习，开放题判分使用隔离替身", async (t) => {
  const f = await fixture(t, [topic()], true);
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
  assert.ok(f.log().current()?.student.py01);
  if (process.env.REPA_LEARNING_EVIDENCE) {
    const parent = process.env.REPA_LEARNING_EVIDENCE;
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(path.join(parent, "py01-"));
    await writeFile(path.join(directory, "original.jsonl"), await readFile(f.log().file));
    await writeFile(
      path.join(directory, "summary.json"),
      JSON.stringify(
        {
          source: "本地判分替身流程夹具",
          lessonTaskId: lesson.task?.taskId,
          reviewTaskId: (await f.state()).task?.taskId,
          student: f.log().current()?.student,
        },
        null,
        2,
      ),
    );
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
  assert.equal(replayLearning(taskEvidence(f.log().records), f.resolved).forced.size, 0);
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
  const progressed = replayLearning(taskEvidence(f.log().records), f.resolved);
  assert.equal(progressed.failures.get("t02")?.kpId, "t02.k2");
  assert.equal(progressed.failures.get("t02")?.stuck, false);
  assert.equal(progressed.forced.size, 0);
  f.time(start + 96 * 3_600_000);
  await retryLesson();
  await f.finishLesson([false]);
  const stuck = replayLearning(taskEvidence(f.log().records), f.resolved);
  assert.equal(stuck.failures.get("t02")?.stuck, true);
  assert.equal(stuck.forced.get("t01"), "review");
  await f.select("t01", "review");
  for (let index = 0; index < 5; index++) {
    await f.submit(false);
    if (index < 4) {
      await f.advance();
    }
  }
  assert.equal(replayLearning(taskEvidence(f.log().records), f.resolved).forced.get("t01"), "lesson");
  await f.select("t01", "lesson");
  assert.equal((await f.state()).task?.kps[0]?.completed, false);
  await f.finishLesson();
  assert.equal(replayLearning(taskEvidence(f.log().records), f.resolved).forced.size, 0);
});

test("菜单相近项不同列，刷新保留身份；连续三次 review 后至少给出合法新课", async (t) => {
  const f = await fixture(t, [
    topic("t01"),
    topic("t02", 1, ["t01"]),
    topic("t03", 1, ["t01"]),
    topic("t04"),
    topic("t05"),
  ]);
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
  const evidence = taskEvidence(f.log().records);
  const task = evidence[0];
  assert.ok(task);
  for (let index = 1; index <= 3; index++) {
    const entry = structuredClone(task);
    entry.at = start + index * 86_400_000;
    entry.task.taskId = `review-${index}`;
    entry.task.kind = "review";
    entry.task.phase = { stage: "completed", outcome: "passed" };
    entry.attempts = [...entry.attempts, structuredClone(entry.attempts[0])].filter(
      (attempt): attempt is NonNullable<typeof attempt> => Boolean(attempt),
    );
    evidence.push(entry);
  }
  const decision = learningMenu(f.resolved, evidence, start + 4 * 86_400_000, menu.menu, () => true);
  assert.equal(decision.menu.candidates[0]?.kind, "lesson");
});

test("申诉登记后服务失败，重开只恢复待处理版本；继续重判保留旧结果并拒绝陈旧版本", async (t) => {
  const definition = topic();
  const question = definition.kps[0]?.practice?.[0];
  assert.ok(question);
  question.slots = [{ id: "answer", type: "text", rubric: [{ id: "meaning", label: "解释含义" }] }];
  const f = await fixture(t, [definition]);
  await f.select();
  f.models.expectStructured().succeed({ verdict: "correct", reason: "符合" });
  f.models.expectStructured().succeed({ verdict: "correct", reason: "符合" });
  await f.finishLesson();
  const original = (await f.state()).task?.submissions[0];
  assert.ok(original);
  f.models.expectStructured().fail(new Error("断线"));
  await f.call("submission.appeal", { submissionId: original.submissionId, expectedGradeRevision: 1, reason: "复核" });
  await f.reopen();
  const queried = await f.call("submission.get", { submissionId: original.submissionId });
  assert.equal(queried.status, "found");
  if (queried.status === "found") {
    assert.deepEqual(queried.submission.processing, { status: "interrupted", reason: "restart" });
  }
  assert.equal(f.models.calls.length, 3);
  f.models.expectStructured().succeed({ verdict: "incorrect", reason: "不符合" });
  await f.call("submission.resume", { submissionId: original.submissionId });
  assert.equal((await f.state()).task?.phase.stage, "completed");
  assert.equal(f.log().current()?.student.t01, undefined);
  assert.equal(f.log().records.filter((entry) => entry.type === "regraded").length, 1);
  await assert.rejects(
    f.call("submission.appeal", { submissionId: original.submissionId, expectedGradeRevision: 1, reason: "旧请求" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "stale_state",
  );
});

test("受限开始先持久化 preparing；中止路径失败后关闭重开，沿原 task.resume 开始计时", async (t) => {
  let failing = true;
  const f = await fixture(t, [topic()], false, undefined, async () => {
    if (failing) {
      throw new Error("中止路径暂不可用");
    }
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

test("两个菜单选择并发时只保留一个任务，迟到的转换不能覆盖已选择任务", async (t) => {
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

test("渲染能力不足时保留例题和当前任务，返回具体缺项而不换另一道题", async (t) => {
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
  assert.equal(f.log().current()?.state.task?.deliveries.length, 0);
});

test("到期后直接中止复习先记录 timeout，旧守卫不能跳过模型更新", async (t) => {
  const f = await fixture(t);
  await f.select();
  await f.finishLesson();
  f.time(start + 86_400_000);
  await f.select("t01", "review");
  const current = await f.state();
  const task = current.task;
  assert.ok(task?.deadlineAt);
  const student = f.log().current()?.student;
  assert.ok(student);
  const expected = updateStudent(
    graphFor(f.resolved),
    student,
    {
      topicId: "t01",
      outcome: "fail",
      quality: 1,
    },
    task.deadlineAt,
  );
  f.time(task.deadlineAt + 1);
  await assert.rejects(
    f.call("task.abort", {
      taskId: task.taskId,
      expectedRevision: current.revision,
      expectedStage: task.phase.stage,
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "stale_state",
  );
  assert.deepEqual(f.log().current()?.state.task?.phase, { stage: "completed", outcome: "timeout" });
  assert.deepEqual(f.log().current()?.student, expected);
  const revision = f.log().revision;
  await f.reopen();
  assert.deepEqual(f.log().current()?.student, expected);
  assert.equal(f.log().revision, revision);
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
  await f.call("submission.appeal", {
    submissionId: original.submissionId,
    expectedGradeRevision: 1,
    reason: "复核第一份原答",
  });
  assert.equal((await f.state()).task?.kps[0]?.completed, false);
  await assert.rejects(
    f.advance(),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "stale_state",
  );
  assert.deepEqual((await f.state()).task?.deliveries, before?.deliveries);
  assert.deepEqual((await f.state()).task?.phase, before?.phase);
  await f.reopen();
  await assert.rejects(
    f.advance(),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "stale_state",
  );
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
  assert.deepEqual(
    (await f.state()).task?.kps.map((entry) => entry.completed),
    [false, false],
  );
  await f.advance();
  await f.advance();
  await f.submit();
  await f.advance();
  await f.submit();
  await f.advance();
  await f.advance();
  await f.advance();
  await review([false, false, false, false, false]);
  assert.deepEqual(
    (await f.state()).task?.kps.map((entry) => entry.completed),
    [true, false],
  );
  await f.reopen();
  f.time(start + 96 * 3_600_000);
  const retried = await f.select("t01", "lesson");
  assert.deepEqual(
    retried.task?.kps.map((entry) => entry.completed),
    [true, false],
  );
  assert.deepEqual(
    retried.task?.kps.map((entry) => entry.attempts),
    [0, 0],
  );
  assert.equal(retried.task?.phase.stage, "explanation");
  if (retried.task?.phase.stage === "explanation") {
    assert.equal(retried.task.phase.page.ref.kpId, "t01.k2");
  }
  await f.finishLesson();
  assert.ok((await f.state()).task?.deliveries.every((entry) => entry.kpId === "t01.k2"));
  assert.equal(replayLearning(taskEvidence(f.log().records), f.resolved).forced.has("t01"), false);
});

test("冷却在当天到期后读取状态恢复菜单，重复读取和重开不重抽候选", async (t) => {
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
  const unchangedRevision = f.log().revision;
  assert.deepEqual((await f.state()).menu, morning.menu);
  assert.equal(f.log().revision, unchangedRevision);
  f.time(availableAt);
  const ready = await f.state();
  assert.deepEqual(
    ready.menu?.candidates.map((entry) => entry.topicIds[0]),
    ["t01"],
  );
  assert.equal(ready.menu?.availableAt, undefined);
  assert.equal(ready.menu?.menuId, morning.menu?.menuId);
  assert.ok(ready.revision > morning.revision);
  assert.deepEqual((await f.state()).menu, ready.menu);
  assert.equal(f.log().revision, ready.revision);
  await f.reopen();
  assert.deepEqual((await f.state()).menu, ready.menu);
  assert.equal(f.log().revision, ready.revision);
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
    const student = f.log().current()?.student;
    assert.ok(student);
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
    const expected = updateStudent(
      graphFor(f.resolved),
      student,
      {
        topicId: "t01",
        outcome: "fail",
        quality: 1,
      },
      acceptedAt,
    );
    assert.deepEqual(f.log().current()?.student, expected);
    await f.reopen();
    assert.deepEqual(f.log().current()?.student, expected);
  });
}

test("交付选择、排列和选择格使用私有随机源，重开沿日志排列与映射而不重新洗牌", async (t) => {
  const definition = topic();
  const question = definition.kps[0]?.practice?.[0];
  assert.ok(question);
  const ids = ["index", "sample_id", "signal"];
  question.slots = [
    {
      id: "choice",
      type: "choice",
      key: "index",
      options: ids.map((id) => ({ id, content: id })),
    },
    {
      id: "order",
      type: "order",
      key: ids,
      items: ids.map((id) => ({ id, content: id })),
    },
    {
      id: "table",
      type: "table",
      columns: [
        {
          id: "v",
          header: "列",
          input: {
            type: "choice",
            options: ids.map((id) => ({ id, label: id })),
          },
        },
      ],
      rows: [{ id: "row", cells: { v: "index" } }],
    },
  ];
  const draws: number[] = [];
  const random = t.mock.method(crypto, "randomInt", (max: number) => {
    draws.push(max);
    return 0;
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
  assert.deepEqual(draws, [3, 2, 3, 2, 3, 2]);
  const frozen = (await f.state()).task?.deliveries;
  const snapshot = f.log().snapshot(Object.values(f.log().current()?.deliveries ?? {})[0] ?? "");
  assert.ok(snapshot);
  const publicOrder = frozen?.[0]?.item.slots.find((slot) => slot.type === "order");
  assert.ok(publicOrder?.type === "order");
  assert.deepEqual(
    publicOrder.items.map((item) => snapshot.idMap[item.id]),
    ["sample_id", "signal", "index"],
  );
  await f.reopen();
  assert.deepEqual((await f.state()).task?.deliveries, frozen);
  assert.deepEqual(f.log().snapshot(Object.values(f.log().current()?.deliveries ?? {})[0] ?? ""), snapshot);
  assert.deepEqual(draws, [3, 2, 3, 2, 3, 2]);
  const receipt = await f.submit();
  assert.equal(receipt.status, "recorded");
  if (receipt.status === "recorded") {
    assert.equal(receipt.submission.feedback?.verdict, "correct");
  }
});
