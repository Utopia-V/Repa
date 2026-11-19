import { RepaFault } from "@repa/base";
import type { Host } from "@repa/base/plugin";
import { canRender, contentVersion, modelFailureOf, type ClientCapabilities, type Content, type Item, type ModelFailure } from "@repa/base/protocol";
import type { Student } from "@repa/learning-model";
import { PYTHON_RUN } from "@repa/python-runner/protocol";
import { content, type QuestionEntry } from "./check/items.js";
import { CourseIndex, gradingNeed, needsModel, needsPython, type IndexedQuestion } from "./course-index.js";
import { scoped } from "./course-key.js";
import { courseStructure, StructureIndex } from "./course-structure.js";
import type { ResolvedCourse } from "./course-sources.js";
import type { Question, Topic } from "./format/schema.js";
import { mapAnswer, renderDelivery } from "./delivery.js";
import { combinedMenu, learningMenu } from "./flow-menu.js";
import {
  deadlineAt,
  deliveryId,
  isQuiz,
  lessonPractice,
  obligations,
  submissionId,
  taskId,
  type DeliveryRecord,
  type Fold,
  type TaskEvidence,
  type TaskRecord,
} from "./flow-state.js";
import { feedbackOf, judgeAnswer } from "./judge.js";
import { dayFormat, progressMenu, progressView } from "./progress.js";
import type { ContentPage, Delivery, LearningMenu, LearningState, LearningTask, Submission } from "./protocol.js";
import { isDeepStrictEqual } from "node:util";
import type { Fact, FactBody, FactOf } from "./records-schema.js";
import type { LearningRecords } from "./records.js";
import { Replay, type Legacy } from "./replay.js";

const POOLS = { lesson: "practice", review: "review", quiz: "quiz", retake: "quiz" } as const;
const MODES = { lesson: "practice", review: "review", quiz: "quiz", retake: "quiz" } as const;

/** 发起调用的前端能否运行 Python：它连接时在 capabilities.services 里声明了 python.run。不另外探测。 */
export const runsPython = (capabilities?: ClientCapabilities) => capabilities?.services?.includes(PYTHON_RUN) ?? false;

/** 空间里的一门可学的课：键、完整的课程内容（题面、讲解、判分）与它的结构（重放、菜单、进度）。 */
export interface CourseContent {
  key: string;
  resolved: ResolvedCourse;
  course: CourseIndex;
  structure: StructureIndex;
}

/** 一门课清单里的标识、标题与版本。 */
function manifest(content: CourseContent): { id: string; title: string; version: string } {
  const { id, title, version } = content.course.course.course;
  return { id, title, version };
}

/** 一门课学过几节、共几节：都取这门课现在的结构里还在的节。 */
function topicCounts(fold: Fold, key: string, structure: StructureIndex): { completedTopics: number; totalTopics: number } {
  return { completedTopics: structure.order.filter((topic) => fold.student[scoped(key, topic.id)]).length, totalTopics: structure.order.length };
}

/** 当前学习状态的公开投影与学生模型；辅导和公开响应的授权都从这里判断。 */
export interface LearningView {
  state: LearningState;
  student: Student;
}

type Rendered = { delivery: Delivery; idMap: Record<string, string> };

/**
 * 任务的结果在什么时刻得出：它最后一条事实（开始、出题、作答、判分、结束）的时间；到了截止时间才结束的测验取截止时间；
 * 课还算上进行期间更早任务的证据最后一次改变的时间，因为更早一轮课的改判可能使这节课通过。
 * 不用 TaskEvidence.at（学生模型更新的锚点，是作答时间）：昨天答完、今天打开时才补判出结果的复习，结果是今天得出的，学习者还没看过。
 * 更早任务的改判没有改变这节课的结论时，改判那天也会再显示一次这节课；这样不必在读取时重算前后两种结论再比较。
 */
function resultAt(evidence: TaskEvidence): number {
  const { task } = evidence;
  const times = [task.at];
  if (task.endedAt !== undefined) times.push(task.endedAt);
  if (task.inheritanceChangedAt !== undefined) times.push(task.inheritanceChangedAt);
  // 截止之前交卷的测验，读取时 settle 照样把 timedOut 设为真，但它的结果在交卷时就已得出。
  const deadline = deadlineAt(task);
  if (task.timedOut && task.endedAt === undefined && deadline !== null) times.push(deadline);
  for (const delivery of task.deliveries) {
    times.push(delivery.at, delivery.answer?.at ?? delivery.at, ...delivery.grades.map((grade) => grade.at));
  }
  return Math.max(...times);
}
/** 课停在课程里已没有的知识点上时，讲解页的说明。 */
const REMOVED_PAGE = "这一节当时要讲的内容已从课程中删去，无法继续。请中止这一节。";

/** 判不了的原因，只在内存里；模型请求失败时带上底座的分类。 */
type Failure = { reason: "service_failure" | "uncertain_grade"; failure?: ModelFailure };

/**
 * 一个空间里的学习会话：事实日志、当前课程、从事实重放出的状态，以及判分。教学方法和辅导共用它。
 * 课程有两种读法：重放、菜单、进度和选题的决定只读课程结构（structure），题面、讲解、判分和能力检查读完整的课程内容（course）。
 * 两者取自同一门当前课程。已有的任务按各自开始时的结构计算（见 Replay）；新任务引用当前结构，见 taskFacts。
 *
 * 判分没有结果（服务失败、模型没有把握、中途关闭）时什么也不写，这份作答尚无证据，不阻塞任务，也不算错。
 * 条件具备时自动补判：打开空间时，规则题当场补判或按改正后的答案重判；代码题等到声明 python.run 的前端来调用，
 * 开放题等到有可用模型的第一次调用。每份作答每次会话最多自动尝试一次，学习者也可以显式恢复。
 *
 * 时间一律取自底座的 host.now()。
 */
export class LearningSession {
  readonly replay: Replay;
  /** 空间里可学的课，按键：完整的课程内容与它的结构。新任务记下所属的课，学习状态按课的键加编号查。 */
  readonly courses: ReadonlyMap<string, CourseContent>;
  readonly timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  private readonly day = dayFormat(this.timeZone);
  /** 需要判分的作答：还没判、按改正后的答案要重判，或申诉后待重判。 */
  private readonly ungraded = new Set<number>();
  private readonly inflight = new Map<number, Promise<void>>();
  private readonly failures = new Map<number, Failure>();
  private readonly attempted = new Set<number>();
  private readonly background = new Set<Promise<unknown>>();
  private readonly rendered = new Map<number, Promise<Rendered>>();
  private readonly explanations = new Map<string, Promise<string>>();
  private unlisten = () => {};
  /** 学习记录里与各门课当前结构相同的一份结构事实的序号，按课的键；还没有时没有这一项。 */
  private readonly recorded = new Map<string, number>();

  private constructor(
    readonly records: LearningRecords,
    courses: readonly { key: string; resolved: ResolvedCourse }[],
    readonly host: Host,
    legacy?: Legacy,
  ) {
    this.courses = new Map(courses.map(({ key, resolved }) => [key, {
      key, resolved, course: new CourseIndex(resolved), structure: new StructureIndex(courseStructure(resolved)),
    }]));
    this.replay = new Replay([...this.courses].map(([key, entry]) => [key, entry.structure] as const), undefined, legacy);
  }

  /** 一门课的内容；课不在空间里（例如换课以前的任务）时为 undefined。 */
  content(key: string): CourseContent | undefined {
    return this.courses.get(key);
  }

  /** 各门课现在的结构，按键。 */
  structures(): Map<string, StructureIndex> {
    return new Map([...this.courses].map(([key, entry]) => [key, entry.structure]));
  }

  /**
   * 从头重放全部事实一次，再找出要补判和重判的作答。只读，不写学习记录：换用课程时先这样建好候选会话，
   * 发布以后再调用 catchUp 补判，所以没有发布的课不会写下判分。courses 是空间里可学的各门课与它们的键；legacy 只给测试里的对照重放用，见 Replay 的 Legacy。
   */
  static async open(records: LearningRecords, courses: readonly { key: string; resolved: ResolvedCourse }[], host: Host, legacy?: Legacy): Promise<LearningSession> {
    const session = new LearningSession(records, courses, host, legacy);
    for (const fact of records.facts) {
      session.observe(fact);
    }
    session.unlisten = records.listen((fact) => session.observe(fact));
    for (const delivery of session.replay.allDeliveries()) {
      if (delivery.answer && await session.prepare(delivery.seq)) {
        session.ungraded.add(delivery.seq);
      }
    }
    return session;
  }

  /** 规则题当场补判或按改正后的答案重判，写下判分。课程发布以后调用；日志尾部残缺时什么也不写。 */
  async catchUp(): Promise<void> {
    const facts: FactBody[] = [];
    for (const seq of this.ungraded) {
      const prepared = await this.prepare(seq);
      if (!prepared || gradingNeed(prepared.question) !== "rule") {
        continue;
      }
      try {
        const judgement = await judgeAnswer(this.host, prepared.content.course.course.course, prepared.question, prepared.topic, prepared.answer);
        facts.push({ type: "graded", delivery: seq, version: prepared.version, verdict: judgement.verdict, slots: judgement.slots });
      } catch {
        // 改过的题判不了，这份作答就仍然没有证据；不因此打不开空间。
        this.failures.set(seq, { reason: "service_failure" });
      }
    }
    if (facts.length && !this.records.incompleteTail) {
      await this.records.write(() => facts);
    }
  }

  /**
   * 开始一项新任务要写的事实，在 write 的回调里调用：任务引用当前的课程结构；学习记录里还没有与之相同的一份结构时，
   * 先写下它，与任务在同一次追加里，结构总在引用它的任务之前。
   */
  taskFacts(task: Omit<FactOf<"task">, "seq" | "at" | "structure" | "course">, key: string): FactBody[] {
    const content = this.courses.get(key);
    if (!content) throw new RepaFault("course_unavailable", "这门课不在空间里");
    const facts: FactBody[] = [];
    let structure = this.recorded.get(key);
    if (structure === undefined) {
      structure = this.records.revision + 1;
      facts.push({ type: "structure", structure: content.structure.data });
    }
    facts.push({ ...task, course: { key, ...content.structure.data.course }, structure });
    return facts;
  }

  private observe(fact: Fact): void {
    this.replay.apply(fact);
    if (fact.type === "structure") {
      for (const [key, content] of this.courses) {
        if (isDeepStrictEqual(fact.structure, content.structure.data)) this.recorded.set(key, fact.seq);
      }
    }
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
    // 只用同一门课、同一道题、学习者看到的同一份题面的判分定义：题目已删除、题面改了或换了一门课，都不能按现在的答案判她当时的作答。
    const versions = await this.seenQuestion(delivery);
    const content = this.courses.get(delivery.task.course);
    const entry = versions && content?.course.questions.get(delivery.questionId);
    if (!entry || !versions || !content) {
      this.ungraded.delete(seq);
      return undefined;
    }
    const latest = delivery.grades.at(-1);
    const appealed = delivery.appeal !== undefined && (!latest || delivery.appeal.seq > latest.seq);
    if (latest && !appealed && latest.version === versions.question) {
      this.ungraded.delete(seq);
      return undefined;
    }
    return { content, question: entry.question, topic: entry.topic, answer, version: versions.question, count: delivery.grades.length };
  }

  /**
   * 一份作答在当前课程里能不能再判：同一门课（任务所属的课的键）、同一道题、学习者看到的同一份题面。能时返回题目的两种版本。
   * 算历史用的结构不决定这一点：两门课可以有同号、同题面的题。
   */
  private async seenQuestion(delivery: DeliveryRecord) {
    const answer = delivery.answer;
    const content = answer && this.courses.get(delivery.task.course);
    if (!answer || !content) return undefined;
    const versions = await content.course.versionsOf(delivery.questionId);
    return versions?.item === answer.seen ? versions : undefined;
  }

  /** 任务所属的课在空间里：它的题面、讲解和题目到那门课的内容里找。 */
  owns(task: TaskRecord): boolean {
    return this.courses.has(task.course);
  }

  /** 一份已判的作答能不能按申诉重判，见 seenQuestion。 */
  async regradable(delivery: DeliveryRecord): Promise<boolean> {
    return (await this.seenQuestion(delivery)) !== undefined;
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
        judgement = await judgeAnswer(this.host, prepared.content.course.course.course, prepared.question, prepared.topic, prepared.answer);
      } catch (error) {
        const failure = modelFailureOf(error);
        this.failures.set(seq, error instanceof RepaFault && error.code === "uncertain_grade"
          ? { reason: "uncertain_grade" }
          : { reason: "service_failure", ...(failure === undefined ? {} : { failure }) });
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

  /** 在后台补判本次会话还没试过的作答；代码题只在调用方声明 python.run 时试，开放题只在有可用模型时试。 */
  autoGrade(capabilities?: ClientCapabilities): void {
    const python = runsPython(capabilities);
    let model: boolean | undefined;
    for (const seq of this.ungraded) {
      const delivery = this.replay.delivery(seq);
      const entry = delivery && this.courses.get(delivery.task.course)?.course.questions.get(delivery.questionId);
      if (!entry || this.attempted.has(seq) || this.inflight.has(seq) || (needsPython(entry.question) && !python)) {
        continue;
      }
      if (needsModel(entry.question) && !(model ??= this.modelAvailable())) {
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

  /** 换用课程时退下这个会话：等在途判分结束，再停止跟随学习记录。学习记录本身由插件关闭。 */
  async retire(): Promise<void> {
    await this.idle();
    this.unlisten();
  }

  /** 通知前端重新读取状态，例如换用课程以后。 */
  announce(): void {
    this.changed();
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

  /** 复习和测验进行中（含准备阶段）不给已答题目的反馈与题解，结束以后才给。 */
  restricted(): boolean {
    this.replay.settle(this.clock());
    const evidence = this.replay.currentEvidence();
    return Boolean(evidence && evidence.task.kind !== "lesson" && evidence.outcome === undefined);
  }

  /**
   * 作答期间不能提问：复习和测验进行中，以及课内有一道题等着作答时，关闭辅导与参考内容。
   * 课内读讲解、看例题和看过反馈以后照常可以问，所以每份作答都是学习者独立完成的。
   */
  private closed(evidence: TaskEvidence | undefined): boolean {
    if (!evidence || evidence.outcome !== undefined) return false;
    return evidence.task.kind !== "lesson" || this.stage(evidence) === "awaiting_answer";
  }

  /** 当前时间，取自底座的 host.now()。 */
  clock(): number {
    return this.host.now();
  }

  /** 现在有没有可用的模型。没有时不出、也不自动补判要由模型判分的开放题。 */
  modelAvailable(): boolean {
    return this.host.models.defaultModel() !== undefined;
  }

  /** 一门课某个 topic 某类任务的题池：课用练习题，复习用复习题，测验与换题重考用测验题。哪些题在池里按当前结构，题目本身取自课程内容。 */
  pool(key: string, topicId: string, kind: TaskRecord["kind"]): QuestionEntry[] {
    const content = this.courses.get(key);
    return content ? this.entries(content, content.structure.pool(topicId, POOLS[kind])).found : [];
  }

  /**
   * 一项已开始的任务能出的题：题号取自任务自己的结构（结算认得的就是这些），题面取自课程内容。
   * removed 是任务结构里有、课程内容里已没有的题的个数：它们出不了，也不能拿别的题顶替。
   */
  taskPool(task: TaskRecord, topicId: string): { found: QuestionEntry[]; removed: number } {
    const ids = task.structure.pool(topicId, POOLS[task.kind]);
    const content = this.courses.get(task.course);
    return content ? this.entries(content, ids) : { found: [], removed: ids.length };
  }

  private entries(content: CourseContent, ids: string[]): { found: QuestionEntry[]; removed: number } {
    const found = ids.flatMap((id) => {
      const entry = content.course.questions.get(id);
      return entry ? [entry] : [];
    });
    return { found, removed: ids.length - found.length };
  }

  /**
   * 判断发起调用的前端能不能用一道题：显示得了题面和作答位，要运行代码的题要声明了 python.run，要模型判分的题要有可用模型。
   * 选题先按它筛，再从余下的题里选；能力只看调用方连接时的声明，模型只在遇到开放题时查一次。
   */
  usable(key: string, capabilities?: ClientCapabilities): (question: Question, topic: Topic) => boolean {
    const python = runsPython(capabilities);
    const course = this.courses.get(key)?.course;
    let model: boolean | undefined;
    return (question, topic) =>
      course !== undefined && canRender(capabilities?.interaction, { requires: course.requires(question, topic) })
      && (python || !needsPython(question))
      && (!needsModel(question) || (model ??= this.modelAvailable()));
  }

  /** 调用方用不了一道题时缺的能力：显示需要的交互能力和 python.run。只缺可用模型时为空。 */
  missing(key: string, question: Question, topic: Topic, capabilities?: ClientCapabilities): string[] {
    const supports = new Set(capabilities?.interaction?.supports ?? []);
    const missing = (this.courses.get(key)?.course.requires(question, topic) ?? []).filter((name) => !supports.has(name));
    if (needsPython(question) && !runsPython(capabilities)) {
      missing.push(PYTHON_RUN);
    }
    return missing.sort();
  }

  /** 某个 topic 当前调用方能用的题，用于菜单判断题够不够；没有一道能用的知识点，它所在的课不进菜单。 */
  questions(key: string, topicId: string, kind: TaskRecord["kind"], capabilities?: ClientCapabilities): QuestionEntry[] {
    const topic = this.courses.get(key)?.course.topics.get(topicId);
    if (!topic) {
      return [];
    }
    const usable = this.usable(key, capabilities);
    return this.pool(key, topicId, kind).filter((entry) => usable(entry.question, topic));
  }

  /** 当前调用方看到的完整学习状态。 */
  async state(capabilities?: ClientCapabilities): Promise<LearningState> {
    return (await this.view(capabilities)).state;
  }

  async view(capabilities?: ClientCapabilities): Promise<LearningView> {
    const now = this.clock();
    this.replay.settle(now);
    const evidence = this.replay.currentEvidence();
    const fold = this.gate(this.replay.fold());
    const finished = !evidence || evidence.outcome !== undefined;
    const restricted = Boolean(evidence && evidence.task.kind !== "lesson" && !finished);
    // 结束的任务只在得出结果的那个本地自然日里留作当前画面；换了一天（按日期，不按经过的小时数），打开时就是菜单。
    // 没结束的任务不受影响，照旧接着做。
    const shown = evidence && (evidence.outcome === undefined || this.day.format(resultAt(evidence)) === this.day.format(now)) ? evidence : undefined;
    let menu: LearningMenu | null = null;
    if (finished) {
      // 一份菜单：各门课按各自的规则算出候选，再并起来（见 combinedMenu）；强制补救是全局的门，任何一门课有就只给它。
      const parts = [...this.courses.values()].map(({ key, course, structure }) => {
        const supply = (id: string, kind: TaskRecord["kind"]) => {
          const available = this.questions(key, id, kind, capabilities);
          if (kind !== "lesson") return available.length > 0;
          // 课要把每个没过的知识点的必做题都做完，所以这些题都得是调用方能用的。
          const inherited = fold.lessons.get(scoped(key, id)) ?? [];
          const practice = lessonPractice(structure, id);
          const usable = new Set(available.map((entry) => entry.question.id));
          return structure.topics.get(id)?.kps.every((kp) => {
            if (inherited.some((entry) => entry.kpId === kp.id && entry.completed)) return true;
            const needed = practice.get(kp.id)?.required ?? [];
            return needed.length > 0 && needed.every((question) => usable.has(question));
          }) ?? false;
        };
        const title = (id: string) => course.topics.get(id)?.title ?? id;
        const studied = this.replay.tasks.findLast((task) => task.course === key)?.seq ?? 0;
        return { key, studied, menu: learningMenu(structure, key, fold, now, this.menuId(), supply, this.timeZone, title) };
      });
      menu = progressMenu(combinedMenu(parts, fold, now, this.menuId()), this.replay, fold, new Set(this.courses.keys()));
    }
    let restriction: LearningState["restrictions"]["kind"] = "none";
    if (restricted && evidence) {
      restriction = isQuiz(evidence.task.kind) ? "quiz" : "review";
    }
    // 正在学的课：画面上这项任务所属的课；没有任务时是空间里的第一门。几门课各自的进度在 courses 里。
    const shownCourse = (shown && this.courses.get(shown.task.course)) ?? this.courses.values().next().value;
    const structures = [...this.courses.values()].map(({ key, structure }) => [key, structure] as const);
    return {
      student: fold.student,
      state: {
        revision: this.records.revision,
        serverNow: now,
        started: this.replay.tasks.length > 0,
        course: shownCourse ? manifest(shownCourse) : null,
        courses: [...this.courses.values()].map((content) => ({ key: content.key, ...manifest(content), ...topicCounts(fold, content.key, content.structure) })),
        task: shown ? await this.task(shown) : null,
        menu,
        restrictions: { kind: restriction, tutorAllowed: !this.closed(evidence), referenceContentAllowed: !this.closed(evidence) },
        progress: progressView(this.replay, fold, structures, now, this.timeZone),
      },
    };
  }

  /** 学习状态里还要求的强制补救：只有课还在空间里、topic 还在那门课现在的结构里的，见 obligations。 */
  gate(fold: Fold): Fold {
    return obligations(fold, (key) => this.courses.get(key)?.structure);
  }

  /**
   * 当前任务的公开画面。topic 与知识点带当前课程里的标题，复习、测验期间界面也不必另查内容。
   * topic 已从课程删除时标题退回为它的 id；知识点由 taskKps 从当前课程取出，总有标题。
   */
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
    // 别的课的任务（换课以前留下的）在这门课的内容里没有标题，退回为编号。
    const content = (id: string) => this.courses.get(task.course)?.course.topics.get(id);
    const topics = task.topicIds.map((id) => ({ id, title: content(id)?.title ?? id }));
    const kpTitles = new Map<string, string>();
    for (const id of task.topicIds) {
      for (const kp of content(id)?.kps ?? []) {
        kpTitles.set(kp.id, kp.title);
      }
    }
    return {
      taskId: taskId(task),
      kind: task.kind,
      course: task.course,
      topics,
      phase: await this.phase(evidence),
      startedAt: evidence.startedAt,
      deadlineAt: evidence.deadlineAt,
      kps: evidence.kps.map((kp) => ({ ...kp, title: kpTitles.get(kp.kpId) ?? kp.kpId })),
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
    | { stage: "completed"; outcome: "passed" | "failed" | "timeout" | "unresolved" }
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
        // 目前中止只有学习者自己点的这一种（新任务开始时还没结束的那项也算它），说明里不另附原因。
        return { stage: "aborted", reason: "" };
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
    const course = this.courses.get(task.course)?.course;
    const topic = course?.topics.get(task.topicIds[0] ?? "");
    const kp = topic?.kps.find((entry) => entry.id === kpId);
    // 引用带上课的键：两门课的编号可以相同。课程标识取自这门课现在的清单；课不在了取任务开始时的结构里记的。
    const courseId = course?.course.course.id ?? task.structure.data.course.id;
    if (!topic || !kp) {
      // 课停在当前课程里已没有的知识点上（例如随包的课随应用更新删了它）：给一页说明，学习者可以中止这节课，状态照常读出。
      // 任务还没翻到任何知识点（kpId 为空）时引用落在 topic 上，不带知识点。
      const blocks: Content = [{ type: "markdown", text: REMOVED_PAGE }];
      const topicId = task.topicIds[0] ?? "";
      const ref = {
        course: task.course,
        courseId,
        topicId,
        ...(kpId === "" ? {} : { kpId }),
        id: `${kpId === "" ? topicId : kpId}.${stage}`,
        version: await contentVersion(blocks),
        kind: stage === "example" ? ("example" as const) : ("lesson" as const),
      };
      return { ref, origin: { taskId: taskId(task), content: ref }, offset: 0, total: blocks.length, blocks };
    }
    const ref = {
      course: task.course,
      courseId,
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
        const entry = this.courses.get(delivery.task.course)?.course.questions.get(delivery.questionId);
        const identity = {
          deliveryId: deliveryId(delivery),
          submissionId: submissionId(delivery),
          repeated: this.replay.firstDelivered(delivery.task.course, delivery.questionId) !== delivery.seq,
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
    const seen = await this.seenQuestion(delivery);
    // 申诉以后题目删了、题面改了或换了课，就再也判不了：保留最后一次判分，不显示为等待重判。
    const appealed = delivery.appeal !== undefined && (!latest || delivery.appeal.seq > latest.seq) && seen !== undefined;
    let processing: Submission["processing"];
    if (latest && !appealed) {
      processing = { status: "completed" };
    } else if (this.inflight.has(delivery.seq)) {
      processing = { status: "pending" };
    } else {
      processing = { status: "interrupted", ...this.failures.get(delivery.seq) ?? { reason: "restart" } };
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
    const entry = await this.releasedQuestion(delivery);
    if (latest && entry) {
      result.feedback = feedbackOf(latest, entry.question, shown.item, idMap, reference);
      result.explanation = content(entry.question.explanation);
    }
    return result;
  }

  /**
   * 一份作答此刻可以放出反馈与解析的那道题：已经判过、任务允许放出（见 released），而且是学习者看到的同一份题面（见 seenQuestion）。
   * 题面改了就不放：新版的解析不配旧题。作答查询、参考搜索与读取都经这里判断。
   */
  async releasedQuestion(delivery: DeliveryRecord): Promise<IndexedQuestion | undefined> {
    if (!delivery.grades.length || !this.released(delivery) || !await this.seenQuestion(delivery)) return undefined;
    return this.courses.get(delivery.task.course)?.course.questions.get(delivery.questionId);
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
  explanationVersion(key: string, questionId: string, blocks: Content): Promise<string> {
    let cached = this.explanations.get(scoped(key, questionId));
    if (!cached) {
      cached = contentVersion(blocks);
      this.explanations.set(scoped(key, questionId), cached);
    }
    return cached;
  }
}

