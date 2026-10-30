import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { describeRuntime } from "../src/runtime.js";
import { SandboxRunner } from "../src/sandbox.js";
import { RUNTIME, sandboxUnavailable, skipUnavailableEnvironment } from "./environment.js";

const LAUNCHER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "sandbox", "launch.py");

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-python-runner-sandbox-"));
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
  const reason = await sandboxUnavailable();
  if (reason) return skipUnavailableEnvironment(t, reason);
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
  const reason = await sandboxUnavailable();
  if (reason) return skipUnavailableEnvironment(t, reason);
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
  const reason = await sandboxUnavailable();
  if (reason) return skipUnavailableEnvironment(t, reason);
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

test("每个任务从空的工作目录开始：留下的文件、改过的目录、环境变量、sys.path 和 pandas 选项都不带到下一个任务", async (t) => {
  const reason = await sandboxUnavailable();
  if (reason) return skipUnavailableEnvironment(t, reason);
  const sandbox = await runner(t);
  const change = [
    "import os, sys, pandas",
    "open('data.csv', 'w').write('a,b')",
    "open('/tmp/scratch.txt', 'w').write('x')",
    "open('/top.txt', 'w').write('x')",
    "os.makedirs('sub/deeper')",
    "os.chdir('sub')",
    "os.environ['LEFTOVER'] = '1'",
    "sys.path.append('/nowhere')",
    "pandas.set_option('display.max_rows', 3)",
  ].join("\n");
  assert.ok((await sandbox.run({ op: "program", data: [], program: change, captures: [], doctest: [] })).status === "done");
  const read = [
    "import os, sys, pandas",
    "cwd = os.getcwd()",
    "here = sorted(os.listdir('.'))",
    "tmp = sorted(os.listdir('/tmp'))",
    "top = os.path.exists('/top.txt')",
    "leftover = os.environ.get('LEFTOVER')",
    "path = '/nowhere' in sys.path",
    "rows = pandas.get_option('display.max_rows')",
  ].join("\n");
  const outcome = await sandbox.run({ op: "program", data: [], program: read, captures: ["cwd", "here", "tmp", "top", "leftover", "path", "rows"], doctest: [] });
  assert.ok(outcome.status === "done" && outcome.ok);
  assert.deepEqual((outcome.result as { captures: unknown }).captures, {
    cwd: { value: { t: "str", v: "/home/pyodide" } },
    here: { value: { t: "list", v: [] } },
    tmp: { value: { t: "list", v: [] } },
    top: { value: { t: "bool", v: false } },
    leftover: { value: { t: "none" } },
    path: { value: { t: "bool", v: false } },
    rows: { value: { t: "int", v: "60" } },
  });
});

test("运行前导在每个任务的命名空间里先运行：数据夹具、setup、作答代码、期望表达式和核对程序都看得到它的名字；前导出错时报告", async (t) => {
  const reason = await sandboxUnavailable();
  if (reason) return skipUnavailableEnvironment(t, reason);
  const sandbox = await runner(t);
  const prelude = "import numpy as np\nbase = 40";
  const data = [{ kind: "python", label: "fixture", code: "total = base + 1" }];
  const program = await sandbox.run({ op: "program", prelude, data, setup: "total = total + 1", program: "answer = total + int(np.float64(1))", captures: ["answer"], doctest: [] });
  assert.ok(program.status === "done" && program.ok);
  assert.deepEqual((program.result as { captures: unknown }).captures, { answer: { value: { t: "int", v: "43" } } });
  const expect = await sandbox.run({ op: "expect", prelude, data: [], setup: "", exprs: { total: "base + np.int64(2)" } });
  assert.ok(expect.status === "done" && expect.ok);
  assert.deepEqual(expect.result, { total: { value: { t: "int", v: "42" } } });
  const verify = await sandbox.run({
    op: "verify", prelude, data, code: "", blocks: [], options: {}, cells: {}, shape: { value: "text" },
    script: "answers = {'value': base + run('out = total * 2')['out']}",
  });
  assert.ok(verify.status === "done" && verify.ok);
  assert.deepEqual(verify.result, { answers: { value: "122" }, unknown: [] });

  const broken = await sandbox.run({ op: "program", prelude: "import no_such_module", data: [], program: "x = 1", captures: [], doctest: [] });
  assert.ok(broken.status === "done" && !broken.ok);
  assert.match(broken.error.message, /运行前导出错：ModuleNotFoundError/);
});

test("核对程序的辅助函数：出错行号、实际执行的行、函数收到的参数、显示内容的标记和固定格", async (t) => {
  const reason = await sandboxUnavailable();
  if (reason) return skipUnavailableEnvironment(t, reason);
  const sandbox = await runner(t);
  const script = [
    "plain = run(\"x = 1\\ny = 2\\nz = y / 0\\nprint('after')\")",
    "inner = run(\"def f():\\n    return 1 / 0\\n\\nprint('a')\\nf()\")",
    "broken = run(\"print('a')\\nx = (\\n\")",
    "fine = run(\"x = 1\")",
    "ran = executed_lines(\"a = 1\\nif a > 5:\\n    b = 2\\nelse:\\n    b = 3\")",
    "seen = calls(\"def label(signal, limit=10):\\n    gap = signal - limit\\n    return gap > 0\\n\\nlabel(12)\\nlabel(3, limit=5)\", name='label')",
    "answers = {",
    "  'plain': plain.error_line, 'inner': inner.error_line, 'broken': broken.error_line, 'fine': fine.error_line,",
    "  'ran': ran,",
    "  'args': [call.args for call in seen], 'first': seen[0].locals, 'returned': [call.returned for call in seen],",
    "  'nothing': show(None), 'function': show(len), 'value': show([1, 'a']),",
    "  'error': ERROR, 'marked': as_shown('abc'), 'bare': 'abc',",
    "  'cell': CELLS['grid']['r1']['input'],",
    "}",
  ].join("\n");
  const shape = {
    plain: "text", inner: "text", broken: "text", fine: "text", ran: "text", args: "text", first: "text", returned: "text",
    nothing: "display", function: "display", value: "display", error: "display", marked: "display", bare: "display", cell: "text",
  };
  const outcome = await sandbox.run({
    op: "verify", data: [], code: "", blocks: [], options: {}, cells: { grid: { r1: { input: "len('ab')" } } }, script, shape,
  });
  assert.ok(outcome.status === "done" && outcome.ok);
  assert.deepEqual(outcome.result, {
    answers: {
      plain: "3", inner: "2", broken: "2", fine: "None", ran: "[1, 2, 5]",
      args: "[{'signal': 12, 'limit': 10}, {'signal': 3, 'limit': 5}]",
      first: "{'signal': 12, 'limit': 10, 'gap': 2}", returned: "[True, False]",
      nothing: "NOTHING", function: "FUNCTION", value: "[1, 'a']", error: "ERROR", marked: "abc", bare: "'abc'",
      cell: "len('ab')",
    },
    unknown: [],
  });
});

test("分配超过内存上限时 Python 得到 MemoryError，沙箱仍可继续使用", async (t) => {
  const reason = await sandboxUnavailable();
  if (reason) return skipUnavailableEnvironment(t, reason);
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
  const reason = await sandboxUnavailable();
  if (reason) return skipUnavailableEnvironment(t, reason);
  const sandbox = await runner(t);
  // 死循环自己不会结束，得到 timeout 就说明是时限结束了它；整个过程不另计墙钟时间，CI 机器慢时重启沙箱也要几秒。
  const outcome = await sandbox.run({ op: "program", data: [], program: "while True:\n    pass", captures: [], doctest: [] }, 1_500);
  assert.deepEqual(outcome, { status: "timeout" });
  const next = await sandbox.run({ op: "program", data: [], program: "value = 6 * 7", captures: ["value"], doctest: [] });
  assert.ok(next.status === "done" && next.ok);
  assert.deepEqual((next.result as { captures: unknown }).captures, { value: { value: { t: "int", v: "42" } } });
});

test("任务后恢复不了解释器状态时，这个任务记为运行器崩溃，下一个任务换一个新的沙箱", async (t) => {
  const reason = await sandboxUnavailable();
  if (reason) return skipUnavailableEnvironment(t, reason);
  const sandbox = await runner(t);
  // 删掉工作目录，任务后回不到它，恢复就失败。
  const broken = await sandbox.run({ op: "program", data: [], program: "import os, shutil\nos.chdir('/')\nshutil.rmtree(os.path.expanduser('~'))", captures: [], doctest: [] });
  assert.equal(broken.status, "crashed");
  assert.match(broken.status === "crashed" ? broken.detail : "", /无法恢复解释器状态/);
  const next = await sandbox.run({ op: "program", data: [], program: "import os\ncwd = os.getcwd()", captures: ["cwd"], doctest: [] });
  assert.ok(next.status === "done" && next.ok);
  assert.deepEqual((next.result as { captures: unknown }).captures, { cwd: { value: { t: "str", v: "/home/pyodide" } } });
});
