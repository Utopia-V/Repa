import { createHash } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { access, glob, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createFindToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  detectSupportedImageMimeTypeFromFile,
  DEFAULT_MAX_BYTES,
  truncateHead,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { RepaFault } from "../schema.js";
import type { SpaceWrites } from "../space.js";
import { existingPath, within } from "../space/paths.js";
import { exactEditTool } from "./edit.js";

// Pi 的 write 和底座的 edit 在这条队列里读写同一个文件；空间宿主的插件写入也用它。
export { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

/** 空间根目录下第一层的 .repa；不区分大小写，大小写不敏感的文件系统上 .REPA 就是同一个目录。 */
function inDataDir(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  if (relative === "" || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return false;
  const [first] = relative.split(path.sep);
  return first?.toLowerCase() === ".repa";
}

/**
 * 文件工具的路径边界：空间根目录内；读取另允许 .repa/tool-output/。其余 .repa/ 是历史库、会话和插件数据，
 * 写进去也记不进历史，所以所有 Agent 的写入和编辑、插件 Agent 的全部文件工具都经过它。
 */
export class FileScope {
  private constructor(readonly root: string, private readonly realRoot: string) {}

  static async create(root: string): Promise<FileScope> {
    return new FileScope(root, await realpath(root));
  }

  private allowed(root: string, file: string, read: boolean): boolean {
    if (!within(root, file)) return false;
    if (!inDataDir(root, file)) return true;
    const [data, directory, ...rest] = path.relative(root, file).split(path.sep);
    return read && data?.toLowerCase() === ".repa" && directory === "tool-output" && rest.length > 0;
  }

  /** 字面路径和解析符号链接后的路径都要在范围内，链接不能把工具带出空间。 */
  async resolve(file: string, read = false): Promise<string> {
    const lexical = path.resolve(this.root, file);
    if (this.allowed(this.root, lexical, read)) {
      const canonical = await existingPath(lexical);
      if (this.allowed(this.realRoot, canonical, read)) return canonical;
    }
    throw new RepaFault("file_outside_space", `只能访问当前空间内的文件，不含 .repa/：${file}`, { path: file });
  }

  /**
   * 通用 Agent 写入的目标：字面路径和解析后的路径都在空间内时，经空间的写入路径记进历史；
   * 有一个在空间外（包括经符号链接出去的），就是空间外的写入，要先经用户确认。空间的 .repa/ 一律不写。
   */
  async writeTarget(file: string): Promise<{ inside: boolean; path: string }> {
    const lexical = path.resolve(this.root, file);
    const canonical = await existingPath(lexical);
    if (inDataDir(this.root, lexical) || inDataDir(this.realRoot, canonical)) {
      throw new RepaFault("file_in_data_dir", `不能写入空间的 .repa/，那里是历史库、会话和插件数据：${file}`, { path: file });
    }
    return { inside: within(this.root, lexical) && within(this.realRoot, canonical), path: canonical };
  }

  /** 用于已解析的路径：是否为空间根目录。 */
  isRoot(file: string): boolean {
    return file === this.realRoot;
  }

  /** 解析符号链接后的空间根目录，查找结果据此排除 .repa/。 */
  get resolvedRoot(): string {
    return this.realRoot;
  }
}

function digest(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** 这个会话读到过的文件内容，按解析后的路径记哈希。整文件写入前据此核对基线。 */
export class ReadState {
  private readonly known = new Map<string, string>();

  remember(file: string, content: Uint8Array | string): void {
    this.known.set(file, digest(content));
  }

  has(file: string): boolean {
    return this.known.has(file);
  }

  matches(file: string, content: Uint8Array | string): boolean {
    return this.known.get(file) === digest(content);
  }
}

/** 一个会话的文件工具共用：路径范围、空间的写入路径，以及这个会话的读取记录。 */
export interface FileTools {
  scope: FileScope;
  writes: SpaceWrites;
  reads: ReadState;
}

/** 空间外的写入取得用户同意；不同意时抛错，工具就不写。 */
export type ApproveOutside = (target: string, signal: AbortSignal | undefined) => Promise<void>;

// 写到空间外时附在工具结果后面：这次改动没有经过空间的写入路径，撤回找不到它。
const OUTSIDE_WRITE = "这个文件在空间外，这次改动没有进入历史，不能撤回。";

/**
 * 通用 Agent 的读取和搜索沿用 Pi 默认实现，读取另外记下读到的内容。写入和精确编辑在空间内照常记进历史；
 * 写空间外的文件和命令一样先经确认，写入不进历史；空间的 .repa/ 一律不写。
 */
export function generalFileTools(tools: FileTools, approve: ApproveOutside): ToolDefinition[] {
  return [recordingReadTool(tools), generalWriteTool(tools, approve), generalEditTool(tools, approve)];
}

/**
 * 插件 Agent 的内置文件工具，只生成定义中列出的那些；读写、列目录和查找都不出 scope。
 * 没有 grep：Pi 的 grep 把模型给的 glob 原样交给 ripgrep，会越过 .repa/.ignore，插件宿主在打开时就拒绝它。
 */
export function spaceFileTools(tools: FileTools, names: readonly string[]): ToolDefinition[] {
  const { scope } = tools;
  const factories: Record<string, () => ToolDefinition> = {
    read: () => readTool(tools),
    write: () => writeTool(tools),
    edit: () => editTool(tools),
    ls: () => lsTool(scope),
    find: () => findTool(scope),
  };
  return names.flatMap(name => {
    const factory = factories[name];
    return factory ? [factory()] : [];
  });
}

/** 磁盘上现在的内容；文件不存在时为 undefined。 */
async function currentContent(file: string): Promise<Buffer | undefined> {
  try {
    return await readFile(file);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * 写入被拒时交给模型的说明，附上文件现在的内容。只报错不给内容，模型会反复重试同一次写入；
 * 有了内容，它可以直接据此重新决定，这份内容也算这个会话读过。
 */
function staleFile(tools: FileTools, file: string, current: Buffer | undefined, reason: string): Error {
  const root = tools.scope.resolvedRoot;
  const shown = within(root, file) ? path.relative(root, file).split(path.sep).join("/") : file;
  if (current === undefined) return new Error(`没有写入：${shown} ${reason}，现在已经不存在。`);
  tools.reads.remember(file, current);
  const text = truncateHead(current.toString("utf8"));
  const rest = text.truncated ? `\n\n[只附上了前 ${text.outputLines} 行，共 ${text.totalLines} 行；用 read 的 offset 继续读取]` : "";
  return new Error(`没有写入：${shown} ${reason}。下面是它现在的内容，请据此重新决定怎样修改：\n\n${text.content}${rest}`);
}

/**
 * 写入工具的整次调用先等空间写锁：带命令行的运行持有它时等它结束，等待中取消就不再执行。
 * 这一步在 Pi 拿同一文件的写入队列之前，加锁次序与空间宿主一致。
 */
function locked(tools: FileTools, tool: ToolDefinition): ToolDefinition {
  return defineTool({
    ...tool,
    execute: (callId, input, signal, onUpdate, ctx) => tools.writes.lock(() => tool.execute(callId, input, signal, onUpdate, ctx), signal),
  });
}

/** 整文件覆盖的基线：已有的文件要和这个会话上一次读到的内容一致；没读过的新文件可以直接写。 */
async function checkBaseline(tools: FileTools, target: string): Promise<void> {
  const { reads } = tools;
  const current = await currentContent(target);
  if (current !== undefined && !reads.matches(target, current)) {
    throw staleFile(tools, target, current, reads.has(target) ? "在这次会话上次读取之后被改过" : "已经存在，这次会话还没有读过它");
  }
}

/** 空间内的整文件写入：经过空间的写入路径，只提交这个文件；基线核对在历史队列里做。 */
async function writeInside(tools: FileTools, target: string, content: string): Promise<void> {
  await tools.writes.commit(target, async () => {
    await checkBaseline(tools, target);
    await writeFile(target, content, "utf8");
  });
  tools.reads.remember(target, content);
}

/** 写回精确编辑的结果：before 是编辑时读到的原始字节，写入前核对磁盘上仍是它。 */
async function writeEdited(tools: FileTools, file: string, before: Buffer, after: string): Promise<void> {
  const current = await currentContent(file);
  if (current === undefined || !current.equals(before)) throw staleFile(tools, file, current, "在这次编辑读取之后、写回之前被改过");
  await writeFile(file, after, "utf8");
}

/** 编辑写回之后更新读取记录，返回编辑是否叠在这个会话没看过的改动上。 */
function rememberEdit(tools: FileTools, file: string, before: Buffer, after: string): { unseen: boolean } {
  const { reads } = tools;
  // 编辑前会话看到的就是 before，编辑后的全文它也知道；否则文件里还有它没看过的改动，之后整份覆盖仍要核对。
  const seen = reads.matches(file, before);
  if (seen) reads.remember(file, after);
  // 会话读过这个文件、这次读到的却不是它上次看到的内容，结果里提示模型；没读过的文件谈不上"自上次读取后"。
  return { unseen: !seen && reads.has(file) };
}

/**
 * Pi 的 write，写入经过空间的写入路径，只提交这个文件。整文件覆盖要求这个会话上一次读到的内容与磁盘一致，
 * 核对在历史队列里做；没读过的新文件可以直接写。
 */
function writeTool(tools: FileTools): ToolDefinition {
  const { scope } = tools;
  return locked(tools, defineTool(createWriteToolDefinition(scope.root, {
    operations: {
      async mkdir(directory) {
        await mkdir(await scope.resolve(directory), { recursive: true });
      },
      async writeFile(file, content) {
        await writeInside(tools, await scope.resolve(file), content);
      },
    },
  })));
}

/**
 * 精确编辑：在同一文件的写入队列里读到最新内容后应用；写回前在历史队列里核对磁盘仍是读到的内容。
 * 应用在别人改过的内容上时，结果里提示模型文件还有其他改动。
 */
function editTool(tools: FileTools): ToolDefinition {
  const { scope, writes } = tools;
  return locked(tools, exactEditTool(scope.root, {
    resolve: file => scope.resolve(file),
    read: file => readFile(file),
    async write(file, before, after) {
      await writes.commit(file, () => writeEdited(tools, file, before, after));
      return rememberEdit(tools, file, before, after);
    },
  }));
}

/** 写到空间外的工具结果：原来的文字后面注明不能撤回。 */
function noteOutside<T extends { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] }>(result: T): T {
  const text = result.content.flatMap(part => part.type === "text" ? [part.text] : []).join("");
  return { ...result, content: [{ type: "text" as const, text: `${text}\n${OUTSIDE_WRITE}` }, ...result.content.filter(part => part.type !== "text")] };
}

/**
 * 通用 Agent 的 write：空间内的照 writeTool 记进历史。空间外的先核对基线，免得用户同意之后才发现写不了；
 * 再经确认，建父目录、直接写入，结果里注明不能撤回。Pi 先建父目录再写文件，所以空间外的父目录等确认之后才建。
 * 确认期间文件可能又被改过，写之前再核对一次基线。
 */
function generalWriteTool(tools: FileTools, approve: ApproveOutside): ToolDefinition {
  const { scope } = tools;
  // 每次调用一份定义：空间外的写入要用这次调用的取消信号，并记下有没有写到空间外。
  const definition = (signal: AbortSignal | undefined, outside: { wrote: boolean }) => createWriteToolDefinition(scope.root, {
    operations: {
      async mkdir(directory) {
        const target = await scope.writeTarget(directory);
        if (target.inside) await mkdir(target.path, { recursive: true });
      },
      async writeFile(file, content) {
        const target = await scope.writeTarget(file);
        if (target.inside) {
          await writeInside(tools, target.path, content);
          return;
        }
        await checkBaseline(tools, target.path);
        await approve(target.path, signal);
        await mkdir(path.dirname(target.path), { recursive: true });
        await checkBaseline(tools, target.path);
        await writeFile(target.path, content, "utf8");
        tools.reads.remember(target.path, content);
        outside.wrote = true;
      },
    },
  });
  return locked(tools, defineTool({
    ...definition(undefined, { wrote: false }),
    async execute(callId, input, signal, onUpdate, ctx) {
      const outside = { wrote: false };
      const result = await defineTool(definition(signal, outside)).execute(callId, input, signal, onUpdate, ctx);
      return outside.wrote ? noteOutside(result) : result;
    },
  }));
}

/**
 * 通用 Agent 的精确编辑：空间内的照 editTool 记进历史。空间外的在文件队列里算好结果再经确认，
 * 锚文本不在时就不必问；写回前核对磁盘仍是编辑时读到的内容，结果里注明不能撤回。
 */
function generalEditTool(tools: FileTools, approve: ApproveOutside): ToolDefinition {
  const { scope, writes } = tools;
  const definition = (signal: AbortSignal | undefined, outside: { target: boolean; wrote: boolean }) => exactEditTool(scope.root, {
    async resolve(file) {
      const target = await scope.writeTarget(file);
      outside.target = !target.inside;
      return target.path;
    },
    read: file => readFile(file),
    async write(file, before, after) {
      if (!outside.target) {
        await writes.commit(file, () => writeEdited(tools, file, before, after));
        return rememberEdit(tools, file, before, after);
      }
      await approve(file, signal);
      await writeEdited(tools, file, before, after);
      outside.wrote = true;
      return rememberEdit(tools, file, before, after);
    },
  });
  return locked(tools, defineTool({
    ...definition(undefined, { target: false, wrote: false }),
    async execute(callId, input, signal, onUpdate, ctx) {
      const outside = { target: false, wrote: false };
      const result = await definition(signal, outside).execute(callId, input, signal, onUpdate, ctx);
      return outside.wrote ? noteOutside(result) : result;
    },
  }));
}

/** 插件 Agent 的读取只在空间内，读到的内容记进这个会话的读取记录。 */
function readTool(tools: FileTools): ToolDefinition {
  const { scope, reads } = tools;
  return defineTool(createReadToolDefinition(scope.root, {
    operations: {
      access: async file => access(await scope.resolve(file, true), constants.R_OK),
      async readFile(file) {
        const target = await scope.resolve(file, true);
        const content = await readFile(target);
        reads.remember(target, content);
        return content;
      },
      detectImageMimeType: async file => detectSupportedImageMimeTypeFromFile(await scope.resolve(file, true)),
    },
  }));
}

/** 通用 Agent 的读取：与 Pi 的默认实现相同，不限路径，只是记下读到的内容。 */
function recordingReadTool(tools: FileTools): ToolDefinition {
  const { scope, reads } = tools;
  return defineTool(createReadToolDefinition(scope.root, {
    operations: {
      access: file => access(file, constants.R_OK),
      async readFile(file) {
        const content = await readFile(file);
        reads.remember(await existingPath(file), content);
        return content;
      },
      detectImageMimeType: file => detectSupportedImageMimeTypeFromFile(file),
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

// 与 Pi 的 find 默认上限一致。
const FIND_LIMIT = 1000;

/**
 * 插件 Agent 的 find 沿用 Pi 的工具定义，查找本身注入 Node 内置的 fs.glob，学习者的电脑不必下载 fd。
 * 写法沿用 Pi 调用 fd 时的约定：不含 / 的 pattern 匹配任意一层的名字，含 / 的从任意一层开始匹配路径。
 * 和 fd 的差别：不读 .gitignore；以点开头的名字只有 pattern 写出这个点时才匹配；不列出符号链接。
 */
function findTool(scope: FileScope): ToolDefinition {
  const builtin = createFindToolDefinition(scope.root, {
    operations: {
      // 搜索起点先经过范围检查；空间外和 .repa/ 的起点在这里报错。
      exists: file => exists(scope, file),
      glob: (pattern, directory, options) => findFiles(scope, pattern, directory, options.limit),
    },
  });
  return defineTool({
    ...builtin,
    description: `按 glob pattern 在当前空间里查找文件，返回相对搜索目录的路径。不含 / 的 pattern 匹配任意一层的名字，例如 *.md；含 / 的从任意一层开始匹配路径，例如 lessons/*.md。不读 .gitignore，不进入 .repa、.git、node_modules，不列出符号链接；以点开头的名字只有 pattern 写出这个点时才匹配。默认最多返回 ${FIND_LIMIT} 个结果，输出最多 ${DEFAULT_MAX_BYTES / 1024}KB。`,
  });
}

/** 把模型给的 pattern 换成相对搜索目录、从任意一层开始匹配的写法；不能用 .. 或绝对路径离开搜索目录。 */
function searchPattern(pattern: string, directory: string): string {
  const relative = pattern.replace(/^(\.\/)+/u, "");
  if (path.isAbsolute(relative)) {
    // 绝对路径的 pattern 按 fd 的习惯只匹配这个位置，换成相对搜索目录的写法后不再加 **/。
    const inside = path.relative(directory, relative);
    if (inside === "" || inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
      throw new Error(`pattern 只能匹配搜索目录之内的路径：${pattern}`);
    }
    return inside.split(path.sep).join("/");
  }
  if (relative.split("/").includes("..")) throw new Error(`pattern 不能用 .. 离开搜索目录：${pattern}`);
  return relative === "**" || relative.startsWith("**/") ? relative : `**/${relative}`;
}

/** 搜索目录以下的 .git、node_modules，以及空间根目录下第一层的 .repa。 */
function hidden(root: string, directory: string, file: string): boolean {
  const below = path.relative(directory, file).split(path.sep);
  return inDataDir(root, file) || below.some(part => part === ".git" || part === "node_modules");
}

/**
 * fs.glob 只在展开 ** 时经过 exclude；字面写出的目录不经过它，例如 .repa/*、经符号链接的 linked/*。
 * 所以 exclude 只用来少走弯路，每个结果还要再查一遍：不是符号链接，所在目录经解析后仍是原路径，不在排除的目录里。
 */
async function findFiles(scope: FileScope, pattern: string, input: string, limit: number): Promise<string[]> {
  const directory = await scope.resolve(input);
  const root = scope.resolvedRoot;
  const parents = new Map<string, boolean>();
  const excluded = (entry: Dirent) => entry.isSymbolicLink() || hidden(root, directory, path.join(entry.parentPath, entry.name));
  const results: string[] = [];
  for await (const entry of glob(searchPattern(pattern, directory), { cwd: directory, withFileTypes: true, exclude: excluded })) {
    const file = path.join(entry.parentPath, entry.name);
    if (file === directory || excluded(entry)) continue;
    let reachable = parents.get(entry.parentPath);
    if (reachable === undefined) {
      // 所在目录经解析后变了，说明中途经过了符号链接，可能已经离开空间。
      reachable = within(directory, entry.parentPath) && await realpath(entry.parentPath) === entry.parentPath;
      parents.set(entry.parentPath, reachable);
    }
    if (!reachable) continue;
    results.push(path.relative(directory, file).split(path.sep).join("/"));
    if (results.length >= limit) break;
  }
  return results.sort();
}
