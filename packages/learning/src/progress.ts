import type { CourseIndex } from "./course-index.js";
import { shuffled } from "./delivery.js";
import {
  independentCorrect,
  isCompleted,
  isQuiz,
  quizResult,
  taskEvidence,
  taskId,
  type Fold,
  type TaskEvidence,
  type TaskRecord,
} from "./flow-state.js";
import {
  DEFAULT_DAILY_GOAL_XP,
  ETA_MIN_ACTIVE_DAYS,
  ETA_WINDOW_DAYS,
  MENU_SIZE,
  MIN_PASS_XP,
  QUIZ_TOPICS,
  QUIZ_XP,
  REVIEW_XP,
} from "./parameters.js";
import type { LearningMenu, LearningProgress } from "./protocol.js";
import type { Replay } from "./replay.js";

/**
 * 一项已结束任务的奖励（repa-xp-v1，Repa 假设，数值见 parameters.ts）。没有证据的作答不进分母：课与复习按已判的作答算独立正确比例，
 * 测验按全部交付算，没答的题也在分母里，结论待定时先按已判对的题算。主动结束和被取代的任务没有奖励。
 */
export function reward(entry: TaskEvidence, course: CourseIndex): number {
  if (!isCompleted(entry.outcome)) {
    return 0;
  }
  const correct = entry.attempts.filter(independentCorrect).length;
  if (isQuiz(entry.task.kind)) {
    return Math.floor(QUIZ_XP * correct / (entry.task.deliveries.length || 1));
  }
  if (entry.outcome !== "passed") {
    return 0;
  }
  const minutes = course.topics.get(entry.task.topicIds[0] ?? "")?.minutes ?? 0;
  const base = entry.task.kind === "lesson" ? minutes : REVIEW_XP;
  const graded = entry.attempts.filter((attempt) => attempt.verdict !== undefined).length;
  return Math.max(MIN_PASS_XP, Math.floor(base * correct / (graded || 1)));
}

/** 按时区写出本地日期（YYYY-MM-DD）的格式器；构造代价较高，一次读取只建一个。 */
function dayFormat(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
}

/** 本地日期加减若干天。用日历日期移动，避免本地夏令时导致一天不是 24 小时。 */
function addDays(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * 为第 n 场测验选 topic：从学过、有测验题的 topic 里随机选，避开上一场测验（或换题重考）答过的 topic，不足时从答过的里补足；
 * 每个 topic 一题，最多 QUIZ_TOPICS 个。补足的 topic 出题时照常优先出学习者没见过的题（见 flow.ts 的选题）。随机由第 n 场的
 * seed 决定，所以重放得到同样的选择。只在测验出现时调用一次，从后往前找上一场测验，不重算各任务的结论。Repa 假设：MA 公开
 * 从学过的 topic 里随机选一组多样的，考过的降低权重，具体的权重没有公开。
 */
export function sampleTopics(tasks: TaskRecord[], fold: Fold, course: CourseIndex, n: number): string[] {
  const candidates = course.course.topics.filter((topic) => fold.student[topic.id] && course.quizTopics.has(topic.id)).map((topic) => topic.id);
  const recent = new Set<string>();
  for (let index = tasks.length - 1; index >= 0 && recent.size === 0; index--) {
    const task = tasks[index];
    if (!task || !isQuiz(task.kind)) {
      continue;
    }
    for (const delivery of task.answered) {
      const topicId = course.questions.get(delivery.questionId)?.topic.id;
      if (topicId) recent.add(topicId);
    }
  }
  const pool = shuffled(candidates, Math.imul(n, 0x9e3779b1) >>> 0);
  return [...pool.filter((id) => !recent.has(id)), ...pool.filter((id) => recent.has(id))].slice(0, QUIZ_TOPICS);
}

/**
 * 日目标、XP、完成率与完课估算。完课估算是 Repa 的粗略估算：剩余课时（未学的课和强制重教的课的预计用时之和）除以最近
 * ETA_WINDOW_DAYS 个完整本地自然日里平均每天的学习量，得出还要几天，再写成日期。学习量按 XP 计：MA 公开 1 XP 约合一分钟专注学习，
 * 与课的预计用时同一单位。其中至少 ETA_MIN_ACTIVE_DAYS 天学过才给出。
 */
export function progressView(replay: Replay, fold: Fold, course: CourseIndex, now: number, timeZone: string): LearningProgress {
  const format = dayFormat(timeZone);
  const day = format.format(now);
  const completedTopics = Object.keys(fold.student).length;
  const daily = new Map<string, number>();
  for (const award of replay.awards) {
    const date = format.format(award.at);
    daily.set(date, (daily.get(date) ?? 0) + award.xp);
  }
  const totals: number[] = [];
  for (let back = 1; back <= ETA_WINDOW_DAYS; back++) {
    totals.push(daily.get(addDays(day, -back)) ?? 0);
  }
  const average = totals.reduce((sum, value) => sum + value, 0) / ETA_WINDOW_DAYS;
  const remaining = course.course.topics
    .filter((topic) => !fold.student[topic.id] || fold.forced.get(topic.id) === "lesson")
    .reduce((sum, topic) => sum + topic.minutes, 0);
  const estimable = totals.filter((value) => value > 0).length >= ETA_MIN_ACTIVE_DAYS && average > 0;
  return {
    day,
    timeZone,
    dailyGoalXp: replay.goal ?? DEFAULT_DAILY_GOAL_XP,
    todayXp: daily.get(day) ?? 0,
    totalXp: replay.total,
    completedTopics,
    totalTopics: course.course.topics.length,
    completionRate: Math.min(1, completedTopics / (course.course.topics.length || 1)),
    etaDate: estimable ? addDays(day, Math.ceil(remaining / average)) : null,
  };
}

/** 在常规菜单上加入强制补救、测验和换题重考。 */
export function progressMenu(menu: LearningMenu, replay: Replay, fold: Fold, course: CourseIndex): LearningMenu {
  if (fold.forced.size) {
    menu.candidates = menu.candidates.filter((candidate) => fold.forced.get(candidate.topicIds[0] ?? "") === candidate.kind);
    if (!menu.candidates.length) {
      menu.unavailableReason = "强制补救尚未可用，请等待冷却结束或补足题量／执行服务。";
    }
    return menu;
  }
  const pending = replay.pending;
  if (pending && !pending.topicIds.length) {
    menu.candidates = [];
    menu.unavailableReason = "已到测验门槛，但已学 topic 的 quiz 题量不足。";
    delete menu.availableAt;
  } else if (pending) {
    const candidate = { id: `quiz-${pending.n}`, kind: "quiz" as const, title: "测验", topicIds: pending.topicIds };
    menu.candidates = [candidate, ...replay.quizOnly() ? [] : menu.candidates].slice(0, MENU_SIZE);
    delete menu.unavailableReason;
    delete menu.availableAt;
  } else {
    const quizzes = replay.tasks.filter((task) => isQuiz(task.kind));
    const original = quizzes.map((task) => taskEvidence(task, course, task.inherited)).findLast((entry) => isCompleted(entry.outcome));
    const retaken = new Set(replay.tasks
      .filter((task) => task.kind === "retake" && !(task.endedAt !== undefined && task.deliveries.length === 0))
      .map((task) => task.retakes));
    // 有 topic 答错或没答才要换题重考；还没判出结果的、题目已从课程删除的都不算。
    if (original && original.task.topicIds.some((id) => quizResult(original.task, original.attempts, course, id) === "fail") && !retaken.has(original.task.seq)) {
      menu.candidates = [{
        id: `retake-${original.task.seq}`,
        kind: "retake" as const,
        title: "换题重考",
        topicIds: original.task.topicIds,
        originalTaskId: taskId(original.task),
      }, ...menu.candidates].slice(0, MENU_SIZE);
      delete menu.unavailableReason;
      delete menu.availableAt;
    }
  }
  return menu;
}
