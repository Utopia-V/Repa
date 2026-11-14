import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import { isCode } from "../backup/copy.js";
import type { PluginHost } from "../plugins.js";
import type { PluginInfo } from "../protocol.js";
import { readEnablement, type PluginEnablement } from "./enablement.js";
import { readPluginFolder, type PluginManifest } from "./manifest.js";
import { folderDigest, snapshotDirectory } from "./snapshots.js";
import type { SpacePlugin, UnavailablePlugin } from "./space-plugins.js";

const ID = /^[a-z][a-z0-9-]*$/;

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
 * 列表只是显示，读不了文件夹目录不应使空间打不开；记录里的插件照样列出，文件夹状态显示为读不了或不在。
 */
async function folderIds(root: string): Promise<string[]> {
  try {
    const entries = await readdir(pluginFoldersOf(root), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && ID.test(entry.name)).map((entry) => entry.name);
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

/** 一次装配的结果：打开着的宿主、随包插件的 id、交给宿主的自写插件与没有交给它的自写插件。 */
export interface AssembledPlugins {
  host: PluginHost;
  bundled: string[];
  selfWritten: SpacePlugin[];
  unavailable: UnavailablePlugin[];
}

/**
 * 插件列表（不含请求状态）：随包插件、启用记录与空间里的插件文件夹的并集，按 id 排列。运行状态取自这次装配，
 * digest 与 previous 取自盘上的启用记录，源文件夹的状态当场核对。宿主必须仍然打开。
 * 启用记录读不了时，取自记录的字段（digest、previous、源文件夹状态）缺省，其余照常：这次装配运行着、停用了或没能交给宿主的自写插件
 * 都在列表里，状态由装配给出；原因已在装配时记进最近错误。
 */
export async function listPlugins(options: { home: string; root: string; dataDir: string; assembled: AssembledPlugins }): Promise<PluginInfo[]> {
  const { home, root, assembled } = options;
  const running = new Map(assembled.host.list().map((plugin) => [plugin.id, plugin]));
  const disabled = new Map(assembled.host.disabled().map((plugin) => [plugin.id, plugin.reason]));
  const selfWritten = new Map(assembled.selfWritten.map((plugin) => [plugin.id, plugin]));
  const unavailable = new Map(assembled.unavailable.map((plugin) => [plugin.id, plugin]));
  let record: PluginEnablement | undefined;
  try {
    record = await readEnablement(options.dataDir);
  } catch {
    record = undefined;
  }
  const bundled = new Set(assembled.bundled);
  const ids = [...new Set([...assembled.bundled, ...Object.keys(record?.plugins ?? {}), ...selfWritten.keys(), ...disabled.keys(), ...unavailable.keys(), ...(await folderIds(root))])]
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
    const folder = pluginFolderOf(root, id);
    let state: PluginInfo["state"];
    let reason: PluginInfo["reason"];
    let manifest: PluginManifest | undefined;
    const loaded = selfWritten.get(id);
    const missing = unavailable.get(id);
    if (instance !== undefined && loaded !== undefined) {
      state = "running";
      manifest = loaded.manifest;
    } else if (disabled.has(id)) {
      state = "failed";
      reason = disabled.get(id);
    } else if (missing !== undefined) {
      state = missing.state;
      reason = missing.reason;
    } else if (entry?.enabled === true) {
      // 记录在这次装配之后改过（例如由别的程序写入），下一次装配才按它运行。
      state = "pending";
      reason = { code: "plugin_not_assembled", message: `插件 ${id} 的启用记录在这次装配之后改过，下一次重组或重新打开空间时生效` };
    } else {
      state = "disabled";
    }
    if (manifest === undefined && entry !== undefined) manifest = await manifestOf(snapshotDirectory(home, root, id, entry.digest));
    if (manifest === undefined) manifest = await manifestOf(folder);
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
