// 插件 Agent 在空间内遍历与搜索文件。本模块同时是 grep 搜索线程的入口：线程里不经过 tsx，
// 源码靠 Node 自带的类型擦除加载，所以这里只用可擦除的类型写法，只引用 Node 内置模块。
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";

export interface WalkEntry {
  path: string;
  directory: boolean;
}

/** 主线程交给搜索线程的任务；起点已经过文件范围检查。 */
export interface GrepJob {
  /** 解析后的空间根目录，用于排除 .repa/。 */
  root: string;
  target: string;
  directory: boolean;
  source: string;
  flags: string;
  glob?: string;
  limit: number;
  context: number;
}

export interface GrepLine {
  file: string;
  line: number;
  text: string;
  match: boolean;
}

export interface GrepOutcome {
  lines: GrepLine[];
  matches: number;
}

const FILE_BYTES = 10 * 1024 * 1024;
// 主线程按 Pi 的规则截断到 500 字符；多传一些，是否截断的判断不变。
const LINE_CHARS = 1024;

/** 空间根目录下第一层的 .repa；不区分大小写，大小写不敏感的文件系统上 .REPA 就是同一个目录。 */
export function inDataDir(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  if (relative === "" || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return false;
  const [first] = relative.split(path.sep);
  return first?.toLowerCase() === ".repa";
}

export function posixPath(file: string): string {
  return file.split(path.sep).join("/");
}

/** 从已检查的目录向下遍历：跳过 excluded 为真的路径、.git 和 node_modules，不跟随符号链接。 */
export async function* walk(directory: string, excluded: (file: string) => boolean): AsyncGenerator<WalkEntry> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.name === ".git" || entry.name === "node_modules" || excluded(file)) continue;
    if (entry.isDirectory()) {
      yield { path: file, directory: true };
      yield* walk(file, excluded);
    } else if (entry.isFile()) {
      yield { path: file, directory: false };
    }
  }
}

/** 沿用 ripgrep 的 glob 写法：不含 / 的模式匹配文件名，! 开头表示排除。 */
function globMatches(glob: string, relative: string): boolean {
  const excluded = glob.startsWith("!");
  const pattern = excluded ? glob.slice(1) : glob;
  const matched = path.matchesGlob(pattern.includes("/") ? relative : path.posix.basename(relative), pattern);
  return excluded ? !matched : matched;
}

/** 与 ripgrep 遍历目录时一致，跳过二进制文件；过大的文件也不整份读入内存。 */
async function searchableText(file: string): Promise<string | undefined> {
  if ((await stat(file)).size > FILE_BYTES) return undefined;
  const content = await readFile(file);
  if (content.subarray(0, 8000).includes(0)) return undefined;
  return content.toString("utf8");
}

async function* only(file: string): AsyncGenerator<WalkEntry> {
  yield { path: file, directory: false };
}

async function search(job: GrepJob): Promise<GrepOutcome> {
  const expression = new RegExp(job.source, job.flags);
  const lines: GrepLine[] = [];
  let matches = 0;
  const entries = job.directory ? walk(job.target, file => inDataDir(job.root, file)) : only(job.target);
  for await (const entry of entries) {
    if (entry.directory) continue;
    const file = job.directory ? posixPath(path.relative(job.target, entry.path)) : path.basename(entry.path);
    if (job.glob !== undefined && !globMatches(job.glob, file)) continue;
    const text = await searchableText(entry.path);
    if (text === undefined) continue;
    const content = text.replace(/\r\n?/g, "\n").split("\n");
    for (let index = 0; index < content.length && matches < job.limit; index++) {
      if (!expression.test(content[index] ?? "")) continue;
      matches++;
      const last = Math.min(content.length - 1, index + job.context);
      for (let line = Math.max(0, index - job.context); line <= last; line++) {
        lines.push({ file, line: line + 1, text: (content[line] ?? "").slice(0, LINE_CHARS), match: line === index });
      }
    }
    if (matches >= job.limit) break;
  }
  return { lines, matches };
}

/** 线程数据带上这个键才执行搜索；其他线程导入本模块只取遍历函数。 */
export const GREP_THREAD = "repaGrep";

const data: unknown = workerData;
if (!isMainThread && parentPort !== null && data !== null && typeof data === "object" && GREP_THREAD in data) {
  // 线程数据由 files.ts 按 GrepJob 构造。
  parentPort.postMessage(await search((data as Record<typeof GREP_THREAD, GrepJob>)[GREP_THREAD]));
}
