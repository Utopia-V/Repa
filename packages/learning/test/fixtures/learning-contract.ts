/** Aqua 审阅用的连续轨迹；仅表达协议画面，不模拟 c1 的持久化或教学转换。 */
import type { Content, Item } from "@repa/base/protocol";
import type { ContentPage, Delivery, LearningState, Submission } from "../../src/protocol.js";

const markdown = (text: string): Content => [{ type: "markdown", text }];
export const version = `sha256:${"a".repeat(64)}`;
/** 任务画面里的 topic 与知识点标题取自随包 Python 课。 */
const py01 = { id: "py01", title: "给数据起名，再按顺序读" };
const py02 = { id: "py02", title: "把计算写成表达式" };
const kp = { kpId: "py01.k1", title: "名字指向当前的值，赋值先算右边" };
export const now = 1_792_454_400_000;
export const item: Item = {
  id: "delivery.q1", version, requires: ["block.markdown", "slot.code"],
  body: markdown("将 prices 中的数加一，写入 result。"),
  slots: [{ id: "s1", type: "code", language: "python", starter: "result = []" }],
};
export const delivery: Delivery = {
  deliveryId: "delivery-1", submissionId: "submission-1", item,
  topicId: "py01", kpId: "py01.k1",
  mode: "practice", repeated: false, requiresServices: ["python.run"],
};
export const accepted: Submission = {
  taskId: "lesson-1", deliveryId: delivery.deliveryId, submissionId: delivery.submissionId,
  response: { item: { id: item.id, version }, answers: { s1: { type: "code", code: "result = [p + 1 for p in prices]" } } },
  acceptedAt: now + 5_000, processing: { status: "accepted" }, gradeRevision: 0,
};
export const page: ContentPage = {
  ref: { courseId: "python", topicId: "py01", kpId: "py01.k1", id: "py01.k1.card", version, kind: "card" },
  origin: {
    taskId: "lesson-1", deliveryId: delivery.deliveryId,
    content: { courseId: "python", topicId: "py01", kpId: "py01.k1", id: "py01.k1.example", version, kind: "example" },
  },
  offset: 0, total: 1, blocks: markdown("列表推导式：对每个元素计算一个新值。"),
};
export function lesson(): LearningState {
  return {
    revision: 1, serverNow: now,
    course: { id: "python", title: "Python", version: "0.1.0" }, menu: null,
    restrictions: { kind: "none", tutorAllowed: true, referenceContentAllowed: true },
    progress: {
      day: "2026-10-20", timeZone: "Asia/Taipei", dailyGoalXp: 20, todayXp: 0, totalXp: 0,
      completedTopics: 0, totalTopics: 48, completionRate: 0, etaDate: null,
    },
    task: {
      taskId: "lesson-1", kind: "lesson", topics: [py01], startedAt: now, deadlineAt: null,
      phase: { stage: "awaiting_answer", deliveryId: delivery.deliveryId },
      kps: [{ ...kp, attempts: 1, consecutiveCorrect: 1, completed: false }],
      deliveries: [structuredClone(delivery)], submissions: [],
    },
  };
}
export function recoveryTrace(): LearningState[] {
  const answering = lesson();
  const pending = lesson();
  pending.revision = 2;
  pending.serverNow = now + 6_000;
  if (pending.task) {
    pending.task.phase = { stage: "judging", submissionId: accepted.submissionId };
    pending.task.submissions = [{ ...structuredClone(accepted), processing: { status: "pending" } }];
  }
  const reconnect = structuredClone(pending);
  reconnect.revision = 3;
  reconnect.serverNow = now + 7_000;
  if (reconnect.task) {
    reconnect.task.phase = { stage: "recovery", submissionId: accepted.submissionId };
    reconnect.task.submissions = [{ ...structuredClone(accepted), processing: { status: "interrupted", reason: "restart" } }];
  }
  const feedback = structuredClone(reconnect);
  feedback.revision = 4;
  feedback.serverNow = now + 8_000;
  if (feedback.task) {
    feedback.task.phase = { stage: "feedback", submissionId: accepted.submissionId };
    feedback.task.kps = [{ ...kp, attempts: 2, consecutiveCorrect: 2, completed: true }];
    feedback.task.submissions = [{
      ...structuredClone(accepted), processing: { status: "completed" }, gradeRevision: 1,
      feedback: { item: accepted.response.item, verdict: "correct", judge: "tests", evidence: { status: "eligible" } },
      explanation: markdown("逐个取出价格并加一。"),
    }];
  }
  const menu = structuredClone(feedback);
  menu.revision = 5;
  if (menu.task) menu.task.phase = { stage: "completed", outcome: "passed" };
  menu.menu = { menuId: "menu-2", candidates: [{ id: "candidate-quiz", kind: "quiz", title: "阶段测验", topicIds: ["py01"] }] };
  const preparing = structuredClone(menu);
  preparing.revision = 6;
  preparing.menu = null;
  preparing.restrictions = { kind: "quiz", tutorAllowed: false, referenceContentAllowed: false };
  if (preparing.task) {
    preparing.task.taskId = "quiz-1";
    preparing.task.kind = "quiz";
    preparing.task.phase = { stage: "preparing" };
    preparing.task.startedAt = null;
    preparing.task.kps = [];
    preparing.task.deliveries = [];
    preparing.task.submissions = [];
  }
  const quiz = structuredClone(preparing);
  quiz.revision = 7;
  quiz.serverNow = now + 20_000;
  if (quiz.task) {
    quiz.task.startedAt = now + 10_000;
    quiz.task.topics = [py01, py02];
    quiz.task.deadlineAt = now + 910_000;
    quiz.task.phase = { stage: "awaiting_answer", deliveryId: "quiz-delivery-2" };
    quiz.task.deliveries = [1, 2].map((index) => ({
      ...structuredClone(delivery), deliveryId: `quiz-delivery-${index}`, submissionId: `quiz-submission-${index}`, mode: "quiz",
      item: { ...structuredClone(item), id: `quiz.q${index}` },
      topicId: `py0${index}`, kpId: `py0${index}.k1`,
    }));
    quiz.task.submissions = [{
      ...structuredClone(accepted), taskId: "quiz-1", deliveryId: "quiz-delivery-1", submissionId: "quiz-submission-1",
      response: { ...structuredClone(accepted.response), item: { id: "quiz.q1", version } },
      acceptedAt: now + 15_000, processing: { status: "completed" }, gradeRevision: 1,
    }];
  }
  const ended = structuredClone(quiz);
  ended.revision = 8;
  ended.serverNow = now + 910_000;
  ended.restrictions = { kind: "none", tutorAllowed: true, referenceContentAllowed: true };
  if (ended.task) {
    ended.task.phase = { stage: "completed", outcome: "timeout" };
    const submission = ended.task.submissions[0];
    if (submission) {
      submission.feedback = { item: submission.response.item, verdict: "correct", judge: "tests", evidence: { status: "eligible" } };
      submission.explanation = markdown("加一后是 [3, 5]。另一道题未答，按超时结束。 ");
    }
  }
  return [answering, pending, reconnect, feedback, menu, preparing, quiz, ended];
}
