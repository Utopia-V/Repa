import { closeSync, constants, fstatSync, openSync, readSync, writeSync, type Dirent } from "node:fs";
import { mkdir, open, readdir, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";

import type { BackupManifest } from "../schema.js";
import { syncDirectory } from "../storage.js";

/** 复制一个文件的取法：原样、只到最后一个换行符，或会话文件在一段同步代码里只到最后一个换行符。 */
export type CopyMode = "plain" | "lines" | "session";

/** 一次复制收下的文件，以及新写出、复制完成后要统一落盘的文件与目录。 */
export interface Copying {
  files: BackupManifest["files"];
  written: { files: string[]; directories: Set<string> };
}

// 每次读写的块大小：复制按块进行，内存占用不随文件大小增长。
const CHUNK = 256 * 1024;
// 找最后一个换行符时从文件末尾往前读的块大小；完整的日志以换行结尾，通常读一块就找到。
const TAIL = 4 * 1024;
// Windows 没有 O_NOFOLLOW；那里的符号链接与目录联接已在遍历时按目录项类型跳过。
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

// 复制是备份与恢复的昂贵边界：在唯一的复制处计数，测试据此断言每个文件只复制一次、复制的字节数等于所收文件大小之和，
// 每次读写不超过一块。
const copies = new Map<string, number>();
let copiedBytes = 0;
let largestRead = 0;

/** 本进程至今复制的文件（按来源路径计次）、写出的字节数和单次读取的最大字节数。 */
export function copyStats(): { files: Map<string, number>; bytes: number; largestRead: number } {
  return { files: new Map(copies), bytes: copiedBytes, largestRead };
}

function counted(source: string, bytes: number): void {
  copies.set(source, (copies.get(source) ?? 0) + 1);
  copiedBytes += bytes;
}

/** 错误是否带着这些 Node 错误码之一。 */
export function isCode(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string" && codes.includes(error.code);
}

/** 新的空复制记录；base 是复制的目标目录，最后同步它自己的目录项。 */
export function copying(base: string): Copying {
  return { files: [], written: { files: [], directories: new Set([base]) } };
}

async function readAt(input: FileHandle, buffer: Buffer, length: number, position: number): Promise<number> {
  largestRead = Math.max(largestRead, length);
  return (await input.read(buffer, 0, length, position)).bytesRead;
}

function readAtSync(input: number, buffer: Buffer, length: number, position: number): number {
  largestRead = Math.max(largestRead, length);
  return readSync(input, buffer, 0, length, position);
}

async function lineEnd(input: FileHandle, size: number): Promise<number> {
  const buffer = Buffer.allocUnsafe(TAIL);
  for (let end = size; end > 0;) {
    const start = Math.max(0, end - TAIL);
    const index = buffer.subarray(0, await readAt(input, buffer, end - start, start)).lastIndexOf(0x0a);
    if (index >= 0) return start + index + 1;
    end = start;
  }
  return 0;
}

function lineEndSync(input: number, size: number): number {
  const buffer = Buffer.allocUnsafe(TAIL);
  for (let end = size; end > 0;) {
    const start = Math.max(0, end - TAIL);
    const index = buffer.subarray(0, readAtSync(input, buffer, end - start, start)).lastIndexOf(0x0a);
    if (index >= 0) return start + index + 1;
    end = start;
  }
  return 0;
}

/**
 * 把 source 按块复制为新文件 target，返回复制时来源的大小与修改时间。lines 为真时只复制到最后一个换行符为止，
 * 正在追加的半行不收；按行追加的日志以完整行结尾的任何前缀都能读。
 */
async function copyFile(source: string, target: string, lines: boolean): Promise<{ size: number; mtimeMs: number }> {
  const input = await open(source, constants.O_RDONLY | NOFOLLOW);
  try {
    const info = await input.stat();
    if (!info.isFile()) throw new Error(`复制的来源不是普通文件：${source}`);
    const end = lines ? await lineEnd(input, info.size) : info.size;
    const output = await open(target, "wx", 0o600);
    try {
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(end, 1)));
      for (let offset = 0; offset < end;) {
        const read = await readAt(input, buffer, Math.min(buffer.length, end - offset), offset);
        if (read === 0) throw new Error(`复制时来源变短了：${source}`);
        for (let written = 0; written < read;) written += (await output.write(buffer, written, read - written)).bytesWritten;
        offset += read;
      }
    } finally {
      await output.close();
    }
    counted(source, end);
    return { size: info.size, mtimeMs: info.mtimeMs };
  } finally {
    await input.close();
  }
}

/**
 * 会话文件的复制。Pi 在主线程上同步写会话：平时按行追加，新建会话、迁移旧版本和分支时整体重写。
 * 这里从打开到读完都在同一段同步代码里，整体重写不会与之交错；同样只复制到最后一个换行符。
 */
function copySession(source: string, target: string): { size: number; mtimeMs: number } {
  const input = openSync(source, constants.O_RDONLY | NOFOLLOW);
  try {
    const info = fstatSync(input);
    if (!info.isFile()) throw new Error(`复制的来源不是普通文件：${source}`);
    const end = lineEndSync(input, info.size);
    const output = openSync(target, "wx", 0o600);
    try {
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(end, 1)));
      for (let offset = 0; offset < end;) {
        const read = readAtSync(input, buffer, Math.min(buffer.length, end - offset), offset);
        if (read === 0) throw new Error(`复制时来源变短了：${source}`);
        for (let written = 0; written < read;) written += writeSync(output, buffer, written, read - written);
        offset += read;
      }
    } finally {
      closeSync(output);
    }
    counted(source, end);
    return { size: info.size, mtimeMs: info.mtimeMs };
  } finally {
    closeSync(input);
  }
}

/**
 * 遍历目录树，只进入真实目录、只交出普通文件；符号链接、目录联接和特殊文件不跟随也不收，空间外的文件不会被带进来。
 * 路径相对于起点，用 / 分隔；skip 为真的条目连同其下内容都不进入。遍历中途消失的目录按空目录处理。
 */
export async function* walk(directory: string, skip: (relative: string) => boolean, relative = ""): AsyncGenerator<{ relative: string; directory: boolean }> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (relative !== "" && isCode(error, "ENOENT")) return;
    throw error;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (skip(child)) continue;
    if (entry.isDirectory()) {
      yield { relative: child, directory: true };
      yield* walk(path.join(directory, entry.name), skip, child);
    } else if (entry.isFile()) {
      yield { relative: child, directory: false };
    }
  }
}

/**
 * 把 source 下 skip 之外的目录与文件复制到 target 下（target 已存在），按 mode 取每个文件。
 * 收下的文件记入 copying.files，路径相对于 source；写出的文件和目录记入 copying.written，复制完成后由 syncCopies 落盘。
 */
export async function copyTree(
  source: string,
  target: string,
  skip: (relative: string) => boolean,
  mode: (relative: string) => CopyMode,
  result: Copying,
): Promise<void> {
  for await (const item of walk(source, skip)) {
    const parts = item.relative.split("/");
    const destination = path.join(target, ...parts);
    if (item.directory) {
      await mkdir(destination, { recursive: true });
      result.written.directories.add(destination);
      continue;
    }
    const from = path.join(source, ...parts);
    const how = mode(item.relative);
    const copied = how === "session" ? copySession(from, destination) : await copyFile(from, destination, how === "lines");
    result.written.files.push(destination);
    result.files.push({ path: item.relative, ...copied });
  }
}

/**
 * 把复制写出的文件和目录落盘：先逐个同步文件，再从深到浅同步目录。放在复制之后统一做，
 * 复制历史库时占着历史队列的时间就只是复制本身。
 */
export async function syncCopies(result: Copying): Promise<void> {
  for (const file of result.written.files) {
    // Windows 上刷新文件需要写权限。
    const handle = await open(file, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  for (const directory of [...result.written.directories].reverse()) await syncDirectory(directory);
}

/**
 * 改名，用于发布备份和换入换出 .repa/ 的内容。Windows 上杀毒软件或索引服务扫描刚写好的文件时，
 * 改名可能暂时以 EPERM、EBUSY 或 EACCES 失败；与 rm 的 maxRetries 一样稍候重试，最多十次。
 */
export async function move(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (attempt >= 10 || !isCode(error, "EPERM", "EBUSY", "EACCES")) throw error;
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
  }
}

/** 删除文件或目录树，不存在也算完成；被占用时按 rm 的 maxRetries 稍候重试。 */
export function remove(target: string): Promise<void> {
  return rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
