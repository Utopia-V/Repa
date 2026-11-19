import type { ModelConfig } from "@repa/learning-model";
import { scoped } from "./course-key.js";
import { StructureIndex } from "./course-structure.js";
import {
  deadlineAt,
  emptyFold,
  foldTask,
  isQuiz,
  taskEvidence,
  type DeliveryRecord,
  type Fold,
  type TaskEvidence,
  type TaskRecord,
} from "./flow-state.js";
import { QUIZ_EVERY_XP, QUIZ_WINDOW_XP, STUDENT_MODEL } from "./parameters.js";
import { reward, sampleTopics } from "./progress.js";
import type { Fact } from "./records-schema.js";

/** 一笔 XP：某项任务的奖励比此前结算的最高值多出的部分，记在使它变高的事实发生的时刻。 */
export interface Award {
  task: number;
  xp: number;
  at: number;
  quiz: boolean;
}

/**
 * 序号不大于 upTo 的任务一律按 structure 计算，不看它们引用的结构事实。产品不用它：只为测试里用冻结的测试版数据对照重放
 * （test/fixtures/test1/），那些任务还没有结构引用。学生模型改成按知识点时，连同那份固定数据一起退役。
 */
export interface Legacy {
  upTo: number;
  structure: StructureIndex;
  /** 这些任务的学习状态归哪门课的键（那些任务事实里还没有记课的键）。 */
  key: string;
}

/** 累计 XP 到了门槛、尚未开始的测验。n 是第几场，atXp 是出现时的累计值，用来算延后窗口。 */
export interface PendingQuiz {
  n: number;
  atXp: number;
  topicIds: string[];
  /** 题单所属的课：选 topic 时用的那门课的键。 */
  course: string;
}

/**
 * 按事实的先后重放学习状态。打开空间时从第一条事实重放一次；之后每追加一条事实增量更新。
 *
 * 学生模型等学习状态是已结束任务依次叠加的结果。只有改变更早任务证据的事实（补判、改了结论的重判）
 * 让叠加结果过期，过期以后在下一次用到时整段重算一次，recomputations 记录重算的次数。
 *
 * XP 按任务的实际结论、在事实发生时结算：奖励变高时补发差额，变低时不收回。是否通过看实际结论，奖励的多少只看
 * 这项任务自己的作答。结算的时刻都是事实的边界，用到的状态也只取决于此前的事实，所以重放与现场得到同样的 XP。
 *
 * 每项任务按它开始时的课程结构计算（TaskRecord.structure），即它引用的结构事实。
 * structure 是当前的课程结构，只用于为新的测验选 topic；菜单与进度由调用方按当前结构另算。
 *
 * model 是学生模型的参数，缺省为插件实际使用的一组。换一组参数重放同一份事实，可以比较两组参数的预测。
 */
export class Replay {
  readonly tasks: TaskRecord[] = [];
  readonly awards: Award[] = [];
  /** 学习者设定的日目标；没有设定时为 undefined。 */
  goal: number | undefined;
  /** 已开始的测验场数，开始前中止的不算。 */
  consumed = 0;
  pending: PendingQuiz | undefined;
  /** 非测验任务的累计 XP，触发测验用。 */
  trigger = 0;
  total = 0;
  /** 代价关卡的计数：重放过的事实条数、整段重算已结束任务的次数，以及为测验选题扫描历史的次数。 */
  applied = 0;
  recomputations = 0;
  samplings = 0;
  private readonly deliveries = new Map<number, DeliveryRecord>();
  private readonly taskIndex = new Map<number, TaskRecord>();
  private readonly firstDeliveries = new Map<string, number>();
  private readonly best = new Map<number, number>();
  /** 除最后一项任务以外的任务叠加出的学习状态。 */
  private prefix: Fold = emptyFold();
  private stale = false;
  /** 学习状态每变一次加一；测验没选到 topic 时，只在它变了以后重选。 */
  private changes = 0;
  private sampled = "";
  /** 学习记录里的课程结构，按事实序号。 */
  private readonly structures = new Map<number, StructureIndex>();
  /** 最近重放的事实序号。 */
  private position = 0;

  /** key 与 structure 是当前的课，只用于为新的测验选 topic。 */
  constructor(
    private readonly key: string,
    private readonly structure: StructureIndex,
    private readonly model: ModelConfig = STUDENT_MODEL,
    private readonly legacy?: Legacy,
  ) {}

  get current(): TaskRecord | undefined {
    return this.tasks.at(-1);
  }

  task(seq: number): TaskRecord | undefined {
    return this.taskIndex.get(seq);
  }

  delivery(seq: number): DeliveryRecord | undefined {
    return this.deliveries.get(seq);
  }

  allDeliveries(): IterableIterator<DeliveryRecord> {
    return this.deliveries.values();
  }

  /** 这门课的这道题第一次交付的事实序号；出过的题再出时标记为重复。 */
  firstDelivered(key: string, questionId: string): number | undefined {
    return this.firstDeliveries.get(scoped(key, questionId));
  }

  /**
   * 当前任务的证据。课的进度从重算后的学习状态继承：更早任务的重判改变了继承的进度时，当前的课随之改变，
   * 与学生模型和菜单一致，XP 也按这个结论结算。
   */
  currentEvidence(): TaskEvidence | undefined {
    const task = this.current;
    if (!task) return undefined;
    const inherited = task.kind === "lesson" ? this.before().lessons.get(scoped(task.course, task.topicIds[0] ?? "")) : undefined;
    return taskEvidence(task, inherited);
  }

  /** 当前任务之前的学习状态，用于判断当前任务是否仍有资格。 */
  before(): Fold {
    if (this.stale) {
      let fold = emptyFold();
      for (const task of this.tasks.slice(0, -1)) {
        fold = foldTask(fold, taskEvidence(task, fold.lessons.get(scoped(task.course, task.topicIds[0] ?? ""))), this.model);
      }
      this.prefix = fold;
      this.stale = false;
      this.recomputations++;
      this.changes++;
    }
    return this.prefix;
  }

  /** 包括已结束的当前任务在内的学习状态。 */
  fold(): Fold {
    const prefix = this.before();
    const entry = this.currentEvidence();
    return entry?.outcome ? foldTask(prefix, entry, this.model) : prefix;
  }

  /** 截止时间已过的测验在截止时刻结束（课和复习不限时）；时间只会向前，所以在读取时就地结算与重放结果一致。 */
  settle(now: number): void {
    const task = this.current;
    const deadline = task && deadlineAt(task);
    if (!task || task.timedOut || deadline === null || deadline === undefined || now < deadline) return;
    task.timedOut = true;
    this.observe(task, deadline);
    this.checkQuiz();
  }

  apply(fact: Fact): void {
    this.applied++;
    this.position = fact.seq;
    // 课程结构只登记解释的依据，不是学习者做的事：写下它的时刻不推进学习时钟，进行中测验的截止仍由学习事实和读数时间决定。
    if (fact.type === "structure") {
      this.structures.set(fact.seq, new StructureIndex(fact.structure));
      return;
    }
    this.settle(fact.at);
    let changed: TaskRecord | undefined;
    switch (fact.type) {
      case "task": {
        const previous = this.current;
        if (previous) {
          previous.nextAt = fact.at;
          // 结束的课记下此刻实际继承的进度：按它得出结论、结算 XP，再叠加进学习状态；之后它自己的判分改变时也按它结算。
          const prefix = this.before();
          const inherited = prefix.lessons.get(scoped(previous.course, previous.topicIds[0] ?? ""));
          if (previous.kind === "lesson" && inherited) previous.inherited = inherited;
          const entry = taskEvidence(previous, previous.inherited);
          this.observe(previous, fact.at, entry);
          this.prefix = foldTask(prefix, entry, this.model);
          this.changes++;
        }
        const task: TaskRecord = {
          seq: fact.seq,
          at: fact.at,
          kind: fact.kind,
          topicIds: [...fact.topics],
          course: this.taskCourse(fact),
          structure: this.taskStructure(fact),
          ...(fact.retakes === undefined ? {} : { retakes: fact.retakes }),
          ...(fact.practice === undefined ? {} : { practice: fact.practice }),
          ...(fact.minutes === undefined ? {} : { minutes: fact.minutes }),
          deliveries: [],
          answered: [],
          timedOut: false,
        };
        this.tasks.push(task);
        this.taskIndex.set(task.seq, task);
        if (task.kind === "quiz") this.consumed++;
        break;
      }
      case "viewed": {
        const task = this.taskOf(fact.task);
        task.page = { seq: fact.seq, kp: fact.kp, page: fact.page };
        changed = task;
        break;
      }
      case "delivered": {
        const task = this.taskOf(fact.task);
        const delivery: DeliveryRecord = {
          seq: fact.seq, at: fact.at, task, questionId: fact.question, seed: fact.seed, grades: [],
        };
        task.deliveries.push(delivery);
        this.deliveries.set(fact.seq, delivery);
        const first = scoped(task.course, fact.question);
        if (!this.firstDeliveries.has(first)) this.firstDeliveries.set(first, fact.seq);
        if (task.kind === "quiz" && task.deliveries.length === 1) this.pending = undefined;
        changed = task;
        break;
      }
      case "answered": {
        const delivery = this.deliveryOf(fact.delivery);
        delivery.answer = fact;
        delivery.task.answered.push(delivery);
        changed = delivery.task;
        break;
      }
      case "graded": {
        const delivery = this.deliveryOf(fact.delivery);
        const last = delivery.grades.at(-1)?.verdict;
        delivery.grades.push(fact);
        // 证据只看最新判分的对错：重判的结论没变（例如按改正后的答案重判仍然判对），学习状态和 XP 都不变。
        if (last !== fact.verdict) changed = delivery.task;
        break;
      }
      case "appealed":
        this.deliveryOf(fact.delivery).appeal = fact;
        break;
      case "ended": {
        const task = this.taskOf(fact.task);
        task.endedAt = fact.at;
        if (task.kind === "quiz" && task.deliveries.length === 0) this.consumed--;
        changed = task;
        break;
      }
      case "goal":
        this.goal = fact.xp;
        break;
    }
    if (changed) {
      const earlier = changed !== this.current;
      // 更早任务的证据变了：之后的学习状态过期，用到时整段重算。
      if (earlier) {
        this.stale = true;
        this.changes++;
        if (this.current?.kind === "lesson") this.current.inheritanceChangedAt = fact.at;
      }
      this.observe(changed, fact.at);
      if (earlier) {
        this.reconsiderCurrent(fact.at);
      }
    }
    this.checkQuiz();
  }

  /**
   * 更早任务的证据变了，当前的课继承的进度可能随之完成，这节课就此通过，此刻也要结算。只有通过时的奖励高于已经结算的值，
   * 才按实际结论再算一次：这需要整段重算，而奖励的多少只看这节课自己的作答，不用重算就能判断有没有补发的可能。
   */
  private reconsiderCurrent(at: number): void {
    const task = this.current;
    if (task?.kind !== "lesson") return;
    const own = taskEvidence(task, undefined);
    if (reward({ ...own, outcome: "passed" }) > (this.best.get(task.seq) ?? 0)) {
      this.observe(task, at);
    }
  }

  /** 任务所属的课：事实里记着的键（对照用的 legacy 之内归它给的那门课）。 */
  private taskCourse(fact: Extract<Fact, { type: "task" }>): string {
    if (this.legacy && fact.seq <= this.legacy.upTo) return this.legacy.key;
    return fact.course.key;
  }

  /** 任务开始时的课程结构：它引用的那一份（对照用的 legacy 见 Legacy）。 */
  private taskStructure(fact: Extract<Fact, { type: "task" }>): StructureIndex {
    if (this.legacy && fact.seq <= this.legacy.upTo) return this.legacy.structure;
    const structure = this.structures.get(fact.structure);
    if (!structure) throw new Error(`第 ${fact.seq} 条任务没有课程结构`);
    return structure;
  }

  private taskOf(seq: number): TaskRecord {
    const task = this.taskIndex.get(seq);
    if (!task) throw new Error(`重放缺少第 ${seq} 条任务`);
    return task;
  }

  private deliveryOf(seq: number): DeliveryRecord {
    const delivery = this.deliveries.get(seq);
    if (!delivery) throw new Error(`重放缺少第 ${seq} 条交付`);
    return delivery;
  }

  /**
   * 按一项任务的实际结论结算 XP：只在奖励变高时补发差额，变低时不收回。当前任务从重算后的学习状态继承进度；
   * 已结束的任务用它结束时实际继承的那份（task.inherited）。
   */
  private observe(task: TaskRecord, at: number, entry?: TaskEvidence): void {
    const evidence = entry ?? (task === this.current ? this.currentEvidence() : taskEvidence(task, task.inherited));
    // XP 发了就不收回。课和复习的奖励按判出结果的作答里答对的比例算，后判出的错题会把比例拉低，所以还有没判出结果的作答时
    // 不结算，等它们判出来按全部证据再发；测验按全部交付算，后判出的结果只会让奖励变高，照常结算。
    if (!evidence || (!isQuiz(task.kind) && evidence.attempts.some((attempt) => attempt.verdict === undefined))) return;
    const value = reward(evidence);
    const best = this.best.get(task.seq) ?? 0;
    if (value <= best) return;
    this.best.set(task.seq, value);
    const quiz = isQuiz(task.kind);
    this.awards.push({ task: task.seq, xp: value - best, at, quiz });
    this.total += value - best;
    if (!quiz) this.trigger += value - best;
  }

  /** 没有进行中的任务时，累计 XP 每到一个门槛就出现一场测验；题目所属的 topic 在出现时选定。 */
  private checkQuiz(): void {
    const due = !this.pending && this.trigger >= (this.consumed + 1) * QUIZ_EVERY_XP;
    const empty = this.pending !== undefined && !this.pending.topicIds.length;
    if (!due && !empty) return;
    // 当前任务的结论与界面一致，用重算后的学习状态；只在要出测验或重选时才算。
    const evidence = this.currentEvidence();
    if (evidence && !evidence.outcome) return;
    // 学习状态由更早任务的叠加和当前任务的结论决定；它没变，重选也选不出别的 topic。
    const state = `${this.changes}:${evidence?.task.seq ?? 0}:${evidence?.outcome ?? ""}`;
    if (due) {
      const n = this.consumed + 1;
      this.sampled = state;
      const picked = this.pick(n);
      this.pending = { n, atXp: this.trigger, topicIds: picked.topicIds, course: picked.course };
    } else if (this.pending && this.sampled !== state) {
      this.sampled = state;
      const picked = this.pick(this.pending.n);
      this.pending.topicIds = picked.topicIds;
      this.pending.course = picked.course;
    }
  }

  /** 选题要扫描一遍历史；还没有学过、带测验题的 topic 时不扫描。新的测验从当前结构选 topic（对照用的 legacy 之内按它的结构）。 */
  private pick(n: number): { topicIds: string[]; course: string } {
    const fold = this.fold();
    const [structure, course] = this.legacy && this.position <= this.legacy.upTo ? [this.legacy.structure, this.legacy.key] : [this.structure, this.key];
    if (!structure.order.some((topic) => fold.student[scoped(course, topic.id)] && structure.quizTopics.has(topic.id))) {
      return { topicIds: [], course };
    }
    this.samplings++;
    return { topicIds: sampleTopics(this.tasks, fold, structure, course, n), course };
  }

  /** 测验出现后又攒够延后窗口，就只提供测验。 */
  quizOnly(): boolean {
    return this.pending !== undefined && this.trigger >= this.pending.atXp + QUIZ_WINDOW_XP;
  }
}
