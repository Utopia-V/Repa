// 在真实 Electron 里检查：连着收到两个 SIGTERM 或 SIGINT 时，Desktop 仍正常退出，并等后端关闭后才结束。
// 只有真实 Electron 才有 Chromium 的信号处理，ELECTRON_RUN_AS_NODE 或 Vitest 里复现不了。先运行 npm run build。
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const desktop = fileURLToPath(new URL("..", import.meta.url));
const electron = createRequire(import.meta.url)("electron");

if (process.platform === "win32") throw new Error("Windows 没有 POSIX 信号，这项检查只在 macOS 和 Linux 上运行。");
try {
  await access(path.join(desktop, "out/main/index.js"));
} catch {
  throw new Error("缺少 out/main/index.js，先运行 npm run build --workspace=@repa/desktop。");
}

async function until(read, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${timeoutMs / 1000} 秒内没有等到${description}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function backendOf(parent) {
  const { stdout } = await exec("ps", ["-A", "-o", "pid=,ppid=,command="]);
  for (const line of stdout.split("\n")) {
    const [pid, ppid, ...command] = line.trim().split(/\s+/);
    if (Number(ppid) === parent && command.join(" ").includes("cli.js serve")) return Number(pid);
  }
  return undefined;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function trial(signal) {
  // 后端用默认的 home，HOME 指向临时目录，不碰本机的 Repa 数据。
  const home = await mkdtemp(path.join(os.tmpdir(), "repa-desktop-quit-"));
  const child = spawn(electron, [desktop], { env: { ...process.env, HOME: home }, stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("exit", (code, received) => resolve({ code, signal: received })));
  let backend;
  try {
    backend = await until(() => backendOf(child.pid), "后端启动");
    child.kill(signal);
    child.kill(signal);
    let timer;
    const result = await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), 30_000); })]);
    clearTimeout(timer);
    assert.deepEqual(result, { code: 0, signal: null }, `连着两个 ${signal} 后 Electron 应当正常退出`);
    assert.equal(alive(backend), false, `Electron 退出时后端（${backend}）应当已经关闭`);
    return { signal, electron: result, backendClosed: true };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (backend !== undefined && alive(backend)) process.kill(backend, "SIGKILL");
    await rm(home, { recursive: true, force: true });
  }
}

console.log(JSON.stringify([await trial("SIGTERM"), await trial("SIGINT")], null, 2));
