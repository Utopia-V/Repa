import { isDue } from "@repa/learning-model";
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
import type { LearningMenu, LearningProgress } from "./protocol.js";
import type { Replay } from "./replay.js";

/** Math Academy 公开：约每 150 XP 一场测验，出现后约 30 XP 的延后窗口。 */
export const QUIZ_EVERY_XP = 150;
export const QUIZ_WINDOW_XP = 30;
/** Repa 假设：每场测验最多五个 topic；默认日目标 20 XP。 */
export const QUIZ_TOPICS = 5;
export const DEFAULT_DAILY_GOAL_XP = 20;

/**
 * 一项已结束任务的奖励（repa-xp-v1，Repa 假设）。没有证据的作答不进分母：课与复习按已判的作答算独立正确比例，
 * 测验按全部交付算，结论待定时先按已判对的题算。主动结束和被取代的任务没有奖励。
 */
export function reward(entry: TaskEvidence, course: CourseIndex): number {
  if (!isCompleted(entry.outcome)) {
    return 0;
  }
  const correct = entry.attempts.filter(independentCorrect).length;
  if (isQuiz(entry.task.kind)) {
    return Math.floor(15 * correct / (entry.task.deliveries.length || 1));
  }
  if (entry.outcome !== "passed") {
    return 0;
  }
  const minutes = course.topics.get(entry.task.topicIds[0] ?? "")?.minutes ?? 0;
  const base = entry.task.kind === "lesson" ? minutes : 5;
  const graded = entry.attempts.filter((attempt) => attempt.verdict !== undefined).length;
  return Math.max(1, Math.floor(base * correct / (graded || 1)));
}

/** 按时区写出本地日期（YYYY-MM-DD）的格式器；构造代价较高，一次读取只建一个。 */
function dayFormat(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
}

/**
 * 从已学且有测验题的 topic 里选题：先选以往测验次数少的，再选最近独立答对得早的；同组按第 n 场的 seed 打散，
 * 并尽量避开有直接先修关系或共享先修的 topic。只在测验出现时调用一次，扫描一遍作答，不重算各任务的结论。
 */
export function sampleTopics(tasks: TaskRecord[], fold: Fold, course: CourseIndex, n: number): string[] {
  const candidates = course.course.topics.filter((topic) => fold.student[topic.id] && course.quizTopics.has(topic.id));
  if (!candidates.length) {
    return [];
  }
  const tested = new Map<string, number>();
  const last = new Map<string, number>();
  for (const task of tasks) {
    if (isQuiz(task.kind) && isCompleted(taskEvidence(task, course, task.inherited).outcome)) {
      for (const id of task.topicIds) tested.set(id, (tested.get(id) ?? 0) + 1);
    }
    for (const delivery of task.answered) {
      const topicId = course.questions.get(delivery.questionId)?.topic.id;
      const answer = delivery.answer;
      if (topicId && answer && !delivery.help && !answer.dontKnow && delivery.grades.at(-1)?.verdict === "correct") {
        last.set(topicId, Math.max(last.get(topicId) ?? 0, answer.at));
      }
    }
  }
  const order = (id: string) => [tested.get(id) ?? 0, last.get(id) ?? 0] as const;
  const pool = shuffled(candidates, Math.imul(n, 0x9e3779b1) >>> 0);
  pool.sort((a, b) => order(a.id)[0] - order(b.id)[0] || order(a.id)[1] - order(b.id)[1]);
  const selected: typeof pool = [];
  for (const topic of pool) {
    if (!selected.some((other) => topic.prerequisites.includes(other.id) || other.prerequisites.includes(topic.id)
      || topic.prerequisites.some((id) => other.prerequisites.includes(id)))) {
      selected.push(topic);
    }
    if (selected.length === QUIZ_TOPICS) {
      break;
    }
  }
  return [...selected, ...pool.filter((topic) => !selected.includes(topic))].slice(0, QUIZ_TOPICS).map((topic) => topic.id);
}

/**
 * 日目标、XP、完成率与完课估算。ETA 是 Repa 的粗略估算：剩余 lesson（含强制重教）的 minutes 乘 1.5，
 * 加上到期或强制 review 每项 5，除以最近七个完整本地自然日的平均 XP；至少三个正 XP 日才给出。
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
  // 用日历日期移动，避免本地夏令时导致一天不是 24 小时。
  const date = new Date(`${day}T12:00:00Z`);
  const totals: number[] = [];
  for (let index = 0; index < 7; index++) {
    date.setUTCDate(date.getUTCDate() - 1);
    totals.push(daily.get(date.toISOString().slice(0, 10)) ?? 0);
  }
  const average = totals.reduce((sum, value) => sum + value, 0) / 7;
  const lessons = course.course.topics
    .filter((topic) => !fold.student[topic.id] || fold.forced.get(topic.id) === "lesson")
    .reduce((sum, topic) => sum + topic.minutes, 0);
  const reviews = Object.entries(fold.student).filter(([id, state]) =>
    isDue(state, now / 86_400_000) || fold.forced.get(id) === "review",
  ).length;
  return {
    day,
    timeZone,
    dailyGoalXp: replay.goal ?? DEFAULT_DAILY_GOAL_XP,
    todayXp: daily.get(day) ?? 0,
    totalXp: replay.total,
    completedTopics,
    totalTopics: course.course.topics.length,
    completionRate: Math.min(1, completedTopics / (course.course.topics.length || 1)),
    etaDays: totals.filter((value) => value > 0).length >= 3 && average > 0 ? (lessons * 1.5 + reviews * 5) / average : null,
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
    menu.candidates = [candidate, ...replay.quizOnly() ? [] : menu.candidates].slice(0, 3);
    delete menu.unavailableReason;
    delete menu.availableAt;
  } else {
    const quizzes = replay.tasks.filter((task) => isQuiz(task.kind));
    const original = quizzes.map((task) => taskEvidence(task, course, task.inherited)).findLast((entry) => isCompleted(entry.outcome));
    const retaken = new Set(replay.tasks
      .filter((task) => task.kind === "retake" && !(task.endedAt !== undefined && task.deliveries.length === 0))
      .map((task) => task.retakes));
    // 只有确实答错或没答的 topic 才要换题重考；还没判出结果的不算。
    if (original && original.task.topicIds.some((id) => quizResult(original.attempts, id) === "fail") && !retaken.has(original.task.seq)) {
      menu.candidates = [{
        id: `retake-${original.task.seq}`,
        kind: "retake" as const,
        title: "换题重考",
        topicIds: original.task.topicIds,
        originalTaskId: taskId(original.task),
      }, ...menu.candidates].slice(0, 3);
      delete menu.unavailableReason;
      delete menu.availableAt;
    }
  }
  return menu;
}
