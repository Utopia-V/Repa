import { RepaFault } from "@repa/base";
import { contentVersion } from "@repa/base/protocol";
import { questionVersion, topicQuestions } from "./check/items.js";
import type { Snapshot } from "./records-schema.js";

/** 题面已由 c2 白名单投影并换号；身份、私有定义及依赖一起冻结。 */
export async function createSnapshot(input: Omit<Snapshot, "topicVersion" | "kpVersion" | "questionVersion">): Promise<Snapshot> {
  const kp = input.topic.kps.find((entry) => entry.id === input.kpId);
  const entry = topicQuestions(input.topic).find((entry) => entry.kp.id === input.kpId && entry.question.id === input.questionId);
  if (!kp || !entry || !input.course.topics.includes(input.topic.id)) throw new RepaFault("invalid_input", "快照身份不属于课程");
  return {
    ...structuredClone(input), topicVersion: await contentVersion(input.topic), kpVersion: await contentVersion(kp),
    questionVersion: await questionVersion(entry.question, input.topic),
  };
}
