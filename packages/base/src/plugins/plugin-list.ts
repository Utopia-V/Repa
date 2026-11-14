import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import { isCode } from "../backup/copy.js";
import type { PluginHost } from "../plugins.js";
import type { PluginInfo } from "../protocol.js";
import { readEnablement, type PluginEnablement } from "./enablement.js";
import { PLUGIN_ID, readPluginFolder, type PluginManifest } from "./manifest.js";
import { folderDigest, snapshotDirectory } from "./snapshots.js";

/** 空间里放自写插件文件夹的目录；文件夹名就是插件 id。 */
export function pluginFoldersOf(root: string): string {
  return path.join(root, ".agents", "plugins");
}

/** 自写插件 id 的文件夹，即编辑的地方；运行的是批准时复制下来的快照。 */
export function pluginFolderOf(root: string, id: string): string {
  return path.join(pluginFoldersOf(root), id);
}

/**
 * 从空间根目录往下到插件文件夹的各层（.agents/、plugins/、<id>/）中最上面的符号链接或目录联接；没有时为 undefined。
 * 插件文件夹应在空间里：链接指向的内容可能在空间之外，批准时却显示为这个文件夹，所以与文件夹内部的链接一样拒绝。
 * 文件夹内部的链接由复制和摘要拒绝；空间根目录本身经链接打开不受限制。
 */
export async function linkInPluginFolder(root: string, id: string): Promise<string | undefined> {
  let current = root;
  for (const part of [".agents", "plugins", id]) {
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

/**
 * 空间里发现的插件文件夹的 id：.agents/plugins/ 下名字合乎 id 格式的目录。目录不在或读不了时为空：
 * 列表只是显示，读不了文件夹目录不应使列表读不出；记录里的插件照样列出，文件夹状态显示为读不了或不在。
 */
async function folderIds(root: string): Promise<string[]> {
  try {
    const entries = await readdir(pluginFoldersOf(root), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && PLUGIN_ID.test(entry.name)).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** 插件文件夹相对记下的版本：内容相同、有改动、不在，或者读不了（它或里面有符号链接、超过上限、没有权限）。 */
async function folderState(root: string, id: string, digest: string): Promise<NonNullable<PluginInfo["folder"]>> {
  const folder = pluginFolderOf(root, id);
  try {
    if ((await linkInPluginFolder(root, id)) !== undefined) return "unreadable";
    return (await folderDigest(folder)) === digest ? "same" : "modified";
  } catch {
    try {
      await lstat(folder);
      return "unreadable";
    } catch (error) {
      return isCode(error, "ENOENT", "ENOTDIR") ? "missing" : "unreadable";
    }
  }
}

async function manifestOf(directory: string): Promise<PluginManifest | undefined> {
  try {
    return (await readPluginFolder(directory)).manifest;
  } catch {
    return undefined;
  }
}

/** 已启用却没有运行的自写插件：待批准，或者失败，附原因。 */
export interface NotRunning {
  state: "pending" | "failed";
  reason: { code: string; message: string };
}

/**
 * 插件列表：随包插件、启用记录与空间里的插件文件夹的并集，按 id 排列。运行状态取自宿主和 notRunning，
 * digest 与 previous 取自盘上的启用记录，源文件夹的状态当场核对；读取列表本身不引起任何装卸。
 * 启用记录读不了时，取自记录的字段缺省，运行着的与 notRunning 里的插件照常列出；原因已在读不了的那一次报告过。
 */
export async function listPlugins(options: {
  home: string;
  root: string;
  dataDir: string;
  host: PluginHost;
  bundled: string[];
  /** 运行中的自写插件的清单。 */
  manifests: ReadonlyMap<string, PluginManifest>;
  notRunning: ReadonlyMap<string, NotRunning>;
}): Promise<PluginInfo[]> {
  const { home, root, host, manifests, notRunning } = options;
  const running = new Map(host.list().map((plugin) => [plugin.id, plugin]));
  const disabled = new Map(host.disabled().map((plugin) => [plugin.id, plugin.reason]));
  let record: PluginEnablement | undefined;
  try {
    record = await readEnablement(options.dataDir);
  } catch {
    record = undefined;
  }
  const bundled = new Set(options.bundled);
  const ids = [...new Set([...bundled, ...Object.keys(record?.plugins ?? {}), ...manifests.keys(), ...notRunning.keys(), ...(await folderIds(root))])]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const result: PluginInfo[] = [];
  for (const id of ids) {
    const instance = running.get(id);
    const live = { methods: instance?.methods ?? [], tools: instance?.tools ?? [] };
    if (bundled.has(id)) {
      const reason = disabled.get(id);
      result.push({ id, source: "bundled", state: reason === undefined ? "running" : "failed", ...(reason === undefined ? {} : { reason }), pages: [], ...live });
      continue;
    }
    const entry = record?.plugins[id];
    let state: PluginInfo["state"];
    let reason: PluginInfo["reason"];
    let manifest: PluginManifest | undefined;
    const other = notRunning.get(id);
    if (instance !== undefined) {
      state = "running";
      manifest = manifests.get(id);
    } else if (record !== undefined && entry?.enabled !== true) {
      state = "disabled";
    } else if (other !== undefined) {
      ({ state, reason } = other);
    } else if (disabled.has(id)) {
      state = "failed";
      reason = disabled.get(id);
    } else {
      // 记录在打开空间之后被别的程序改过：下次打开空间时按它运行。
      state = "failed";
      reason = { code: "plugin_not_running", message: `插件 ${id} 已启用但没有运行，重新打开空间时按启用记录运行` };
    }
    if (manifest === undefined && entry !== undefined) manifest = await manifestOf(snapshotDirectory(home, root, id, entry.digest));
    if (manifest === undefined) manifest = await manifestOf(pluginFolderOf(root, id));
    result.push({
      id,
      source: "space",
      ...(manifest?.title === undefined ? {} : { title: manifest.title }),
      ...(manifest === undefined ? {} : { version: manifest.version }),
      state,
      ...(reason === undefined ? {} : { reason }),
      ...(entry === undefined ? {} : { folder: await folderState(root, id, entry.digest), digest: entry.digest }),
      ...(entry?.previous === undefined ? {} : { previous: entry.previous }),
      pages: (manifest?.pages ?? []).map((page) => ({ id: page.id, title: page.title })),
      ...live,
    });
  }
  return result;
}
