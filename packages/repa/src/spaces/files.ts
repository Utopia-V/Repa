import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readdir, readlink, symlink } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "typebox";
import { object, literals } from "../schema.js";
import { RepaFault } from "../errors.js";
import { syncDirectory } from "../storage/atomic.js";

export const TreeEntrySchema = object({
  path: Type.String(), kind: literals(["file", "directory", "symlink"]), mode: Type.Integer({ minimum: 0, maximum: 0o777 }),
  hash: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })), link: Type.Optional(Type.String()),
});
export type TreeEntry = Static<typeof TreeEntrySchema>;
export const within = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return !relative || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
};
export function relativePath(value: string): string {
  if (!value || value.includes("\\") || value.includes("\0") || path.posix.normalize(value) !== value || value === "." || value.startsWith("/") || value.split("/").some(p => p === ".." || p.includes(":")))
    throw new RepaFault("invalid_snapshot", "快照中的相对路径无效。", { path: value });
  return value;
}
async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}
export async function scanTree(root: string, include: (relative: string) => boolean = () => true): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  const walk = async (directory: string) => {
    for (const name of (await readdir(path.join(root, directory))).sort()) {
      const relative = directory ? `${directory}/${name}` : name;
      relativePath(relative);
      if (!include(relative)) continue;
      const file = path.join(root, relative), stat = await lstat(file), mode = stat.mode & 0o777;
      if (stat.isSymbolicLink()) {
        if (relative === ".repa" || relative.startsWith(".repa/")) throw new RepaFault("invalid_snapshot", "持久数据目录不能包含符号链接。", { path: relative });
        entries.push({ path: relative, kind: "symlink", mode, link: await readlink(file) });
      } else if (stat.isDirectory()) {
        entries.push({ path: relative, kind: "directory", mode }); await walk(relative);
      } else if (stat.isFile()) entries.push({ path: relative, kind: "file", mode, hash: await hashFile(file) });
      else throw new RepaFault("unsupported_content", "快照无法保存该文件类型。", { path: relative });
    }
  };
  await walk(""); return entries;
}
export function validateTree(entries: TreeEntry[]): void {
  const byPath = new Map<string, TreeEntry>();
  for (const entry of entries) {
    relativePath(entry.path);
    if (byPath.has(entry.path) || (entry.kind === "file" && !entry.hash) || (entry.kind === "symlink" && entry.link === undefined))
      throw new RepaFault("invalid_snapshot", "快照文件清单无效。");
    if (entry.kind === "symlink" && (entry.path === ".repa" || entry.path.startsWith(".repa/")))
      throw new RepaFault("invalid_snapshot", "持久数据目录不能包含符号链接。");
    byPath.set(entry.path, entry);
  }
  for (const entry of entries) {
    let parent = path.posix.dirname(entry.path);
    while (parent !== ".") {
      if (byPath.get(parent)?.kind !== "directory") throw new RepaFault("invalid_snapshot", "快照文件的父级不是普通目录。", { path: entry.path });
      parent = path.posix.dirname(parent);
    }
  }
}
export async function copyTree(source: string, destination: string, entries: TreeEntry[]): Promise<void> {
  validateTree(entries);
  await mkdir(destination, { recursive: true });
  for (const entry of [...entries].sort((a,b) => a.path.split("/").length - b.path.split("/").length)) {
    const target = path.join(destination, entry.path), original = path.join(source, entry.path);
    const current = await lstat(original);
    if ((entry.kind === "file" && !current.isFile()) || (entry.kind === "directory" && !current.isDirectory()) || (entry.kind === "symlink" && !current.isSymbolicLink()))
      throw new RepaFault("revision_conflict", "快照期间文件类型发生了变化。", { path: entry.path });
    if (entry.kind === "directory") await mkdir(target, { mode: 0o700 });
    else if (entry.kind === "symlink") {
      if (await readlink(original) !== entry.link) throw new RepaFault("revision_conflict", "快照期间符号链接发生了变化。");
      await symlink(entry.link!, target);
    } else {
      await copyFile(original, target, constants.COPYFILE_EXCL);
      if (await hashFile(target) !== entry.hash) throw new RepaFault("revision_conflict", "快照期间文件内容发生了变化。", { path: entry.path });
      await chmod(target, entry.mode);
    }
  }
}
export async function syncTree(root: string, entries: TreeEntry[]): Promise<void> {
  for (const entry of entries) if (entry.kind === "file") {
    const handle = await open(path.join(root, entry.path), "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }
  for (const entry of [...entries].reverse()) if (entry.kind === "directory") {
    await chmod(path.join(root, entry.path), entry.mode); await syncDirectory(path.join(root, entry.path));
  }
  await syncDirectory(root);
}
