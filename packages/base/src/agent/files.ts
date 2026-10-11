import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  detectSupportedImageMimeTypeFromFile,
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  truncateLine,
  type GrepToolDetails,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { RepaFault } from "../schema.js";
import { existingPath, within } from "../space/paths.js";
import { exactEditTool } from "./edit.js";

/** 文件工具的路径边界：限在空间根目录内，可以再排除 .repa/。 */
export class FileScope {
  private constructor(readonly root: string, private readonly realRoot: string, readonly excludeData: boolean) {}

  static async create(root: string, excludeData: boolean): Promise<FileScope> {
    return new FileScope(root, await realpath(root), excludeData);
  }

  private allowed(root: string, file: string): boolean {
    return within(root, file) && !(this.excludeData && within(path.join(root, ".repa"), file));
  }

  /** 字面路径和解析符号链接后的路径都要在范围内，链接不能把工具带出空间。 */
  async resolve(file: string): Promise<string> {
    const lexical = path.resolve(this.root, file);
    if (this.allowed(this.root, lexical)) {
      const canonical = await existingPath(lexical);
      if (this.allowed(this.realRoot, canonical)) return canonical;
    }
    const message = this.excludeData ? `只能访问当前空间内的文件，不含 .repa/：${file}` : `只能写入当前空间内的文件：${file}`;
    throw new RepaFault("file_outside_space", message, { path: file });
  }

  /** 用于已解析的路径：是否为空间根目录。 */
  isRoot(file: string): boolean {
    return file === this.realRoot;
  }

  /** 用于已解析的路径：是否落在被排除的 .repa/ 中。 */
  isExcluded(file: string): boolean {
    return this.excludeData && within(path.join(this.realRoot, ".repa"), file);
  }
}

/** 通用 Agent 的读取沿用 Pi 默认实现；写入和精确编辑只在空间内，写到空间外就记不进历史。 */
export function generalFileTools(scope: FileScope): ToolDefinition[] {
  return [writeTool(scope), editTool(scope)];
}

/** 插件 Agent 的内置文件工具，只生成定义中列出的那些；读写、列目录和搜索都不出 scope。 */
export function spaceFileTools(scope: FileScope, names: readonly string[]): ToolDefinition[] {
  const factories: Record<string, (scope: FileScope) => ToolDefinition> = {
    read: readTool, write: writeTool, edit: editTool, ls: lsTool, find: findTool, grep: grepTool,
  };
  return names.flatMap(name => {
    const factory = factories[name];
    return factory ? [factory(scope)] : [];
  });
}

function writeTool(scope: FileScope): ToolDefinition {
  return defineTool(createWriteToolDefinition(scope.root, {
    operations: {
      async mkdir(directory) {
        await mkdir(await scope.resolve(directory), { recursive: true });
      },
      async writeFile(file, content) {
        await writeFile(await scope.resolve(file), content, "utf8");
      },
    },
  }));
}

function editTool(scope: FileScope): ToolDefinition {
  return exactEditTool(scope.root, {
    read: async file => readFile(await scope.resolve(file), "utf8"),
    async write(file, text) {
      await writeFile(await scope.resolve(file), text, "utf8");
    },
  });
}

function readTool(scope: FileScope): ToolDefinition {
  return defineTool(createReadToolDefinition(scope.root, {
    operations: {
      access: async file => access(await scope.resolve(file), constants.R_OK),
      readFile: async file => readFile(await scope.resolve(file)),
      detectImageMimeType: async file => detectSupportedImageMimeTypeFromFile(await scope.resolve(file)),
    },
  }));
}

async function exists(scope: FileScope, file: string): Promise<boolean> {
  const resolved = await scope.resolve(file);
  try {
    await access(resolved);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function lsTool(scope: FileScope): ToolDefinition {
  return defineTool(createLsToolDefinition(scope.root, {
    operations: {
      exists: file => exists(scope, file),
      // Pi 逐项 stat 并跳过失败的条目，指向范围外的链接因此不出现在结果中。
      stat: async file => stat(await scope.resolve(file)),
      async readdir(directory) {
        const resolved = await scope.resolve(directory);
        const names = await readdir(resolved);
        return scope.isRoot(resolved) ? names.filter(name => name !== ".repa") : names;
      },
    },
  }));
}

interface WalkEntry {
  path: string;
  directory: boolean;
}

/** 从已检查的目录向下遍历：不进 .repa、.git 和 node_modules，不跟随符号链接。 */
async function* walk(scope: FileScope, directory: string): AsyncGenerator<WalkEntry> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.name === ".git" || entry.name === "node_modules" || scope.isExcluded(file)) continue;
    if (entry.isDirectory()) {
      yield { path: file, directory: true };
      yield* walk(scope, file);
    } else if (entry.isFile()) {
      yield { path: file, directory: false };
    }
  }
}

function posixPath(file: string): string {
  return file.split(path.sep).join("/");
}

/** 沿用 Pi 调用 fd 的写法：不含 / 的模式匹配文件名，含 / 的模式在任意深度匹配相对路径。 */
function findMatches(pattern: string, relative: string): boolean {
  if (!pattern.includes("/")) return path.matchesGlob(path.posix.basename(relative), pattern);
  const anywhere = pattern.startsWith("**/") || pattern === "**" ? pattern : `**/${pattern}`;
  return path.matchesGlob(relative, anywhere);
}

function findTool(scope: FileScope): ToolDefinition {
  const builtin = createFindToolDefinition(scope.root, {
    operations: {
      exists: file => exists(scope, file),
      // Pi 把自定义 glob 的结果按搜索目录换成相对路径；这里直接返回相对路径，链接目录不会造成偏差。
      async glob(pattern, directory, options) {
        const start = await scope.resolve(directory);
        const results: string[] = [];
        for await (const entry of walk(scope, start)) {
          const relative = posixPath(path.relative(start, entry.path));
          if (!findMatches(pattern, relative)) continue;
          results.push(entry.directory ? `${relative}/` : relative);
          if (results.length >= options.limit) break;
        }
        return results;
      },
    },
  });
  return defineTool({
    ...builtin,
    description: `按 glob 模式查找当前空间中的文件，返回相对搜索目录的路径。不进入 .repa、.git、node_modules，不跟随符号链接，也不读取 .gitignore。最多返回 1000 个结果或 ${DEFAULT_MAX_BYTES / 1024}KB。`,
  });
}

const GREP_LIMIT = 100;
const GREP_FILE_BYTES = 10 * 1024 * 1024;

/** 沿用 ripgrep 的 glob 写法：不含 / 的模式匹配文件名，! 开头表示排除。 */
function grepMatches(glob: string, relative: string): boolean {
  const excluded = glob.startsWith("!");
  const pattern = excluded ? glob.slice(1) : glob;
  const matched = path.matchesGlob(pattern.includes("/") ? relative : path.posix.basename(relative), pattern);
  return excluded ? !matched : matched;
}

/** 与 ripgrep 遍历目录时一致，跳过二进制文件；过大的文件也不整份读入内存。 */
async function searchableText(file: string): Promise<string | undefined> {
  if ((await stat(file)).size > GREP_FILE_BYTES) return undefined;
  const content = await readFile(file);
  if (content.subarray(0, 8000).includes(0)) return undefined;
  return content.toString("utf8");
}

async function* only(file: string): AsyncGenerator<WalkEntry> {
  yield { path: file, directory: false };
}

// Pi 的 grep 直接对搜索路径启动 ripgrep，operations 只能检查起点；从空间根目录搜索时仍会进入 .repa/，
// 所以插件 Agent 的 grep 沿用 Pi 的参数与输出格式，在进程内遍历空间。
function grepTool(scope: FileScope): ToolDefinition {
  const builtin = createGrepToolDefinition(scope.root);
  return defineTool({
    ...builtin,
    description: `在当前空间的文件中搜索内容，返回匹配行的路径和行号。pattern 按 JavaScript 正则表达式解释，literal 为 true 时按原文匹配。不进入 .repa、.git、node_modules，不跟随符号链接，跳过二进制文件和超过 10MB 的文件。最多返回 ${GREP_LIMIT} 个匹配或 ${DEFAULT_MAX_BYTES / 1024}KB。`,
    async execute(_callId, input, signal) {
      signal?.throwIfAborted();
      const target = await scope.resolve(input.path ?? ".");
      const directory = (await stat(target)).isDirectory();
      const limit = Math.max(1, input.limit ?? GREP_LIMIT);
      const around = input.context !== undefined && input.context > 0 ? input.context : 0;
      const source = input.literal ? input.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : input.pattern;
      const expression = new RegExp(source, input.ignoreCase ? "i" : "");
      const output: string[] = [];
      let matches = 0;
      let linesTruncated = false;
      for await (const entry of directory ? walk(scope, target) : only(target)) {
        if (entry.directory) continue;
        const relative = directory ? posixPath(path.relative(target, entry.path)) : path.basename(entry.path);
        if (input.glob !== undefined && !grepMatches(input.glob, relative)) continue;
        signal?.throwIfAborted();
        const text = await searchableText(entry.path);
        if (text === undefined) continue;
        const lines = text.replace(/\r\n?/g, "\n").split("\n");
        for (let index = 0; index < lines.length && matches < limit; index++) {
          if (!expression.test(lines[index] ?? "")) continue;
          matches++;
          const last = Math.min(lines.length - 1, index + around);
          for (let line = Math.max(0, index - around); line <= last; line++) {
            const shown = truncateLine(lines[line] ?? "");
            if (shown.wasTruncated) linesTruncated = true;
            output.push(line === index ? `${relative}:${line + 1}: ${shown.text}` : `${relative}-${line + 1}- ${shown.text}`);
          }
        }
        if (matches >= limit) break;
      }
      if (matches === 0) return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };
      const truncation = truncateHead(output.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
      const details: GrepToolDetails = {};
      const notices: string[] = [];
      if (matches >= limit) {
        notices.push(`已达到 ${limit} 个匹配的上限，可用 limit=${limit * 2} 或更具体的 pattern 继续`);
        details.matchLimitReached = limit;
      }
      if (truncation.truncated) {
        notices.push(`已达到 ${formatSize(DEFAULT_MAX_BYTES)} 输出上限`);
        details.truncation = truncation;
      }
      if (linesTruncated) {
        notices.push("部分长行已截断，可用 read 查看全文");
        details.linesTruncated = true;
      }
      const text = notices.length > 0 ? `${truncation.content}\n\n[${notices.join("；")}]` : truncation.content;
      return { content: [{ type: "text" as const, text }], details: Object.keys(details).length > 0 ? details : undefined };
    },
  });
}
