import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";

import { contentVersion } from "@repa/base/protocol";

import { PYTHON_BATCH, type PythonBatchInput, type PythonBatchResult } from "../src/protocol.js";
import type { WorkerRequest } from "../src/python-runner/messages.js";
import { loadRuntimeFiles, PythonRunner, type RunnerWorker, type RuntimeFiles } from "../src/python-runner/runner.js";

const runnerSource = await readFile(new URL("../sandbox/runner.py", import.meta.url), "utf8");
const ASSETS_URL = "http://127.0.0.1:5173/__repa/pyodide/";
const job = { program: "print(1)", prelude: "", setup: "", data: [], captures: [], doctest: [] };
const input: PythonBatchInput = {
  protocol: PYTHON_BATCH,
  kind: "execute",
  submissionId: "sub-1",
  gradeRevision: 2,
  runtime: { pyodide: "314.0.7", python: "3.14.2", packages: { numpy: "2.4.6", pandas: "3.0.2" }, prelude: "import pandas as pd" },
  runner: "sha256:expected",
  tests: [{ id: "a", ...job }, { id: "b", ...job }, { id: "c", ...job }],
};
/** Worker 报告的是全部加载的包，包括依赖。 */
const loaded = { pyodide: "314.0.7", python: "3.14.2", packages: { numpy: "2.4.6", pandas: "3.0.2", six: "1.17.0" } };
const program = { stdout: "1\n", error: null, captures: {}, doctest: [] };
const completed = { status: "completed" as const, result: program };
const files: RuntimeFiles = { lock: "{}", packages: ["pandas"], files: { "pyodide.asm.wasm": new Uint8Array([1, 2]).buffer } };

type RunRequest = Extract<WorkerRequest, { type: "run" }>;
/** 给第 test 个测试的回复：报告的阶段和结果；返回 undefined 就是卡在最后报告的阶段。 */
type Script = (test: number, request: RunRequest) => { phases: [string, number | null][]; response?: unknown };
type Respond = (request: WorkerRequest, worker: FakeWorker) => void;

/** 按 respond 应答的 Worker 替身；不应答就是卡住。 */
class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string; preventDefault(): void }) => void) | null = null;
  readonly requests: WorkerRequest[] = [];
  terminated = false;

  constructor(private readonly respond: Respond) {}

  postMessage(request: WorkerRequest): void {
    this.requests.push(request);
    queueMicrotask(() => this.respond(request, this));
  }

  terminate(): void {
    this.terminated = true;
  }

  send(data: unknown): void {
    if (!this.terminated) this.onmessage?.({ data });
  }
}

/** 正常启动的 Worker，测试按 script 运行，和真正的 Worker 一样在测试没有正常结束时停下。 */
function healthy(script: Script = () => ({ phases: [["prepare", null], ["program", null]], response: completed })): Respond {
  return (request, worker) => {
    if (request.type === "start") {
      worker.send({ type: "ready", runtime: loaded });
      return;
    }
    for (const [test] of request.tests.entries()) {
      const { phases, response } = script(test, request);
      for (const [phase, index] of phases) worker.send({ type: "phase", test, phase, index });
      if (response === undefined) return;
      worker.send({ type: "tested", test, response });
      if ((response as { status?: unknown }).status !== "completed") return;
    }
  };
}

interface FixtureOptions {
  testTimeoutMs?: number;
  startTimeoutMs?: number;
  loadFiles?: () => Promise<RuntimeFiles>;
}

function fixture(respond: Respond | Respond[], options: FixtureOptions = {}) {
  const responders = Array.isArray(respond) ? respond : [respond];
  const workers: FakeWorker[] = [];
  let downloads = 0;
  const runner = new PythonRunner({
    assetsUrl: ASSETS_URL,
    runnerSource,
    loadFiles: () => {
      downloads += 1;
      return Promise.resolve(files);
    },
    createWorker: () => {
      const worker = new FakeWorker(responders[Math.min(workers.length, responders.length - 1)]!);
      workers.push(worker);
      return worker as unknown as RunnerWorker;
    },
    ...options,
  });
  return { runner, workers, downloads: () => downloads };
}

/** 等到 check 成立；一秒内不成立就失败，并带上 state 给出的状态。 */
async function until(check: () => boolean, state: () => unknown = () => undefined): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`等待超时：${JSON.stringify(state())}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const types = (worker: FakeWorker | undefined) => worker?.requests.map((request) => request.type);
const statuses = (result: PythonBatchResult) => result.tests.map((entry) => entry.status);

async function rejectsWith(promise: Promise<unknown>, code: string, message?: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, code);
    if (message !== undefined) assert.equal((error as Error).message, message);
    return true;
  });
}

test("一批测试在一个新 Worker 里按顺序运行；结果带回提交身份，报告问到的包的实际版本和 runner.py 的 contentVersion", async () => {
  const { runner, workers } = fixture(healthy());
  const result = await runner.run(input);

  assert.deepEqual(result, {
    protocol: PYTHON_BATCH,
    submissionId: "sub-1",
    gradeRevision: 2,
    runtime: { pyodide: "314.0.7", python: "3.14.2", packages: { numpy: "2.4.6", pandas: "3.0.2" } },
    runner: await contentVersion(runnerSource),
    freshInterpreter: true,
    tests: input.tests.map(({ id }) => ({ id, ...completed })),
  } satisfies PythonBatchResult);
  const [start, run] = workers[0]!.requests;
  assert.equal(start?.type, "start");
  if (start?.type !== "start") return;
  assert.equal(start.indexURL, ASSETS_URL);
  assert.equal(start.packageBaseUrl, `${ASSETS_URL}packages/`);
  assert.deepEqual(start.packages, ["pandas"]);
  assert.equal(start.runner, runnerSource);
  assert.notEqual(start.files["pyodide.asm.wasm"], files.files["pyodide.asm.wasm"]);
  assert.deepEqual(run, { type: "run", tests: input.tests });
  assert.equal(workers[0]?.terminated, true);
});

test("课程要求的包没有加载时不出现在结果里，由后端判断环境不符", async () => {
  const { runner } = fixture(healthy());
  const result = await runner.run({ ...input, runtime: { ...input.runtime, packages: { pandas: "3.0.2", scipy: "1.16.0" } } });
  assert.deepEqual(result.runtime.packages, { pandas: "3.0.2" });
});

test("探测报告预热 Worker 的环境，不运行代码；之后的调用用的就是这个 Worker", async () => {
  const { runner, workers } = fixture(healthy());
  assert.deepEqual(await runner.capabilities(), {
    protocol: PYTHON_BATCH,
    runtime: { pyodide: "314.0.7", python: "3.14.2", packages: { numpy: "2.4.6", pandas: "3.0.2" } },
    runner: await contentVersion(runnerSource),
    freshInterpreter: true,
  });
  await runner.capabilities();
  assert.equal(workers.length, 1);
  assert.deepEqual(types(workers[0]), ["start"]);

  await runner.run(input);
  assert.deepEqual(types(workers[0]), ["start", "run"]);
});

test("探测时 Pyodide 起不来就以 runtime_unavailable 结束", async () => {
  const notIsolated: Respond = (request, worker) => {
    if (request.type === "start") worker.send({ type: "failed", message: "Python 运行环境没有隔离" });
  };
  const { runner } = fixture(notIsolated);
  await rejectsWith(runner.capabilities(), "runtime_unavailable", "Python 运行环境没有隔离");
});

test("每次调用都用另一个 Worker：上一次结束后预热下一个，文件只下载一次", async () => {
  const { runner, workers, downloads } = fixture(healthy());
  await runner.run(input);
  await until(() => workers.length === 2, () => workers.length);
  assert.deepEqual(types(workers[1]), ["start"]);

  await runner.run({ ...input, submissionId: "sub-2" });
  assert.deepEqual(types(workers[1]), ["start", "run"]);
  assert.equal(workers[1]?.terminated, true);
  assert.equal(downloads(), 1);
});

test("测试超时就结束 Worker，结果写明停在哪个阶段，之后的测试未执行", async () => {
  const stuck = healthy((test) => test === 0
    ? { phases: [["program", null]], response: completed }
    : { phases: [["program", null], ["capture", 0], ["serialize", 0], ["doctest", 1]] });
  const { runner, workers } = fixture(stuck, { testTimeoutMs: 20 });

  const result = await runner.run(input);
  assert.deepEqual(statuses(result), ["completed", "timeout", "not_run"]);
  assert.deepEqual(result.tests[1], { id: "b", status: "timeout", phase: "doctest" });
  assert.equal(workers[0]?.terminated, true);
});

test("卡在学习者代码之外时阶段照实写出：准备和收尾是 timeout，序列化 capture 的值卡住是 capture 阶段的 failed", async () => {
  const preparing = fixture(healthy(() => ({ phases: [["prepare", null]] })), { testTimeoutMs: 20 });
  assert.deepEqual((await preparing.runner.run(input)).tests, [
    { id: "a", status: "timeout", phase: "prepare" },
    { id: "b", status: "not_run" },
    { id: "c", status: "not_run" },
  ]);

  const cleaning = fixture(healthy(() => ({ phases: [["program", null], ["cleanup", null]] })), { testTimeoutMs: 20 });
  assert.deepEqual((await cleaning.runner.run(input)).tests[0], { id: "a", status: "timeout", phase: "cleanup" });

  const serializing = fixture(healthy(() => ({ phases: [["capture", 0], ["serialize", 0]] })), { testTimeoutMs: 20 });
  assert.deepEqual((await serializing.runner.run(input)).tests[0], {
    id: "a", status: "failed", phase: "capture", error: { type: "TimeoutError", message: "序列化 capture 的值超过 0.02 秒" },
  });
});

test("每个测试单独计时：各自没超时的测试加起来超过期限也照常完成", async () => {
  const slow: Respond = (request, worker) => {
    if (request.type === "start") return worker.send({ type: "ready", runtime: loaded });
    void (async () => {
      for (const [test] of request.tests.entries()) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        worker.send({ type: "tested", test, response: completed });
      }
    })();
  };
  const { runner } = fixture(slow, { testTimeoutMs: 30 });
  assert.deepEqual(statuses(await runner.run(input)), ["completed", "completed", "completed"]);
});

test("没有测试时不运行，直接交回空结果", async () => {
  const { runner, workers } = fixture(healthy());
  const result = await runner.run({ ...input, tests: [] });
  assert.equal(result.submissionId, "sub-1");
  assert.deepEqual(result.tests, []);
  assert.deepEqual(types(workers[0]), ["start"]);
});

test("前导、夹具或 setup 出错时整批停下；Worker 出错或回复无法识别时记为当前阶段的失败", async () => {
  const setupFailed = { status: "failed", phase: "prepare", error: { type: "RuntimeError", message: "测试的 setup 出错" } };
  const failing = fixture(healthy((test) => ({ phases: [], response: test === 1 ? setupFailed : completed })));
  assert.deepEqual((await failing.runner.run(input)).tests, [{ id: "a", ...completed }, { id: "b", ...setupFailed }, { id: "c", status: "not_run" }]);

  const garbled = fixture(healthy(() => ({ phases: [["program", null]], response: { status: "completed", result: { stdout: 1 } } })));
  assert.deepEqual((await garbled.runner.run(input)).tests, [
    { id: "a", status: "failed", phase: "program", error: { type: "WorkerError", message: "运行器返回了无法识别的结果" } },
    { id: "b", status: "not_run" },
    { id: "c", status: "not_run" },
  ]);

  const crashing: Respond = (request, worker) => {
    if (request.type === "start") return worker.send({ type: "ready", runtime: loaded });
    worker.send({ type: "phase", test: 0, phase: "serialize", index: 0 });
    worker.onerror?.({ message: "out of memory", preventDefault: () => {} });
  };
  const crashed = fixture(crashing);
  assert.deepEqual((await crashed.runner.run(input)).tests[0], {
    id: "a", status: "failed", phase: "capture", error: { type: "WorkerError", message: "Python 运行器出错：out of memory" },
  });
  assert.equal(crashed.workers[0]?.terminated, true);
});

test("Pyodide 没在期限内就绪、报告失败或报告不出运行环境时以 runtime_unavailable 结束，下一次重新启动", async () => {
  const silent: Respond = () => {};
  const notIsolated: Respond = (request, worker) => {
    if (request.type === "start") worker.send({ type: "failed", message: "Python 运行环境没有隔离" });
  };
  const noVersions: Respond = (request, worker) => {
    if (request.type === "start") worker.send({ type: "ready", runtime: { pyodide: "314.0.7" } });
  };
  const { runner, workers } = fixture([silent, notIsolated, noVersions, healthy()], { startTimeoutMs: 20 });

  await rejectsWith(runner.run(input), "runtime_unavailable", "Pyodide 在 0.02 秒内没有就绪");
  await rejectsWith(runner.run(input), "runtime_unavailable", "Python 运行环境没有隔离");
  await rejectsWith(runner.run(input), "runtime_unavailable", "Python 运行器报告的运行环境无法识别");
  assert.deepEqual(statuses(await runner.run(input)), ["completed", "completed", "completed"]);
  assert.deepEqual(workers.slice(0, 3).map((worker) => worker.terminated), [true, true, true]);
});

test("启动期限从下载文件算起", async () => {
  const { runner, workers } = fixture(healthy(), { startTimeoutMs: 20, loadFiles: () => new Promise(() => {}) });
  await rejectsWith(runner.run(input), "runtime_unavailable");
  assert.equal(workers.length, 0);
});

test("取消正在进行的调用会结束 Worker，不交回结果；已取消的调用不启动 Worker", async () => {
  const { runner, workers } = fixture(healthy(() => ({ phases: [["program", null]] })));
  const controller = new AbortController();
  const running = runner.run(input, controller.signal);
  await until(() => workers[0]?.requests.length === 2, () => types(workers[0]));
  controller.abort();

  await rejectsWith(running, "cancelled");
  assert.equal(workers[0]?.terminated, true);
  const count = workers.length;
  await rejectsWith(runner.run(input, AbortSignal.abort()), "cancelled");
  assert.equal(workers.length, count);
});

test("close 结束预热的 Worker，取消正在进行的调用，之后不再预热", async () => {
  const { runner, workers } = fixture(healthy());
  await runner.run(input);
  await until(() => workers.length === 2, () => workers.length);
  runner.close();
  await until(() => workers[1]?.terminated === true);

  const stuck = fixture(healthy(() => ({ phases: [["program", null]] })));
  const running = stuck.runner.run(input);
  await until(() => stuck.workers[0]?.requests.length === 2, () => types(stuck.workers[0]));
  stuck.runner.close();
  await rejectsWith(running, "cancelled");
  assert.equal(stuck.workers[0]?.terminated, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(stuck.workers.length, 1);
});

const wheel = new TextEncoder().encode("wheel");

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 用替身 fetch 提供 Pyodide 文件，测试结束时换回原来的；返回请求过的路径。 */
function serve(t: TestContext, sha: string, sixFile = "six.whl"): string[] {
  const lock = {
    packages: {
      numpy: { file_name: "numpy.whl", sha256: sha, depends: [] },
      pandas: { file_name: "pandas.whl", sha256: sha, depends: ["numpy", "six"] },
      six: { file_name: sixFile, sha256: sha, depends: [] },
      scipy: { file_name: "scipy.whl", sha256: sha, depends: [] },
    },
  };
  const requested: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (url) => {
    const { pathname } = new URL(url instanceof Request ? url.url : url);
    requested.push(pathname);
    const name = pathname.split("/").pop();
    if (name === "pyodide-lock.json") return Promise.resolve(new Response(JSON.stringify(lock)));
    if (name === "missing.whl") return Promise.resolve(new Response(null, { status: 404 }));
    return Promise.resolve(new Response(wheel.slice()));
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return requested;
}

test("按 pyodide-lock.json 取 runner.py 需要的包及依赖，核对 SHA-256", async (t) => {
  const requested = serve(t, await sha256(wheel));
  const result = await loadRuntimeFiles(ASSETS_URL);

  assert.deepEqual(result.packages.sort(), ["numpy", "pandas", "six"]);
  assert.deepEqual(Object.keys(result.files).sort(), ["numpy.whl", "pandas.whl", "pyodide.asm.wasm", "python_stdlib.zip", "six.whl"]);
  assert.ok(requested.includes("/__repa/pyodide/packages/six.whl"));
});

test("缺少 wheel 时提示先准备离线包", async (t) => {
  serve(t, await sha256(wheel), "missing.whl");
  await rejectsWith(
    loadRuntimeFiles(ASSETS_URL),
    "runtime_unavailable",
    "缺少 Pyodide 包，先运行 npm run course:runtime 准备离线包：/__repa/pyodide/packages/missing.whl 返回 HTTP 404",
  );
});

test("wheel 的 SHA-256 不符时拒绝，不交给 Worker", async (t) => {
  serve(t, "0".repeat(64));
  await assert.rejects(loadRuntimeFiles(ASSETS_URL), (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, "runtime_unavailable");
    assert.match((error as Error).message, /的 SHA-256 与 pyodide-lock\.json 不符$/u);
    return true;
  });
});
