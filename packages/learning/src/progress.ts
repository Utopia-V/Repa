import { isDue } from "@repa/learning-model";
import type { ResolvedCourse } from "./course-sources.js";
import { opaqueId, shuffled } from "./delivery.js";
import {
  finished,
  independentCorrect,
  isQuiz,
  kpProgress,
  quizCorrect,
  replayLearning,
  reviewResult,
  type TaskEvidence,
} from "./flow-state.js";
import type { LearningMenu, LearningTask } from "./protocol.js";
import type { Projection } from "./records-schema.js";

export const XP_VERSION = "repa-xp-v1";
export function reward(
  entry: TaskEvidence,
  course: ResolvedCourse,
  inherited: LearningTask["kps"] = [],
): number {
  if (entry.task.phase.stage !== "completed") {
    return 0;
  }
  const correct = entry.attempts.filter(independentCorrect).length;
  if (isQuiz(entry.task)) {
    return Math.floor(15 * correct / (entry.task.deliveries.length || 1));
  }
  const passed =
    entry.task.kind === "lesson"
      ? kpProgress(entry, inherited).every((kp) => kp.completed)
      : reviewResult(entry).passed;
  if (!passed) {
    return 0;
  }
  const minutes = entry.minutes ?? course.topics.find((topic) => topic.id === entry.task.topicIds[0])?.minutes ?? 0;
  const base = entry.task.kind === "lesson" ? minutes : 5;
  return Math.max(1, Math.floor(base * correct / (entry.attempts.length || 1)));
}
export function localDay(now: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
function sampleTopics(
  evidence: TaskEvidence[],
  course: ResolvedCourse,
  seed: number,
  available: (id: string) => boolean,
): string[] {
  const model = replayLearning(evidence, course);
  const history = (id: string) => {
    const tested = evidence.filter((entry) =>
      isQuiz(entry.task) && entry.task.phase.stage === "completed" && entry.task.topicIds.includes(id),
    ).length;
    const last = evidence.flatMap((entry) =>
      entry.attempts.filter(independentCorrect).filter((attempt) =>
        entry.task.deliveries.some((delivery) =>
          delivery.topicId === id && delivery.deliveryId === attempt.submission.deliveryId,
        ),
      ),
    ).reduce((at, attempt) => Math.max(at, attempt.submission.acceptedAt), 0);
    return { tested, last };
  };
  const pool = shuffled(course.topics.filter((topic) => model.student[topic.id] && available(topic.id)), seed);
  pool.sort((a, b) => history(a.id).tested - history(b.id).tested || history(a.id).last - history(b.id).last);
  const selected: typeof pool = [];
  for (const topic of pool) {
    if (!selected.some((other) => topic.prerequisites.includes(other.id) || other.prerequisites.includes(topic.id)
      || topic.prerequisites.some((id) => other.prerequisites.includes(id)))) {
      selected.push(topic);
    }
    if (selected.length === 5) {
      break;
    }
  }
  return [...selected, ...pool.filter((topic) => !selected.includes(topic))].slice(0, 5).map((topic) => topic.id);
}
/** 奖励差额与高水位随原判分投影原子保存；历史门槛不会因申诉回退。 */
export function updateProgress(
  current: Projection,
  evidence: TaskEvidence[],
  course: ResolvedCourse,
  now: number,
  available: (id: string) => boolean = () => true,
): void {
  const initializing = current.xp === undefined;
  const xp = current.xp ??= { rewards: [], highWater: 0, consumed: 0, origins: {} };
  const progress = current.state.progress;
  let trigger = 0;
  for (const [index, entry] of evidence.entries()) {
    const before = replayLearning(evidence.slice(0, index), course);
    const value = reward(entry, course, before.lessons.get(entry.task.topicIds[0] ?? ""));
    const previous = xp.rewards.filter((row) => row.taskId === entry.task.taskId).reduce((sum, row) => sum + row.xp, 0);
    if (value !== previous) {
      xp.rewards.push({ taskId: entry.task.taskId, xp: value - previous, at: initializing ? entry.at : now, ruleVersion: XP_VERSION });
    }
    if (!isQuiz(entry.task)) {
      trigger += value;
    }
  }
  xp.highWater = Math.max(xp.highWater, trigger);
  const active = current.state.task;
  if (!xp.pending && (!active || finished(active)) && xp.highWater >= (xp.consumed + 1) * 150) {
    const seed = Math.floor(Math.random() * 0x7fffffff);
    xp.pending = {
      id: opaqueId(),
      atXp: xp.highWater,
      seed,
      topicIds: sampleTopics(evidence, course, seed, available),
    };
  }
  if (xp.pending && !xp.pending.topicIds.length) {
    xp.pending.topicIds = sampleTopics(evidence, course, xp.pending.seed, available);
  }
  progress.day = localDay(now, progress.timeZone);
  progress.totalXp = xp.rewards.reduce((sum, row) => sum + row.xp, 0);
  progress.todayXp = Math.max(
    0,
    xp.rewards.filter((row) => localDay(row.at, progress.timeZone) === progress.day)
      .reduce((sum, row) => sum + row.xp, 0),
  );
  const model = replayLearning(evidence, course);
  progress.completedTopics = Object.keys(model.student).length;
  progress.completionRate = progress.completedTopics / course.topics.length;
  // 用日历日期移动，避免本地夏令时导致一天不是 24 小时。
  const date = new Date(`${progress.day}T12:00:00Z`);
  const days: string[] = [];
  for (let index = 0; index < 7; index++) {
    date.setUTCDate(date.getUTCDate() - 1);
    days.push(date.toISOString().slice(0, 10));
  }
  const totals = days.map((day) => xp.rewards.filter((row) => localDay(row.at, progress.timeZone) === day)
    .reduce((sum, row) => sum + row.xp, 0));
  const average = totals.reduce((sum, value) => sum + value, 0) / 7;
  const lessons = course.topics
    .filter((topic) => !model.student[topic.id] || model.forced.get(topic.id) === "lesson")
    .reduce((sum, topic) => sum + topic.minutes, 0);
  const reviews = Object.entries(model.student).filter(([id, state]) =>
    isDue(state, now / 86_400_000) || model.forced.get(id) === "review",
  ).length;
  progress.etaDays =
    totals.filter((value) => value > 0).length >= 3 && average > 0
      ? (lessons * 1.5 + reviews * 5) / average
      : null;
}
export function progressMenu(
  current: Projection,
  evidence: TaskEvidence[],
  course: ResolvedCourse,
  menu: LearningMenu,
): LearningMenu {
  const xp = current.xp;
  const model = replayLearning(evidence, course);
  if (model.forced.size) {
    menu.candidates = menu.candidates.filter((candidate) => model.forced.get(candidate.topicIds[0] ?? "") === candidate.kind);
    if (!menu.candidates.length) {
      menu.unavailableReason = "强制补救尚未可用，请等待冷却结束或补足题量／执行服务。";
    }
    return menu;
  }
  const pending = xp?.pending;
  if (pending && !pending.topicIds.length) {
    menu.candidates = [];
    menu.unavailableReason = "已到测验门槛，但已学 topic 的 quiz 题量不足。";
  } else if (pending) {
    const candidate = { id: pending.id, kind: "quiz" as const, title: "测验", topicIds: pending.topicIds };
    const others = xp.highWater >= pending.atXp + 30 ? [] : menu.candidates;
    menu.candidates = [candidate, ...others].slice(0, 3);
    delete menu.unavailableReason;
  } else {
    const original = evidence.findLast((entry) => isQuiz(entry.task) && entry.task.phase.stage === "completed");
    if (original && original.task.topicIds.some((id) => !quizCorrect(original, id))
      && !Object.values(xp?.origins ?? {}).includes(original.task.taskId)) {
      const retained = current.state.menu?.candidates.find((entry) => entry.originalTaskId === original.task.taskId);
      const candidate: LearningMenu["candidates"][number] = {
        id: retained?.id ?? opaqueId(),
        kind: "retake",
        title: "换题重考",
        topicIds: original.task.topicIds,
        originalTaskId: original.task.taskId,
      };
      menu.candidates = [candidate, ...menu.candidates].slice(0, 3);
      delete menu.unavailableReason;
    }
  }
  return menu;
}
