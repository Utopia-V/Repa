import type { Stats } from "node:fs";
import { lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RepaFault } from "../errors.js";
import type { BrowseDirectoryInput, DirectoryEntry, DirectoryListing } from "./schema.js";

function directoryFault(error: unknown, directory: string): never {
  switch ((error as NodeJS.ErrnoException).code) {
    case "ENOENT":
      throw new RepaFault("not_found", "目录不存在。", { path: directory });
    case "ENOTDIR":
      throw new RepaFault("not_directory", "该路径不是目录。", { path: directory });
    case "EACCES":
    case "EPERM":
      throw new RepaFault("permission_denied", "没有访问该目录的权限。", { path: directory });
    default:
      throw error;
  }
}

function absoluteDirectory(directory: string): string {
  if (!path.isAbsolute(directory) || directory.includes("\0"))
    throw new RepaFault("invalid_path", "请选择目录的绝对路径。", { path: directory });
  return directory;
}

function fileKind(info: Stats): "directory" | "file" | "other" {
  if (info.isDirectory()) return "directory";
  if (info.isFile()) return "file";
  return "other";
}

async function describeEntry(directory: string, name: string): Promise<DirectoryEntry | undefined> {
  const file = path.join(directory, name);
  let info: Stats;
  try {
    info = await lstat(file);
  } catch (error) {
    // 目录在浏览期间可能变化；跳过已经移除的条目。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!info.isSymbolicLink()) {
    return { name, path: file, kind: fileKind(info), ...(info.isFile() ? { size: info.size } : {}) };
  }
  const entry: DirectoryEntry = { name, path: file, kind: "symlink" };
  try {
    entry.targetKind = fileKind(await stat(file));
  } catch (error) {
    if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? ""))
      throw error;
  }
  return entry;
}

/** 浏览只取得当前目录的元信息，不读取正文或修改材料授权。 */
export async function browseDirectory(input: BrowseDirectoryInput): Promise<DirectoryListing> {
  const requested = absoluteDirectory(input.path ?? os.homedir());
  try {
    const directory = await realpath(requested);
    const names = (await readdir(directory))
      .filter(name => (input.includeHidden || !name.startsWith(".")) && (input.cursor === undefined || name > input.cursor))
      .sort();
    const selected = names.slice(0, input.limit ?? 100);
    const entries = await Promise.all(selected.map(name => describeEntry(directory, name)));
    const parent = path.dirname(directory);
    const last = selected.at(-1);
    return {
      path: directory,
      parent: parent === directory ? null : parent,
      entries: entries.filter((entry): entry is DirectoryEntry => entry !== undefined),
      ...(last !== undefined && names.length > selected.length ? { nextCursor: last } : {}),
    };
  } catch (error) {
    return directoryFault(error, requested);
  }
}

/** 保留可读目标；最多 60 个 Unicode 字符，为常见文件系统的字节限制及重名后缀留出空间。 */
function directoryName(hint: string): string {
  const cleaned = hint.normalize("NFC").replace(/[<>:"/\\|?*\p{Cc}]/gu, " ").trim().replace(/\s+/gu, " ");
  return [...cleaned].slice(0, 60).join("").replace(/^[. ]+|[. ]+$/gu, "") || "学习空间";
}

/** mkdir 独占建立目标目录，重名时选择下一个后缀，不沿用现有目录。 */
export async function createSpaceDirectory(parentDirectory: string, hint: string): Promise<string> {
  const requested = absoluteDirectory(parentDirectory);
  try {
    const parent = await realpath(requested);
    const name = directoryName(hint);
    for (let index = 1; ; index++) {
      const directory = path.join(parent, index === 1 ? name : `${name} (${index})`);
      try {
        await mkdir(directory);
        return directory;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  } catch (error) {
    return directoryFault(error, requested);
  }
}
