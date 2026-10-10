import { createHash, randomUUID } from "node:crypto";
import { createReadStream, lstatSync, readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { RepaFault } from "../errors.js";
import { atomicWrite, atomicWriteSync, syncDirectory } from "./atomic.js";

export const digest = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Immutable bytes used by saved content revisions and operation recovery. */
export class BlobStore {
  constructor(readonly directory: string) {}
  async open(): Promise<void> { await mkdir(this.directory, { recursive: true }); }
  async put(bytes: Uint8Array | string): Promise<string> {
    // hash 与落盘使用同一份快照，异步期间调用方可以继续修改自己的缓冲区。
    bytes = typeof bytes === "string" ? bytes : Buffer.from(bytes);
    const id = digest(bytes);
    const file = this.#path(id);
    try {
      if (digest(await readFile(file)) === id) return id;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await atomicWrite(file, bytes);
    return id;
  }
  async importFile(file: string): Promise<string> {
    const temporary = path.join(this.directory, `.repa-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    try {
      try {
        // 源文件由调用方关闭并持有；同一轮读取同时复制和计算内容标识。
        for await (const bytes of createReadStream(file)) {
          hash.update(bytes);
          await handle.writeFile(bytes);
        }
        await handle.chmod(0o600);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const id = hash.digest("hex");
      await rename(temporary, this.#path(id));
      await syncDirectory(this.directory);
      return id;
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async get(id: string, maxBytes?: number): Promise<Buffer> {
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1))
      throw new RepaFault("invalid_input", "读取的字节限额必须为正整数。");
    const checkLimit = (size: number) => {
      if (maxBytes !== undefined && size > maxBytes)
        throw new RepaFault("content_limit", "资源超过读取的字节限额。", { id, size, maxBytes });
    };
    let bytes: Buffer;
    try {
      const handle = await open(this.#path(id), "r");
      try {
        if (maxBytes !== undefined) checkLimit((await handle.stat()).size);
        bytes = await handle.readFile();
        checkLimit(bytes.length);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new RepaFault("revision_unavailable", "所需的内容版本不可用。", { id });
      throw error;
    }
    if (digest(bytes) !== id)
      throw new RepaFault("invalid_storage", "保存的内容版本校验失败。", { id });
    return bytes;
  }
  putSync(bytes: Uint8Array): string {
    const snapshot = Buffer.from(bytes);
    const id = digest(snapshot), file = this.#path(id);
    try { if (digest(readFileSync(file)) === id) return id; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    atomicWriteSync(file, snapshot);
    return id;
  }
  getSync(id: string): Buffer {
    let bytes: Buffer;
    try { bytes = readFileSync(this.#path(id)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new RepaFault("revision_unavailable", "所需的内容版本不可用。", { id });
      throw error;
    }
    if (digest(bytes) !== id) throw new RepaFault("invalid_storage", "保存的内容版本校验失败。", { id });
    return bytes;
  }
  assertAvailableSync(id: string): void {
    try {
      if (!lstatSync(this.#path(id)).isFile())
        throw new RepaFault("invalid_storage", "保存的内容版本不是普通文件。", { id });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new RepaFault("revision_unavailable", "所需的内容版本不可用。", { id });
      throw error;
    }
  }
  #path(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new RepaFault("invalid_input", "内容版本标识无效。");
    return path.join(this.directory, id);
  }
}
