import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { opendir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { RepaFault, type DirectoryListing, type DirectoryRoot } from "../schema.js";
import { isSpace } from "./nesting.js";

const execFileAsync = promisify(execFile);
const LIMIT = 1000;

/** 所有系统上都不列的条目：点开头的，和 Office 打开文档时旁边留下的锁文件（~$ 开头，Windows 上本来带隐藏属性）。 */
function hiddenEntry(name: string): boolean {
  return name.startsWith(".") || name.startsWith("~$");
}

/** 读出一个文件夹里带隐藏属性的条目名（小写，Windows 的文件名不分大小写）。 */
export type HiddenReader = (directory: string) => Promise<ReadonlySet<string>>;

/** `dir /b` 的输出：每行一个名称，CRLF 分隔。名称可能以空格开头，所以不修剪。 */
export function parseHiddenListing(output: string): Set<string> {
  return new Set(output.split(/\r?\n/).filter((line) => line !== "").map((line) => line.toLowerCase()));
}

/**
 * Windows 上哪些条目带隐藏属性，资源管理器按它决定显示什么：AppData、“「开始」菜单”等兼容链接、NTUSER.DAT、
 * $Recycle.Bin 都带。Node 的 fs 读不到属性，每列一次目录调用一次 `cmd /u /c dir /a:h /b`（实测约 23 ms），
 * /u 让 cmd 以 UTF-16LE 写进管道，中文名不受代码页影响。没有隐藏条目时 dir 以 1 退出；
 * 这一步出任何错都按没有隐藏条目处理，多列几项也比打不开文件夹好。
 * 路径放在双引号里交给 cmd；文件夹名里成对的 % 仍会被 cmd 当成环境变量展开，这时读不出，同样按没有处理。
 */
export const readWindowsHidden: HiddenReader = async (directory) => {
  try {
    const { stdout } = await execFileAsync("cmd.exe", ["/d", "/u", "/c", "dir", "/a:h", "/b", directory], {
      encoding: "buffer", windowsHide: true, timeout: 5000,
    });
    return parseHiddenListing(stdout.toString("utf16le"));
  } catch {
    return new Set();
  }
};

const noHidden: HiddenReader = () => Promise.resolve(new Set());

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

/** 文件名的扩展名是否在 extensions 里（带点，不分大小写）；没有给 extensions 时都算。 */
function wanted(name: string, extensions: ReadonlySet<string> | undefined): boolean {
  return extensions === undefined || extensions.has(path.extname(name).toLowerCase());
}

/**
 * 返回子文件夹的名称与空间标记，只读取空间格式标记；files 为真时连同文件的名称与大小。
 * extensions 只列这些扩展名的文件（带点，例如 .pdf），由调用方按用途给出，例如选课件的窗口只列课件插件读得了的格式。
 * hidden 读出带隐藏属性的条目，缺省在 Windows 上是 readWindowsHidden，别的系统上没有这种属性。
 */
export async function browseDirectory(
  requested = os.homedir(),
  { files = false, extensions, limit = LIMIT, hidden = process.platform === "win32" ? readWindowsHidden : noHidden }: {
    files?: boolean; extensions?: readonly string[]; limit?: number; hidden?: HiddenReader;
  } = {},
): Promise<DirectoryListing> {
  if (!path.isAbsolute(requested) || requested.includes("\0")) {
    throw new RepaFault("invalid_path", "请提供文件夹的绝对路径。", { path: requested });
  }
  const folders: string[] = [];
  const found: string[] = [];
  let directory = requested;
  let truncated = false;
  const accepted = extensions && new Set(extensions.map((extension) => extension.toLowerCase()));
  try {
    directory = await realpath(requested);
    const attributeHidden = await hidden(directory);
    // 逐项读取，超大目录读到上限即停止；目录在两次请求之间可能变化，因此不提供翻页游标。
    for await (const entry of await opendir(directory)) {
      if (hiddenEntry(entry.name) || attributeHidden.has(entry.name.toLowerCase())) continue;
      const kind = await entryKind(directory, entry);
      if (kind === undefined || (kind === "file" && (!files || !wanted(entry.name, accepted)))) continue;
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
