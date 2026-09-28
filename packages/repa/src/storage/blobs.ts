import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { RepaFault } from "../errors.js";
import { atomicWrite, atomicWriteSync } from "./atomic.js";

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
  async get(id: string): Promise<Buffer> {
    let bytes: Buffer;
    try { bytes = await readFile(this.#path(id)); }
    catch (error) {
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
  #path(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new RepaFault("invalid_input", "内容版本标识无效。");
    return path.join(this.directory, id);
  }
}
