// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { RepaProcess } from "@repa/base/process";

import { createQuitHandler } from "../src/main/quit";

/** 正常关闭永不结束的后端，记下 close 与 kill；kill 以后 close 以异常退出结束，与真实进程句柄相同。 */
function hangingBackend() {
  const calls: string[] = [];
  let exit: (error: Error) => void = () => undefined;
  const exited = new Promise<void>((_resolve, reject) => { exit = reject; });
  exited.catch(() => undefined);
  const handle = {
    connection: { url: "ws://127.0.0.1:1/rpc", token: "t" },
    closed: exited,
    close: () => { calls.push("close"); return exited; },
    kill: async () => { calls.push("kill"); exit(new Error("Repa 后端异常退出（SIGKILL）。")); },
  } satisfies RepaProcess;
  return { handle, calls };
}

/** 收尾完成之前可控的后端：finish() 让 close 正常结束。 */
function closingBackend() {
  const calls: string[] = [];
  let finish: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => { finish = resolve; });
  const handle = {
    connection: { url: "ws://127.0.0.1:1/rpc", token: "t" },
    closed: exited,
    close: () => { calls.push("close"); return exited; },
    kill: () => { calls.push("kill"); return Promise.resolve(); },
  } satisfies RepaProcess;
  return { handle, calls, finish };
}

function event() {
  const state = { prevented: false };
  return { state, preventDefault: () => { state.prevented = true; } };
}

/**
 * 按 Electron 的次序模拟 Windows、Linux 上的应用：app.quit() 先发 before-quit，没被拦下才关窗口；
 * 窗口的 close 事件交给 closeWindow，没被拦下就关掉窗口，最后一个窗口关掉以后应用退出。
 */
function simulatedApp(backend: () => Promise<RepaProcess> | undefined) {
  const log: string[] = [];
  const errors: unknown[] = [];
  let exited: () => void = () => undefined;
  const exit = new Promise<void>((resolve) => { exited = resolve; });
  let windowOpen = true;
  const closeWindow = () => {
    const close = event();
    handler.closeWindow(close);
    if (close.state.prevented || !windowOpen) return;
    windowOpen = false;
    log.push("window closed");
    quit();
  };
  const quit = () => {
    const before = event();
    handler.beforeQuit(before);
    if (before.state.prevented) return;
    if (windowOpen) {
      // 窗口拦下 close 时 Electron 取消这次退出。
      const close = event();
      handler.closeWindow(close);
      if (close.state.prevented) return;
      windowOpen = false;
      log.push("window closed");
    }
    log.push("exit");
    exited();
  };
  const handler = createQuitHandler({
    backend,
    quit,
    report: (error) => { errors.push(error); },
    closing: () => { log.push("closing"); },
  });
  return { handler, log, errors, exit, closeWindow, quit };
}

describe("退出应用", () => {
  it("关窗口时窗口留着，告诉页面正在收尾；后端收尾完以后才关窗口、退出", async () => {
    const backend = closingBackend();
    const app = simulatedApp(() => Promise.resolve(backend.handle));
    app.closeWindow();
    await Promise.resolve();
    expect(app.log).toEqual(["closing"]);
    expect(backend.calls).toEqual(["close"]);
    expect(app.handler.quitting()).toBe(true);
    backend.finish();
    await app.exit;
    expect(app.log).toEqual(["closing", "window closed", "exit"]);
    expect(backend.calls).toEqual(["close"]);
    expect(app.errors).toEqual([]);
  });

  it("后端收尾卡住时一直等，不会自己结束后端进程", async () => {
    const backend = hangingBackend();
    const app = simulatedApp(() => Promise.resolve(backend.handle));
    app.quit();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(backend.calls).toEqual(["close"]);
    expect(app.log).toEqual(["closing"]);
  });

  it.each([
    ["页面上的“立即退出”或再按一次退出快捷键", "quit"],
    ["再关一次窗口", "closeWindow"],
  ] as const)("收尾卡住时%s：结束后端进程，应用随即退出", async (_name, again) => {
    const backend = hangingBackend();
    const app = simulatedApp(() => Promise.resolve(backend.handle));
    app.closeWindow();
    await Promise.resolve();
    expect(backend.calls).toEqual(["close"]);
    app[again]();
    await app.exit;
    expect(backend.calls).toEqual(["close", "kill"]);
    expect(app.log).toEqual(["closing", "window closed", "exit"]);
    expect(String(app.errors[0])).toContain("SIGKILL");
    // 正在结束时又请求一次，不再重复结束。
    app.quit();
    expect(backend.calls).toEqual(["close", "kill"]);
  });

  it("没有启动后端时直接退出：窗口照常关掉，不通知页面", () => {
    const app = simulatedApp(() => undefined);
    app.closeWindow();
    expect(app.log).toEqual(["window closed", "exit"]);
    const quit = simulatedApp(() => undefined);
    quit.quit();
    expect(quit.log).toEqual(["window closed", "exit"]);
  });
});
