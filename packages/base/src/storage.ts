import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";

/** 同步目录项；Windows 不支持对目录调用 fsync，改名后的目录项由 NTFS 日志保证。 */
export async function syncDirectory(directory: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Windows 上改名重试前依次等待的毫秒数：间隔逐次加倍，共 8 次，合计约 2.5 秒。Repa 的假设：
 * 备份复制一个小文件只占用它几毫秒，Defender 实时扫描、OneDrive 同步打开刚写过的文件通常不到一秒；
 * 占用超过这段时间就不是短暂的，按原错误报出。
 */
export const MOVE_DELAYS: readonly number[] = [10, 20, 40, 80, 160, 320, 640, 1280];

/** move 用到的改名与等待；测试换成假的，不碰文件系统也不按时间等。 */
export interface MoveIo {
  rename(from: string, to: string): Promise<void>;
  wait(ms: number): Promise<void>;
}

const fsMove: MoveIo = { rename, wait: async (ms) => { await sleep(ms); } };

/**
 * 改名，目标已存在时覆盖它。Windows 上来源或目标正被另一个句柄打开时（Repa 自己的备份正在复制它、杀毒软件扫描、同步盘读取），
 * 改名以 EPERM、EACCES 或 EBUSY 失败，对方关掉文件后就能成功：按 MOVE_DELAYS 等待并重试，用完仍失败时抛出最后一次的原错误。
 * 其他平台上改名不受打开的句柄影响，不重试；其他错误码也不重试。
 */
export async function move(from: string, to: string, platform: NodeJS.Platform = process.platform, io: MoveIo = fsMove): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await io.rename(from, to);
      return;
    } catch (error) {
      const delay = MOVE_DELAYS[attempt];
      if (platform !== "win32" || delay === undefined || !isSharingViolation(error)) throw error;
      await io.wait(delay);
    }
  }
}

function isSharingViolation(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES" || error.code === "EBUSY");
}

/** 同目录原子替换写 JSON；文件同步并按平台完成目录同步后才向调用方报告保存成功。 */
export async function writeJson(file: string, value: unknown): Promise<void> {
  await writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeText(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.repa-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await move(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally {
    await rm(temporary, { force: true });
  }
}

export class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(action);
    this.#tail = result.catch(() => {});
    return result;
  }

  async settled(): Promise<void> {
    await this.#tail;
  }
}
