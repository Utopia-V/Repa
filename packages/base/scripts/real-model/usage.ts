import type { Result } from "@repa/base/protocol";

import type { RawUsage } from "./transport.js";

type Usage = NonNullable<Result<"session.history">[number]["usage"]>;

export function usageMatches(raw: RawUsage[], saved: Usage[]): boolean {
  if (raw.length === 0 || saved.length === 0) return false;
  if (raw.some(usage => usage.input === null || usage.output === null)) return false;
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  // Pi 一次压缩可能分别总结历史与截断回合，再把两次模型用量合并为一个条目。
  return sum(raw.map(usage => usage.input ?? 0)) === sum(saved.map(usage => usage.input + usage.cacheRead + usage.cacheWrite))
    && sum(raw.map(usage => usage.output ?? 0)) === sum(saved.map(usage => usage.output))
    && (raw.some(usage => usage.cached === null) || sum(raw.map(usage => usage.cached ?? 0)) === sum(saved.map(usage => usage.cacheRead)))
    && (raw.some(usage => usage.cacheWrite === null) || sum(raw.map(usage => usage.cacheWrite ?? 0)) === sum(saved.map(usage => usage.cacheWrite)));
}
