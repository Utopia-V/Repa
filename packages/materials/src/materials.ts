import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { RepaFault } from "@repa/base/plugin";

import { convert, sniff } from "./convert.js";
import type { Converted } from "./result.js";

/** 学习者放课件的文件夹，相对空间根目录。 */
export const MATERIALS_DIRECTORY = "materials";

// 转换的写法改变时加一，旧的缓存随之作废、重新转换。
const CONVERTER_VERSION = 1;

/** 一个文件读成文字的结果；plain 是不用转换、直接用 read 读的文字文件。 */
export type Outcome = Converted | { status: "plain" } | { status: "failed"; reason: "unsupported" };

/** 缓存的一项：版本加转换结果。 */
interface CacheEntry {
  version: number;
  result: Converted;
}

/**
 * 读空间里的课件并缓存转换结果。只读空间文件；缓存写在插件的数据目录，以内容的 SHA-256 为键，
 * 同一份内容换了名字、挪了位置也不再转换。
 */
export class Materials {
  // 同一路径的大小和修改时间都没变时沿用上次算出的摘要，列目录时不必把每个文件重读一遍。
  private readonly digests = new Map<string, { size: number; mtimeMs: number; ctimeMs: number; digest: string }>();

  constructor(private readonly root: string, private readonly dataDir: string) {}

  /** materials/ 下的全部文件，按路径排序；文件夹不在时返回 undefined。 */
  async list(signal: AbortSignal): Promise<Array<{ path: string; outcome: Outcome }> | undefined> {
    const directory = path.join(this.root, MATERIALS_DIRECTORY);
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
    for (const file of files) result.push({ path: file, outcome: await this.outcome(path.join(this.root, file), signal) });
    return result;
  }

  /** 读一个空间内的文件；file 相对空间根目录，返回规范化后的路径。 */
  async read(file: string, signal: AbortSignal): Promise<{ path: string; outcome: Outcome }> {
    const absolute = path.resolve(this.root, file);
    const relative = path.relative(this.root, absolute);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new RepaFault("file_outside_space", `${file} 不在空间里；路径相对空间根目录写，例如 ${MATERIALS_DIRECTORY}/第一章.pdf。`);
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
    if (container === "other") return { status: "failed", reason: "unsupported" };
    const info = await stat(file);
    const known = this.digests.get(file);
    let data: Uint8Array | undefined;
    let digest: string;
    if (known !== undefined && known.size === info.size && known.mtimeMs === info.mtimeMs && known.ctimeMs === info.ctimeMs) {
      digest = known.digest;
    } else {
      data = await readFile(file);
      digest = createHash("sha256").update(data).digest("hex");
      this.digests.set(file, { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, digest });
    }
    const cached = await this.cached(digest);
    if (cached !== undefined) return cached;
    const result = await convert(data ?? await readFile(file), container, signal);
    await this.store(digest, result);
    return result;
  }

  private cacheFile(digest: string): string {
    return path.join(this.dataDir, "cache", `${digest}.json`);
  }

  /** 缓存是可以重算的派生数据：没有、版本旧或读不懂时都当作没有，重新转换后覆盖。 */
  private async cached(digest: string): Promise<Converted | undefined> {
    let text;
    try {
      text = await readFile(this.cacheFile(digest), "utf8");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    try {
      const entry = JSON.parse(text) as CacheEntry;
      return entry.version === CONVERTER_VERSION ? entry.result : undefined;
    } catch {
      return undefined;
    }
  }

  /** 先写临时文件再改名，并发的两次转换各写各的，读到的总是完整的一份。 */
  private async store(digest: string, result: Converted): Promise<void> {
    const file = this.cacheFile(digest);
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: CONVERTER_VERSION, result } satisfies CacheEntry));
      await rename(temporary, file);
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
