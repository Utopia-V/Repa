import type { CourseIndex } from "./course-index.js";
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
import { QUIZ_EVERY_XP, QUIZ_WINDOW_XP, reward, sampleTopics } from "./progress.js";
import type { Fact } from "./records-schema.js";

/** 一笔 XP：某项任务的奖励比此前结算的最高值多出的部分，记在使它变高的事实发生的时刻。 */
export interface Award {
  task: number;
  xp: number;
  at: number;
  quiz: boolean;
}

/** 累计 XP 到了门槛、尚未开始的测验。n 是第几场，atXp 是出现时的累计值，用来算延后窗口。 */
export interface PendingQuiz {
  n: number;
  atXp: number;
  topicIds: string[];
}

/**
 * 按事实的先后重放学习状态。打开空间时从第一条事实重放一次；之后每追加一条事实增量更新。
 *
 * 学生模型等学习状态是已结束任务依次叠加的结果。只有改变更早任务证据的事实（补判、重判）
 * 让叠加结果过期，过期以后在下一次用到时整段重算一次，recomputations 记录重算的次数。
 *
 * XP 按事实发生的先后结算：任务结束时结算一次，之后这项任务的判分改变使奖励变高时补发差额，变低时不收回。
 * 结算只用这项任务自己的事实和它开始时继承的课内进度，所以重放与现场得到同样的 XP。
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

  constructor(private readonly course: CourseIndex) {}

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

  /** 这道题第一次交付的事实序号；出过的题再出时标记为重复。 */
  firstDelivered(questionId: string): number | undefined {
    return this.firstDeliveries.get(questionId);
  }

  /** 当前任务的证据，用它开始时继承的进度计算。 */
  currentEvidence(): TaskEvidence | undefined {
    const task = this.current;
    return task && taskEvidence(task, this.course, task.inherited);
  }

  /** 当前任务之前的学习状态，用于判断当前任务是否仍有资格。 */
  before(): Fold {
    if (this.stale) {
      let fold = emptyFold();
      for (const task of this.tasks.slice(0, -1)) {
        fold = foldTask(fold, taskEvidence(task, this.course, fold.lessons.get(task.topicIds[0] ?? "")), this.course);
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
    const task = this.current;
    if (!task) return prefix;
    const entry = taskEvidence(task, this.course, prefix.lessons.get(task.topicIds[0] ?? ""));
    return entry.outcome ? foldTask(prefix, entry, this.course) : prefix;
  }

  /** 截止时间已过的复习或测验在截止时刻结束；时间只会向前，所以在读取时就地结算与重放结果一致。 */
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
    this.settle(fact.at);
    let changed: TaskRecord | undefined;
    switch (fact.type) {
      case "task": {
        const previous = this.current;
        if (previous) {
          previous.nextAt = fact.at;
          this.observe(previous, fact.at);
          const prefix = this.before();
          this.prefix = foldTask(prefix, taskEvidence(previous, this.course, prefix.lessons.get(previous.topicIds[0] ?? "")), this.course);
          this.changes++;
        }
        const task: TaskRecord = {
          seq: fact.seq,
          at: fact.at,
          kind: fact.kind,
          topicIds: [...fact.topics],
          ...(fact.retakes === undefined ? {} : { retakes: fact.retakes }),
          deliveries: [],
          answered: [],
          timedOut: false,
        };
        const inherited = this.prefix.lessons.get(task.topicIds[0] ?? "");
        if (task.kind === "lesson" && inherited) task.inherited = inherited;
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
          seq: fact.seq, at: fact.at, task, questionId: fact.question, seed: fact.seed, help: false, grades: [],
        };
        task.deliveries.push(delivery);
        this.deliveries.set(fact.seq, delivery);
        if (!this.firstDeliveries.has(fact.question)) this.firstDeliveries.set(fact.question, fact.seq);
        if (task.kind === "quiz" && task.deliveries.length === 1) this.pending = undefined;
        changed = task;
        break;
      }
      case "help": {
        const delivery = this.deliveryOf(fact.delivery);
        // 只有作答之前的求助影响这份作答是否独立完成。
        if (!delivery.answer) delivery.help = true;
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
        delivery.grades.push(fact);
        changed = delivery.task;
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
      // 更早任务的证据变了：之后的学习状态过期，用到时整段重算。
      if (changed !== this.current) {
        this.stale = true;
        this.changes++;
      }
      this.observe(changed, fact.at);
    }
    this.checkQuiz();
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

  /** 按这项任务自己的事实结算 XP：只在奖励变高时补发差额。 */
  private observe(task: TaskRecord, at: number): void {
    const value = reward(taskEvidence(task, this.course, task.inherited), this.course);
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
    const task = this.current;
    const outcome = task && taskEvidence(task, this.course, task.inherited).outcome;
    if (task && !outcome) return;
    // 学习状态由更早任务的叠加和当前任务的结论决定；它没变，重选也选不出别的 topic。
    const state = `${this.changes}:${task?.seq ?? 0}:${outcome ?? ""}`;
    if (!this.pending && this.trigger >= (this.consumed + 1) * QUIZ_EVERY_XP) {
      const n = this.consumed + 1;
      this.sampled = state;
      this.pending = { n, atXp: this.trigger, topicIds: this.pick(n) };
    } else if (this.pending && !this.pending.topicIds.length && this.sampled !== state) {
      this.sampled = state;
      this.pending.topicIds = this.pick(this.pending.n);
    }
  }

  /** 选题要扫描一遍历史；还没有学过、带测验题的 topic 时不扫描。 */
  private pick(n: number): string[] {
    const fold = this.fold();
    if (!this.course.course.topics.some((topic) => fold.student[topic.id] && this.course.quizTopics.has(topic.id))) {
      return [];
    }
    this.samplings++;
    return sampleTopics(this.tasks, fold, this.course, n);
  }

  /** 测验出现后又攒够延后窗口，就只提供测验。 */
  quizOnly(): boolean {
    return this.pending !== undefined && this.trigger >= this.pending.atXp + QUIZ_WINDOW_XP;
  }
}
