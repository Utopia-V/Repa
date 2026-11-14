import { calculateCost, type Model, type Usage as PiUsage } from "@earendil-works/pi-ai";
import type { SessionEntry as PiSessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionUsage, Usage } from "../schema.js";

const TOKENS = ["input", "output", "cacheRead", "cacheWrite"] as const;

/** 没有任何请求时的累计值。 */
export function emptyUsage(): SessionUsage {
  return {
    requests: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    unpriced: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function add(total: Usage, usage: Usage): void {
  for (const key of TOKENS) total[key] += usage[key];
}

/** 目录里有单价的模型：四项单价不全是零。免费或没有标价的模型在 Pi 的目录里同样是零，分不出来，一律按没有单价。 */
function priced(model: Model<string> | undefined): model is Model<string> {
  return model !== undefined && (model.cost.input > 0 || model.cost.output > 0 || model.cost.cacheRead > 0 || model.cost.cacheWrite > 0);
}

/**
 * 把一个会话的全部条目（含分支以外的旧分支，它们同样花了钱）计入累计值。助手消息与 Pi 的 usage 条目各是一次请求，
 * 按记下的提供方和模型 id 在目录里取单价，由 Pi 的 calculateCost 折算（含分档单价与长缓存写入）；
 * 压缩与分支摘要不记模型，只计 token。
 */
export function addSessionUsage(total: SessionUsage, entries: readonly PiSessionEntry[], catalog: (provider: string, id: string) => Model<string> | undefined): void {
  const request = (usage: PiUsage, model: Model<string> | undefined) => {
    total.requests++;
    add(total.usage, usage);
    if (!priced(model)) {
      add(total.unpriced, usage);
      return;
    }
    // calculateCost 改写传入用量的 cost 字段，交给它一份副本。
    total.cost += calculateCost(model, { ...usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }).total;
  };
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      request(entry.message.usage, catalog(entry.message.provider, entry.message.model));
    } else if (entry.type === "usage") {
      request(entry.usage, catalog(entry.provider, entry.model));
    } else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
      request(entry.usage, undefined);
    }
  }
}
