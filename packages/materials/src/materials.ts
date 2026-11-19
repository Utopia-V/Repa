import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { move } from "@repa/base";
import { RepaFault } from "@repa/base/plugin";

import { convert, sniff } from "./convert.js";
import type { Converted } from "./result.js";

/** 学习者放课件的文件夹，在每门课的文件夹里。 */
export const MATERIALS_DIRECTORY = "materials";
/** 空间里放各门课的文件夹；一门课的文件夹是 courses/<名>。 */
export const COURSES_DIRECTORY = "courses";

/** 一门课的文件夹（相对空间根，courses/<名>）；写法不对时拒绝。 */
function courseFolder(folder: string): string {
  const parts = folder.split("/");
  if (parts.length !== 2 || parts[0] !== COURSES_DIRECTORY || !parts[1] || parts[1] === "." || parts[1] === ".." || parts[1].includes("\\")) {
    throw new RepaFault("invalid_path", `${folder} 不是课的文件夹；课的文件夹相对空间根目录写，例如 ${COURSES_DIRECTORY}/操作系统。`, { path: folder });
  }
  return folder;
}

// 转换的写法改变时加一，旧的缓存随之作废、重新转换。
const CONVERTER_VERSION = 1;

/** 一个文件读成文字的结果；plain 是不用转换、直接用 read 读的文字文件。 */
export type Outcome = Converted | { status: "plain" };

/**
 * 读空间里的课件并缓存转换结果。只读空间文件；缓存写在插件的数据目录，以内容的 SHA-256 为键，
 * 同一份内容换了名字、挪了位置也不再转换。
 */
export class Materials {
  constructor(private readonly root: string, private readonly dataDir: string) {}

  /** 有 materials/ 的课的文件夹（相对空间根），按名称排序。 */
  async folders(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(path.join(this.root, COURSES_DIRECTORY), { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const result = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const folder = `${COURSES_DIRECTORY}/${entry.name}`;
      if (await stat(path.join(this.root, folder, MATERIALS_DIRECTORY)).then((info) => info.isDirectory(), () => false)) result.push(folder);
    }
    return result.sort();
  }

  /** 一门课的 materials/ 下的全部文件（路径相对空间根），按路径排序；文件夹不在时返回 undefined。 */
  async list(folder: string, signal: AbortSignal): Promise<Array<{ path: string; size: number; outcome: Outcome }> | undefined> {
    const directory = path.join(this.root, courseFolder(folder), MATERIALS_DIRECTORY);
    let entries;
    try {
      entries = await readdir(directory, { recursive: true, withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    // 只收普通文件：符号链接可能指到空间外，隐藏文件（如 .DS_Store）不是课件。
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(entry.parentPath, entry.name))
      .filter((file) => !path.relative(directory, file).split(path.sep).some((part) => part.startsWith(".")))
      .map((file) => toSpacePath(path.relative(this.root, file)))
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const result = [];
    for (const file of files) {
      const absolute = path.join(this.root, file);
      result.push({ path: file, size: (await stat(absolute)).size, outcome: await this.outcome(absolute, signal) });
    }
    return result;
  }

  /**
   * 把本机的文件复制进一门课的 materials/，文件名不变。先逐个核对：要是绝对路径、是普通文件、materials/ 里还没有同名的文件，
   * 有一个不合就一个也不复制。同名的不覆盖，学习者先删掉旧的或改个名字。复制不经空间的文件接口：那是文本接口，课件多是二进制。
   */
  async add(folder: string, sources: readonly string[]): Promise<void> {
    const directory = path.join(this.root, courseFolder(folder), MATERIALS_DIRECTORY);
    const names = new Set<string>();
    for (const source of sources) {
      if (!path.isAbsolute(source)) throw new RepaFault("invalid_path", `${source} 不是绝对路径。`, { path: source });
      const info = await stat(source).catch((error: unknown) => {
        if (isMissing(error)) throw new RepaFault("file_not_found", `没有 ${source} 这个文件。`, { path: source });
        throw error;
      });
      if (!info.isFile()) throw new RepaFault("not_file", `${source} 不是文件。`, { path: source });
      const name = path.basename(source);
      if (names.has(name)) throw new RepaFault("duplicate_name", `选了两个都叫 ${name} 的文件。`, { name });
      names.add(name);
      if (await stat(path.join(directory, name)).then(() => true, (error: unknown) => (isMissing(error) ? false : Promise.reject(error)))) {
        throw new RepaFault("file_exists", `${MATERIALS_DIRECTORY}/ 里已经有 ${name}。`, { name });
      }
    }
    await mkdir(directory, { recursive: true });
    // COPYFILE_EXCL：核对以后别处恰好放进了同名文件时报错，不覆盖。
    for (const source of sources) await copyFile(source, path.join(directory, path.basename(source)), constants.COPYFILE_EXCL);
  }

  /**
   * 读一门课的 materials/ 里的一个文件；file 相对空间根目录，返回规范化后的路径。只读得到各门课的 materials/：
   * 课程文件夹里的 course/ 有题目的答案，辅导经这里读不到它。
   */
  async read(file: string, signal: AbortSignal): Promise<{ path: string; outcome: Outcome }> {
    const absolute = path.resolve(this.root, file);
    const relative = path.relative(this.root, absolute);
    const parts = relative.split(path.sep);
    if (parts.length < 4 || parts[0] !== COURSES_DIRECTORY || parts[2] !== MATERIALS_DIRECTORY || parts.some((part) => part === "..")) {
      throw new RepaFault("file_outside_materials", `${file} 不在哪门课的 ${MATERIALS_DIRECTORY}/ 里；路径相对空间根目录写，例如 ${COURSES_DIRECTORY}/操作系统/${MATERIALS_DIRECTORY}/第一章.pdf。`);
    }
    let real;
    try {
      real = await realpath(absolute);
    } catch (error) {
      if (isMissing(error)) throw new RepaFault("file_not_found", `没有 ${toSpacePath(relative)} 这个文件；用 materials_list 查看有哪些文件。`);
      throw error;
    }
    const realRelative = path.relative(await realpath(this.root), real);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      throw new RepaFault("file_outside_space", `${toSpacePath(relative)} 经符号链接指到了空间外。`);
    }
    if (!(await stat(real)).isFile()) throw new RepaFault("file_not_found", `${toSpacePath(relative)} 不是文件。`);
    return { path: toSpacePath(relative), outcome: await this.outcome(real, signal) };
  }

  private async outcome(file: string, signal: AbortSignal): Promise<Outcome> {
    const container = await sniff(file);
    if (container === "text") return { status: "plain" };
    if (container === "empty") return { status: "failed", reason: "damaged", detail: "文件是空的" };
    if (container === "other") return { status: "failed", reason: "unsupported" };
    const data = await readFile(file);
    const digest = createHash("sha256").update(data).digest("hex");
    const cached = await this.cached(digest);
    if (cached !== undefined) return cached;
    const result = await convert(data, container, signal);
    await this.store(digest, result);
    return result;
  }

  // 文件名带上转换的版本，写法改变后旧的缓存不再命中。
  private cacheFile(digest: string): string {
    return path.join(this.dataDir, "cache", `${CONVERTER_VERSION}-${digest}.json`);
  }

  private async cached(digest: string): Promise<Converted | undefined> {
    let text;
    try {
      text = await readFile(this.cacheFile(digest), "utf8");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    return JSON.parse(text) as Converted;
  }

  /** 先写临时文件再改名，并发的两次转换各写各的，读到的总是完整的一份。 */
  private async store(digest: string, result: Converted): Promise<void> {
    const file = this.cacheFile(digest);
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(result));
      await move(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/** 给模型看的路径一律用 /，Windows 上也一样。 */
function toSpacePath(relative: string): string {
  return relative.split(path.sep).join("/");
}
