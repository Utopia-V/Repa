import type { RepaProcess } from "@repa/base/process";

/**
 * 退出时先请后端正常收尾，等它保存完再退出应用。插件的 open 或 close 永不返回时，正常收尾一直不结束；
 * 用户再退出一次，就直接结束后端进程，空间锁留到过期后回收，应用随即退出。
 */
export function createQuitHandler(options: {
  backend: () => Promise<RepaProcess> | undefined;
  quit: () => void;
  report: (error: unknown) => void;
}): { quitting: () => boolean; beforeQuit: (event: { preventDefault(): void }) => void } {
  let state: "running" | "closing" | "killing" | "done" = "running";
  let handle: Promise<RepaProcess> | undefined;
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
        void handle.then((process) => process.close()).catch(options.report).finally(() => {
          state = "done";
          options.quit();
        });
        return;
      }
      // 正在收尾时再退出：结束后端进程。上面的 close 随之以异常退出结束，由它完成退出。
      event.preventDefault();
      if (state === "closing" && handle !== undefined) {
        state = "killing";
        void handle.then((process) => process.kill()).catch(options.report);
      }
    },
  };
}
