import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { Type, type Static } from "typebox";
import { Check, Clean } from "typebox/value";

import { isCode } from "../backup/copy.js";
import { object, RepaFault } from "../schema.js";
import { writeJson } from "../storage.js";

const DigestSchema = Type.String({ pattern: "^[0-9a-f]{64}$" });

/**
 * 一个自写插件的启用记录。digest 是使用者要运行的版本，在打开之前写入，打不开时仍指向它；
 * previous 是上一个要运行的版本，可以明确地让它重新生效；activatedAt 是 digest 成为这个值的时刻，
 * 同一摘要重新加载、正常打开空间都不改它。卸载只把 enabled 改为 false，其余不变。
 */
export const PluginEnablementEntrySchema = object({
  enabled: Type.Boolean(),
  digest: DigestSchema,
  previous: Type.Optional(DigestSchema),
  activatedAt: Type.String({ format: "date-time" }),
});
/** 空间的启用记录 `<空间>/.repa/plugins.json`：只记自写插件，以插件 id 为键。 */
export const PluginEnablementSchema = object({
  plugins: Type.Record(Type.String({ pattern: "^[a-z][a-z0-9-]*$" }), PluginEnablementEntrySchema, { additionalProperties: false }),
});
export type PluginEnablementEntry = Static<typeof PluginEnablementEntrySchema>;
export type PluginEnablement = Static<typeof PluginEnablementSchema>;

/** 启用记录的路径。 */
export function enablementFile(dataDir: string): string {
  return path.join(dataDir, "plugins.json");
}

/**
 * 读启用记录；文件不存在时是空记录。读取时忽略各项里不认识的字段，已知字段仍校验；
 * 读不了或损坏时抛错，不当作空记录：那样清理会删掉记录本来指向的快照。
 */
export async function readEnablement(dataDir: string): Promise<PluginEnablement> {
  const file = enablementFile(dataDir);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT")) return { plugins: {} };
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new RepaFault("invalid_plugin_enablement", "启用记录不是有效的 JSON", { file, cause: String(error) });
  }
  // typebox 的 Clean 遇到按模式匹配键的对象会把条目一并删掉，所以逐项清理。
  if (value !== null && typeof value === "object" && "plugins" in value && value.plugins !== null && typeof value.plugins === "object") {
    const plugins = Object.fromEntries(Object.entries(value.plugins).map(([id, entry]) => [id, Clean(PluginEnablementEntrySchema, entry)]));
    value = { plugins };
  }
  if (!Check(PluginEnablementSchema, value)) throw new RepaFault("invalid_plugin_enablement", "启用记录的字段无效", { file });
  return value;
}

/** 加载插件 id 的 digest 版本以后的记录。摘要变了时 previous 取原 digest、activatedAt 取 at；同一摘要不改这两项。 */
export function withLoaded(record: PluginEnablement, id: string, digest: string, at: string): PluginEnablement {
  const current = record.plugins[id];
  let entry: PluginEnablementEntry;
  if (current === undefined) {
    entry = { enabled: true, digest, activatedAt: at };
  } else if (current.digest === digest) {
    entry = { ...current, enabled: true };
  } else {
    entry = { enabled: true, digest, previous: current.digest, activatedAt: at };
  }
  return { plugins: { ...record.plugins, [id]: entry } };
}

/** 卸载插件 id 以后的记录：只把 enabled 改为 false，摘要与时刻都留着，快照因此保留，再启用同一版本不必重新批准。 */
export function withUnloaded(record: PluginEnablement, id: string): PluginEnablement {
  const current = record.plugins[id];
  if (current === undefined) return record;
  return { plugins: { ...record.plugins, [id]: { ...current, enabled: false } } };
}

/**
 * 写记录的结果，按盘上实际的内容报告，而不按写入有没有抛错推断：写入先改名再同步目录，
 * 改名成功、同步失败时新记录已经在盘上。
 * - written：盘上是新记录，并已落盘。
 * - unconfirmed：写入报错，但读回的是新记录；运行的集合照新记录装配，持久化未确认。
 * - unchanged：写入报错，读回的不是新记录，record 是盘上实际的记录（通常就是旧记录）。
 * - unknown：写入报错，读回也失败；盘上是什么不知道，不要据此清理快照。
 */
export type EnablementWrite =
  | { status: "written"; record: PluginEnablement }
  | { status: "unconfirmed"; record: PluginEnablement; error: unknown }
  | { status: "unchanged"; record: PluginEnablement; error: unknown }
  | { status: "unknown"; error: unknown; readError: unknown };

/** 写入启用记录；失败时读回，报告盘上实际的记录。 */
export async function writeEnablement(dataDir: string, next: PluginEnablement): Promise<EnablementWrite> {
  // 按写出的 JSON 比较读回的内容：值为 undefined 的键写出时就没有了。
  const record = JSON.parse(JSON.stringify(next)) as unknown;
  if (!Check(PluginEnablementSchema, record)) throw new RepaFault("invalid_plugin_enablement", "启用记录的字段无效");
  try {
    await writeJson(enablementFile(dataDir), record);
    return { status: "written", record };
  } catch (error) {
    let actual: PluginEnablement;
    try {
      actual = await readEnablement(dataDir);
    } catch (readError) {
      return { status: "unknown", error, readError };
    }
    if (isDeepStrictEqual(actual, record)) return { status: "unconfirmed", record: actual, error };
    return { status: "unchanged", record: actual, error };
  }
}
