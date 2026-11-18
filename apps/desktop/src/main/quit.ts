import type { RepaProcess } from "@repa/base/process";

/**
 * 正常收尾最多等这么久，到期就结束后端进程。Repa 的假设：收尾要停下模型请求、最后备份一次、提交空间历史，
 * 走查里不到 1 秒；会话记录较大、杀毒软件逐个扫描新文件时也应在几秒内完成，这里留得很宽。
 * 必须有期限：Windows 和 Linux 上关掉窗口以后应用没有界面，学习者无法再退出一次；再次打开应用时，
 * 单实例锁把这次启动交给这个没有窗口的进程，什么也不会发生，直到收尾结束。
 */
export const CLOSE_DEADLINE_MS = 60_000;

/**
 * 退出时先请后端正常收尾，等它保存完再退出应用。收尾卡住时，例如插件的 open 或 close 永不返回，
 * 到 CLOSE_DEADLINE_MS 或用户再退出一次（macOS 上没有窗口时仍能退出），就直接结束后端进程，
 * 空间锁留到过期后回收，应用随即退出。到期时报告原因；后端进程写到 stderr 的内容在 close 的异常里一并报告。
 */
export function createQuitHandler(options: {
  backend: () => Promise<RepaProcess> | undefined;
  quit: () => void;
  report: (error: unknown) => void;
  /** 收尾开始时调用，到期时调用 expire，返回取消计时的函数。缺省按 CLOSE_DEADLINE_MS 计时；测试换成手动到期。 */
  deadline?: (expire: () => void) => () => void;
}): { quitting: () => boolean; beforeQuit: (event: { preventDefault(): void }) => void } {
  let state: "running" | "closing" | "killing" | "done" = "running";
  let handle: Promise<RepaProcess> | undefined;
  const deadline = options.deadline ?? ((expire) => {
    const timer = setTimeout(expire, CLOSE_DEADLINE_MS);
    return () => { clearTimeout(timer); };
  });
  // 结束后端进程。正在等的 close 随之以异常退出结束，由它完成退出。
  const kill = () => {
    if (state !== "closing" || handle === undefined) return;
    state = "killing";
    void handle.then((process) => process.kill()).catch(options.report);
  };
  return {
    quitting: () => state !== "running",
    beforeQuit(event) {
      if (state === "done") return;
      if (state === "running") {
        handle = options.backend();
        if (handle === undefined) {
          state = "done";
          return;
        }
        event.preventDefault();
        state = "closing";
        const cancel = deadline(() => {
          if (state !== "closing") return;
          options.report(new Error(`Repa 后端 ${CLOSE_DEADLINE_MS / 1000} 秒内没有收尾完，已结束后端进程。`));
          kill();
        });
        void handle.then((process) => process.close()).catch(options.report).finally(() => {
          cancel();
          state = "done";
          options.quit();
        });
        return;
      }
      // 正在收尾时再退出。
      event.preventDefault();
      kill();
    },
  };
}
