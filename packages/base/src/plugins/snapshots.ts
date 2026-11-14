import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";

import { copying, copyTree, isCode, publish, remove, syncCopies, syncEntries, walk } from "../backup/copy.js";
import { RepaFault } from "../schema.js";
import { spaceKey } from "../space/paths.js";
import type { PluginEnablement } from "./enablement.js";

/**
 * 插件文件夹的上限，是 Repa 的假设：防的是 Agent 把依赖或数据堆进插件文件夹，使每次批准都复制大量内容，
 * 每次打开空间核对快照也要读一遍。files 计文件与目录的总数，空目录不进摘要，但同样要遍历。实际使用嫌小时再调。
 */
export const SNAPSHOT_LIMITS = { bytes: 16 * 1024 * 1024, files: 2000 } as const;

/** 摘要算法的版本，写在摘要输入的第一行；算法一变，已有的快照都按“已改动”处理，需要重新批准。 */
const ALGORITHM = "repa-plugin-folder 1";
const DIGEST = /^[0-9a-f]{64}$/;
const ID = /^[a-z][a-z0-9-]*$/;
// 暂存目录以点开头，与插件 id 不会重名。
const STAGING = ".staging";
const CHUNK = 256 * 1024;
// Windows 没有 O_NOFOLLOW；那里的符号链接与目录联接已在遍历时按目录项类型拒绝。
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** 应用配置目录中宿主保管自写插件的目录。Agent 的文件工具在任何模式下都不写它。 */
export function pluginsDirectory(home: string): string {
  return path.join(home, "plugins");
}

/** 一个空间的快照与暂存所在的目录，与备份一样按空间根目录的真实路径分组。 */
export function snapshotGroup(home: string, root: string): string {
  return path.join(pluginsDirectory(home), spaceKey(root));
}

/** 一个插件某个版本的快照目录：`<配置目录>/plugins/<空间键>/<id>/<摘要>/`。存在且核对通过，就是本机为这个空间批准过这个版本。 */
export function snapshotDirectory(home: string, root: string, id: string, digest: string): string {
  if (!ID.test(id)) throw new RepaFault("invalid_plugin_id", "插件 id 格式不正确", { id });
  if (!DIGEST.test(digest)) throw new RepaFault("invalid_plugin_digest", "插件摘要格式不正确", { digest });
  return path.join(snapshotGroup(home, root), id, digest);
}

function rejectOther(relative: string): never {
  throw new RepaFault("invalid_plugin_folder", `插件文件夹里只能有普通文件和目录，${relative} 是符号链接、目录联接或特殊文件`, { path: relative });
}

function tooLarge(files: number, bytes: number): RepaFault {
  return new RepaFault(
    "plugin_folder_too_large",
    `插件文件夹超过上限：最多 ${SNAPSHOT_LIMITS.files} 个文件、共 ${SNAPSHOT_LIMITS.bytes / 1024 / 1024} MiB。依赖和数据不放在插件文件夹里`,
    { files, bytes },
  );
}

/** 文件夹里全部普通文件的相对路径，以 / 分隔；遇到符号链接等即拒绝，文件与目录的总数超过上限即停止。 */
async function folderFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  let entries = 0;
  for await (const item of walk(directory, { skip: () => false, vanished: "fail", other: rejectOther })) {
    if (++entries > SNAPSHOT_LIMITS.files) throw tooLarge(entries, 0);
    if (!item.directory) files.push(item.relative);
  }
  return files;
}

/**
 * 从配置目录往下到 target 的各层（plugins/、空间分组、<id>/、<摘要>/ 等）中最上面的符号链接或目录联接；没有时为 undefined。
 * 这几层都由宿主建立，不该是链接。遍历只拒绝起点以下的链接，起点本身或它的上级是链接时，读到的是链接指向的、
 * 可以被文件工具改写的文件，核对照样通过，所以单独检查；删除时也只删链接本身，不进入它指向的目录。
 */
async function linkAbove(home: string, target: string): Promise<string | undefined> {
  let current = home;
  for (const part of path.relative(home, target).split(path.sep)) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) return current;
    } catch (error) {
      if (isCode(error, "ENOENT", "ENOTDIR")) return undefined;
      throw error;
    }
  }
  return undefined;
}

/** 按块读出一个文件的 SHA-256 与字节数；读到的总字节超过 budget 即停止。 */
async function hashFile(file: string, budget: number): Promise<{ size: number; hash: string }> {
  const handle = await open(file, constants.O_RDONLY | NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new RepaFault("invalid_plugin_folder", "插件文件夹里只能有普通文件和目录", { path: file });
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK, size);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > budget) throw tooLarge(0, size);
      hash.update(buffer.subarray(0, bytesRead));
    }
    return { size, hash: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

/** 文件夹里每个普通文件的字节数与内容摘要，以 / 分隔的相对路径为键，按 UTF-8 字节序排列；超过上限即拒绝。 */
async function hashFiles(directory: string): Promise<Map<string, { size: number; hash: string }>> {
  const files = (await folderFiles(directory)).sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
  const hashes = new Map<string, { size: number; hash: string }>();
  let bytes = 0;
  for (const relative of files) {
    const file = await hashFile(path.join(directory, ...relative.split("/")), SNAPSHOT_LIMITS.bytes - bytes);
    bytes += file.size;
    hashes.set(relative, file);
  }
  return hashes;
}

/**
 * 插件文件夹的摘要：sha256("repa-plugin-folder 1\n" + Σ(路径 + "\0" + 字节长度 + "\0" + sha256(内容) + "\n"))，
 * 路径按 UTF-8 字节序排列，相对文件夹、以 / 分隔，取文件系统给出的名字原样，不做 Unicode 规范化。
 * 收全部普通文件，含点开头的文件，不含空目录；遇到符号链接、目录联接或特殊文件即拒绝，超过上限即拒绝。
 */
export async function folderDigest(directory: string): Promise<string> {
  const digest = createHash("sha256").update(`${ALGORITHM}\n`);
  for (const [relative, { size, hash }] of await hashFiles(directory)) digest.update(`${relative}\0${size}\0${hash}\n`, "utf8");
  return digest.digest("hex");
}

/**
 * 文件夹里每个普通文件的内容摘要，以 / 分隔的相对路径为键；限制与 folderDigest 相同。
 * 批准时用它比较暂存副本与记录里的当前版本，列出改动了哪些文件。
 */
export async function folderHashes(directory: string): Promise<Map<string, string>> {
  return new Map([...(await hashFiles(directory))].map(([relative, { hash }]) => [relative, hash]));
}

/** 复制之前先按目录列表量一遍来源，明显超限的文件夹不必复制；准确的上限由复制以后对副本算摘要时判断。 */
async function measure(source: string): Promise<void> {
  let bytes = 0;
  const files = await folderFiles(source);
  for (const relative of files) {
    bytes += (await lstat(path.join(source, ...relative.split("/")))).size;
    if (bytes > SNAPSHOT_LIMITS.bytes) throw tooLarge(files.length, bytes);
  }
}

/**
 * 建立目录；新建了哪几层，就同步它们各自的上级目录，新目录在掉电以后仍在。
 * 已经存在时什么也不做。
 */
async function ensureDirectory(directory: string): Promise<void> {
  const created = await mkdir(directory, { recursive: true });
  if (created === undefined) return;
  for (let current = directory; ; current = path.dirname(current)) {
    const parent = path.dirname(current);
    await syncEntries(parent);
    if (current === created || parent === current) return;
  }
}

/** 暂存好的一份插件文件夹：暂存目录和对它算出的摘要。 */
export interface StagedFolder {
  directory: string;
  digest: string;
}

/**
 * 把插件文件夹 source 当时的内容复制到这个空间的暂存目录，落盘后对副本算摘要。此后只读副本，不再读源文件夹。
 * 只收普通文件，遇到符号链接即拒绝，超过上限即拒绝。中途失败留下的副本不在这里删除，下次打开空间时随暂存目录一起清掉。
 */
export async function stageFolder(home: string, root: string, source: string): Promise<StagedFolder> {
  await measure(source);
  const staging = path.join(snapshotGroup(home, root), STAGING);
  await ensureDirectory(staging);
  const directory = path.join(staging, randomUUID());
  await mkdir(directory);
  const result = copying(directory);
  await copyTree(source, directory, { skip: () => false, vanished: "fail", other: rejectOther, mode: () => "plain" }, result);
  await syncCopies(result);
  return { directory, digest: await folderDigest(directory) };
}

/**
 * 把暂存副本发布为插件 id 的快照，返回快照目录。副本在暂存时已落盘；改名以后同步 `<id>/` 目录，
 * 新建 `<id>/` 时同步它的上级，与备份发布的顺序相同。
 * 同一摘要的快照已经存在且核对通过时直接用它，丢弃副本；已存在却被改动过时先删掉它（路径上有链接时只删链接），
 * 换成这份副本：内容与摘要相同，换上的正是批准过的内容。
 */
export async function publishSnapshot(home: string, root: string, id: string, staged: StagedFolder): Promise<string> {
  const target = snapshotDirectory(home, root, id, staged.digest);
  const status = await checkSnapshot(home, root, id, staged.digest);
  if (status === "ok") {
    await remove(staged.directory);
    return target;
  }
  if (status === "modified") await removeSnapshot(home, root, id, staged.digest);
  await ensureDirectory(path.dirname(target));
  await publish(staged.directory, target);
  return target;
}

/**
 * 核对插件 id 的 digest 版本的快照：ok；missing，快照不存在；modified，内容与摘要不符，出现了符号链接、超过了上限，
 * 或快照目录本身、它在配置目录里的某一层上级是符号链接。其余读取错误照常抛出，由调用方报告，不当作改动去删除。
 */
export async function checkSnapshot(home: string, root: string, id: string, digest: string): Promise<"ok" | "missing" | "modified"> {
  const directory = snapshotDirectory(home, root, id, digest);
  if ((await linkAbove(home, directory)) !== undefined) return "modified";
  try {
    if (!(await lstat(directory)).isDirectory()) return "modified";
  } catch (error) {
    if (isCode(error, "ENOENT", "ENOTDIR")) return "missing";
    throw error;
  }
  try {
    return (await folderDigest(directory)) === digest ? "ok" : "modified";
  } catch (error) {
    if (error instanceof RepaFault && (error.code === "invalid_plugin_folder" || error.code === "plugin_folder_too_large")) return "modified";
    throw error;
  }
}

/** 删除一份快照，用于核对不通过的快照；只在使用它的实例关闭以后调用。路径上有链接时只删最上面的链接本身。 */
export async function removeSnapshot(home: string, root: string, id: string, digest: string): Promise<void> {
  const directory = snapshotDirectory(home, root, id, digest);
  await remove((await linkAbove(home, directory)) ?? directory);
}

/** 删除这个空间全部的暂存副本。打开空间时调用：此前中途结束的复制和批准留下的副本不再有人使用。路径上有链接时只删链接。 */
export async function clearStaging(home: string, root: string): Promise<void> {
  const staging = path.join(snapshotGroup(home, root), STAGING);
  await remove((await linkAbove(home, staging)) ?? staging);
}

/**
 * 按启用记录保留快照：每个插件只留记录里的 digest 与 previous，其余版本删除；记录里没有的插件整个删除。
 * record 必须是从盘上读到的记录。调用时不能有实例在用将被删除的快照：打开空间时在插件打开之前调用。
 */
export async function cleanSnapshots(home: string, root: string, record: PluginEnablement): Promise<void> {
  const group = snapshotGroup(home, root);
  // 分组目录或它的上级是链接时，删掉链接本身就清理完了：清理不进入链接指向的目录。
  const link = await linkAbove(home, group);
  if (link !== undefined) {
    await remove(link);
    return;
  }
  let names: string[];
  try {
    names = (await readdir(group)).filter((name) => ID.test(name));
  } catch (error) {
    if (isCode(error, "ENOENT")) return;
    throw error;
  }
  for (const id of names) {
    const entry = record.plugins[id];
    const parent = path.join(group, id);
    // 记录里没有的插件整个删除；<id>/ 是链接时同样只删链接，不列出它指向的目录。
    if (entry === undefined || (await lstat(parent)).isSymbolicLink()) {
      await remove(parent);
      continue;
    }
    const keep = new Set([entry.digest, ...(entry.previous === undefined ? [] : [entry.previous])]);
    for (const name of await readdir(parent)) {
      if (DIGEST.test(name) && !keep.has(name)) await remove(path.join(parent, name));
    }
  }
}
