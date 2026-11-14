import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import semver from "semver";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { Plugin } from "../plugin.js";
import { errorText, object, RepaFault } from "../schema.js";
import { within } from "../space/paths.js";
import { confinePluginFolder } from "./folder-imports.js";

/** 插件 id 的格式：小写字母开头，只含小写字母、数字和连字符。清单、启用记录与快照目录名都按它。 */
export const PLUGIN_ID = /^[a-z][a-z0-9-]*$/;
const ID = Type.String({ pattern: PLUGIN_ID.source });

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

/** 静态读出的插件文件夹：真实路径、清单和入口模块的真实路径。 */
export interface PluginFolder {
  root: string;
  manifest: PluginManifest;
  entry: string;
}

/**
 * 只读清单并核对，不执行任何代码：字段、版本、底座兼容性、入口与页面文件。批准自写插件之前用它读暂存的副本，
 * 展示标题、版本与页面；导入要等使用者同意以后。
 */
export async function readPluginFolder(directory: string): Promise<PluginFolder> {
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
    // 页面目录是入口文档所在的目录，后端只提供其中的文件，入口模块和清单不能在里面。
    const pages = path.dirname(await folderFile(root, page.entry, [".html"], "页面入口"));
    if (pages === root || within(pages, entry)) {
      throw new RepaFault("invalid_plugin_manifest", "页面入口要放在子目录里，例如 page/index.html，入口模块和清单不能在这个目录中", { page: page.id, entry: page.entry });
    }
  }
  return { root, manifest, entry };
}

/**
 * 清单和兼容性全部通过后才执行插件。
 *
 * 根目录有 package.json 或位于 node_modules 下的文件夹是一个 npm 包，随包插件即如此：依赖由包管理器安装，按 Node 的规则照常解析。
 * 只看文件夹自己，不看上级目录：空间可能就在某个 JS 项目里，上级的 package.json 不该改变插件的含义。
 * 其余文件夹只能导入 Node 内置模块、文件夹内的文件和 @repa/base/plugin，见 confinePluginFolder。
 * 从已批准快照加载的自写插件给出 snapshotOf，即启用记录里的插件 id：清单 id 与它不同即拒绝，不执行入口；
 * 导入一律这样限制，不看文件夹里有没有 package.json，按来源而不按内容判断。
 */
export async function loadPlugin(directory: string, options: { snapshotOf?: string } = {}): Promise<LoadedPlugin> {
  const { root, manifest, entry } = await readPluginFolder(directory);
  const { snapshotOf } = options;
  if (snapshotOf !== undefined && manifest.id !== snapshotOf) {
    throw new RepaFault("plugin_id_mismatch", `快照里的插件 id 是 ${manifest.id}，启用记录里是 ${snapshotOf}`, { id: snapshotOf, manifest: manifest.id });
  }
  const npmPackage = snapshotOf === undefined && (root.split(path.sep).includes("node_modules") || (await exists(path.join(root, "package.json"))));
  if (!npmPackage) confinePluginFolder(root, manifest.id);
  const module = await importEntry(manifest.id, root, npmPackage, pathToFileURL(entry).href);
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
 * 反斜杠在别的系统上是文件名的一部分，冒号在 Windows 上表示盘符，两者都不接受；
 * 每一段都按目录列表逐字比对，大小写不一致的文件名在不区分大小写的文件系统上也拒绝。解析符号链接后也不能越出文件夹。
 */
async function folderFile(root: string, value: string, extensions: string[], label: string): Promise<string> {
  const parts = value.split("/");
  const lexical = path.resolve(root, ...parts);
  if (/[\\:]/.test(value) || parts.some((part) => part === "" || part === "..") || !within(root, lexical) || !extensions.includes(path.extname(lexical))) {
    throw new RepaFault("invalid_plugin_manifest", `${label}必须是插件文件夹内以 / 分隔的相对路径，扩展名为 ${extensions.join("、")}`, { path: value });
  }
  let directory = root;
  for (const part of parts) {
    if (part === ".") continue;
    const names = await readdir(directory).catch(() => [] as string[]);
    if (!names.includes(part)) throw new RepaFault("invalid_plugin_manifest", `${label} ${value} 不存在；文件名的大小写要与文件夹里的一致`, { path: value });
    directory = path.join(directory, part);
  }
  try {
    const canonical = await realpath(lexical);
    if (!within(root, canonical) || !extensions.includes(path.extname(canonical)) || !(await stat(canonical)).isFile()) throw new Error(`${label}不是文件夹内的文件`);
    return canonical;
  } catch (error) {
    throw new RepaFault("invalid_plugin_manifest", `${label}无效或无法读取`, { path: value, cause: String(error) });
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** 导入入口；Node 的错误换成说得清原因的 RepaFault，插件自己抛出的 RepaFault 原样交回。 */
async function importEntry(id: string, root: string, npmPackage: boolean, url: string): Promise<unknown> {
  try {
    return await import(url) as unknown;
  } catch (error) {
    if (error instanceof RepaFault) throw error;
    const message = errorText(error);
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    const where = error instanceof Error ? location(error, root) : undefined;
    // reason 说明是哪一类问题，advice 说明怎样改，放在 Node 的原话和出错位置之后。
    let reason = "入口导入失败";
    let advice: string | undefined;
    if (code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") {
      reason = "用了需要转换的 TypeScript 写法";
      advice = "Node 只去掉类型标注，不转换代码，enum、namespace、构造函数的参数属性等要改成普通的 JavaScript 写法";
    } else if (code === "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING") {
      reason = "从 node_modules 里导入了 .ts 文件";
      advice = "Node 不剥离 node_modules 里文件的类型";
    } else if (error instanceof SyntaxError && message.includes("does not provide an export named")) {
      // 链接阶段的错误，V8 也报为 SyntaxError。最常见的成因是没有写 type 修饰导入了只是类型的名字，类型剥离把它留成了值导入。
      reason = "导入了模块没有导出的名字";
      advice = "只是类型的名字要写 import type，例如 import type { Tool } from \"@repa/base/plugin\"";
    } else if (error instanceof SyntaxError) {
      reason = "有语法错误";
    } else if (npmPackage && code === "ERR_MODULE_NOT_FOUND") {
      advice = "插件文件夹的根目录有 package.json 或位于 node_modules 下，按 npm 包加载，依赖要由包管理器安装；不经构建的插件文件夹不放 package.json";
    }
    const text = [`插件 ${id} ${reason}：${message}`, where, advice].filter((line) => line !== undefined).join("\n");
    throw new RepaFault("plugin_import_failed", text, { id, cause: message });
  }
}

// 出错的文件、行号、那一行源码和指向出错处的标记，Node 放在 stack 开头、错误名那一行之前，message 里没有。
// 语法错误和链接错误都是这样，前者在标记后另有一个空行。文件可能写成路径，也可能写成 file: URL。
function location(error: Error, root: string): string | undefined {
  const lines = (error.stack ?? "").split("\n");
  const head = /^(?<name>\S.*):(?<line>\d+)$/.exec(lines[0] ?? "")?.groups;
  const end = lines.findIndex((line) => line.startsWith(error.name));
  if (head?.name === undefined || head.line === undefined || end < 2) return undefined;
  const file = head.name.startsWith("file:") ? fileURLToPath(head.name) : head.name;
  const shown = within(root, file) ? path.relative(root, file).split(path.sep).join("/") : file;
  return [`${shown}:${head.line}`, ...lines.slice(1, end).filter((line) => line !== "")].join("\n");
}
