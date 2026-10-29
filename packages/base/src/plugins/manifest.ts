import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import semver from "semver";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { Plugin } from "../plugin.js";
import { object, RepaFault } from "../schema.js";
import { within } from "../space/paths.js";

export const PluginManifestSchema = object({
  id: Type.String({ pattern: "^[a-z][a-z0-9-]*$" }),
  version: Type.String({ minLength: 1 }),
  baseVersion: Type.String({ minLength: 1 }),
  entry: Type.String({ minLength: 1 }),
});
export type PluginManifest = Static<typeof PluginManifestSchema>;

/** 清单和兼容性全部通过后才执行插件；构建目录仍是产品提供的可信代码。 */
export async function loadPlugin(directory: string): Promise<Plugin> {
  const root = await realpath(directory);
  if (!(await stat(root)).isDirectory()) throw new RepaFault("invalid_plugin_manifest", "插件路径必须是构建目录");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path.join(root, "repa-plugin.json"), "utf8"));
  } catch (error) {
    throw new RepaFault("invalid_plugin_manifest", "无法读取插件清单", { directory, cause: String(error) });
  }
  if (!Check(PluginManifestSchema, value) || !semver.valid(value.version) || !semver.validRange(value.baseVersion)) {
    throw new RepaFault("invalid_plugin_manifest", "插件清单的字段或版本无效", { directory });
  }
  const manifest = value;
  const base: unknown = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  if (!base || typeof base !== "object" || !("version" in base) || typeof base.version !== "string") {
    throw new RepaFault("invalid_base_version", "底座包缺少版本");
  }
  if (!semver.satisfies(base.version, manifest.baseVersion)) {
    throw new RepaFault("incompatible_base_version", "插件不兼容当前底座版本", { id: manifest.id, version: base.version, required: manifest.baseVersion });
  }
  const entry = path.resolve(root, manifest.entry);
  if (path.isAbsolute(manifest.entry) || !within(root, entry) || !/\.(m?js)$/.test(entry)) {
    throw new RepaFault("invalid_plugin_manifest", "构建入口必须是目录内的 JavaScript 文件");
  }
  let canonical: string;
  try {
    canonical = await realpath(entry);
    if (!within(root, canonical) || !/\.(m?js)$/.test(canonical) || !(await stat(canonical)).isFile()) throw new Error("入口不是目录内的 JavaScript 文件");
  } catch (error) {
    throw new RepaFault("invalid_plugin_manifest", "构建入口无效或无法读取", { entry: manifest.entry, cause: String(error) });
  }
  const module: unknown = await import(pathToFileURL(canonical).href);
  const exported = module !== null && typeof module === "object" ? module : {};
  const plugin: unknown = "default" in exported ? exported.default : "plugin" in exported ? exported.plugin : undefined;
  if (!plugin || typeof plugin !== "object" || !("id" in plugin) || plugin.id !== manifest.id || !("open" in plugin) || typeof plugin.open !== "function") {
    throw new RepaFault("invalid_plugin_export", "插件必须导出 default 或 plugin，且 id 与清单一致并包含 open(host)");
  }
  const definition = plugin as Plugin;
  return { id: manifest.id, open: (host) => definition.open(host) };
}
