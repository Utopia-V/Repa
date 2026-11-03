/**
 * 随机操作序列：经真实的插件方法走学习流程（选任务、作答、判分失败、补判、申诉、改答案、等待、重开），每一步之后核对
 * 不依赖具体情形的性质。操作是否被接受由流程的守卫决定，所以序列都是学习者实际走得到的；失败时 fast-check 把序列缩到最短。
 *
 * 种子固定，合并门禁上的结果可以重复。多探索时设置 REPA_PROPERTY_RUNS 和 REPA_PROPERTY_SEED；.github/workflows/property-exploration.yml 每晚换一个种子跑一次。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { CompletionRequest } from "@repa/base/plugin";
import { parse } from "@repa/base/protocol";
import { ModelTestDriver } from "@repa/base/testing";
import fc from "fast-check";
import type { Static, TSchema } from "typebox";
import { gradingNeed, needsModel, type CourseIndex } from "../src/course-index.js";
import {
  emptyFold,
  foldTask,
  isQuiz,
  taskEvidence,
  type DeliveryRecord,
  type Fold,
  type TaskEvidence,
  type TaskRecord,
} from "../src/flow-state.js";
import type { Question, Topic } from "../src/format/schema.js";
import { reward } from "../src/progress.js";
import type { LearningState } from "../src/protocol.js";
import type { GradedSlot } from "../src/records-schema.js";
import { Replay } from "../src/replay.js";
import { DAY_MS } from "../src/student-model.js";
import { learningFixture, start, topic } from "./fixtures/learning-session.js";

const RUNS = Number(process.env.REPA_PROPERTY_RUNS ?? 100);
const SEED = Number(process.env.REPA_PROPERTY_SEED ?? 20261103);

type Verdict = GradedSlot["verdict"];
type ModelVerdict = Verdict | "unsure" | "fail";
type Fixture = Awaited<ReturnType<typeof learningFixture>>;

/** 模型按作答文字给结论：补判和申诉之前改这张表，后台补判与前台判分的先后就不影响结果。 */
class ScriptedModel extends ModelTestDriver {
  readonly verdicts = new Map<string, ModelVerdict>();

  override async completeStructured<S extends TSchema>(request: CompletionRequest, schema: S): Promise<Static<S>> {
    const { answer } = JSON.parse(request.prompt) as { answer: { text: string } };
    const verdict = this.verdicts.get(answer.text) ?? "fail";
    if (verdict === "fail") throw new Error("断网");
    return parse(schema, { verdict, reason: "按 rubric" });
  }
}

const rubric = [{ id: "meaning", label: "说明含义" }];

/**
 * 练习、复习、测验都混有开放题的 topic：开放题判分可以失败，才有待判的作答。minutes 取上限，三节课就到测验门槛；
 * 复习里开放题的位置随 topic 不同，待判的作答才会落在通过判定的不同位置。只有一道必做题时，“待判、对”的结论取决于待判的那题。
 */
function mixedTopic(id: string, count: number, prerequisites: string[], reviewOpenAt: number, required = 2): Topic {
  const definition = topic(id, count, prerequisites, 3);
  definition.minutes = 60;
  for (const kp of definition.kps) {
    const rule = (name: string): Question => ({
      id: `${kp.id}.${name}`, body: "一加一？", explanation: "二。", slots: [{ id: "answer", type: "text", key: "2" }],
    });
    const open = (name: string): Question => ({
      id: `${kp.id}.${name}`, body: "说明相加的含义", explanation: "合并。", slots: [{ id: "answer", type: "text", rubric }],
    });
    kp.practice = [open("q0"), ...Array.from({ length: required }, (_, index) => rule(`q${index + 1}`))];
    kp.review = [0, 1, 2].map((index) => (index === reviewOpenAt ? open(`r${index}`) : rule(`r${index}`)));
    // 测验优先出没见过的题，开放题排在前面，第一场就可能有待判的作答。
    kp.quiz = [open("z0"), rule("z1")];
  }
  return definition;
}

const courseTopics = (): Topic[] => {
  const dependent = mixedTopic("t02", 1, ["t01"], 2);
  // 卡在这个知识点上第二次失败时，先修 t01 转入强制补救。
  for (const kp of dependent.kps) kp.keyPrerequisites = ["t01"];
  return [mixedTopic("t01", 2, [], 1), dependent, mixedTopic("t03", 1, [], 2, 1), mixedTopic("t04", 1, [], 0, 1), mixedTopic("t05", 1, [], 1)];
};

type Operation = { kind: OperationKind; choice: number; verdict: ModelVerdict };
type OperationKind = "step" | "abort" | "retry" | "finish" | "resume" | "appeal" | "wait" | "reopen" | "rekey";

/** 按权重取值；shrink 时趋向第一项。 */
const weighted = <T>(entries: [T, number][]): fc.Arbitrary<T> =>
  fc.oneof(...entries.map(([value, weight]) => ({ weight, arbitrary: fc.constant(value) })));

const operation: fc.Arbitrary<Operation> = fc.record({
  // step 按当前阶段做下一件该做的事，占大多数，序列才走得到测验和补救。
  kind: weighted<OperationKind>([
    ["step", 60], ["resume", 6], ["wait", 6], ["appeal", 4], ["retry", 2], ["abort", 1], ["finish", 1], ["reopen", 1], ["rekey", 1],
  ]),
  choice: fc.nat(99),
  verdict: weighted<ModelVerdict>([["correct", 12], ["partial", 1], ["incorrect", 1], ["unsure", 1], ["fail", 2]]),
});

/** 16 分钟越过测验的截止时间，三天越过课的冷却并让复习到期。 */
const WAITS = [60_000, 16 * 60_000, 16 * 60_000, DAY_MS, 3 * DAY_MS];
/** 流程的守卫拒绝一次操作时用的错误码；操作不合时宜是正常情形，其他错误都是缺陷。 */
const REFUSALS = new Set(["stale_state", "insufficient_items"]);

/** 一项任务此刻的证据与它继承的进度：当前的课从重算后的学习状态继承，已结束的任务用它结束时记下的。 */
function inheritedOf(replay: Replay, task: TaskRecord) {
  if (task !== replay.current) return task.inherited;
  return task.kind === "lesson" ? replay.before().lessons.get(task.topicIds[0] ?? "") : undefined;
}
const evidenceOf = (replay: Replay, task: TaskRecord, course: CourseIndex): TaskEvidence =>
  taskEvidence(task, course, inheritedOf(replay, task));

/** 从第一项任务重新叠加，不经增量更新；与 replay.before() 比较。 */
function refold(replay: Replay, course: CourseIndex): Fold {
  let fold = emptyFold();
  for (const task of replay.tasks.slice(0, -1)) {
    fold = foldTask(fold, taskEvidence(task, course, fold.lessons.get(task.topicIds[0] ?? "")), course);
  }
  return fold;
}

/** 重放出的全部学习状态。当前任务的证据取自重放本身，已结束的任务按它结束时记下的进度算。 */
function snapshot(replay: Replay, course: CourseIndex) {
  return {
    tasks: replay.tasks.map((task) => {
      const evidence = task === replay.current ? replay.currentEvidence() : taskEvidence(task, course, task.inherited);
      assert.ok(evidence);
      const { outcome, kps, at } = evidence;
      return { seq: task.seq, outcome, kps, at, inherited: task.inherited, timedOut: task.timedOut, nextAt: task.nextAt };
    }),
    fold: replay.fold(),
    awards: replay.awards,
    total: replay.total,
    trigger: replay.trigger,
    consumed: replay.consumed,
    pending: replay.pending,
    goal: replay.goal,
    quizOnly: replay.quizOnly(),
  };
}

/** 假定没判出结果的作答都判成 verdict 时，任务的结论。 */
function outcomeIf(replay: Replay, task: TaskRecord, course: CourseIndex, verdict: Verdict) {
  const answered = task.answered.map((delivery): DeliveryRecord => (delivery.grades.length ? delivery : {
    ...delivery,
    grades: [{ type: "graded", seq: 0, at: 0, delivery: delivery.seq, version: "", verdict, slots: {} }],
  }));
  return taskEvidence({ ...task, answered }, course, inheritedOf(replay, task)).outcome;
}

/**
 * 逐条事实核对 XP：一项任务得到的 XP 始终等于它到此刻为止的最高奖励，不漏发、不多发、不收回。还有待判作答的课和复习不计，
 * 判出来以后比例可能变低；奖励按实际结论算。核对的是每条事实的边界，而不只是重放认为要结算的时刻。
 */
class XpAudit {
  readonly replay: Replay;
  private readonly best = new Map<number, number>();
  private fed = 0;

  constructor(private readonly course: CourseIndex, private readonly seen: Set<string>) {
    this.replay = new Replay(course);
  }

  feed(facts: readonly Parameters<Replay["apply"]>[0][], now: number): void {
    for (const fact of facts.slice(this.fed)) {
      this.replay.settle(fact.at);
      this.audit();
      const awards = this.replay.awards.length;
      const previous = this.replay.current;
      this.replay.apply(fact);
      if (fact.type !== "task" && this.replay.awards.slice(awards).some((award) => award.task !== previous?.seq)) {
        this.seen.add("更早任务补发 XP");
      }
      this.audit();
    }
    this.fed = facts.length;
    this.replay.settle(now);
    this.audit();
  }

  private audit(): void {
    const { replay, course } = this;
    assert.equal(replay.total, replay.awards.reduce((sum, award) => sum + award.xp, 0), "累计 XP 与各笔之和不符");
    assert.equal(replay.trigger, replay.awards.filter((award) => !award.quiz).reduce((sum, award) => sum + award.xp, 0), "测验门槛的累计与课和复习的 XP 不符");
    for (const task of replay.tasks) {
      const evidence = evidenceOf(replay, task, course);
      this.seen.add(task.kind);
      if (evidence.outcome) this.seen.add(evidence.outcome);
      if (isQuiz(task.kind) || evidence.attempts.every((attempt) => attempt.verdict !== undefined)) {
        this.best.set(task.seq, Math.max(this.best.get(task.seq) ?? 0, reward(evidence, course)));
      }
      const awarded = replay.awards.filter((award) => award.task === task.seq).reduce((sum, award) => sum + award.xp, 0);
      assert.equal(awarded, this.best.get(task.seq) ?? 0, `任务 ${task.seq}（${task.kind}，${evidence.outcome}）的 XP 不等于它到此刻的最高奖励`);
    }
  }
}

/** 一次随机序列的现场：真实插件宿主、模型替身、课程副本和 XP 核对。 */
interface Run {
  f: Fixture;
  model: ScriptedModel;
  topics: Topic[];
  audit: XpAudit;
  clock: number;
  answers: number;
  seen: Set<string>;
}

/** 等后台补判结束，返回稳定的状态：发起调用时可能触发补判，所以先调用一次。 */
async function stable(f: Fixture): Promise<LearningState> {
  await f.state();
  await f.settled();
  return f.state();
}

async function reopen(run: Run): Promise<void> {
  await run.f.reopen();
  await stable(run.f);
  run.audit = new XpAudit(run.f.session().course, run.seen);
}

/** 公开状态里与判分进程有关的部分（为什么中断）只在内存里，重开后不同，比较时去掉。 */
function durable(state: LearningState) {
  const { task } = state;
  return { ...state, ...(task ? { task: { ...task, submissions: task.submissions.map(({ processing: _, ...rest }) => rest) } } : {}) };
}

const textOf = (delivery: DeliveryRecord) => {
  const answer = delivery.answer?.answers.answer;
  return answer?.type === "text" ? answer.text : undefined;
};

/** 答当前这道题：开放题的结论写进模型替身；规则题 correct 用标准答案，其余答错，课和复习里有时说“不会”。 */
async function answer(run: Run, op: Operation, quiz: boolean): Promise<void> {
  const { f, model } = run;
  const input = await f.input();
  const seq = Number(input.deliveryId.slice(1));
  const record = f.session().replay.delivery(seq);
  const entry = record && f.session().course.questions.get(record.questionId);
  assert.ok(entry);
  const { item } = input.response;
  let response = input.response;
  if (needsModel(entry.question)) {
    const text = `作答${++run.answers}`;
    model.verdicts.set(text, op.verdict);
    response = { item, answers: { answer: { type: "text", text } } };
  } else if (op.verdict !== "correct") {
    response = !quiz && op.choice % 2
      ? { item, answers: {}, dontKnow: true }
      : { item, answers: { answer: { type: "text", text: "不对" } } };
  }
  await f.call("submission.submit", { ...input, response });
}

/** 按当前阶段做下一件该做的事。 */
async function step(run: Run, op: Operation): Promise<void> {
  const { f } = run;
  const state = await f.state();
  if (state.menu) {
    const candidates = state.menu.candidates;
    const candidate = candidates[op.choice % (candidates.length || 1)];
    if (candidate) await f.call("menu.select", { menuId: state.menu.menuId, candidateId: candidate.id });
    return;
  }
  const task = state.task;
  assert.ok(task);
  const guard = { taskId: task.taskId, expectedRevision: state.revision, expectedStage: task.phase.stage };
  const phase = task.phase;
  const quiz = task.kind === "quiz" || task.kind === "retake";
  if (phase.stage === "preparing") {
    await f.call("task.resume", guard);
  } else if (phase.stage === "awaiting_answer" && !task.submissions.some((entry) => entry.deliveryId === phase.deliveryId)) {
    await answer(run, op, quiz);
  } else if (quiz) {
    await f.call("quiz.finish", guard);
  } else {
    await f.call("task.advance", guard);
  }
}

/** 先学会几节课：三节课的 XP 就到测验门槛，序列才有机会走到测验、超时和换题重考。 */
async function learn(run: Run, lessons: number): Promise<void> {
  for (let lesson = 0; lesson < lessons; lesson++) {
    let steps = 0;
    do {
      await step(run, { kind: "step", choice: 0, verdict: "correct" });
      assert.ok(++steps < 50);
    } while (!(await run.f.state()).menu);
  }
}

async function perform(run: Run, op: Operation): Promise<void> {
  const { f, model } = run;
  const replay = () => f.session().replay;
  switch (op.kind) {
    case "step":
      return step(run, op);
    case "abort":
    case "finish": {
      const state = await f.state();
      const task = state.task;
      if (!task || state.menu) return;
      const guard = { taskId: task.taskId, expectedRevision: state.revision, expectedStage: task.phase.stage };
      await f.call(op.kind === "abort" ? "task.abort" : "quiz.finish", guard);
      return;
    }
    case "retry": {
      // 中止这节课再学同一个 topic：前一轮的补判才可能改变正在进行的课继承的进度。
      const state = await f.state();
      const task = state.task;
      if (state.menu || task?.kind !== "lesson") return;
      const { menu } = await f.call("task.abort", { taskId: task.taskId, expectedRevision: state.revision, expectedStage: task.phase.stage });
      const candidate = menu?.candidates.find((entry) => entry.kind === "lesson" && entry.topicIds[0] === task.topics[0]?.id);
      if (menu && candidate) await f.call("menu.select", { menuId: menu.menuId, candidateId: candidate.id });
      return;
    }
    case "resume":
    case "appeal": {
      const appeal = op.kind === "appeal";
      const targets = [...replay().allDeliveries()].filter((delivery) => delivery.answer && (delivery.grades.length > 0) === appeal);
      const target = targets[op.choice % (targets.length || 1)];
      if (!target) return;
      const text = textOf(target);
      if (text !== undefined) model.verdicts.set(text, op.verdict);
      const submissionId = `s${target.seq}`;
      if (appeal) {
        await f.call("submission.appeal", { submissionId, expectedGradeRevision: target.grades.length, reason: "复核" });
      } else {
        await f.call("submission.resume", { submissionId });
      }
      return;
    }
    case "wait":
      run.clock += WAITS[op.choice % WAITS.length] ?? 0;
      f.time(run.clock);
      return;
    case "reopen": {
      const before = await stable(f);
      await reopen(run);
      const after = await f.state();
      // 重开时补判写下了新事实，状态自然不同；没有新事实时必须一字不差。
      if (after.revision === before.revision) assert.deepEqual(durable(after), durable(before), "重开空间改变了学习状态");
      return;
    }
    case "rekey": {
      // 改正一道规则题的标准答案：重开时过去的作答按新答案重判。
      const questions = run.topics.flatMap((entry) => entry.kps.flatMap((kp) => [...kp.practice ?? [], ...kp.review ?? [], ...kp.quiz ?? []]));
      const slots = questions.flatMap((question) => question.slots).flatMap((slot) => (slot.type === "text" && slot.key !== undefined ? [slot] : []));
      const slot = slots[op.choice % slots.length];
      assert.ok(slot);
      slot.key = slot.key === "2" ? "3" : "2";
      await f.writeTopics(run.topics);
      await reopen(run);
      for (const delivery of f.session().replay.allDeliveries()) {
        const question = f.session().course.questions.get(delivery.questionId)?.question;
        const definition = question?.slots[0];
        if (!delivery.answer || !question || gradingNeed(question) !== "rule" || definition?.type !== "text") continue;
        const correct = !delivery.answer.dontKnow && textOf(delivery) === definition.key;
        assert.equal(delivery.grades.at(-1)?.verdict, correct ? "correct" : "incorrect", `答案改正后，交付 ${delivery.seq} 没有按新答案重判`);
        if (delivery.grades.length > 1) run.seen.add("改正答案后重判");
      }
      return;
    }
  }
}

async function check(run: Run): Promise<void> {
  const { f, seen } = run;
  const state = await stable(f);
  const session = f.session();
  const { replay: live, course } = session;
  const cold = new Replay(course);
  for (const fact of session.records.facts) cold.apply(fact);
  cold.settle(state.serverNow);
  assert.deepEqual(snapshot(live, course), snapshot(cold, course), "现场状态与从事实重放的结果不同");
  const prefix = refold(live, course);
  assert.deepEqual(live.before(), prefix, "增量叠加的学习状态与从头叠加的结果不同");
  const current = live.current;
  if (current) {
    // 当前的课与学生模型用同一份继承进度：更早任务的重判改变了它，课的进度和结论随之改变。
    const expected = taskEvidence(current, course, current.kind === "lesson" ? prefix.lessons.get(current.topicIds[0] ?? "") : undefined);
    const actual = live.currentEvidence();
    assert.deepEqual([actual?.outcome, actual?.kps], [expected.outcome, expected.kps], "当前任务的证据与重算后的学习状态不一致");
    assert.deepEqual(live.fold(), expected.outcome ? foldTask(prefix, expected, course) : prefix, "包括当前任务在内的学习状态与从头叠加的结果不同");
  }
  run.audit.feed(session.records.facts, state.serverNow);
  for (const task of live.tasks) {
    const { outcome, attempts } = evidenceOf(live, task, course);
    // 复习的通过只看有证据的作答，待判的不计入，判出来以后重算（见 learning-flow.md），所以是暂定的。
    const provisional = task.kind === "review" && outcome === "passed";
    if (attempts.some((attempt) => attempt.verdict === undefined) && !provisional && (outcome === "passed" || outcome === "failed" || outcome === "timeout")) {
      // 没有证据不下结论：已经得出的结论，待判的作答怎样判都不能推翻。
      seen.add("待判时下结论");
      assert.equal(outcomeIf(live, task, course, "correct"), outcome, `任务 ${task.seq}（${task.kind}）结论为 ${outcome}，待判的作答都判对就会改变`);
      assert.equal(outcomeIf(live, task, course, "incorrect"), outcome, `任务 ${task.seq}（${task.kind}）结论为 ${outcome}，待判的作答都判错就会改变`);
    }
    if (outcome === "unresolved") {
      // 结论待定要有理由：待判的作答判对和判错，结论确实不同。
      assert.notEqual(outcomeIf(live, task, course, "correct"), outcomeIf(live, task, course, "incorrect"), `任务 ${task.seq}（${task.kind}）结论待定，但待判的作答怎样判结论都相同`);
    }
  }
  if (live.recomputations > 0) seen.add("整段重算");
  if (live.fold().forced.size > 0) seen.add("强制补救");
}

test("随机的学习操作序列下：现场状态与从事实重放相同，增量叠加与从头叠加相同，XP 不漏不多不收回，没有证据不下结论", async () => {
  const seen = new Set<string>();
  await fc.assert(
    fc.asyncProperty(fc.nat(3), fc.array(operation, { maxLength: 120, size: "max" }), async (lessons, operations) => {
      const cleanups: (() => Promise<void>)[] = [];
      try {
        const model = new ScriptedModel();
        const topics = courseTopics();
        const f = await learningFixture({ after: (cleanup) => { cleanups.push(cleanup); } }, topics, { models: model });
        await f.state();
        const run: Run = { f, model, topics, audit: new XpAudit(f.session().course, seen), clock: start, answers: 0, seen };
        await learn(run, lessons);
        for (const op of operations) {
          try {
            await perform(run, op);
          } catch (error) {
            if (!(error instanceof Error && "code" in error && REFUSALS.has(String(error.code)))) throw error;
          }
          await check(run);
        }
      } finally {
        for (const cleanup of cleanups) await cleanup();
      }
    }),
    // 失败时缩短序列可能要很久：时间上限只截断探索和缩短，不判定失败。
    { numRuns: RUNS, seed: SEED, includeErrorInReport: true, interruptAfterTimeLimit: (RUNS * 3 + 120) * 1000 },
  );
  // 生成器走不到这些情形时，上面的性质就成了空话。
  for (const name of [
    "lesson", "review", "quiz", "retake", "passed", "failed", "timeout", "unresolved", "aborted",
    "整段重算", "强制补救", "待判时下结论", "更早任务补发 XP", "改正答案后重判",
  ]) {
    assert.ok(seen.has(name), `随机序列没有走到：${name}（走到的有 ${[...seen].join("、")}）`);
  }
});
