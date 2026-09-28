import { lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import { RepaFault } from "../errors.js";

/** 管理状态目录必须位于实际空间内，不能沿项目附带的符号链接写到外部。 */
export function managedDirectory(root: string, ...segments: string[]): string {
  let directory = root;
  for (const segment of [".repa", ...segments]) {
    directory = path.join(directory, segment);
    try { mkdirSync(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new RepaFault("invalid_storage", "应用管理目录必须是空间中的普通目录。", { directory });
  }
  return directory;
}
