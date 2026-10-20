import { RepaFault } from "@repa/base";
import { memoryAt, type KnowledgeGraph } from "@repa/learning-model";
import type { ResolvedCourse } from "./course-sources.js";
import type { Grade, LearningRecord, Projection } from "./records-schema.js";
import type { LearningTask, Submission } from "./protocol.js";
import { updateStudent } from "./student-model.js";

export const FLOW_VERSION = "repa-flow-v1";
export const finished = (task: LearningTask) => ["completed", "aborted"].includes(task.phase.stage);
export interface Attempt {
  submission: Submission;
  grade?: Grade;
  independent: boolean;
}
export interface TaskEvidence {
  task: LearningTask;
  at: number;
  attempts: Attempt[];
}

/** 日志保留当时的任务；重算只替换采用判分，不改写既往选择和交付。 */
export function taskEvidence(records: LearningRecord[], replacement?: { id: string; grade: Grade }): TaskEvidence[] {
  const tasks = new Map<string, TaskEvidence>();
  const attempts = new Map<string, Attempt>();
  for (const record of records) {
    if (record.type === "checkpoint" || record.type === "graded" || record.type === "regraded") {
      const task = record.projection.state.task;
      if (task) {
        const previous = tasks.get(task.taskId);
        const at =
          task.phase.stage === "completed" && task.phase.outcome === "timeout"
            ? task.deadlineAt ?? record.at
            : record.at;
        tasks.set(task.taskId, {
          task: structuredClone(task),
          at: previous && finished(previous.task) ? previous.at : at,
          attempts: previous?.attempts ?? [],
        });
      }
    }
    if (record.type === "accepted") {
      const attempt = { submission: record.submission, independent: record.context.helpBefore.length === 0 };
      attempts.set(record.submission.submissionId, attempt);
      tasks.get(record.submission.taskId)?.attempts.push(attempt);
    }
    if (record.type === "graded" || record.type === "regraded") {
      const attempt = attempts.get(record.type === "graded" ? record.submissionId : record.submission.submissionId);
      if (attempt) {
        attempt.grade = record.grade;
      }
    }
  }
  if (replacement) {
    const attempt = attempts.get(replacement.id);
    if (attempt) {
      attempt.grade = replacement.grade;
    }
  }
  return [...tasks.values()];
}
export const independentCorrect = (attempt: Attempt) =>
  attempt.independent &&
  !attempt.submission.response.dontKnow &&
  attempt.grade?.feedback.verdict === "correct" &&
  attempt.grade.feedback.evidence?.status === "eligible";

export function kpProgress(evidence: TaskEvidence, inherited: LearningTask["kps"] = []): LearningTask["kps"] {
  return evidence.task.kps.map((kp) => {
    const previous = inherited.find((entry) => entry.kpId === kp.kpId);
    const result = { kpId: kp.kpId, attempts: 0, consecutiveCorrect: 0, completed: previous?.completed ?? false };
    for (const attempt of evidence.attempts) {
      const delivery = evidence.task.deliveries.find((entry) => entry.deliveryId === attempt.submission.deliveryId);
      if (delivery?.kpId !== kp.kpId || !attempt.grade || result.completed) {
        continue;
      }
      result.attempts++;
      result.consecutiveCorrect = independentCorrect(attempt) ? result.consecutiveCorrect + 1 : 0;
      result.completed = result.consecutiveCorrect >= 2;
    }
    return result;
  });
}
export function reviewResult(evidence: TaskEvidence) {
  const attempts = evidence.attempts.filter((entry) => entry.grade);
  const correct = attempts.filter(independentCorrect).length;
  const passed = attempts.length >= 3 && correct >= 3 && attempts.slice(-2).every(independentCorrect);
  return {
    passed,
    count: attempts.length,
    quality: passed ? correct / attempts.length : Math.max(0.2, 1 - correct / (attempts.length || 1)),
  };
}
export function graphFor(course: ResolvedCourse): KnowledgeGraph {
  return {
    topics: course.topics.map((topic) => topic.id),
    encompassings: [],
    prerequisites: course.topics.flatMap((topic) =>
      topic.prerequisites.map((prerequisite) => ({ topic: topic.id, prerequisite })),
    ),
  };
}

/** 同一决策时刻也可传入删去关键作答的证据副本，供反事实重放。 */
export function replayLearning(
  evidence: TaskEvidence[],
  course: ResolvedCourse,
): Pick<Projection, "student"> & {
  lessons: Map<string, LearningTask["kps"]>;
  failures: Map<string, { at: number; kpId: string; stuck: boolean }>;
  forced: Map<string, "review" | "lesson">;
  consecutiveReviews: number;
} {
  const graph = graphFor(course);
  let student: Projection["student"] = {};
  const lessons = new Map<string, LearningTask["kps"]>();
  const failures = new Map<string, { at: number; kpId: string; stuck: boolean }>();
  const forced = new Map<string, "review" | "lesson">();
  let consecutiveReviews = 0;
  for (const entry of evidence) {
    const topicId = entry.task.topicIds[0];
    if (!topicId || !finished(entry.task)) {
      continue;
    }
    let repetitionAt = entry.at;
    if (entry.task.phase.stage !== "completed" || entry.task.phase.outcome !== "timeout") {
      const accepted = entry.attempts
        .filter((attempt) => attempt.grade)
        .map((attempt) => attempt.submission.acceptedAt);
      repetitionAt = Math.max(entry.task.startedAt ?? entry.at, ...accepted);
    }
    if (entry.task.kind === "lesson") {
      consecutiveReviews = 0;
      const progress = kpProgress(entry, forced.get(topicId) === "lesson" ? [] : lessons.get(topicId));
      lessons.set(topicId, progress);
      if (progress.every((kp) => kp.completed)) {
        if (!student[topicId] || forced.has(topicId)) {
          student = updateStudent(graph, student, { topicId, outcome: "pass", quality: 1 }, repetitionAt);
        }
        failures.delete(topicId);
        forced.delete(topicId);
      } else if (entry.task.phase.stage === "completed") {
        const kpId = progress.find((kp) => !kp.completed)?.kpId;
        if (kpId) {
          const stuck = failures.get(topicId)?.kpId === kpId;
          failures.set(topicId, { at: entry.at, kpId, stuck });
          const prerequisites =
            course.topics.find((topic) => topic.id === topicId)?.kps.find((kp) => kp.id === kpId)?.keyPrerequisites ??
            [];
          if (stuck) {
            const weakness = (id: string) => (student[id] ? memoryAt(student[id], entry.at / 86_400_000) : 0);
            for (const id of [...prerequisites].sort((a, b) => weakness(a) - weakness(b))) {
              forced.set(id, student[id] ? "review" : "lesson");
            }
          }
        }
      }
    } else if (entry.task.kind === "review" && entry.task.phase.stage === "completed" && student[topicId]) {
      const result = reviewResult(entry);
      student = updateStudent(
        graph,
        student,
        { topicId, outcome: result.passed ? "pass" : "fail", quality: result.quality },
        repetitionAt,
      );
      if (forced.has(topicId)) {
        if (result.passed) {
          forced.delete(topicId);
        } else {
          forced.set(topicId, "lesson");
        }
      }
      consecutiveReviews++;
    }
  }
  return { student, lessons, failures, forced, consecutiveReviews };
}
export function requireTask(projection: Projection): LearningTask {
  if (!projection.state.task) {
    throw new RepaFault("stale_state", "当前没有任务");
  }
  return projection.state.task;
}
