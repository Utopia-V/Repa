import { closeSync, constants, fstatSync, openSync, readSync, writeSync, type Dirent } from "node:fs";
import { link, lstat, mkdir, open, readdir, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";

import type { BackupManifest } from "../schema.js";
import { move, syncDirectory } from "../storage.js";

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
// 每次读写不超过一块。从上一份备份链接过来的文件另记，不算复制。落盘同样在唯一的同步处记下路径，测试据此核对发布之前写出的内容都已同步。
const copies = new Map<string, number>();
const links = new Map<string, number>();
const synced = new Map<string, number>();
let copiedBytes = 0;
let largestRead = 0;

/**
 * 本进程至今复制的文件（按来源路径计次）、写出的字节数、单次读取的最大字节数、链接而没有复制的文件（按来源路径计次），
 * 以及同步过的文件与目录（按路径计次）。
 */
export function copyStats(): { files: Map<string, number>; bytes: number; largestRead: number; linked: Map<string, number>; synced: Map<string, number> } {
  return { files: new Map(copies), bytes: copiedBytes, largestRead, linked: new Map(links), synced: new Map(synced) };
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

/** 遍历的范围：skip 为真的条目连同其下内容都不进入，路径相对于起点、用 / 分隔；vanished 决定中途消失的子目录怎么处理。 */
export interface WalkOptions {
  skip(relative: string): boolean;
  /**
   * 活动空间备份时取 skip，按空目录处理：历史库在队列之外列出时，Git 维护可能正在删除对象目录。
   * 从备份恢复时取 fail，报错：来源消失说明这份备份正被删除，复制出的内容不完整，不能发布。
   */
  vanished: "skip" | "fail";
  /** 遇到符号链接、目录联接或特殊文件时调用，可以抛错中止遍历；省略时跳过它们。 */
  other?(relative: string): void;
}

/**
 * 遍历目录树，只进入真实目录、只交出普通文件；符号链接、目录联接和特殊文件不跟随也不收，空间外的文件不会被带进来，
 * 给了 options.other 时交它处理。
 * 起点本身不存在时总是报错。
 */
export async function* walk(directory: string, options: WalkOptions, relative = ""): AsyncGenerator<{ relative: string; directory: boolean }> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (relative !== "" && options.vanished === "skip" && isCode(error, "ENOENT")) return;
    throw error;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (options.skip(child)) continue;
    if (entry.isDirectory()) {
      yield { relative: child, directory: true };
      yield* walk(path.join(directory, entry.name), options, child);
    } else if (entry.isFile()) {
      yield { relative: child, directory: false };
    } else {
      options.other?.(child);
    }
  }
}

/**
 * 不复制，把 earlier 硬链接为 target：earlier 是普通文件且与来源此刻一样大时才链接。返回来源此刻的大小与修改时间；
 * 不链接或链接以任何原因失败（文件系统不支持、earlier 恰好被删、链接数到上限）时返回 undefined，由调用方照旧复制。
 * 只用于名字由内容决定、写出以后不再改写的文件，大小相同即内容相同；earlier 属于一份已经整体落盘的备份，不必再同步。
 */
async function linkFile(source: string, earlier: string, target: string): Promise<{ size: number; mtimeMs: number } | undefined> {
  try {
    const [from, previous] = await Promise.all([lstat(source), lstat(earlier)]);
    if (!from.isFile() || !previous.isFile() || previous.size !== from.size) return undefined;
    await link(earlier, target);
    links.set(source, (links.get(source) ?? 0) + 1);
    return { size: from.size, mtimeMs: from.mtimeMs };
  } catch {
    return undefined;
  }
}

/**
 * 把 source 下的目录与文件复制到 target 下（target 已存在），范围见 WalkOptions，按 mode 取每个文件；来源中的文件消失时报错。
 * earlier 对一个文件给出另一份备份里同一文件的路径时，先试着链接它，见 linkFile；没给或链接不成就复制。
 * 收下的文件记入 result.files，路径相对于 source；复制写出的文件和新建的目录记入 result.written，复制完成后由 syncCopies 落盘，
 * 链接来的文件不在其中：它不是这次写出的，落盘时也不以可写方式打开它。
 */
export async function copyTree(
  source: string,
  target: string,
  options: WalkOptions & { mode(relative: string): CopyMode; earlier?(relative: string): string | undefined },
  result: Copying,
): Promise<void> {
  for await (const item of walk(source, options)) {
    const parts = item.relative.split("/");
    const destination = path.join(target, ...parts);
    if (item.directory) {
      await mkdir(destination, { recursive: true });
      result.written.directories.add(destination);
      continue;
    }
    const from = path.join(source, ...parts);
    const earlier = options.earlier?.(item.relative);
    const linked = earlier === undefined ? undefined : await linkFile(from, earlier, destination);
    if (linked !== undefined) {
      result.files.push({ path: item.relative, ...linked });
      continue;
    }
    const how = options.mode(item.relative);
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
    synced.set(file, (synced.get(file) ?? 0) + 1);
  }
  for (const directory of [...result.written.directories].reverse()) await syncEntries(directory);
}

/**
 * 把一棵已经写好的目录树落盘，次序与 syncCopies 相同：先逐个同步文件，再从深到浅同步目录，最后是 root 本身。
 * 之后把 root 改名发布、或写下引用它的记录，掉电以后它下面的文件也都在。
 */
export async function syncTree(root: string): Promise<void> {
  const result = copying(root);
  for await (const item of walk(root, { skip: () => false, vanished: "fail" })) {
    const absolute = path.join(root, ...item.relative.split("/"));
    if (item.directory) result.written.directories.add(absolute);
    else result.written.files.push(absolute);
  }
  await syncCopies(result);
}

/** 同步一个目录的目录项，并记下路径。 */
export async function syncEntries(directory: string): Promise<void> {
  await syncDirectory(directory);
  synced.set(directory, (synced.get(directory) ?? 0) + 1);
}

/**
 * 发布已落盘的临时目录：改名为 to，再同步 to 所在的目录。改名使它在运行时原子地出现，
 * 同步目录项使它在掉电以后仍在；只改名的话，之后写下的、引用它的记录可能比它先落盘。
 */
export async function publish(from: string, to: string): Promise<void> {
  await move(from, to);
  await syncEntries(path.dirname(to));
}

/** 删除文件或目录树，不存在也算完成；被占用时按 rm 的 maxRetries 稍候重试。 */
export function remove(target: string): Promise<void> {
  return rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
