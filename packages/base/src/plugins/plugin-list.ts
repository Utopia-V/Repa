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

/** 插件文件夹相对记下的版本：内容相同、有改动、不在，或者读不了（有符号链接、超过上限、没有权限）。 */
async function folderState(folder: string, digest: string): Promise<NonNullable<PluginInfo["folder"]>> {
  try {
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
 * 启用记录读不了时，自写插件只按文件夹列出，状态由装配给出；原因已在装配时记进最近错误。
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
  const ids = [...new Set([...assembled.bundled, ...Object.keys(record?.plugins ?? {}), ...unavailable.keys(), ...(await folderIds(root))])]
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
      ...(entry === undefined ? {} : { folder: await folderState(folder, entry.digest), digest: entry.digest }),
      ...(entry?.previous === undefined ? {} : { previous: entry.previous }),
      pages: (manifest?.pages ?? []).map((page) => ({ id: page.id, title: page.title })),
      ...live,
    });
  }
  return result;
}
