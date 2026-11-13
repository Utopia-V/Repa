import { isBuiltin, registerHooks, type ResolveFnOutput, type ResolveHookSync } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RepaFault } from "../schema.js";
import { within } from "../space/paths.js";

/** 插件文件夹里的代码导入宿主时用的名字。 */
export const PLUGIN_SPECIFIER = "@repa/base/plugin";

// 宿主自己的那一份。插件与宿主共用同一个模块实例，RepaFault 才是同一个类，错误码不会在边界上退化。
// 构建后指向 dist/plugin.js；在 tsx 下运行源码时，tsx 的解析把它换成 src/plugin.ts，与宿主自己的导入一致。
const HOST_PLUGIN = import.meta.resolve("../plugin.js");

const MODULE_FORMATS: Record<string, string> = {
  ".js": "module",
  ".mjs": "module",
  ".ts": "module-typescript",
  ".json": "json",
};

// 已登记的插件文件夹，真实路径到插件 id。
const roots = new Map<string, string>();
let registered = false;

/**
 * 让插件 id 的文件夹 root（真实路径）里的模块只能导入 Node 内置模块、文件夹内的文件和 @repa/base/plugin，
 * 后者解析到宿主自己的那一份。文件夹里的 .js、.mjs、.ts 一律按 ES 模块解释，不看文件夹内外的 package.json，
 * 同一个文件夹放到哪里都是同样的含义。这不是安全边界：代码仍可以经 node:fs、node:child_process 做任何事，
 * 它保证的是插件的依赖都在文件夹之内。
 *
 * 解析钩子对整个进程生效，在第一次导入这样的插件之前注册一次；只处理 parentURL 或结果落在已登记文件夹里的解析，
 * 宿主自己和属于 npm 包的插件照常解析。
 */
export function confinePluginFolder(root: string, id: string): void {
  roots.set(root, id);
  if (registered) return;
  registerHooks({ resolve });
  registered = true;
}

const resolve: ResolveHookSync = (specifier, context, nextResolve) => {
  const parent = rootOf(context.parentURL);
  if (parent !== undefined) {
    if (specifier === PLUGIN_SPECIFIER) return { url: HOST_PLUGIN, shortCircuit: true };
    if (isBuiltin(specifier)) return nextResolve(specifier, context);
    if (bare(specifier)) throw denied(parent, context.parentURL, specifier);
  }
  let result: ResolveFnOutput;
  try {
    result = nextResolve(specifier, context);
  } catch (error) {
    if (parent !== undefined && missing(error)) throw notFound(parent, context.parentURL, specifier, error);
    throw error;
  }
  const target = rootOf(result.url);
  if (parent !== undefined && target !== parent) throw denied(parent, context.parentURL, specifier);
  if (target === undefined) return result;
  const file = fileURLToPath(result.url);
  const format = MODULE_FORMATS[path.extname(file)];
  if (format === undefined) {
    throw new RepaFault("plugin_import_failed", `插件 ${roots.get(target) ?? ""} 只能导入 .js、.mjs、.ts 模块和 JSON 文件：${relative(target, file)}`, { folder: target, file });
  }
  return { ...result, format };
};

/** 包含这个模块的已登记文件夹；文件夹嵌套时取最深的一层。 */
function rootOf(url: string | undefined): string | undefined {
  if (roots.size === 0 || url === undefined || !url.startsWith("file:")) return undefined;
  const file = fileURLToPath(url);
  let found: string | undefined;
  for (const root of roots.keys()) {
    if (within(root, file) && (found === undefined || root.length > found.length)) found = root;
  }
  return found;
}

// 不是相对路径、绝对路径或 URL 的说明符，即包名和 package.json 的 imports 映射（#开头）。
// 这些都要到文件夹之外查找，不交给 Node 去解析。
function bare(specifier: string): boolean {
  return !/^(?:\.{1,2}(?:[/\\]|$)|[/\\]|[a-zA-Z][a-zA-Z\d+.-]*:)/.test(specifier);
}

function missing(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return error.code === "ERR_MODULE_NOT_FOUND" || error.code === "MODULE_NOT_FOUND" || error.code === "ERR_UNSUPPORTED_DIR_IMPORT";
}

function relative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function importer(root: string, parentURL: string | undefined): string {
  const file = parentURL === undefined ? "入口" : relative(root, fileURLToPath(parentURL));
  return `插件 ${roots.get(root) ?? ""} 的 ${file}`;
}

function denied(root: string, parentURL: string | undefined, specifier: string): RepaFault {
  return new RepaFault(
    "plugin_import_failed",
    `${importer(root, parentURL)} 导入了 ${specifier}：插件文件夹里的代码只能导入 Node 内置模块、文件夹内的文件和 ${PLUGIN_SPECIFIER}`,
    { folder: root, specifier },
  );
}

function notFound(root: string, parentURL: string | undefined, specifier: string, error: unknown): RepaFault {
  return new RepaFault(
    "plugin_import_failed",
    `${importer(root, parentURL)} 找不到 ${specifier}。导入要写出文件真实的扩展名，例如 ./lib.ts；Node 不补全扩展名，也不把 .js 换成 .ts`,
    { folder: root, specifier, cause: error instanceof Error ? error.message : String(error) },
  );
}
