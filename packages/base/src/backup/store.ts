import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { Value } from "typebox/value";

import {
  BackupManifestSchema, parse, RepaFault,
  type BackupInfo, type BackupManifest, type BackupSpace, type BackupStatus,
} from "../schema.js";
import { LOCK_NAME, RESTORE_NAMES } from "../space/paths.js";
import { syncDirectory } from "../storage.js";
import { copying, copyTree, isCode, move, remove, syncCopies, walk } from "./copy.js";

/** 要备份的空间：根目录的真实路径、它的 .repa/，以及在历史队列中执行动作的入口。 */
export interface BackupSource {
  root: string;
  dataDir: string;
  /** 在历史队列中执行 action，期间历史库不变；空间已关闭、没有写入者时直接执行。 */
  withHistory<T>(action: () => Promise<T>): Promise<T>;
}

/** 磁盘上的一份备份：id 是它在组内的目录名。 */
export interface StoredBackup {
  id: string;
  directory: string;
  manifest: BackupManifest;
}

// 正式备份的目录名：UTC 时间加随机后缀；临时目录以点开头，不会被当作备份。
const BACKUP_ID = /^[0-9A-Za-z-]+$/;
const GROUP = /^[0-9a-f]{16}$/;
const TEMPORARY = ".tmp-";
// storage.ts 的 writeText 先写到这样的临时文件再改名，写到一半的不收。
const HALF_WRITTEN = /^\.repa-.*\.tmp$/;

/** 一个空间的备份所在目录：按空间根目录的真实路径分组，目录名取路径 SHA-256 的前 16 位。 */
export function groupDirectory(home: string, root: string): string {
  return path.join(home, "backups", createHash("sha256").update(root).digest("hex").slice(0, 16));
}

// 不收进备份的条目：空间锁、恢复留下的标记与暂存内容，以及写到一半的临时文件。
function excluded(relative: string): boolean {
  if (relative === LOCK_NAME || relative === RESTORE_NAMES.marker || relative === RESTORE_NAMES.staging || relative === RESTORE_NAMES.replaced) return true;
  return HALF_WRITTEN.test(relative.slice(relative.lastIndexOf("/") + 1));
}

const inHistory = (relative: string) => relative === "history.git" || relative.startsWith("history.git/");
const isSession = (relative: string) => /^sessions\/[^/]+\.jsonl$/.test(relative);

/** 列表中显示的备份信息；大小是所收文件的大小之和。 */
export function backupInfo(stored: StoredBackup): BackupInfo {
  return {
    id: stored.id,
    createdAt: stored.manifest.createdAt,
    bytes: stored.manifest.files.reduce((sum, file) => sum + file.size, 0),
    kind: stored.manifest.kind,
  };
}

async function readManifest(directory: string): Promise<BackupManifest> {
  const value: unknown = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  // 读取时忽略不认识的可选字段，已知字段仍校验。
  return parse(BackupManifestSchema, Value.Clean(BackupManifestSchema, value));
}

/**
 * 读出一组备份，从新到旧排列；临时目录不算。清单读不出的备份跳过并发出警告：
 * 一份损坏不应挡住学习者看到和恢复其余的备份，它本来也无法恢复。
 */
export async function readGroup(group: string): Promise<StoredBackup[]> {
  let names: string[];
  try {
    names = await readdir(group);
  } catch (error) {
    if (isCode(error, "ENOENT")) return [];
    throw error;
  }
  const result: StoredBackup[] = [];
  for (const id of names) {
    if (!BACKUP_ID.test(id)) continue;
    const directory = path.join(group, id);
    try {
      result.push({ id, directory, manifest: await readManifest(directory) });
    } catch (error) {
      process.emitWarning(`备份清单无法读取，列表中跳过这份备份：${directory}（${error instanceof Error ? error.message : String(error)}）`);
    }
  }
  return result.sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt));
}

/** 按空间根目录与备份 id 找到一份备份；不存在时报 backup_not_found。 */
export async function findBackup(home: string, root: string, id: string): Promise<StoredBackup> {
  const notFound = () => new RepaFault("backup_not_found", "找不到这份备份", { root, id });
  if (!BACKUP_ID.test(id)) throw notFound();
  const directory = path.join(groupDirectory(home, root), id);
  let manifest: BackupManifest;
  try {
    manifest = await readManifest(directory);
  } catch (error) {
    if (isCode(error, "ENOENT", "ENOTDIR")) throw notFound();
    throw error;
  }
  if (manifest.root !== root) throw notFound();
  return { id, directory, manifest };
}

/** 一个空间的备份状态：最近一份备份的时间；failure 由定期检查的持有者给出。 */
export async function groupStatus(home: string, root: string, failure: BackupStatus["failure"] = null): Promise<BackupStatus> {
  const [latest] = await readGroup(groupDirectory(home, root));
  return { root, lastSuccess: latest?.manifest.createdAt ?? null, failure };
}

/** 列出全部空间的备份，包括文件夹已不存在的空间；空间按路径排列，备份从新到旧。 */
export async function listBackups(home: string): Promise<BackupSpace[]> {
  let groups: string[];
  try {
    groups = await readdir(path.join(home, "backups"));
  } catch (error) {
    if (isCode(error, "ENOENT")) return [];
    throw error;
  }
  const result: BackupSpace[] = [];
  for (const group of groups.filter((name) => GROUP.test(name))) {
    const stored = await readGroup(path.join(home, "backups", group));
    const root = stored[0]?.manifest.root;
    if (root === undefined) continue;
    let exists = true;
    try {
      exists = (await stat(root)).isDirectory();
    } catch (error) {
      if (!isCode(error, "ENOENT", "ENOTDIR")) throw error;
      exists = false;
    }
    result.push({ root, exists, backups: stored.map(backupInfo) });
  }
  return result.sort((a, b) => a.root.localeCompare(b.root));
}

// 当前 .repa/ 中会收进备份的文件及其大小、修改时间。历史库在队列之外读取，Git 可能正在写入，
// 中途消失的临时文件不算；这次只用来判断有没有变化，复制时在队列中重新列出。
async function scan(dataDir: string): Promise<BackupManifest["files"]> {
  const files: BackupManifest["files"] = [];
  for await (const item of walk(dataDir, { skip: excluded, vanished: "skip" })) {
    if (item.directory) continue;
    try {
      const info = await lstat(path.join(dataDir, ...item.relative.split("/")));
      files.push({ path: item.relative, size: info.size, mtimeMs: info.mtimeMs });
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
  }
  return files;
}

function unchanged(current: BackupManifest["files"], previous: BackupManifest["files"]): boolean {
  if (current.length !== previous.length) return false;
  const known = new Map(previous.map((file) => [file.path, file]));
  return current.every((file) => {
    const before = known.get(file.path);
    return before !== undefined && before.size === file.size && before.mtimeMs === file.mtimeMs;
  });
}

/** 删除一份备份：先改成临时目录名，列表里立即看不到它；删到一半中断留下的临时目录在这一组下次备份时清理。 */
async function discard(directory: string): Promise<void> {
  const temporary = path.join(path.dirname(directory), `${TEMPORARY}${randomUUID()}`);
  try {
    await move(directory, temporary);
  } catch (error) {
    if (isCode(error, "ENOENT")) return;
    throw error;
  }
  await remove(temporary);
}

/** 删除一份备份，常用于学习者不再需要的"恢复前"备份；定期备份也可以删，下一次检查会按需补上。 */
export async function deleteBackup(home: string, root: string, id: string): Promise<void> {
  await discard((await findBackup(home, root, id)).directory);
}

/**
 * 复制一份备份：先写到组内的临时目录，全部复制并同步以后才改为正式名称。失败时删除临时目录，已有的备份不动。
 * 复制顺序依各文件的写法而定：先在同步代码里逐个复制会话，再复制其余文件，最后在历史队列中复制历史库；
 * 会话引用的工具输出全文和父关联都在会话之前写完，所以备份中的会话所引用的文件都齐全。
 * "恢复前"的备份在空间关闭、由恢复持锁时复制，没有写入者，所有文件按原始字节复制，原样保留当前状态，以便撤回或排查。
 */
export async function createBackup(home: string, source: BackupSource, kind: BackupManifest["kind"], createdAt: number): Promise<StoredBackup> {
  const group = groupDirectory(home, source.root);
  await mkdir(group, { recursive: true });
  // 上次中途结束的备份或删除留下的临时目录。同一空间同时只有持有空间锁的一方往这一组写备份。
  for (const name of await readdir(group)) {
    if (name.startsWith(TEMPORARY)) await remove(path.join(group, name));
  }
  const temporary = path.join(group, `${TEMPORARY}${randomUUID()}`);
  try {
    const data = path.join(temporary, "data");
    await mkdir(data, { recursive: true });
    const result = copying(data);
    result.written.directories.add(temporary);
    // 定期备份时有写入者在追加：日志只取到最后一个换行符，会话在一段同步代码里复制。
    const live = kind === "regular";
    await copyTree(source.dataDir, data, {
      skip: (relative) => excluded(relative) || !(relative === "sessions" || isSession(relative)),
      mode: () => (live ? "session" : "plain"),
      vanished: "skip",
    }, result);
    await copyTree(source.dataDir, data, {
      skip: (relative) => excluded(relative) || inHistory(relative) || isSession(relative),
      mode: (relative) => (live && relative.endsWith(".jsonl") ? "lines" : "plain"),
      vanished: "skip",
    }, result);
    await source.withHistory(() => copyTree(source.dataDir, data, {
      skip: (relative) => excluded(relative) || !inHistory(relative),
      mode: () => "plain",
      vanished: "skip",
    }, result));
    await syncCopies(result);
    const manifest: BackupManifest = { root: source.root, createdAt: new Date(createdAt).toISOString(), kind, files: result.files };
    const handle = await open(path.join(temporary, "manifest.json"), "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(manifest)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(temporary);
    const id = `${new Date(createdAt).toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    await move(temporary, path.join(group, id));
    await syncDirectory(group);
    return { id, directory: path.join(group, id), manifest };
  } catch (error) {
    // 报告复制失败的原因；临时目录若也删不掉，这一组下次备份时再清理。
    await remove(temporary).catch(() => undefined);
    throw error;
  }
}

/**
 * 定期检查：把 .repa/ 中各文件的路径、大小和修改时间与最近一份备份的清单比较，没有变化就不复制；
 * 有变化时复制一份，成功以后删除这个空间超出保留份数的最旧的定期备份。"恢复前"的备份不参与轮换。
 */
export async function checkBackup(home: string, source: BackupSource, keep: number, now: number): Promise<{ created: boolean; backup: BackupInfo }> {
  const group = groupDirectory(home, source.root);
  const [latest] = await readGroup(group);
  if (latest !== undefined && unchanged(await scan(source.dataDir), latest.manifest.files)) {
    return { created: false, backup: backupInfo(latest) };
  }
  const created = await createBackup(home, source, "regular", now);
  const regular = (await readGroup(group)).filter((stored) => stored.manifest.kind === "regular");
  for (const old of regular.slice(keep)) await discard(old.directory);
  return { created: true, backup: backupInfo(created) };
}
