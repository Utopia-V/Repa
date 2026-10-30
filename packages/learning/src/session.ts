import { RepaFault } from "@repa/base";
import type { Host } from "@repa/base/plugin";
import { contentVersion, type ClientCapabilities, type Content, type Item } from "@repa/base/protocol";
import type { Student } from "@repa/learning-model";
import { PYTHON_RUN } from "@repa/python-runner/protocol";
import { content, slotTests, topicQuestions } from "./check/items.js";
import { CourseIndex, gradingNeed } from "./course-index.js";
import type { ResolvedCourse } from "./course-sources.js";
import { mapAnswer, renderDelivery } from "./delivery.js";
import { learningMenu } from "./flow-menu.js";
import {
  deliveryId,
  isQuiz,
  submissionId,
  taskId,
  type DeliveryRecord,
  type Fold,
  type TaskEvidence,
  type TaskRecord,
} from "./flow-state.js";
import { feedbackOf, judgeAnswer } from "./judge.js";
import { progressMenu, progressView } from "./progress.js";
import type { ContentPage, Delivery, LearningMenu, LearningState, LearningTask, Submission } from "./protocol.js";
import type { Fact, FactBody } from "./records-schema.js";
import type { LearningRecords } from "./records.js";
import { Replay } from "./replay.js";

const POOLS = { lesson: "practice", review: "review", quiz: "quiz", retake: "quiz" } as const;
const MODES = { lesson: "practice", review: "review", quiz: "quiz", retake: "quiz" } as const;

/** 发起调用的前端能否运行 Python：它连接时在 capabilities.services 里声明了 python.run。不另外探测。 */
export const runsPython = (capabilities?: ClientCapabilities) => capabilities?.services?.includes(PYTHON_RUN) ?? false;

/** 当前学习状态的公开投影与学生模型；辅导和公开响应的授权都从这里判断。 */
export interface LearningView {
  state: LearningState;
  student: Student;
}

type Rendered = { delivery: Delivery; idMap: Record<string, string> };
type Failure = "service_failure" | "uncertain_grade";

/**
 * 一个空间里的学习会话：事实日志、当前课程、从事实重放出的状态，以及判分。教学方法和辅导共用它。
 *
 * 判分没有结果（服务失败、模型没有把握、中途关闭）时什么也不写，这份作答尚无证据，不阻塞任务，也不算错。
 * 条件具备时自动补判：打开空间时，规则题当场补判或按改正后的答案重判；代码题等到声明 python.run 的前端来调用，
 * 开放题在本次会话的第一次调用时调用模型。每份作答每次会话最多自动尝试一次，学习者也可以显式恢复。
 */
export class LearningSession {
  readonly replay: Replay;
  readonly course: CourseIndex;
  readonly timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  /** 需要判分的作答：还没判、按改正后的答案要重判，或申诉后待重判。 */
  private readonly ungraded = new Set<number>();
  private readonly inflight = new Map<number, Promise<void>>();
  private readonly failures = new Map<number, Failure>();
  private readonly attempted = new Set<number>();
  private readonly background = new Set<Promise<unknown>>();
  private readonly rendered = new Map<number, Promise<Rendered>>();
  private readonly explanations = new Map<string, Promise<string>>();

  private constructor(
    readonly records: LearningRecords,
    resolved: ResolvedCourse,
    readonly host: Host,
    readonly clock: () => number,
  ) {
    this.course = new CourseIndex(resolved);
    this.replay = new Replay(this.course);
  }

  /** 从头重放全部事实一次，再找出要补判和重判的作答；规则题当场判完。 */
  static async open(records: LearningRecords, resolved: ResolvedCourse, host: Host, clock: () => number = Date.now): Promise<LearningSession> {
    const session = new LearningSession(records, resolved, host, clock);
    for (const fact of records.facts) {
      session.observe(fact);
    }
    records.listen((fact) => session.observe(fact));
    for (const delivery of session.replay.allDeliveries()) {
      if (delivery.answer && await session.prepare(delivery.seq)) {
        session.ungraded.add(delivery.seq);
      }
    }
    const facts: FactBody[] = [];
    for (const seq of session.ungraded) {
      const prepared = await session.prepare(seq);
      if (!prepared || gradingNeed(prepared.question) !== "rule") {
        continue;
      }
      try {
        const judgement = await judgeAnswer(host, resolved.course, prepared.question, prepared.topic, prepared.answer);
        facts.push({ type: "graded", delivery: seq, version: prepared.version, verdict: judgement.verdict, slots: judgement.slots });
      } catch {
        // 改过的题判不了，这份作答就仍然没有证据；不因此打不开空间。
        session.failures.set(seq, "service_failure");
      }
    }
    if (facts.length && !records.incompleteTail) {
      await records.write(() => facts);
    }
    return session;
  }

  private observe(fact: Fact): void {
    this.replay.apply(fact);
    if (fact.type === "answered" || fact.type === "appealed") {
      this.ungraded.add(fact.delivery);
    } else if (fact.type === "graded") {
      this.ungraded.delete(fact.delivery);
      this.failures.delete(fact.delivery);
    }
  }

  /** 判分前的核对：返回要用的题目与版本；不需要或不能再判时返回 undefined。 */
  private async prepare(seq: number) {
    const delivery = this.replay.delivery(seq);
    const answer = delivery?.answer;
    if (!delivery || !answer) {
      throw new RepaFault("invalid_input", "找不到提交");
    }
    const entry = this.course.questions.get(delivery.questionId);
    const versions = await this.course.versionsOf(delivery.questionId);
    // 题目已删除，或学习者看到的题面已经改了：不能按现在的答案判她当时的作答。
    if (!entry || !versions || versions.item !== answer.seen) {
      this.ungraded.delete(seq);
      return undefined;
    }
    const latest = delivery.grades.at(-1);
    const appealed = delivery.appeal !== undefined && (!latest || delivery.appeal.seq > latest.seq);
    if (latest && !appealed && latest.version === versions.question) {
      this.ungraded.delete(seq);
      return undefined;
    }
    return { question: entry.question, topic: entry.topic, answer, version: versions.question, count: delivery.grades.length };
  }

  /**
   * 判一份作答并追加判分；同一份作答的并发调用合并为一次。判不了时只在内存里记下原因，不写任何事实。
   * 判分期间不占串行入口；写入前核对期间没有别的判分写进来。
   */
  grade(seq: number): Promise<void> {
    const active = this.inflight.get(seq);
    if (active) {
      return active;
    }
    this.attempted.add(seq);
    const work = (async () => {
      const prepared = await this.records.serial(async () => this.prepare(seq));
      if (!prepared) {
        return;
      }
      let judgement: Awaited<ReturnType<typeof judgeAnswer>>;
      try {
        judgement = await judgeAnswer(this.host, this.course.course.course, prepared.question, prepared.topic, prepared.answer);
      } catch (error) {
        this.failures.set(seq, error instanceof RepaFault && error.code === "uncertain_grade" ? "uncertain_grade" : "service_failure");
        return;
      }
      const written = await this.records.write(() => {
        const delivery = this.replay.delivery(seq);
        if (!delivery || delivery.grades.length !== prepared.count) {
          return [];
        }
        return [{ type: "graded", delivery: seq, version: prepared.version, verdict: judgement.verdict, slots: judgement.slots }];
      });
      if (written.length) {
        this.changed(seq);
      }
    })();
    this.inflight.set(seq, work);
    const cleanup = () => {
      if (this.inflight.get(seq) === work) this.inflight.delete(seq);
    };
    work.then(cleanup, cleanup);
    return work;
  }

  /** 在后台补判本次会话还没试过的作答；代码题只在调用方声明 python.run 时试。 */
  autoGrade(capabilities?: ClientCapabilities): void {
    const python = runsPython(capabilities);
    for (const seq of this.ungraded) {
      const delivery = this.replay.delivery(seq);
      const entry = delivery && this.course.questions.get(delivery.questionId);
      if (!entry || this.attempted.has(seq) || this.inflight.has(seq) || (gradingNeed(entry.question) === "tests" && !python)) {
        continue;
      }
      const work = this.grade(seq).catch(() => {});
      this.background.add(work);
      void work.finally(() => this.background.delete(work));
    }
  }

  /** 等待在途判分和后台补判结束；关闭空间前调用。 */
  async idle(): Promise<void> {
    while (this.background.size || this.inflight.size) {
      await Promise.allSettled([...this.background, ...this.inflight.values()]);
    }
  }

  /** 在串行入口里按当前状态决定并写入事实，写入后通知前端。 */
  async write(build: () => FactBody[] | Promise<FactBody[]>): Promise<Fact[]> {
    const facts = await this.records.write(async () => {
      this.replay.settle(this.clock());
      return build();
    });
    if (facts.length) {
      this.changed();
    }
    return facts;
  }

  private changed(submission?: number): void {
    const evidence = this.replay.currentEvidence();
    const finished = !evidence || evidence.outcome !== undefined;
    this.host.emit({
      type: "learning.changed",
      revision: this.records.revision,
      taskId: evidence ? taskId(evidence.task) : null,
      menuId: finished ? this.menuId() : null,
      ...(submission === undefined ? {} : { submissionId: `s${submission}` }),
    });
  }

  private menuId(): string {
    return `menu-${this.replay.tasks.length}`;
  }

  /** 复习和测验进行中（含准备阶段）关闭辅导与参考内容。 */
  restricted(): boolean {
    this.replay.settle(this.clock());
    const evidence = this.replay.currentEvidence();
    return Boolean(evidence && evidence.task.kind !== "lesson" && evidence.outcome === undefined);
  }

  /** 某个 topic 当前调用方能拿到的题：按任务类型选题池，不能运行 Python 时去掉要运行代码的题。 */
  questions(topicId: string, kind: TaskRecord["kind"], capabilities?: ClientCapabilities) {
    const topic = this.course.topics.get(topicId);
    const python = runsPython(capabilities);
    return topic
      ? topicQuestions(topic).filter((entry) => entry.pool === POOLS[kind] && (python || !entry.question.slots.some((slot) => slotTests(slot).length)))
      : [];
  }

  /** 当前调用方看到的完整学习状态。 */
  async state(capabilities?: ClientCapabilities): Promise<LearningState> {
    return (await this.view(capabilities)).state;
  }

  async view(capabilities?: ClientCapabilities): Promise<LearningView> {
    const now = this.clock();
    this.replay.settle(now);
    const evidence = this.replay.currentEvidence();
    const fold = this.replay.fold();
    const finished = !evidence || evidence.outcome !== undefined;
    const restricted = Boolean(evidence && evidence.task.kind !== "lesson" && !finished);
    let menu: LearningMenu | null = null;
    if (finished) {
      const supply = (id: string, kind: TaskRecord["kind"]) => {
        const available = this.questions(id, kind, capabilities);
        if (kind !== "lesson") return available.length > 0;
        const inherited = fold.lessons.get(id) ?? [];
        return this.course.topics.get(id)?.kps.every((kp) =>
          inherited.some((entry) => entry.kpId === kp.id && entry.completed) || available.some((entry) => entry.kp.id === kp.id),
        ) ?? false;
      };
      menu = progressMenu(learningMenu(this.course, fold, now, this.menuId(), supply), this.replay, fold, this.course);
    }
    let restriction: LearningState["restrictions"]["kind"] = "none";
    if (restricted && evidence) {
      restriction = isQuiz(evidence.task.kind) ? "quiz" : "review";
    }
    const course = this.course.course.course;
    return {
      student: fold.student,
      state: {
        revision: this.records.revision,
        serverNow: now,
        course: { id: course.id, title: course.title, version: course.version },
        task: evidence ? await this.task(evidence) : null,
        menu,
        restrictions: { kind: restriction, tutorAllowed: !restricted, referenceContentAllowed: !restricted },
        progress: progressView(this.replay, fold, this.course, now, this.timeZone),
      },
    };
  }

  /** 当前任务的公开画面。 */
  async task(evidence: TaskEvidence): Promise<LearningTask> {
    const task = evidence.task;
    const deliveries: Delivery[] = [];
    for (const delivery of task.deliveries) {
      deliveries.push((await this.render(delivery)).delivery);
    }
    const submissions: Submission[] = [];
    for (const delivery of task.answered) {
      submissions.push(await this.submission(delivery));
    }
    return {
      taskId: taskId(task),
      kind: task.kind,
      topicIds: [...task.topicIds],
      phase: await this.phase(evidence),
      startedAt: evidence.startedAt,
      deadlineAt: evidence.deadlineAt,
      kps: evidence.kps,
      deliveries,
      submissions,
    };
  }

  /** 当前阶段的名称；不需要渲染讲解页，供授权检查使用。 */
  stage(evidence: TaskEvidence): LearningTask["phase"]["stage"] {
    return this.position(evidence).stage;
  }

  /** 当前任务停在哪一步：讲解或例题页、哪一道题、判分到哪一步。 */
  position(evidence: TaskEvidence):
    | { stage: "completed"; outcome: "passed" | "failed" | "timeout" }
    | { stage: "aborted" }
    | { stage: "preparing" }
    | { stage: "explanation" | "example"; kp: string }
    | { stage: "awaiting_answer"; delivery: DeliveryRecord }
    | { stage: "judging" | "recovery" | "feedback"; delivery: DeliveryRecord } {
    const task = evidence.task;
    const outcome = evidence.outcome;
    if (outcome === "aborted" || outcome === "ended") return { stage: "aborted" };
    if (outcome) return { stage: "completed", outcome };
    const last = task.deliveries.at(-1);
    const answered = (delivery: DeliveryRecord) => {
      if (delivery.grades.length) return { stage: "feedback" as const, delivery };
      return { stage: this.inflight.has(delivery.seq) ? "judging" as const : "recovery" as const, delivery };
    };
    if (task.kind === "lesson") {
      if (task.page && (!last || task.page.seq > last.seq)) {
        return { stage: task.page.page === "lesson" ? "explanation" : "example", kp: task.page.kp };
      }
      if (!last) {
        return { stage: "explanation", kp: evidence.kps.find((kp) => !kp.completed)?.kpId ?? evidence.kps[0]?.kpId ?? "" };
      }
      return last.answer ? answered(last) : { stage: "awaiting_answer", delivery: last };
    }
    if (!last) return { stage: "preparing" };
    if (task.kind === "review") {
      return last.answer ? answered(last) : { stage: "awaiting_answer", delivery: last };
    }
    // 测验整场一起交付：先显示正在判分的，再显示没答的题；只剩没判出结果的，停在恢复，交卷不受影响。
    const judging = task.answered.find((delivery) => !delivery.grades.length && this.inflight.has(delivery.seq));
    if (judging) return { stage: "judging", delivery: judging };
    const open = task.deliveries.find((delivery) => !delivery.answer);
    if (open) return { stage: "awaiting_answer", delivery: open };
    const unresolved = task.answered.find((delivery) => !delivery.grades.length);
    if (unresolved) return { stage: "recovery", delivery: unresolved };
    return { stage: "awaiting_answer", delivery: last };
  }

  private async phase(evidence: TaskEvidence): Promise<LearningTask["phase"]> {
    const position = this.position(evidence);
    switch (position.stage) {
      case "completed":
        return { stage: "completed", outcome: position.outcome };
      case "aborted":
        return { stage: "aborted", reason: "学习者中止" };
      case "preparing":
        return { stage: "preparing" };
      case "explanation":
      case "example":
        return { stage: position.stage, page: await this.page(evidence.task, position.kp, position.stage) };
      case "awaiting_answer":
        return { stage: "awaiting_answer", deliveryId: deliveryId(position.delivery) };
      default:
        return { stage: position.stage, submissionId: submissionId(position.delivery) };
    }
  }

  /** 课内讲解页或例题页。 */
  async page(task: TaskRecord, kpId: string, stage: "explanation" | "example"): Promise<ContentPage> {
    const topic = this.course.topics.get(task.topicIds[0] ?? "");
    const kp = topic?.kps.find((entry) => entry.id === kpId);
    if (!topic || !kp) {
      throw new RepaFault("invalid_input", "当前知识点不存在");
    }
    const ref = {
      courseId: this.course.course.course.id,
      topicId: topic.id,
      kpId: kp.id,
      id: `${kp.id}.${stage}`,
      version: await contentVersion(kp),
      kind: stage === "example" ? ("example" as const) : ("lesson" as const),
    };
    const blocks = stage === "example" ? [...content(kp.example?.body), ...content(kp.example?.explanation)] : content(kp.lesson);
    return { ref, origin: { taskId: taskId(task), content: ref }, offset: 0, total: blocks.length, blocks };
  }

  /** 按交付事实的 seed 渲染学习者看到的题目；题目已不在课程里时给出说明，不能作答。 */
  render(delivery: DeliveryRecord): Promise<Rendered> {
    let cached = this.rendered.get(delivery.seq);
    if (!cached) {
      cached = (async () => {
        const entry = this.course.questions.get(delivery.questionId);
        const identity = {
          deliveryId: deliveryId(delivery),
          submissionId: submissionId(delivery),
          repeated: this.replay.firstDelivered(delivery.questionId) !== delivery.seq,
        };
        if (!entry) {
          const draft = {
            id: `o${delivery.seq}`,
            title: "题目已不在课程中",
            body: [{ type: "markdown" as const, text: "这道题已从课程中移除。可以中止当前任务，再从菜单重新选择。" }],
            slots: [],
          };
          const item: Item = { ...draft, version: await contentVersion(draft), requires: ["block.markdown"] };
          const topicId = delivery.questionId.split(".")[0] ?? delivery.task.topicIds[0] ?? "";
          return {
            delivery: {
              ...identity, item, topicId, kpId: delivery.questionId.slice(0, delivery.questionId.lastIndexOf(".")) || topicId,
              mode: MODES[delivery.task.kind], requiresServices: [],
            },
            idMap: {},
          };
        }
        return renderDelivery(entry.question, entry.topic, entry.kp.id, MODES[delivery.task.kind], identity, delivery.seed);
      })();
      this.rendered.set(delivery.seq, cached);
    }
    return cached;
  }

  /** 一份作答的公开样子：作答换回这次交付的编号；反馈与解析按任务类型的释放时机给出。 */
  async submission(delivery: DeliveryRecord): Promise<Submission> {
    const answer = delivery.answer;
    if (!answer) {
      throw new RepaFault("invalid_input", "找不到提交");
    }
    const { delivery: shown, idMap } = await this.render(delivery);
    const answers = Object.fromEntries(Object.entries(answer.answers).map(([slotId, value]) => {
      const slot = shown.item.slots.find((entry) => entry.id === slotId);
      return [slotId, slot ? mapAnswer(value, slot, idMap, true) : value];
    }));
    const latest = delivery.grades.at(-1);
    const appealed = delivery.appeal !== undefined && (!latest || delivery.appeal.seq > latest.seq);
    let processing: Submission["processing"];
    if (latest && !appealed) {
      processing = { status: "completed" };
    } else if (this.inflight.has(delivery.seq)) {
      processing = { status: "pending" };
    } else {
      processing = { status: "interrupted", reason: this.failures.get(delivery.seq) ?? "restart" };
    }
    const reference = { id: shown.item.id, version: answer.seen };
    const result: Submission = {
      taskId: taskId(delivery.task),
      deliveryId: deliveryId(delivery),
      submissionId: submissionId(delivery),
      response: { item: reference, answers, ...(answer.dontKnow ? { dontKnow: true as const } : {}) },
      acceptedAt: answer.at,
      processing,
      gradeRevision: delivery.grades.length,
    };
    const entry = this.course.questions.get(delivery.questionId);
    if (latest && entry && this.released(delivery)) {
      result.feedback = feedbackOf(latest, entry.question, shown.item, idMap, reference, !delivery.help);
      result.explanation = content(entry.question.explanation);
    }
    return result;
  }

  /** 课内判完就释放反馈与解析；复习和测验等任务结束。 */
  released(delivery: DeliveryRecord): boolean {
    if (delivery.task.kind === "lesson" || delivery.task !== this.replay.current) {
      return true;
    }
    return this.replay.currentEvidence()?.outcome !== undefined;
  }

  /** 当前任务之前的学习状态，用于判断当前任务是否仍有资格。 */
  before(): Fold {
    return this.replay.before();
  }

  /** 一道题解析的内容版本；同一道题只算一次。 */
  explanationVersion(questionId: string, blocks: Content): Promise<string> {
    let cached = this.explanations.get(questionId);
    if (!cached) {
      cached = contentVersion(blocks);
      this.explanations.set(questionId, cached);
    }
    return cached;
  }
}
