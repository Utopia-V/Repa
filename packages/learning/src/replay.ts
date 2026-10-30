import type { ModelConfig } from "@repa/learning-model";
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

/** 累计 XP 到了门槛、尚未开始的测验。n 是第几场，atXp 是出现时的累计值，用来算延后窗口。 */
export interface PendingQuiz {
  n: number;
  atXp: number;
  topicIds: string[];
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

  constructor(private readonly course: CourseIndex, private readonly model: ModelConfig = STUDENT_MODEL) {}

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

  /**
   * 当前任务的证据。课的进度从重算后的学习状态继承：更早任务的重判改变了继承的进度时，当前的课随之改变，
   * 与学生模型和菜单一致，XP 也按这个结论结算。
   */
  currentEvidence(): TaskEvidence | undefined {
    const task = this.current;
    if (!task) return undefined;
    const inherited = task.kind === "lesson" ? this.before().lessons.get(task.topicIds[0] ?? "") : undefined;
    return taskEvidence(task, this.course, inherited);
  }

  /** 当前任务之前的学习状态，用于判断当前任务是否仍有资格。 */
  before(): Fold {
    if (this.stale) {
      let fold = emptyFold();
      for (const task of this.tasks.slice(0, -1)) {
        fold = foldTask(fold, taskEvidence(task, this.course, fold.lessons.get(task.topicIds[0] ?? "")), this.course, this.model);
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
    return entry?.outcome ? foldTask(prefix, entry, this.course, this.model) : prefix;
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
          // 结束的课记下此刻实际继承的进度：按它得出结论、结算 XP，再叠加进学习状态；之后它自己的判分改变时也按它结算。
          const prefix = this.before();
          const inherited = prefix.lessons.get(previous.topicIds[0] ?? "");
          if (previous.kind === "lesson" && inherited) previous.inherited = inherited;
          const entry = taskEvidence(previous, this.course, previous.inherited);
          this.observe(previous, fact.at, entry);
          this.prefix = foldTask(prefix, entry, this.course, this.model);
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
    const own = taskEvidence(task, this.course, undefined);
    if (reward({ ...own, outcome: "passed" }, this.course) > (this.best.get(task.seq) ?? 0)) {
      this.observe(task, at);
    }
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
    const evidence = entry ?? (task === this.current ? this.currentEvidence() : taskEvidence(task, this.course, task.inherited));
    if (!evidence) return;
    const value = reward(evidence, this.course);
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
      this.pending = { n, atXp: this.trigger, topicIds: this.pick(n) };
    } else if (this.pending && this.sampled !== state) {
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
