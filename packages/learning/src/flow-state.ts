import { isDue, memoryAt, type Student } from "@repa/learning-model";
import type { CourseIndex } from "./course-index.js";
import { shuffled } from "./delivery.js";
import type { LearningTask } from "./protocol.js";
import type { FactOf, TaskKind } from "./records-schema.js";
import { updateStudent } from "./student-model.js";

/** 一个知识点在本次课里的进度。 */
export type KpProgress = LearningTask["kps"][number];
/** 任务的结论：通过、失败、超时、主动结束，或没有结论就被后来的任务取代。 */
export type Outcome = "passed" | "failed" | "timeout" | "aborted" | "ended";

/** Repa 假设：复习限时 10 分钟，测验与换题重考 15 分钟。 */
export const REVIEW_DURATION_MS = 600_000;
export const QUIZ_DURATION_MS = 900_000;

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
  /** 开始时从此前同一 topic 的课继承的知识点进度；任务进行中的进度和 XP 都从它算起。 */
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
export const quizCorrect = (attempts: Attempt[], topicId: string) =>
  attempts.some((attempt) => attempt.topicId === topicId && independentCorrect(attempt));

export function emptyFold(): Fold {
  return { student: {}, lessons: new Map(), failures: new Map(), forced: new Map(), consecutiveReviews: 0 };
}

/** 课的开始时间是选定的时间；复习与测验从第一道题出现时开始计时。 */
export function startedAt(task: TaskRecord): number | null {
  return task.kind === "lesson" ? task.at : task.deliveries[0]?.at ?? null;
}

export function deadlineAt(task: TaskRecord): number | null {
  const started = startedAt(task);
  if (task.kind === "lesson" || started === null) return null;
  return started + (isQuiz(task.kind) ? QUIZ_DURATION_MS : REVIEW_DURATION_MS);
}

/** 复习按 seed 打散知识点顺序；seed 由任务序号得出，重放时顺序不变。 */
export function taskKps(task: TaskRecord, course: CourseIndex): string[] {
  const kps = course.topics.get(task.topicIds[0] ?? "")?.kps.map((kp) => kp.id) ?? [];
  return task.kind === "review" ? shuffled(kps, Math.imul(task.seq, 0x9e3779b1) >>> 0) : kps;
}

export function kpProgress(kpIds: string[], attempts: Attempt[], inherited: KpProgress[] | undefined): KpProgress[] {
  return kpIds.map((kpId) => {
    const previous = inherited?.find((entry) => entry.kpId === kpId);
    const result = { kpId, attempts: 0, consecutiveCorrect: 0, completed: previous?.completed ?? false };
    for (const attempt of attempts) {
      if (attempt.kpId !== kpId || attempt.verdict === undefined || result.completed) {
        continue;
      }
      result.attempts++;
      result.consecutiveCorrect = independentCorrect(attempt) ? result.consecutiveCorrect + 1 : 0;
      result.completed = result.consecutiveCorrect >= 2;
    }
    return result;
  });
}

/** 只看有证据的作答；Repa 假设：至少三题、三题独立答对且最后两题连对才通过，五题仍不通过算失败。 */
export function reviewResult(attempts: Attempt[]) {
  const graded = attempts.filter((entry) => entry.verdict !== undefined);
  const correct = graded.filter(independentCorrect).length;
  const passed = graded.length >= 3 && correct >= 3 && graded.slice(-2).every(independentCorrect);
  return {
    passed,
    count: graded.length,
    quality: passed ? correct / graded.length : Math.max(0.2, 1 - correct / (graded.length || 1)),
  };
}

/**
 * 从一项任务的事实得出证据与结论。inherited 是此前同一 topic 的课留下的知识点进度。
 * 先看作答本身能否得出结论（课的两连对与五次失败、复习的通过与失败），再看主动结束、截止和被后来的任务取代。
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
  const kps = task.kind === "lesson"
    ? kpProgress(kpIds, attempts, inherited)
    : kpIds.map((kpId) => ({ kpId, attempts: 0, consecutiveCorrect: 0, completed: false }));
  const started = startedAt(task);
  const deadline = deadlineAt(task);
  let outcome: Outcome | undefined;
  if (task.kind === "lesson") {
    if (kps.length > 0 && kps.every((kp) => kp.completed)) {
      outcome = "passed";
    } else if (kps.some((kp) => !kp.completed && kp.attempts >= 5)) {
      outcome = "failed";
    }
  } else if (task.kind === "review") {
    const result = reviewResult(attempts);
    if (result.passed) {
      outcome = "passed";
    } else if (result.count >= 5) {
      outcome = "failed";
    }
  } else if (task.deliveries.length > 0 && (task.endedAt !== undefined || task.timedOut)) {
    if (task.topicIds.every((id) => quizCorrect(attempts, id))) {
      outcome = "passed";
    } else {
      outcome = task.endedAt !== undefined ? "failed" : "timeout";
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
  } else if (outcome && isQuiz(task.kind)) {
    at = task.endedAt ?? deadline ?? answeredAt;
  }
  return { task, attempts, kps, ...(outcome ? { outcome } : {}), at, startedAt: started, deadlineAt: deadline };
}

/** 在已有学习状态上叠加一项已结束的任务；不修改传入的状态。 */
export function foldTask(previous: Fold, entry: TaskEvidence, course: CourseIndex): Fold {
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
  const completed = ["passed", "failed", "timeout"].includes(entry.outcome);
  // 正式作答的更新以最后一份有证据的作答为锚点；判分延迟不把旧表现当成新的表现。超时取截止时间。
  const repetitionAt = entry.outcome === "timeout" ? entry.at : Math.max(
    entry.startedAt ?? entry.at,
    ...entry.attempts.filter((attempt) => attempt.verdict !== undefined).map((attempt) => attempt.acceptedAt),
  );
  if (isQuiz(entry.task.kind)) {
    if (completed) {
      for (const id of entry.task.topicIds) {
        const correct = quizCorrect(entry.attempts, id);
        fold.student = updateStudent(course.graph, fold.student, { topicId: id, outcome: correct ? "pass" : "fail", quality: 1 }, repetitionAt);
        if (!correct) {
          force(id, "review");
        }
      }
    }
  } else if (entry.task.kind === "lesson") {
    fold.consecutiveReviews = 0;
    fold.lessons.set(topicId, entry.kps);
    if (entry.outcome === "passed") {
      if (!fold.student[topicId] || fold.forced.has(topicId)) {
        fold.student = updateStudent(course.graph, fold.student, { topicId, outcome: "pass", quality: 1 }, repetitionAt);
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
          const weakness = (id: string) => {
            const state = fold.student[id];
            return state ? memoryAt(state, entry.at / 86_400_000) : 0;
          };
          for (const id of [...prerequisites].sort((a, b) => weakness(a) - weakness(b))) {
            force(id, fold.student[id] ? "review" : "lesson");
          }
        }
      }
    }
  } else if (completed && fold.student[topicId]) {
    const result = reviewResult(entry.attempts);
    fold.student = updateStudent(
      course.graph,
      fold.student,
      { topicId, outcome: result.passed ? "pass" : "fail", quality: result.quality },
      repetitionAt,
    );
    if (fold.forced.has(topicId)) {
      if (result.passed) {
        fold.forced.delete(topicId);
      } else {
        force(topicId, "lesson");
      }
    }
    fold.consecutiveReviews++;
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
    const remembered = fold.student[topicId];
    return Boolean(remembered && (fold.forced.get(topicId) === "review" || isDue(remembered, now / 86_400_000)));
  }
  return kind !== "lesson" || (
    topic.prerequisites.every((id) => fold.student[id]) &&
    (!fold.forced.size || fold.forced.get(topicId) === "lesson")
  );
}
