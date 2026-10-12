import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { describeRuntime } from "../src/sandbox/runtime.js";
import { SandboxRunner } from "../src/sandbox/session.js";
import { RUNTIME, runtimeUnavailable } from "./demo-course.js";

const LAUNCHER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "sandbox", "launch.py");

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-learning-sandbox-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function runner(t: TestContext): Promise<SandboxRunner> {
  const sandbox = new SandboxRunner({ assets: await describeRuntime(RUNTIME) });
  t.after(() => sandbox.close());
  return sandbox;
}

/** 直接用 launch.py 的限制运行一段 Node 脚本，返回它打印的 JSON。 */
async function launch(script: string): Promise<Record<string, string>> {
  const node = await realpath(process.execPath);
  const config = {
    read: ["/usr", "/etc/ld.so.cache"], write: ["/dev/null"], memory: 2 * 1024 ** 3, cpuSeconds: 60,
    env: { OPENSSL_CONF: "/dev/null" }, argv: [node, "-e", script],
  };
  const child = spawn("/usr/bin/python3", ["-I", "-S", LAUNCHER, JSON.stringify(config)], { stdio: ["ignore", "pipe", "pipe"], env: {} });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout) as Record<string, string>;
}

test("受限的进程读不到宿主文件、写不了文件、建不了新进程、不能向别的进程发信号或调优先级，也连不上本机端口", async (t) => {
  const reason = await runtimeUnavailable();
  if (reason) return t.skip(reason);
  const directory = await temporaryDirectory(t);
  const secret = path.join(directory, "secret.txt");
  await writeFile(secret, "不应被读到");
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as net.AddressInfo).port;

  const results = await launch(`
    const fs = require("node:fs");
    const out = {};
    const attempt = (name, action) => { try { action(); out[name] = "allowed"; } catch (error) { out[name] = error.info?.code ?? error.code; } };
    attempt("read", () => fs.readFileSync(${JSON.stringify(secret)}));
    attempt("list", () => fs.readdirSync(${JSON.stringify(directory)}));
    attempt("write", () => fs.writeFileSync(${JSON.stringify(path.join(directory, "written.txt"))}, "x"));
    attempt("signal", () => process.kill(process.ppid, 0));
    attempt("group", () => process.kill(0, 0));
    attempt("priority", () => require("node:os").setPriority(process.ppid, 19));
    attempt("self", () => process.kill(process.pid, 0));
    const spawned = require("node:child_process").spawnSync(process.execPath, ["-e", "1"]);
    out.spawn = spawned.error ? spawned.error.code : "allowed";
    const socket = require("node:net").connect(${port}, "127.0.0.1");
    socket.on("connect", () => { out.connect = "allowed"; console.log(JSON.stringify(out)); process.exit(0); });
    socket.on("error", (error) => { out.connect = error.code; console.log(JSON.stringify(out)); });
  `);
  assert.deepEqual(results, {
    read: "EACCES", list: "EACCES", write: "EACCES", signal: "EPERM", group: "EPERM", priority: "EPERM", self: "allowed",
    spawn: "EPERM", connect: "EACCES",
  });
  assert.equal(connections, 0);
  assert.deepEqual(await readdir(directory), ["secret.txt"]);
});

test("Pyodide 里的 Python 拿不到 Node 的 process、require 和 Function 构造器", async (t) => {
  const reason = await runtimeUnavailable();
  if (reason) return t.skip(reason);
  const sandbox = await runner(t);
  const program = [
    "import js",
    "reachable = [name for name in ('process', 'require', 'fetch', 'setTimeout', 'globalThis', 'constructor') if hasattr(js, name)]",
  ].join("\n");
  const outcome = await sandbox.run({ op: "program", data: [], program, captures: ["reachable"], doctest: [] });
  assert.ok(outcome.status === "done" && outcome.ok);
  assert.deepEqual((outcome.result as { captures: unknown }).captures, { reachable: { value: { t: "list", v: [] } } });
});

test("一个任务改动的 pandas 选项、NumPy 显示设置和 builtins，在下一个任务前恢复原样", async (t) => {
  const reason = await runtimeUnavailable();
  if (reason) return t.skip(reason);
  const sandbox = await runner(t);
  const change = [
    "import builtins, numpy, pandas",
    "pandas.set_option('display.precision', 1)",
    "numpy.set_printoptions(precision=1)",
    "builtins.len = lambda value: 99",
  ].join("\n");
  assert.ok((await sandbox.run({ op: "program", data: [], program: change, captures: [], doctest: [] })).status === "done");
  const read = "import numpy, pandas\nprecision = pandas.get_option('display.precision')\nshown = repr(numpy.array([0.123456]))\nsize = len([1, 2])";
  const outcome = await sandbox.run({ op: "program", data: [], program: read, captures: ["precision", "shown", "size"], doctest: [] });
  assert.ok(outcome.status === "done" && outcome.ok);
  assert.deepEqual((outcome.result as { captures: unknown }).captures, {
    precision: { value: { t: "int", v: "6" } },
    shown: { value: { t: "str", v: "array([0.123456])" } },
    size: { value: { t: "int", v: "2" } },
  });
});

test("分配超过内存上限时 Python 得到 MemoryError，沙箱仍可继续使用", async (t) => {
  const reason = await runtimeUnavailable();
  if (reason) return t.skip(reason);
  const sandbox = await runner(t);
  // Pyodide 是 32 位，单个对象不能超过 2 GiB；分块申请才会碰到 RLIMIT_DATA 的上限。
  const program = "chunks = []\nfor _ in range(16):\n    chunks.append(bytearray(256 * 1024 ** 2))";
  const outcome = await sandbox.run({ op: "program", data: [], program, captures: [], doctest: [] });
  assert.ok(outcome.status === "done" && outcome.ok);
  assert.equal((outcome.result as { error: { type: string } | null }).error?.type, "MemoryError");
  const next = await sandbox.run({ op: "program", data: [], program: "x = 1", captures: ["x"], doctest: [] });
  assert.ok(next.status === "done" && next.ok);
});

test("超时的任务结束整个进程，下一个任务换一个新的沙箱", async (t) => {
  const reason = await runtimeUnavailable();
  if (reason) return t.skip(reason);
  const sandbox = await runner(t);
  const started = Date.now();
  const outcome = await sandbox.run({ op: "program", data: [], program: "while True:\n    pass", captures: [], doctest: [] }, 1_500);
  assert.deepEqual(outcome, { status: "timeout" });
  assert.ok(Date.now() - started < 5_000);
  const next = await sandbox.run({ op: "program", data: [], program: "value = 6 * 7", captures: ["value"], doctest: [] });
  assert.ok(next.status === "done" && next.ok);
  assert.deepEqual((next.result as { captures: unknown }).captures, { value: { value: { t: "int", v: "42" } } });
});
