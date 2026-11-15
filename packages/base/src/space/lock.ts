import path from "node:path";

import lockfile from "proper-lockfile";

import { RepaFault } from "../schema.js";

/**
 * 取得空间锁 `.repa/lock`，打开空间与从备份恢复共用；空间已在别处打开时报 space_locked。
 * 异常退出留下的锁 30 秒后视为过期，可以回收；正常释放立即生效。锁失效时调用 onCompromised。
 */
export async function lockSpace(root: string, onCompromised: (error: Error) => void): Promise<() => Promise<void>> {
  try {
    return await lockfile.lock(root, {
      lockfilePath: path.join(root, ".repa", "lock"),
      realpath: true,
      retries: 0,
      stale: 30_000,
      update: 10_000,
      onCompromised,
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ELOCKED") {
      throw new RepaFault("space_locked", "空间正由另一个 Repa 使用；上次没有正常关闭时，约 30 秒后可重新打开", { root });
    }
    throw error;
  }
}
