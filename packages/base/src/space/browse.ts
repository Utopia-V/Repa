import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { opendir, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Type } from "typebox";
import { Check } from "typebox/value";

import { RepaFault, type DirectoryListing, type DirectoryRoot } from "../schema.js";

const execFileAsync = promisify(execFile);
const LIMIT = 1000;
// Node 读不到 Windows 的隐藏属性，按资源管理器默认不显示的系统目录名过滤。
const WINDOWS_SYSTEM = new Set(["system volume information", "config.msi", "recovery", "programdata", "appdata"]);
// 为旧程序保留的兼容链接本身拒绝列出内容；同名的普通文件夹不受影响。
const WINDOWS_LEGACY_LINKS = new Set([
  "documents and settings",
  "application data",
  "cookies",
  "local settings",
  "my documents",
  "my music",
  "my pictures",
  "my videos",
  "nethood",
  "printhood",
  "recent",
  "sendto",
  "start menu",
  "templates",
]);

export function hiddenEntry(name: string, link: boolean, platform: NodeJS.Platform = process.platform): boolean {
  if (name.startsWith(".")) return true;
  if (platform !== "win32") return false;
  const lower = name.toLowerCase();
  return lower.startsWith("$") || WINDOWS_SYSTEM.has(lower) || (link && WINDOWS_LEGACY_LINKS.has(lower));
}

function browseFault(error: unknown, directory: string): unknown {
  const code = (error as NodeJS.ErrnoException).code;
  switch (code) {
    case undefined:
      return error;
    case "ENOENT":
      return new RepaFault("not_found", "文件夹不存在。", { path: directory });
    case "ENOTDIR":
      return new RepaFault("not_directory", "这个路径不是文件夹。", { path: directory });
    case "EACCES":
    case "EPERM":
      return new RepaFault("permission_denied", "没有访问这个文件夹的权限。", { path: directory });
    default:
      return new RepaFault("unavailable", "暂时无法读取这个文件夹。", { path: directory, code });
  }
}

/** 浏览只识别有效的格式标记，包括当前程序尚不能打开的更新版本。 */
async function isSpace(directory: string): Promise<boolean> {
  try {
    const value: unknown = JSON.parse(await readFile(path.join(directory, ".repa", "format.json"), "utf8"));
    return Check(Type.Object({ version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }), value);
  } catch {
    return false;
  }
}

/** 子文件夹、文件或都不是（读不了的链接、设备文件等）。链接跟随一次，Windows 的 junction 也报告为链接。 */
async function entryKind(directory: string, entry: Dirent): Promise<"folder" | "file" | undefined> {
  if (entry.isDirectory()) return "folder";
  if (entry.isFile()) return "file";
  if (!entry.isSymbolicLink()) return undefined;
  try {
    const info = await stat(path.join(directory, entry.name));
    return info.isDirectory() ? "folder" : info.isFile() ? "file" : undefined;
  } catch {
    return undefined;
  }
}

/** 返回子文件夹的名称与空间标记，只读取空间格式标记；files 为真时连同文件的名称与大小。 */
export async function browseDirectory(
  requested = os.homedir(),
  { files = false, limit = LIMIT }: { files?: boolean; limit?: number } = {},
): Promise<DirectoryListing> {
  if (!path.isAbsolute(requested) || requested.includes("\0")) {
    throw new RepaFault("invalid_path", "请提供文件夹的绝对路径。", { path: requested });
  }
  const folders: string[] = [];
  const found: string[] = [];
  let directory = requested;
  let truncated = false;
  try {
    directory = await realpath(requested);
    // 逐项读取，超大目录读到上限即停止；目录在两次请求之间可能变化，因此不提供翻页游标。
    for await (const entry of await opendir(directory)) {
      if (hiddenEntry(entry.name, entry.isSymbolicLink())) continue;
      const kind = await entryKind(directory, entry);
      if (kind === undefined || (kind === "file" && !files)) continue;
      if (folders.length + found.length === limit) {
        truncated = true;
        break;
      }
      (kind === "folder" ? folders : found).push(entry.name);
    }
  } catch (error) {
    throw browseFault(error, directory);
  }
  const order = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;
  folders.sort(order);
  found.sort(order);
  const folderEntries = await Promise.all(folders.map(async (name) => {
    const child = path.join(directory, name);
    return { name, path: child, space: await isSpace(child) };
  }));
  // 文件在列出与读大小之间可能被删掉，删掉的不列。
  const fileEntries = (await Promise.all(found.map(async (name) => {
    const child = path.join(directory, name);
    const info = await stat(child).catch(() => undefined);
    return info?.isFile() ? [{ name, path: child, space: false, file: true as const, size: info.size }] : [];
  }))).flat();
  const parent = path.dirname(directory);
  return { path: directory, parent: parent === directory ? null : parent, space: await isSpace(directory), entries: [...folderEntries, ...fileEntries], truncated };
}

export function parseDrives(output: string): DirectoryRoot[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().toUpperCase())
    .filter((line) => /^[A-Z]:\\$/.test(line))
    .map((drive) => ({ path: drive, label: drive.slice(0, 2) }));
}

/** Windows 列出盘符供用户从 `C:\` 继续向上；其他平台只有 `/`。 */
export async function listRoots(): Promise<DirectoryRoot[]> {
  if (process.platform !== "win32") return [{ path: "/", label: "/" }];
  try {
    // wmic 已从新版 Windows 移除；逐个探测盘符会被掉线的网络盘阻塞。只读名称，不查询盘是否就绪。
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "[System.IO.DriveInfo]::GetDrives() | ForEach-Object { $_.Name }"],
      { timeout: 5000, windowsHide: true },
    );
    const drives = parseDrives(stdout);
    if (drives.length) return drives;
  } catch {
    // 读不到盘符列表时退回用户目录所在的盘，浏览仍可继续。
  }
  const home = path.parse(os.homedir()).root;
  return [{ path: home, label: home.replace(/\\$/, "") }];
}
