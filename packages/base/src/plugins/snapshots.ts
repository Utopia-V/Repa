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
 * 每次打开空间核对快照也要读一遍。实际使用嫌小时再调。
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

/** 文件夹里全部普通文件的相对路径，以 / 分隔；遇到符号链接等即拒绝，文件数超过上限即停止。 */
async function folderFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for await (const item of walk(directory, { skip: () => false, vanished: "fail", other: rejectOther })) {
    if (item.directory) continue;
    files.push(item.relative);
    if (files.length > SNAPSHOT_LIMITS.files) throw tooLarge(files.length, 0);
  }
  return files;
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

/**
 * 插件文件夹的摘要：sha256("repa-plugin-folder 1\n" + Σ(路径 + "\0" + 字节长度 + "\0" + sha256(内容) + "\n"))，
 * 路径按 UTF-8 字节序排列，相对文件夹、以 / 分隔，取文件系统给出的名字原样，不做 Unicode 规范化。
 * 收全部普通文件，含点开头的文件，不含空目录；遇到符号链接、目录联接或特殊文件即拒绝，超过上限即拒绝。
 */
export async function folderDigest(directory: string): Promise<string> {
  const files = (await folderFiles(directory))
    .map((relative) => ({ relative, key: Buffer.from(relative, "utf8") }))
    .sort((left, right) => Buffer.compare(left.key, right.key));
  const digest = createHash("sha256").update(`${ALGORITHM}\n`);
  let bytes = 0;
  for (const { relative } of files) {
    const { size, hash } = await hashFile(path.join(directory, ...relative.split("/")), SNAPSHOT_LIMITS.bytes - bytes);
    bytes += size;
    digest.update(`${relative}\0${size}\0${hash}\n`, "utf8");
  }
  return digest.digest("hex");
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
 * 只收普通文件，遇到符号链接即拒绝，超过上限即拒绝；失败时删除这次的暂存副本。
 */
export async function stageFolder(home: string, root: string, source: string): Promise<StagedFolder> {
  await measure(source);
  const staging = path.join(snapshotGroup(home, root), STAGING);
  await ensureDirectory(staging);
  const directory = path.join(staging, randomUUID());
  try {
    await mkdir(directory);
    const result = copying(directory);
    await copyTree(source, directory, { skip: () => false, vanished: "fail", other: rejectOther, mode: () => "plain" }, result);
    await syncCopies(result);
    return { directory, digest: await folderDigest(directory) };
  } catch (error) {
    await remove(directory).catch(() => undefined);
    throw error;
  }
}

/** 丢弃暂存副本：拒绝、取消或中途出错时调用。 */
export async function discardStaged(staged: StagedFolder): Promise<void> {
  await remove(staged.directory);
}

/**
 * 把暂存副本发布为插件 id 的快照，返回快照目录。副本在暂存时已落盘；改名以后同步 `<id>/` 目录，
 * 新建 `<id>/` 时同步它的上级，与备份发布的顺序相同。
 * 同一摘要的快照已经存在且核对通过时直接用它，丢弃副本。已存在却核对不通过时拒绝，不删除它：
 * 它可能正被运行着的实例使用，删除只在旧实例关闭以后进行（见 spacePlugins 与 cleanSnapshots）。
 */
export async function publishSnapshot(home: string, root: string, id: string, staged: StagedFolder): Promise<string> {
  const target = snapshotDirectory(home, root, id, staged.digest);
  await ensureDirectory(path.dirname(target));
  const status = await checkSnapshot(target, staged.digest);
  if (status === "ok") {
    await discardStaged(staged);
    return target;
  }
  if (status === "modified") {
    throw new RepaFault("snapshot_modified", "同一版本的已批准快照被改动过，要在重新打开插件以后再批准", { id, digest: staged.digest });
  }
  await publish(staged.directory, target);
  return target;
}

/**
 * 核对快照与目录名中的摘要：ok；missing，快照不存在；modified，内容与摘要不符，或出现了符号链接、超过了上限。
 * 其余读取错误照常抛出，由调用方报告，不当作改动去删除。
 */
export async function checkSnapshot(directory: string, digest: string): Promise<"ok" | "missing" | "modified"> {
  let actual: string;
  try {
    actual = await folderDigest(directory);
  } catch (error) {
    if (error instanceof RepaFault && (error.code === "invalid_plugin_folder" || error.code === "plugin_folder_too_large")) return "modified";
    if (!isCode(error, "ENOENT", "ENOTDIR")) throw error;
    // 目录本身还在，说明其中的文件中途不见了或被换成了别的东西，同样算改动。
    try {
      await lstat(directory);
      return "modified";
    } catch (statError) {
      if (isCode(statError, "ENOENT", "ENOTDIR")) return "missing";
      throw statError;
    }
  }
  return actual === digest ? "ok" : "modified";
}

/** 删除一份快照，用于核对不通过的快照；只在使用它的实例关闭以后调用。 */
export async function removeSnapshot(directory: string): Promise<void> {
  await remove(directory);
}

/** 删除这个空间全部的暂存副本。打开空间时调用：此前中途结束的复制和批准留下的副本不再有人使用。 */
export async function clearStaging(home: string, root: string): Promise<void> {
  await remove(path.join(snapshotGroup(home, root), STAGING));
}

/**
 * 按启用记录保留快照：每个插件只留记录里的 digest 与 previous，其余版本删除；记录里没有的插件整个删除。
 * ids 省略时清理这个空间的全部插件。record 必须是从盘上读到的记录，读不到时不要清理。
 * 调用时不能有实例在用将被删除的快照：打开空间时在插件打开之前调用，装卸时在旧实例关闭以后调用。
 */
export async function cleanSnapshots(home: string, root: string, record: PluginEnablement, ids?: Iterable<string>): Promise<void> {
  const group = snapshotGroup(home, root);
  let names: string[];
  if (ids === undefined) {
    try {
      names = (await readdir(group)).filter((name) => ID.test(name));
    } catch (error) {
      if (isCode(error, "ENOENT")) return;
      throw error;
    }
  } else {
    names = [...ids].filter((name) => ID.test(name));
  }
  for (const id of names) {
    const entry = record.plugins[id];
    const parent = path.join(group, id);
    if (entry === undefined) {
      await remove(parent);
      continue;
    }
    const keep = new Set([entry.digest, ...(entry.previous === undefined ? [] : [entry.previous])]);
    let versions: string[];
    try {
      versions = await readdir(parent);
    } catch (error) {
      if (isCode(error, "ENOENT", "ENOTDIR")) continue;
      throw error;
    }
    for (const name of versions) {
      if (DIGEST.test(name) && !keep.has(name)) await remove(path.join(parent, name));
    }
  }
}
