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

function event() {
  const state = { prevented: false };
  return { state, preventDefault: () => { state.prevented = true; } };
}

describe("退出应用", () => {
  it("后端收尾卡住时，第二次退出结束后端进程，应用随即退出", async () => {
    const backend = hangingBackend();
    let quits = 0;
    let quitted: () => void = () => undefined;
    const quit = new Promise<void>((resolve) => { quitted = resolve; });
    const errors: unknown[] = [];
    const handler = createQuitHandler({ backend: () => Promise.resolve(backend.handle), quit: () => { quits++; quitted(); }, report: (error) => { errors.push(error); } });
    const first = event();
    handler.beforeQuit(first);
    expect(first.state.prevented).toBe(true);
    expect(handler.quitting()).toBe(true);
    await Promise.resolve();
    expect(backend.calls).toEqual(["close"]);
    const second = event();
    handler.beforeQuit(second);
    expect(second.state.prevented).toBe(true);
    await quit;
    expect(quits).toBe(1);
    expect(backend.calls).toEqual(["close", "kill"]);
    expect(errors).toHaveLength(1);
    // 收尾结束以后应用自己发起的退出不再拦。
    const last = event();
    handler.beforeQuit(last);
    expect(last.state.prevented).toBe(false);
  });

  it("没有启动后端时直接退出", () => {
    const handler = createQuitHandler({ backend: () => undefined, quit: () => undefined, report: () => undefined });
    const only = event();
    handler.beforeQuit(only);
    expect(only.state.prevented).toBe(false);
  });
});
