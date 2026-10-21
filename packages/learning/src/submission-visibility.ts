import { parse } from "@repa/base/protocol";
import { finished } from "./flow-state.js";
import { LearningTaskSchema, SubmissionSchema, type Submission } from "./protocol.js";
import type { Projection } from "./records-schema.js";

export function referenceAllowed(current: Projection | undefined): boolean {
  const task = current?.state.task;
  return Boolean(current?.state.restrictions.referenceContentAllowed && (
    !task || task.kind === "lesson" || finished(task)
  ));
}
function hideReference(submission: Submission): Submission {
  delete submission.feedback;
  delete submission.explanation;
  return submission;
}
/** 只投影公开响应副本；日志与判分始终保存完整结果，出口按返回时的当前任务判权。 */
export function visibleLearningResponse(value: unknown, current: Projection | undefined): unknown {
  if (referenceAllowed(current)) {
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
    result.state = visibleLearningResponse(result.state, current);
  }
  return result;
}
