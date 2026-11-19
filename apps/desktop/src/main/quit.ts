import type { RepaProcess } from "@repa/base/process";

/**
 * 退出时先请后端正常收尾，窗口留着，等后端保存完再关窗口、退出应用。收尾平时不到 1 秒；慢的时候页面在
 * 窗口里说明正在退出，并给一个立即退出的按钮，等多久由学习者决定，这里不设期限。
 * 收尾期间再请求退出一次（点这个按钮、再关一次窗口、再按退出快捷键；macOS 上没有窗口时也能这样退出），
 * 就直接结束后端进程，空间锁留到过期后回收，应用随即退出。后端进程写到 stderr 的内容在 close 的异常里一并报告。
 */
export function createQuitHandler(options: {
  backend: () => Promise<RepaProcess> | undefined;
  /** 请求退出应用，即 app.quit()：它先发出 before-quit，由 beforeQuit 处理。 */
  quit: () => void;
  report: (error: unknown) => void;
  /** 收尾开始时调用：主进程借此告诉页面，后端是应用自己关的。 */
  closing: () => void;
}): {
  quitting: () => boolean;
  beforeQuit: (event: { preventDefault(): void }) => void;
  /** 窗口的 close 事件（macOS 以外）：有后端要收尾时拦下，改为退出应用，窗口留到收尾完成。 */
  closeWindow: (event: { preventDefault(): void }) => void;
} {
  let state: "running" | "closing" | "killing" | "done" = "running";
  let handle: Promise<RepaProcess> | undefined;
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
        options.closing();
        void handle.then((process) => process.close()).catch(options.report).finally(() => {
          state = "done";
          options.quit();
        });
        return;
      }
      // 正在收尾时再退出。
      event.preventDefault();
      kill();
    },
    closeWindow(event) {
      // 没有后端时照常关窗口，最后一个窗口关掉以后应用退出；收尾结束后应用自己关窗口，也不再拦。
      if (state === "done" || (state === "running" && options.backend() === undefined)) return;
      event.preventDefault();
      options.quit();
    },
  };
}
