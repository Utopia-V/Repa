import { lstat, mkdir, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";

import { RepaFault } from "../schema.js";
import { writeText } from "../storage.js";

const IGNORE_ALL = "*\n";

// 同时检查输入路径与解析后的路径，符号链接不能把文件接口带出空间。
export function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export async function existingPath(file: string, depth = 0): Promise<string> {
  if (depth > 40) throw new RepaFault("invalid_file_path", "符号链接层级过多");
  try {
    return await realpath(file);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    try {
      if ((await lstat(file)).isSymbolicLink()) {
        return existingPath(path.resolve(path.dirname(file), await readlink(file)), depth + 1);
      }
    } catch (statError) {
      if (!(statError instanceof Error) || !("code" in statError) || statError.code !== "ENOENT") throw statError;
    }
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(await existingPath(parent, depth), path.basename(file));
  }
}

export async function directory(file: string): Promise<void> {
  try {
    const info = await lstat(file);
    if (!info.isDirectory()) throw new RepaFault("invalid_control_directory", "控制目录必须是普通目录", { file });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    try {
      await mkdir(file);
    } catch (mkdirError) {
      if (!(mkdirError instanceof Error) || !("code" in mkdirError) || mkdirError.code !== "EEXIST") throw mkdirError;
      if (!(await lstat(file)).isDirectory()) throw new RepaFault("invalid_control_directory", "控制目录必须是普通目录", { file });
    }
  }
}

/** ripgrep 和 fd 都读 .ignore：放一份忽略全部内容的文件，从空间根目录开始的搜索就不进 .repa/。 */
export async function ignoreDataDir(dataDir: string): Promise<void> {
  const file = path.join(dataDir, ".ignore");
  try {
    if (!(await lstat(file)).isFile()) throw new RepaFault("invalid_control_file", "控制文件必须是普通文件", { file });
    if (await readFile(file, "utf8") === IGNORE_ALL) return;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  await writeText(file, IGNORE_ALL);
}
