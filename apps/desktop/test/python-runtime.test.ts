// @vitest-environment node
import { access } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { workspacePythonDirectories } from "../src/main/python-runtime";

const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

describe("工作区的 Python 运行文件", () => {
  it("找到 Pyodide 目录，同时不给主进程注册信号监听，Electron 收到结束信号时仍按自己的方式退出", async () => {
    const before = SIGNALS.map((signal) => process.listenerCount(signal));
    const directories = await workspacePythonDirectories();
    await access(path.join(directories.pyodide, "pyodide.mjs"));
    expect(SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(before);
  });
});
