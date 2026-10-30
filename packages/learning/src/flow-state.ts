import type { ModelConfig, Student } from "@repa/learning-model";
import type { CourseIndex } from "./course-index.js";
import { shuffled } from "./delivery.js";
import {
  FAIL_QUALITY_FLOOR,
  KP_MAX_ATTEMPTS,
  KP_PASS_STREAK,
  KP_WRONG_LIMIT,
  QUIZ_DURATION_MS,
  REVIEW_FINAL_STREAK,
  REVIEW_MAX_QUESTIONS,
  REVIEW_PASS_CORRECT,
  STUDENT_MODEL,
} from "./parameters.js";
import type { LearningTask } from "./protocol.js";
import type { FactOf, TaskKind } from "./records-schema.js";
import { topicDue, topicMemory, updateStudent } from "./student-model.js";

/** 一个知识点在本次课里的进度。 */
export type KpProgress = LearningTask["kps"][number];
/**
 * 任务的结论：通过、失败、超时、主动结束，或没有结论就被后来的任务取代。只有测验限时，超时只出现在测验上。
 * unresolved 是测验已经结束（交卷或到了截止时间），但还有没判出结果的作答，判出来就可能改变结论：结论等它们判出来再定。
 */
export type Outcome = "passed" | "failed" | "timeout" | "unresolved" | "aborted" | "ended";

/** 从事实重放出的一次交付：出了哪道题、作答前是否求助、作答和历次判分。 */
export interface DeliveryRecord {
  seq: number;
  at: number;
  task: TaskRecord;
  questionId: string;
  seed: number;
  /** 作答之前问过辅导或读过参考内容。 */
  help: boolean;
  answer?: FactOf<"answered">;
  grades: FactOf<"graded">[];
  /** 最近一次申诉；晚于最近一次判分时，这份作答等待重判。 */
  appeal?: FactOf<"appealed">;
}

/** 从事实重放出的一项任务。 */
export interface TaskRecord {
  seq: number;
  /** 选定任务的时间。 */
  at: number;
  kind: TaskKind;
  topicIds: string[];
  retakes?: number;
  deliveries: DeliveryRecord[];
  /** 已作答的交付，按作答先后。 */
  answered: DeliveryRecord[];
  /** 课内最后一次翻到的讲解或例题页。 */
  page?: { seq: number; kp: string; page: "lesson" | "example" };
  /** 学习者主动结束的时间。 */
  endedAt?: number;
  /** 重放到的时刻已过截止时间。 */
  timedOut: boolean;
  /** 下一个任务开始的时间；有了下一个任务，这个任务一定已经结束。 */
  nextAt?: number;
  /**
   * 课结束时实际继承的知识点进度，在下一项任务开始时记下。之后这节课自己的判分改变时，按它得出结论、补发 XP 差额。
   * 进行中的课从重算后的学习状态继承，见 Replay.currentEvidence。
   */
  inherited?: KpProgress[];
}

/** 一份作答作为证据的样子；verdict 缺省表示尚无证据（没判或判不了），既不算对也不算错。 */
export interface Attempt {
  delivery: DeliveryRecord;
  kpId: string;
  topicId: string;
  acceptedAt: number;
  independent: boolean;
  dontKnow: boolean;
  verdict?: FactOf<"graded">["verdict"];
}

/** 一项任务的证据与结论。 */
export interface TaskEvidence {
  task: TaskRecord;
  attempts: Attempt[];
  kps: KpProgress[];
  outcome?: Outcome;
  /** 结论的时刻：超时取截止时间，按作答得出结论取最后一份已判作答的时间，主动结束取结束时间。 */
  at: number;
  startedAt: number | null;
  deadlineAt: number | null;
}

/** 依次叠加已结束任务得到的学习状态。 */
export interface Fold {
  student: Student;
  lessons: Map<string, KpProgress[]>;
  failures: Map<string, { at: number; kpId: string; stuck: boolean }>;
  forced: Map<string, "review" | "lesson">;
  consecutiveReviews: number;
}

export const isQuiz = (kind: TaskKind) => kind === "quiz" || kind === "retake";
/** 公开的任务、交付与提交编号由对应事实的序号得出，不另存。 */
export const taskId = (task: TaskRecord) => `t${task.seq}`;
export const deliveryId = (delivery: DeliveryRecord) => `d${delivery.seq}`;
export const submissionId = (delivery: DeliveryRecord) => `s${delivery.seq}`;
/** 从公开编号取回事实序号；格式不符时返回 undefined。 */
export function sequenceOf(id: string, prefix: "t" | "d" | "s"): number | undefined {
  const match = new RegExp(`^${prefix}([1-9][0-9]*)$`).exec(id);
  return match ? Number(match[1]) : undefined;
}
export const independentCorrect = (attempt: Attempt) =>
  attempt.independent && !attempt.dontKnow && attempt.verdict === "correct";
/** 任务正常结束，阶段为 completed：通过、失败、超时，或结论待定。主动结束和被取代的不算。 */
export const isCompleted = (outcome: Outcome | undefined) =>
  outcome === "passed" || outcome === "failed" || outcome === "timeout" || outcome === "unresolved";

/**
 * 测验结束时一个 topic 的结果：pass 是独立答对；fail 是判过而不对，或者题出了却没有作答（交卷或到截止时间时还没答）；
 * pending 是作答还没判出结果，尚无证据，判出来以后再算；untested 是这个 topic 出的题已从课程删除，不是学习者的原因，
 * 不算对也不算错。时间到了题还没做完，本身说明掌握有问题；只让交卷时的空题算错，等时间耗尽就能避开失败，所以两种结束一样算。
 */
export type TopicResult = "pass" | "fail" | "pending" | "untested";

export function quizResult(task: TaskRecord, attempts: Attempt[], course: CourseIndex, topicId: string): TopicResult {
  const own = attempts.filter((attempt) => attempt.topicId === topicId);
  if (own.length === 0) {
    const delivered = task.deliveries.some((delivery) => course.questions.get(delivery.questionId)?.topic.id === topicId);
    return delivered ? "fail" : "untested";
  }
  if (own.some(independentCorrect)) {
    return "pass";
  }
  return own.every((attempt) => attempt.verdict === undefined) ? "pending" : "fail";
}

/**
 * 一项任务交给学生模型的质量，课、复习、测验同一条规则：通过时取独立答对的题数占有证据的题数的比例，失败时取 1 减去这个比例，
 * 不低于 FAIL_QUALITY_FLOOR。这项任务里没有判出结果的作答时取 1，例如课全靠继承的进度通过。Repa 假设，见 parameters.ts。
 */
function quality(attempts: Attempt[], passed: boolean): number {
  const graded = attempts.filter((attempt) => attempt.verdict !== undefined);
  if (graded.length === 0) {
    return 1;
  }
  const ratio = graded.filter(independentCorrect).length / graded.length;
  return passed ? ratio : Math.max(FAIL_QUALITY_FLOOR, 1 - ratio);
}

export function emptyFold(): Fold {
  return { student: {}, lessons: new Map(), failures: new Map(), forced: new Map(), consecutiveReviews: 0 };
}

/** 课的开始时间是选定的时间；复习与测验从第一道题出现时开始。 */
export function startedAt(task: TaskRecord): number | null {
  return task.kind === "lesson" ? task.at : task.deliveries[0]?.at ?? null;
}

/** 只有测验限时，从第一道题出现时算起；课和复习不限时，与 MA 公开的一致。 */
export function deadlineAt(task: TaskRecord): number | null {
  const started = startedAt(task);
  if (!isQuiz(task.kind) || started === null) return null;
  return started + QUIZ_DURATION_MS;
}

/** 复习按 seed 打散知识点顺序；seed 由任务序号得出，重放时顺序不变。 */
export function taskKps(task: TaskRecord, course: CourseIndex): string[] {
  const kps = course.topics.get(task.topicIds[0] ?? "")?.kps.map((kp) => kp.id) ?? [];
  return task.kind === "review" ? shuffled(kps, Math.imul(task.seq, 0x9e3779b1) >>> 0) : kps;
}

/**
 * 按作答先后归约课里的每个知识点：连续独立答对 KP_PASS_STREAK 题通过；没通过而答错第 KP_WRONG_LIMIT 题、或做满 KP_MAX_ATTEMPTS 题，
 * 这个知识点失败，这节课也就失败。通过或失败即停止，之后的作答不再改变这个知识点的结果。判错、部分对和说不会都算答错；
 * 求助以后答对的不算独立完成，但也不算答错。没判出结果的作答不计入：它后来判出结果，就按它原来的位置重新归约，
 * 例如“错、错、待判、对、对”在第三题判错以后就是第三题失败，后面两题不再算。此前的课继承为通过的知识点不再计数。
 */
export function lessonProgress(
  kpIds: string[], attempts: Attempt[], inherited: KpProgress[] | undefined,
): { kps: KpProgress[]; failed: boolean } {
  let failed = false;
  const kps = kpIds.map((kpId) => {
    const previous = inherited?.find((entry) => entry.kpId === kpId);
    const result = { kpId, attempts: 0, consecutiveCorrect: 0, completed: previous?.completed ?? false };
    let wrong = 0;
    for (const attempt of attempts) {
      if (result.completed) {
        break;
      }
      if (attempt.kpId !== kpId || attempt.verdict === undefined) {
        continue;
      }
      result.attempts++;
      if (attempt.verdict !== "correct") {
        wrong++;
      }
      result.consecutiveCorrect = independentCorrect(attempt) ? result.consecutiveCorrect + 1 : 0;
      result.completed = result.consecutiveCorrect >= KP_PASS_STREAK;
      if (!result.completed && (wrong >= KP_WRONG_LIMIT || result.attempts >= KP_MAX_ATTEMPTS)) {
        failed = true;
        break;
      }
    }
    return result;
  });
  return { kps, failed };
}

/** 复习的判定（Repa 假设，见 parameters.ts）：按作答先后，独立答对至少 REVIEW_PASS_CORRECT 题，且最后 REVIEW_FINAL_STREAK 题都独立答对。 */
function reviewPasses(correct: boolean[]): boolean {
  return correct.filter(Boolean).length >= REVIEW_PASS_CORRECT
    && correct.length >= REVIEW_FINAL_STREAK
    && correct.slice(-REVIEW_FINAL_STREAK).every(Boolean);
}

/** 只看有证据的作答：通过即结束；出满 REVIEW_MAX_QUESTIONS 题仍不通过算失败。 */
function reviewResult(attempts: Attempt[]) {
  const graded = attempts.filter((entry) => entry.verdict !== undefined);
  return { passed: reviewPasses(graded.map(independentCorrect)), count: graded.length };
}

/**
 * 学习者中止复习时能否说已经失败：把没判出结果的作答和还没出的题都当作答对，仍不能通过，才有失败的证据。
 * 否则缺的只是没有的证据，既不算对也不算错。
 */
function reviewCouldPass(attempts: Attempt[]): boolean {
  const assumed = attempts.map((attempt) => attempt.verdict === undefined || independentCorrect(attempt));
  const remaining = Math.max(0, REVIEW_MAX_QUESTIONS - assumed.length);
  return reviewPasses([...assumed, ...Array.from({ length: remaining }, () => true)]);
}

/** 一次已结束的复习给学生模型的证据：通过或失败；中止而还可能通过的、被后来的任务取代的，尚无证据。 */
function reviewVerdict(entry: TaskEvidence): "pass" | "fail" | undefined {
  if (entry.outcome === "passed") {
    return "pass";
  }
  return entry.outcome === "failed" ? "fail" : undefined;
}

/**
 * 从一项任务的事实得出证据与结论。inherited 是此前同一 topic 的课留下的知识点进度。
 * 先看作答本身能否得出结论（课的连对通过、答错太多或练满失败，复习的通过与失败），再看主动结束、截止和被后来的任务取代。
 * 没判出结果的作答不算对也不算错：任务结束时，只有它们怎样判都改变不了的结论才当场得出，否则结论待定（unresolved）。
 * 复习不限时，中途离开下次接着做；学习者中止复习时，已经不可能通过的记失败，其他情形尚无证据。测验没答的题算错。
 */
export function taskEvidence(task: TaskRecord, course: CourseIndex, inherited: KpProgress[] | undefined): TaskEvidence {
  const attempts: Attempt[] = [];
  for (const delivery of task.answered) {
    const entry = course.questions.get(delivery.questionId);
    const answer = delivery.answer;
    // 题目已不在当前课程里：无法归属，也无法判分，不作为证据。
    if (!entry || !answer) {
      continue;
    }
    attempts.push({
      delivery,
      kpId: entry.kp.id,
      topicId: entry.topic.id,
      acceptedAt: answer.at,
      independent: !delivery.help,
      dontKnow: answer.dontKnow === true,
      ...(delivery.grades.length ? { verdict: delivery.grades.at(-1)?.verdict } : {}),
    });
  }
  const kpIds = taskKps(task, course);
  const lesson = task.kind === "lesson" ? lessonProgress(kpIds, attempts, inherited) : undefined;
  const kps = lesson?.kps ?? kpIds.map((kpId) => ({ kpId, attempts: 0, consecutiveCorrect: 0, completed: false }));
  const started = startedAt(task);
  const deadline = deadlineAt(task);
  let outcome: Outcome | undefined;
  if (lesson) {
    if (lesson.failed) {
      outcome = "failed";
    } else if (kps.length > 0 && kps.every((kp) => kp.completed)) {
      outcome = "passed";
    }
  } else if (task.kind === "review") {
    const result = reviewResult(attempts);
    if (result.passed) {
      outcome = "passed";
    } else if (result.count >= REVIEW_MAX_QUESTIONS || (task.endedAt !== undefined && !reviewCouldPass(attempts))) {
      // 出满题数仍不通过，或者学习者中止时已经不可能通过：失败，照常做失败更新。中止而还可能通过的，下面记为中止。
      outcome = "failed";
    }
  } else if (task.deliveries.length > 0 && (task.endedAt !== undefined || task.timedOut)) {
    // 测验交卷或到了截止时间：有 topic 答错或没答，就失败（到截止时间结束的为超时）；否则还有作答没判出结果时，
    // 结论等它们判出来；其余都答对就通过，题目已从课程删除的 topic 不影响结论。
    const results = task.topicIds.map((id) => quizResult(task, attempts, course, id));
    if (results.includes("fail")) {
      outcome = task.endedAt !== undefined ? "failed" : "timeout";
    } else if (results.includes("pending")) {
      outcome = "unresolved";
    } else {
      outcome = "passed";
    }
  }
  if (!outcome && task.endedAt !== undefined) {
    outcome = "aborted";
  } else if (!outcome && task.timedOut) {
    outcome = "timeout";
  } else if (!outcome && task.nextAt !== undefined) {
    outcome = "ended";
  }
  const answeredAt = Math.max(started ?? task.at, ...attempts.filter((entry) => entry.verdict !== undefined).map((entry) => entry.acceptedAt));
  let at = answeredAt;
  if (outcome === "timeout") {
    at = deadline ?? answeredAt;
  } else if (outcome === "aborted") {
    at = task.endedAt ?? answeredAt;
  } else if (outcome === "ended") {
    at = task.nextAt ?? answeredAt;
  } else if (outcome === "unresolved" || (outcome && isQuiz(task.kind))) {
    at = task.endedAt ?? deadline ?? answeredAt;
  }
  return { task, attempts, kps, ...(outcome ? { outcome } : {}), at, startedAt: started, deadlineAt: deadline };
}

/** 在已有学习状态上叠加一项已结束的任务；不修改传入的状态。model 是学生模型的参数。 */
export function foldTask(previous: Fold, entry: TaskEvidence, course: CourseIndex, model: ModelConfig = STUDENT_MODEL): Fold {
  const fold: Fold = {
    student: previous.student,
    lessons: new Map(previous.lessons),
    failures: new Map(previous.failures),
    forced: new Map(previous.forced),
    consecutiveReviews: previous.consecutiveReviews,
  };
  const topicId = entry.task.topicIds[0];
  if (!topicId || !entry.outcome) {
    return fold;
  }
  const force = (id: string, kind: "review" | "lesson"): void => {
    if (!fold.student[id]) {
      kind = "lesson";
    }
    if (kind === "lesson") {
      for (const prerequisite of course.topics.get(id)?.prerequisites ?? []) {
        if (!fold.student[prerequisite]) {
          force(prerequisite, "lesson");
        }
      }
    }
    if (kind === "lesson" && fold.forced.get(id) !== "lesson") {
      // 只在进入新一轮重教时清除旧轮进度，失败重试继续继承本轮已过 KP。
      fold.lessons.delete(id);
      fold.failures.delete(id);
    }
    fold.forced.set(id, kind);
  };
  // 正式作答的更新以最后一份有证据的作答为锚点；判分延迟不把旧表现当成新的表现。超时取截止时间。
  const repetitionAt = entry.outcome === "timeout" ? entry.at : Math.max(
    entry.startedAt ?? entry.at,
    ...entry.attempts.filter((attempt) => attempt.verdict !== undefined).map((attempt) => attempt.acceptedAt),
  );
  const update = (id: string, outcome: "pass" | "fail", attempts: Attempt[]) => {
    fold.student = updateStudent(course.graph, fold.student, { topicId: id, outcome, quality: quality(attempts, outcome === "pass") }, repetitionAt, model);
  };
  if (isQuiz(entry.task.kind)) {
    if (isCompleted(entry.outcome)) {
      // 测验按 topic 更新：答对的记一次通过；答错或没答的记一次失败并强制复习。没判出结果的 topic 判出来以后重算时再更新；
      // 题目已从课程删除的 topic 不更新也不补救。
      for (const id of entry.task.topicIds) {
        const result = quizResult(entry.task, entry.attempts, course, id);
        if (result !== "pass" && result !== "fail") {
          continue;
        }
        update(id, result, entry.attempts.filter((attempt) => attempt.topicId === id));
        if (result === "fail") {
          force(id, "review");
        }
      }
    }
  } else if (entry.task.kind === "lesson") {
    fold.consecutiveReviews = 0;
    fold.lessons.set(topicId, entry.kps);
    if (entry.outcome === "passed") {
      if (!fold.student[topicId] || fold.forced.has(topicId)) {
        update(topicId, "pass", entry.attempts);
      }
      fold.failures.delete(topicId);
      fold.forced.delete(topicId);
    } else if (entry.outcome === "failed") {
      const kpId = entry.kps.find((kp) => !kp.completed)?.kpId;
      if (kpId) {
        const stuck = fold.failures.get(topicId)?.kpId === kpId;
        fold.failures.set(topicId, { at: entry.at, kpId, stuck });
        const prerequisites = course.topics.get(topicId)?.kps.find((kp) => kp.id === kpId)?.keyPrerequisites ?? [];
        if (stuck) {
          const weakness = (id: string) => topicMemory(fold.student, id, entry.at);
          for (const id of [...prerequisites].sort((a, b) => weakness(a) - weakness(b))) {
            force(id, fold.student[id] ? "review" : "lesson");
          }
        }
      }
    }
  } else if (fold.student[topicId]) {
    // 复习有了证据才更新：中止而还可能通过的、被后来的任务取代的不更新，topic 照旧到期（强制复习照旧强制）。
    const verdict = reviewVerdict(entry);
    if (verdict) {
      update(topicId, verdict, entry.attempts);
      if (fold.forced.has(topicId)) {
        if (verdict === "pass") {
          fold.forced.delete(topicId);
        } else {
          force(topicId, "lesson");
        }
      }
      fold.consecutiveReviews++;
    }
  }
  return fold;
}

/** 菜单和已选任务共用资格判断；冷却、题量与当前 KP 位置由各入口检查。 */
export function topicEligible(course: CourseIndex, fold: Fold, topicId: string, kind: TaskKind, now: number): boolean {
  const topic = course.topics.get(topicId);
  if (!topic) {
    return false;
  }
  if (kind === "review") {
    return Boolean(fold.student[topicId] && (fold.forced.get(topicId) === "review" || topicDue(fold.student, topicId, now)));
  }
  return kind !== "lesson" || (
    topic.prerequisites.every((id) => fold.student[id]) &&
    (!fold.forced.size || fold.forced.get(topicId) === "lesson")
  );
}
