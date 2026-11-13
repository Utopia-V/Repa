import { access, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import semver from "semver";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { Plugin } from "../plugin.js";
import { object, RepaFault } from "../schema.js";
import { within } from "../space/paths.js";
import { confinePluginFolder } from "./folder-imports.js";

const ID = Type.String({ pattern: "^[a-z][a-z0-9-]*$" });

/** 插件页面的声明：页面 id、显示的标题和插件文件夹内的 HTML 入口文档。 */
export const PluginPageSchema = object({
  id: ID,
  title: Type.String({ minLength: 1 }),
  entry: Type.String({ minLength: 1 }),
});
export type PluginPage = Static<typeof PluginPageSchema>;

export const PluginManifestSchema = object({
  id: ID,
  version: Type.String({ minLength: 1 }),
  baseVersion: Type.String({ minLength: 1 }),
  entry: Type.String({ minLength: 1 }),
  title: Type.Optional(Type.String({ minLength: 1 })),
  pages: Type.Optional(Type.Array(PluginPageSchema)),
});
export type PluginManifest = Static<typeof PluginManifestSchema>;

/** 加载结果：插件文件夹的真实路径、清单和插件定义。title 与 pages 暂只随清单保留，协议尚未公布它们。 */
export interface LoadedPlugin {
  root: string;
  manifest: PluginManifest;
  plugin: Plugin;
}

const ENTRY_EXTENSIONS = [".js", ".mjs", ".ts"];

/**
 * 清单和兼容性全部通过后才执行插件。
 *
 * 文件夹或它的上级目录里有 package.json 的，属于一个 npm 包，随包插件即如此：依赖由包管理器安装，按 Node 的规则照常解析。
 * 不属于任何包的文件夹只能导入 Node 内置模块、文件夹内的文件和 @repa/base/plugin，见 confinePluginFolder。
 * 这一区分是在装卸与快照落地之前的临时判断：那时自写插件从宿主保管的快照加载，由来源而不由位置决定。
 */
export async function loadPlugin(directory: string): Promise<LoadedPlugin> {
  const root = await realpath(directory);
  if (!(await stat(root)).isDirectory()) throw new RepaFault("invalid_plugin_manifest", "插件路径必须是插件文件夹");
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
  const entry = await folderFile(root, manifest.entry, ENTRY_EXTENSIONS, "入口模块");
  const underNodeModules = root.split(path.sep).includes("node_modules");
  // Node 只在 node_modules 之外剥离类型；与它判断的方式相同，按路径中的目录名。
  if (underNodeModules && path.extname(entry) === ".ts") {
    throw new RepaFault("invalid_plugin_manifest", "装在 node_modules 下的插件要以构建后的 JavaScript 为入口：Node 不剥离 node_modules 里 .ts 文件的类型", { entry: manifest.entry });
  }
  const pageIds = new Set<string>();
  for (const page of manifest.pages ?? []) {
    if (pageIds.has(page.id)) throw new RepaFault("invalid_plugin_manifest", "插件页面的 id 重复", { page: page.id });
    pageIds.add(page.id);
    await folderFile(root, page.entry, [".html"], "页面入口");
  }
  if (!underNodeModules && !(await insidePackage(root))) confinePluginFolder(root, manifest.id);
  const module = await importEntry(manifest.id, pathToFileURL(entry).href);
  const exported = module !== null && typeof module === "object" ? module : {};
  const plugin: unknown = "default" in exported ? exported.default : "plugin" in exported ? exported.plugin : undefined;
  if (!plugin || typeof plugin !== "object" || !("id" in plugin) || plugin.id !== manifest.id || !("open" in plugin) || typeof plugin.open !== "function") {
    throw new RepaFault("invalid_plugin_export", "插件必须导出 default 或 plugin，且 id 与清单一致并包含 open(host)");
  }
  const definition = plugin as Plugin;
  return { root, manifest, plugin: { id: manifest.id, open: (host) => definition.open(host) } };
}

/**
 * 清单里的路径一律相对插件文件夹、以 / 分隔，同一份清单在 Windows 和其他系统上指同一个文件：
 * 反斜杠在别的系统上是文件名的一部分，冒号在 Windows 上表示盘符，两者都不接受。解析符号链接后也不能越出文件夹。
 */
async function folderFile(root: string, value: string, extensions: string[], label: string): Promise<string> {
  const parts = value.split("/");
  const lexical = path.resolve(root, ...parts);
  if (/[\\:]/.test(value) || parts.some((part) => part === "" || part === "..") || !within(root, lexical) || !extensions.includes(path.extname(lexical))) {
    throw new RepaFault("invalid_plugin_manifest", `${label}必须是插件文件夹内以 / 分隔的相对路径，扩展名为 ${extensions.join("、")}`, { path: value });
  }
  try {
    const canonical = await realpath(lexical);
    if (!within(root, canonical) || !extensions.includes(path.extname(canonical)) || !(await stat(canonical)).isFile()) throw new Error(`${label}不是文件夹内的文件`);
    return canonical;
  } catch (error) {
    throw new RepaFault("invalid_plugin_manifest", `${label}无效或无法读取`, { path: value, cause: String(error) });
  }
}

/** 从文件夹起逐级向上找 package.json，与 Node 判断模块所属的包相同。 */
async function insidePackage(directory: string): Promise<boolean> {
  for (let current = directory; ; current = path.dirname(current)) {
    try {
      await access(path.join(current, "package.json"));
      return true;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    if (path.dirname(current) === current) return false;
  }
}

/** 导入入口；Node 的错误换成说得清原因的 RepaFault，插件自己抛出的 RepaFault 原样交回。 */
async function importEntry(id: string, url: string): Promise<unknown> {
  try {
    return await import(url) as unknown;
  } catch (error) {
    if (error instanceof RepaFault) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    const where = error instanceof Error ? location(error) : undefined;
    let reason: string;
    if (code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") {
      reason = "用了需要转换的 TypeScript 写法。Node 只去掉类型标注，不转换代码，enum、namespace、构造函数的参数属性等要改成普通的 JavaScript 写法";
    } else if (code === "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING") {
      reason = "从 node_modules 里导入了 .ts 文件，Node 不剥离那里的类型";
    } else if (error instanceof SyntaxError) {
      reason = "有语法错误";
    } else {
      reason = "入口导入失败";
    }
    throw new RepaFault("plugin_import_failed", `插件 ${id} ${reason}：${message}${where === undefined ? "" : `\n${where}`}`, { id, cause: message });
  }
}

// 语法错误的文件、行号和那一行源码，Node 放在 stack 开头、错误名之前，message 里没有。
function location(error: Error): string | undefined {
  const stack = error.stack ?? "";
  const end = stack.indexOf("\n\n");
  if (end < 0) return undefined;
  const head = stack.slice(0, end);
  return /^\S.*:\d+\n/.test(head) ? head : undefined;
}
