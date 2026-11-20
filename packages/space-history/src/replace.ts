import { rename } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Windows 上重试前依次等待的毫秒数：间隔逐次加倍，共 8 次，合计约 2.5 秒，与底座 storage.ts 的 move 相同。
 * Repa 的假设：编辑器、杀毒软件或同步盘打开刚写过的文件通常不到一秒；占用更久就不是短暂的，按原错误报出。
 */
const DELAYS: readonly number[] = [10, 20, 40, 80, 160, 320, 640, 1280];

/** replace 用到的改名与等待；测试换成假的，不按时间等。 */
export interface ReplaceIo {
  rename(from: string, to: string): Promise<void>;
  wait(ms: number): Promise<void>;
}

const fsReplace: ReplaceIo = { rename, wait: async (ms) => { await sleep(ms); } };

/**
 * 改名，目标已存在时覆盖它。Windows 上目标正被另一个句柄打开时，改名以 EPERM、EACCES 或 EBUSY 失败，
 * 对方关掉后就能成功：按间隔重试，用完仍失败时抛出最后一次的原错误。其他平台、其他错误码不重试。
 * 空间历史不依赖底座，所以这里另写一份，而不引用底座的 move。
 */
export async function replace(from: string, to: string, platform: NodeJS.Platform = process.platform, io: ReplaceIo = fsReplace): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await io.rename(from, to);
      return;
    } catch (error) {
      const delay = DELAYS[attempt];
      const busy = error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES" || error.code === "EBUSY");
      if (platform !== "win32" || delay === undefined || !busy) throw error;
      await io.wait(delay);
    }
  }
}
