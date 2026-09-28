import { randomUUID } from "node:crypto";
import { closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";

export async function syncDirectory(directory: string): Promise<void> {
  // Windows does not expose fsync for directory handles through Node.
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Replace a file only after its complete new contents have reached storage. */
export async function atomicWrite(
  destination: string,
  bytes: Uint8Array | string,
  mode = 0o600,
  temporary = path.join(path.dirname(destination), `.repa-${randomUUID()}.tmp`),
): Promise<void> {
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, destination);
    await syncDirectory(path.dirname(destination));
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function writeJson(destination: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  await atomicWrite(destination, `${JSON.stringify(value, null, 2)}\n`);
}

/** Pi 的同步消息投影在发布资源引用前完成落盘。 */
export function atomicWriteSync(destination: string, bytes: Uint8Array | string, mode = 0o600): void {
  const temporary = path.join(path.dirname(destination), `.repa-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", mode);
    writeFileSync(fd, bytes);
    fchmodSync(fd, mode);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temporary, destination);
    if (process.platform !== "win32") {
      const directory = openSync(path.dirname(destination), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

export function writeJsonSync(destination: string, value: unknown): void {
  mkdirSync(path.dirname(destination), { recursive: true });
  atomicWriteSync(destination, `${JSON.stringify(value, null, 2)}\n`);
}

/** 一份空间中的程序修改共用该队列，失败不会阻塞后续读取与恢复。 */
export class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work);
    this.#tail = result.catch(() => {});
    return result;
  }
  async settled(): Promise<void> { await this.#tail; }
}
