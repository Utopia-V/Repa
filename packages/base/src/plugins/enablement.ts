import { readFile } from "node:fs/promises";
import path from "node:path";

import { Type, type Static } from "typebox";
import { Check, Clean } from "typebox/value";

import { isCode } from "../backup/copy.js";
import { object, RepaFault } from "../schema.js";
import { writeJson } from "../storage.js";
import { PLUGIN_ID } from "./manifest.js";

/** 插件文件夹摘要的格式：64 位小写十六进制。快照目录名也按它。 */
export const DIGEST = /^[0-9a-f]{64}$/;
const DigestSchema = Type.String({ pattern: DIGEST.source });

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
  plugins: Type.Record(Type.String({ pattern: PLUGIN_ID.source }), PluginEnablementEntrySchema, { additionalProperties: false }),
});
export type PluginEnablementEntry = Static<typeof PluginEnablementEntrySchema>;
export type PluginEnablement = Static<typeof PluginEnablementSchema>;

/** 启用记录的路径。 */
export function enablementFile(dataDir: string): string {
  return path.join(dataDir, "plugins.json");
}

/**
 * 读启用记录；文件不存在时是空记录。读取时忽略各项里不认识的字段，已知字段仍校验，与应用设置的读取相同；
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

/** 写入启用记录：先写临时文件再改名，写不成时抛错。 */
export async function writeEnablement(dataDir: string, next: PluginEnablement): Promise<void> {
  if (!Check(PluginEnablementSchema, next)) throw new RepaFault("invalid_plugin_enablement", "启用记录的字段无效");
  await writeJson(enablementFile(dataDir), next);
}
