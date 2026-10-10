import type { Result } from "@repa/base/protocol";

type History = Result<"session.history">;

export function summarizeUsage(entries: History) {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const entry of entries) {
    if (!entry.usage) continue;
    usage.input += entry.usage.input;
    usage.output += entry.usage.output;
    usage.cacheRead += entry.usage.cacheRead;
    usage.cacheWrite += entry.usage.cacheWrite;
  }
  const fullInput = usage.input + usage.cacheRead + usage.cacheWrite;
  const assistantMessages = entries.filter(entry => entry.type === "assistant").length;
  const compactions = entries.filter(entry => entry.type === "compaction").length;
  const cacheWarmOperations = entries.filter(entry => entry.type === "usage"
    && entry.data !== null && typeof entry.data === "object"
    && "kind" in entry.data && entry.data.kind === "cache_warm").length;
  return {
    ...usage,
    fullInput,
    cacheHitRate: fullInput > 0 ? usage.cacheRead / fullInput : null,
    assistantMessages,
    compactions,
    cacheWarmOperations,
    // Pi 保存的是一次压缩的合计用量，不能从中恢复子请求数。
    modelOperations: assistantMessages + compactions + cacheWarmOperations,
  };
}

export function assertModelBudget(entries: History, limit: number): void {
  if (summarizeUsage(entries).modelOperations >= limit) throw new Error("model_operation_limit");
}
