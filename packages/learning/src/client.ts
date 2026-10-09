import type { RepaClient } from "repa/client";
import { RepaFault } from "repa/protocol";
import { Check } from "typebox/value";
import { learningMethods, type LearningMethod, type LearningParams, type LearningResult } from "./protocol.js";

export type LearningClient = Pick<RepaClient, "call">;

/** 保留领域方法的参数与结果类型，传输和实现选择使用通用能力调用。 */
export async function callLearning<M extends LearningMethod>(
  client: LearningClient,
  method: M,
  params: LearningParams<M>,
): Promise<LearningResult<M>> {
  if (!Object.hasOwn(learningMethods, method) || !Check(learningMethods[method].params, params))
    throw new RepaFault("invalid_input", "学习语境调用参数无效。");
  const { spaceId, ...input } = structuredClone(params);
  const accepted = await client.call("capability.invoke", {
    scope: { kind: "space", spaceId },
    requestId: crypto.randomUUID(),
    contract: { id: `repa.${method}`, version: "1" },
    input,
  });
  if (accepted.kind !== "inline" || !Check(learningMethods[method].result, accepted.result))
    throw new RepaFault("invalid_capability_output", "学习语境能力返回了无效结果。");
  // 上面的运行时校验使用同一 method；泛型索引在此保留该对应关系。
  return accepted.result as LearningResult<M>;
}
