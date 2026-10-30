import { parse } from "@repa/base/protocol";
import { LearningTaskSchema, SubmissionSchema, type LearningState, type Submission } from "./protocol.js";

/** 复习和测验进行中（含准备阶段）不能看参考内容和反馈；课、没有任务或任务已结束时可以。 */
export function referenceAllowed(state: LearningState): boolean {
  const task = state.task;
  return Boolean(state.restrictions.referenceContentAllowed && (
    !task || task.kind === "lesson" || ["completed", "aborted"].includes(task.phase.stage)
  ));
}

function hideReference(submission: Submission): Submission {
  delete submission.feedback;
  delete submission.explanation;
  return submission;
}

/** 只投影公开响应副本；日志与判分始终保存完整结果，出口按返回时的当前任务判权。 */
export function visibleLearningResponse(value: unknown, allowed: boolean): unknown {
  if (allowed) {
    return value;
  }
  const result = structuredClone(value);
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }
  if ("submission" in result) {
    const submission = parse(SubmissionSchema, result.submission);
    result.submission = hideReference(submission);
  }
  if ("task" in result && result.task) {
    const task = parse(LearningTaskSchema, result.task);
    task.submissions = task.submissions.map(hideReference);
    result.task = task;
  }
  if ("state" in result) {
    result.state = visibleLearningResponse(result.state, allowed);
  }
  return result;
}
