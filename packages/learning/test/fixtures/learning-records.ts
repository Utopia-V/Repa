import type { KnowledgeGraph } from "@repa/learning-model";
import type { Course, Topic } from "../../src/format/schema.js";
import type { Grade, Projection } from "../../src/records-schema.js";
import { LearningRecords } from "../../src/records.js";
import { createSnapshot } from "../../src/snapshot.js";
import type { ResolvedCourse } from "../../src/course-sources.js";
import { publicItem, referenceResponse, topicQuestions } from "../../src/check/items.js";
import { updateStudent } from "../../src/student-model.js";
import { lesson, now } from "./learning-contract.js";
import type { Submission } from "../../src/protocol.js";

export const course: Course = {
  id: "python", version: "0.1.0", title: "Python", language: "zh-CN", license: "Apache-2.0",
  runtime: { pyodide: "314.0.7", python: "3.14.2", packages: {} }, sources: {}, topics: ["py01"],
};
export const topic: Topic = {
  id: "py01", title: "数字", status: "complete", minutes: 5, prerequisites: [], sources: [],
  kps: [{ id: "py01.k1", title: "加法", practice: [{
    id: "py01.k1.q1", body: "1 + 1？", explanation: "两个一。", slots: [{ id: "s1", type: "text", key: "2" }],
  }] }],
};
export const graph: KnowledgeGraph = { topics: ["py01", "py02"], prerequisites: [], encompassings: [{ advanced: "py02", simple: "py01", weight: 1 }] };
export async function setup(records: LearningRecords, resolved?: ResolvedCourse): Promise<void> {
  const selectedTopic = resolved?.topics[0] ?? topic;
  const kp = selectedTopic.kps[0];
  const question = kp?.practice?.[0];
  if (!question || !kp) throw new Error("夹具缺题");
  const item = { ...await publicItem(question, selectedTopic), id: "opaque-q" };
  const snapshotId = await records.saveSnapshot(await createSnapshot({
    course: resolved?.course ?? course, topic: selectedTopic, kpId: kp.id, questionId: question.id, item, idMap: { "opaque-q": question.id }, graph,
  }));
  const state = lesson();
  if (!state.task || !state.task.deliveries[0]) throw new Error("夹具缺交付");
  state.task.deliveries[0].item = item;
  state.task.deliveries[0].requiresServices = [];
  state.task.kps = [{ kpId: "py01.k1", attempts: 0, consecutiveCorrect: 0, completed: false }];
  await records.checkpoint(records.revision, (_current, decisionNow) => ({
    projection: { state, student: updateStudent(graph, {}, { topicId: "py01", outcome: "pass" }, decisionNow), deliveries: { "delivery-1": snapshotId } },
    decision: { policyVersion: "test-v1", now: decisionNow, seed: 7, candidates: ["lesson-1"], selected: "lesson-1", scores: { "lesson-1": 1 } },
  }));
}
export function answer(records: LearningRecords, text?: string) {
  const delivery = records.current()?.state.task?.deliveries[0];
  if (!delivery) throw new Error("夹具缺交付");
  const snapshot = records.snapshot(records.current()?.deliveries[delivery.deliveryId] ?? "");
  const question = snapshot && topicQuestions(snapshot.topic).find((entry) => entry.question.id === snapshot.questionId)?.question;
  if (!question) throw new Error("夹具缺快照");
  const response = referenceResponse(question, delivery.item);
  if (text !== undefined) response.answers.s1 = { type: "text", text };
  return {
    taskId: "lesson-1", deliveryId: delivery.deliveryId, submissionId: delivery.submissionId,
    response,
  };
}
export function judged(submission: Submission): Grade {
  return { feedback: { item: submission.response.item, verdict: "correct", judge: "rule" }, ruleVersion: "test-v1", source: { key: "2" } };
}
export function advance(current: Projection, submission: Submission, grade: Grade): Projection {
  const task = current.state.task;
  if (!task) throw new Error("夹具缺任务");
  task.submissions = task.submissions.map((entry) => entry.submissionId === submission.submissionId ? {
    ...entry, processing: { status: "completed" }, gradeRevision: entry.gradeRevision + 1, feedback: grade.feedback,
  } : entry);
  task.phase = { stage: "feedback", submissionId: submission.submissionId };
  const kp = task.kps[0];
  if (kp) kp.attempts++;
  current.student = updateStudent(graph, current.student, { topicId: "py01", outcome: "pass" }, clock());
  return current;
}
export const clock = () => now + 20_000;
