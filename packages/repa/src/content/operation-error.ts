import { RepaFault } from "../errors.js";

/** 模型读取错误正文；操作标识同时保留在可见文本中，供查询真实保存结果。 */
export function operationError(error: unknown, operationId: string): RepaFault {
  const failure = new RepaFault(error instanceof RepaFault ? error.code : "content_operation_failed",
    `${error instanceof Error ? error.message : String(error)}\noperationId: ${operationId}`,
    error instanceof RepaFault ? error.details : { operationId });
  failure.cause = error;
  return failure;
}
