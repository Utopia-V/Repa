import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
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
import { GREP_THREAD, inDataDir, posixPath, walk, type GrepJob, type GrepOutcome } from "./search.js";

/** 文件工具的路径边界：限在空间根目录内，可以再排除 .repa/。 */
export class FileScope {
  private constructor(readonly root: string, private readonly realRoot: string, readonly excludeData: boolean) {}

  static async create(root: string, excludeData: boolean): Promise<FileScope> {
    return new FileScope(root, await realpath(root), excludeData);
  }

  private allowed(root: string, file: string): boolean {
    return within(root, file) && !(this.excludeData && inDataDir(root, file));
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
    return this.excludeData && inDataDir(this.realRoot, file);
  }

  /** 交给搜索线程的根目录，与 isExcluded 使用同一个解析结果。 */
  get resolvedRoot(): string {
    return this.realRoot;
  }
}

/** 通用 Agent 的读取沿用 Pi 默认实现；写入和精确编辑只在空间内，写到空间外就记不进历史。 */
export function generalFileTools(scope: FileScope): ToolDefinition[] {
  return [writeTool(scope), editTool(scope)];
}

/** 插件 Agent 的内置文件工具，只生成定义中列出的那些；读写、列目录和搜索都不出 scope。 */
export function spaceFileTools(scope: FileScope, names: readonly string[], options: { grepTimeoutMs?: number } = {}): ToolDefinition[] {
  const factories: Record<string, () => ToolDefinition> = {
    read: () => readTool(scope),
    write: () => writeTool(scope),
    edit: () => editTool(scope),
    ls: () => lsTool(scope),
    find: () => findTool(scope),
    grep: () => grepTool(scope, options.grepTimeoutMs ?? GREP_TIMEOUT_MS),
  };
  return names.flatMap(name => {
    const factory = factories[name];
    return factory ? [factory()] : [];
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
        return scope.isRoot(resolved) ? names.filter(name => name.toLowerCase() !== ".repa") : names;
      },
    },
  }));
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
        for await (const entry of walk(start, file => scope.isExcluded(file))) {
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
const GREP_TIMEOUT_MS = 20_000;
// 源码经 tsx 运行时本模块后缀为 .ts，构建后为 .js；搜索线程入口与本模块同目录、同后缀。
const GREP_WORKER = new URL(`./search${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url);

/** 在独立线程中搜索：模型给出的正则即使回溯失控，也只占用这个线程，超时或取消时终止它。 */
function runGrep(job: GrepJob, timeoutMs: number, signal: AbortSignal | undefined): Promise<GrepOutcome> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(GREP_WORKER, { workerData: { [GREP_THREAD]: job } });
    let settled = false;
    const finish = (outcome: { value: GrepOutcome } | { error: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      // 等线程实际停止再交回结果，工具结束后不留下仍在运行的搜索。
      worker.terminate().catch(() => undefined).finally(() => {
        if ("value" in outcome) resolve(outcome.value);
        else reject(outcome.error);
      });
    };
    const timer = setTimeout(() => {
      finish({ error: new Error(`搜索超过 ${timeoutMs / 1000} 秒仍未完成，已经停止；可以缩小搜索范围或换用更简单的 pattern`) });
    }, timeoutMs);
    const abort = () => finish({ error: new Error("Operation aborted") });
    signal?.addEventListener("abort", abort, { once: true });
    // 搜索线程只回传 GrepOutcome，由同一进程的 search.ts 构造。
    worker.once("message", (value: GrepOutcome) => finish({ value }));
    worker.once("error", error => finish({ error }));
    worker.once("exit", code => finish({ error: new Error(`搜索线程意外退出（${code}）`) }));
  });
}

// Pi 的 grep 直接对搜索路径启动 ripgrep，operations 只能检查起点；从空间根目录搜索时仍会进入 .repa/，
// 所以插件 Agent 的 grep 沿用 Pi 的参数与输出格式，在独立线程中遍历空间。
function grepTool(scope: FileScope, timeoutMs: number): ToolDefinition {
  const builtin = createGrepToolDefinition(scope.root);
  return defineTool({
    ...builtin,
    description: `在当前空间的文件中搜索内容，返回匹配行的路径和行号。pattern 按 JavaScript 正则表达式解释，literal 为 true 时按原文匹配。不进入 .repa、.git、node_modules，不跟随符号链接，跳过二进制文件和超过 10MB 的文件。最多返回 ${GREP_LIMIT} 个匹配或 ${DEFAULT_MAX_BYTES / 1024}KB，超过 ${timeoutMs / 1000} 秒停止。`,
    async execute(_callId, input, signal) {
      signal?.throwIfAborted();
      const target = await scope.resolve(input.path ?? ".");
      const limit = Math.max(1, input.limit ?? GREP_LIMIT);
      const source = input.literal ? input.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : input.pattern;
      const flags = input.ignoreCase ? "i" : "";
      // 先在主线程编译一次，pattern 有语法错误时直接作为工具错误返回。
      new RegExp(source, flags);
      const outcome = await runGrep({
        root: scope.resolvedRoot,
        target,
        directory: (await stat(target)).isDirectory(),
        source,
        flags,
        ...(input.glob === undefined ? {} : { glob: input.glob }),
        limit,
        context: input.context !== undefined && input.context > 0 ? input.context : 0,
      }, timeoutMs, signal);
      if (outcome.matches === 0) return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };
      let linesTruncated = false;
      const output = outcome.lines.map(line => {
        const shown = truncateLine(line.text);
        if (shown.wasTruncated) linesTruncated = true;
        return line.match ? `${line.file}:${line.line}: ${shown.text}` : `${line.file}-${line.line}- ${shown.text}`;
      });
      const truncation = truncateHead(output.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
      const details: GrepToolDetails = {};
      const notices: string[] = [];
      if (outcome.matches >= limit) {
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
