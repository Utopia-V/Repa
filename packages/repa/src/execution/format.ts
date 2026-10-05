import { Check } from "typebox/value";
import type { ProcessingResult } from "../requests/schema.js";
import { ExecutionViewSchema, type ExecutionView } from "./schema.js";

export function executionRepresentation(view: ExecutionView): ProcessingResult {
  return { format: { id: "repa.execution", version: "1" }, value: { kind: "inline", data: view },
    sources: [], resources: [...(view.fullOutput ? [view.fullOutput] : []), ...(view.resources ?? [])] };
}

/** 复制操作改变归属，历史命令和实际执行目录仍保留当时的事实。 */
export function remapExecutionResult(result: ProcessingResult, source: string, destination: string): void {
  if (result.format.id !== "repa.execution" || result.format.version !== "1" ||
    result.value.kind !== "inline" || !Check(ExecutionViewSchema, result.value.data)) return;
  const execution = result.value.data;
  if (execution.spaceId === source) execution.spaceId = destination;
  if (execution.source.kind === "agent" && execution.source.spaceId === source) execution.source.spaceId = destination;
  if (execution.fullOutput?.spaceId === source) execution.fullOutput.spaceId = destination;
  for (const resource of execution.resources ?? []) {
    if (resource.spaceId === source) resource.spaceId = destination;
  }
}
