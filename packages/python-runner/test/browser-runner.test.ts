import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";

import type { WorkerRequest } from "../src/browser/messages.js";
import { loadRuntimeFiles, PythonRunner, type RunnerWorker, type RuntimeFiles } from "../src/browser/runner.js";
import { PYTHON_BATCH, type PythonBatchInput, type PythonBatchResult } from "../src/protocol.js";

const runnerSource = await readFile(new URL("../runner.py", import.meta.url), "utf8");
const ASSETS_URL = "http://127.0.0.1:5173/__repa/pyodide/";
const job = { program: "print(1)", prelude: "", setup: "", data: [], captures: [], doctest: [] };
const input: PythonBatchInput = {
  protocol: PYTHON_BATCH,
  tests: [{ id: "a", ...job }, { id: "b", ...job }, { id: "c", ...job }],
};
/** Worker 启动后报告的 Pyodide 与 Python 版本；带的包的版本由页面从 lockfile 读出。 */
const loaded = { pyodide: "314.0.7", python: "3.14.2" };
const program = { stdout: "1\n", error: null, captures: {}, doctest: [] };
const completed = { status: "completed" as const, result: program };
const files: RuntimeFiles = {
  lock: "{}",
  versions: { numpy: "2.4.6", pandas: "3.0.2" },
  imports: { numpy: "numpy", pandas: "pandas", six: "six" },
  files: { "pyodide.asm.wasm": new Uint8Array([1, 2]).buffer },
};

type RunRequest = Extract<WorkerRequest, { type: "run" }>;
/** 给第 test 个测试的回复：加载的包、报告的阶段和结果；不给 response 就是卡在最后报告的阶段。 */
type Script = (test: number, request: RunRequest) => { packages?: string[]; phases: [string, number | null][]; response?: unknown };
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
      const { packages = [], phases, response } = script(test, request);
      worker.send({ type: "loading", test, packages });
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

/** 等到 check 成立；十秒内不成立就失败，并带上 state 给出的状态。期限只防卡死，宽一些，机器忙时也不误报。 */
async function until(check: () => boolean, state: () => unknown = () => undefined): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`等待超时：${JSON.stringify(state())}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const types = (worker: FakeWorker | undefined) => worker?.requests.map((request) => request.type);

/** 预热一个 Worker 并等它就绪。 */
async function warmed(runner: PythonRunner, workers: FakeWorker[]): Promise<void> {
  runner.warm();
  await until(() => types(workers.at(-1))?.[0] === "start", () => workers.length);
  // 替身在微任务里回复 ready；等一轮宏任务，预热的 Promise 就已兑现。
  await new Promise((resolve) => setTimeout(resolve, 0));
}
const statuses = (result: PythonBatchResult) => result.tests.map((entry) => entry.status);

async function rejectsWith(promise: Promise<unknown>, code: string, message?: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, code);
    if (message !== undefined) assert.equal((error as Error).message, message);
    return true;
  });
}

test("一批测试在一个新 Worker 里按顺序运行；结果报告 Pyodide、Python 和带的包的版本，不列出依赖", async () => {
  const { runner, workers } = fixture(healthy());
  const result = await runner.run(input);

  assert.deepEqual(result, {
    protocol: PYTHON_BATCH,
    runtime: { pyodide: "314.0.7", python: "3.14.2", packages: { numpy: "2.4.6", pandas: "3.0.2" } },
    loaded: [],
    tests: input.tests.map(({ id }) => ({ id, ...completed })),
  } satisfies PythonBatchResult);
  const [start, run] = workers[0]!.requests;
  assert.equal(start?.type, "start");
  if (start?.type !== "start") return;
  assert.equal(start.indexURL, ASSETS_URL);
  assert.equal(start.packageBaseUrl, `${ASSETS_URL}packages/`);
  assert.deepEqual(start.imports, files.imports);
  assert.equal(start.runner, runnerSource);
  assert.notEqual(start.files["pyodide.asm.wasm"], files.files["pyodide.asm.wasm"]);
  assert.deepEqual(run, { type: "run", tests: input.tests });
  assert.equal(workers[0]?.terminated, true);
});

test("warm 在后台预热一个 Worker，不运行代码，重复调用不多开；之后的调用用的就是这个 Worker", async () => {
  const { runner, workers } = fixture(healthy());
  runner.warm();
  runner.warm();
  await until(() => types(workers[0])?.length === 1, () => workers.length);
  assert.equal(workers.length, 1);
  assert.deepEqual(types(workers[0]), ["start"]);

  await runner.run(input);
  assert.deepEqual(types(workers[0]), ["start", "run"]);
});

test("loaded 是这一批测试引入的包；下一个预热的 Worker 先加载它们，第一个预热全部带的包", async () => {
  const pandasFirst = healthy((test) => ({ packages: test === 0 ? ["pandas"] : [], phases: [["program", null]], response: completed }));
  const { runner, workers } = fixture([pandasFirst, healthy()]);
  const preload = (worker: FakeWorker | undefined) => worker?.requests.find((request) => request.type === "start")?.preload;
  assert.deepEqual((await runner.run(input)).loaded, ["pandas"]);
  assert.deepEqual(preload(workers[0]), ["numpy", "pandas"]);
  await until(() => workers.length === 2, () => workers.length);
  assert.deepEqual(preload(workers[1]), ["pandas"]);
  // 这一批的测试什么都没引入：loaded 为空，下一个预热的 Worker 不加载包。
  assert.deepEqual((await runner.run(input)).loaded, []);
  await until(() => workers.length === 3, () => workers.length);
  assert.deepEqual(preload(workers[2]), []);
});

const restoreError = { type: "FileNotFoundError", message: "[Errno 44] No such file or directory: '/home/pyodide'" };
/** 第一个 Worker 在测试 b 之后恢复不了解释器状态。 */
const brokenAfterB = healthy((test, request) => ({
  phases: [["program", null], ["cleanup", null]],
  response: request.tests[test]?.id === "b" ? { ...completed, restoreError } : completed,
}));

test("运行中调用 warm 预热的 Worker，调用结束后照样用它，不再多开一个", async () => {
  let finish: (() => void) | undefined;
  const slow: Respond = (request, worker) => {
    if (request.type === "start") return worker.send({ type: "ready", runtime: loaded });
    finish = () => request.tests.forEach((_test, index) => worker.send({ type: "tested", test: index, response: completed }));
  };
  const { runner, workers } = fixture(slow);
  const running = runner.run(input);
  await until(() => finish !== undefined);
  runner.warm();
  await until(() => workers.length === 2, () => workers.length);
  finish?.();
  await running;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(workers.length, 2);
  await runner.run(input);
  assert.deepEqual(types(workers[1]), ["start", "run"]);
});

test("恢复解释器状态失败时，这个测试的结果照样交回，余下的测试换一个新的 Worker 接着运行；Worker 数是 1 加上恢复失败的次数", async () => {
  const { runner, workers } = fixture([brokenAfterB, healthy()]);
  const result = await runner.run(input);
  assert.deepEqual(result.tests, [{ id: "a", ...completed }, { id: "b", ...completed, restoreError }, { id: "c", ...completed }]);
  assert.deepEqual(workers.slice(0, 2).map(types), [["start", "run"], ["start", "run"]]);
  const [, second] = workers[1]!.requests;
  assert.deepEqual(second, { type: "run", tests: [input.tests[2]] });
  assert.deepEqual(workers.slice(0, 2).map((worker) => worker.terminated), [true, true]);
  // 没有恢复失败时一次调用只用一个 Worker；第三个是后台预热的下一个。
  await runner.run(input);
  assert.equal(workers.filter((worker) => types(worker)?.includes("run")).length, 3);
});

test("最后一个测试恢复失败时不再启动新的 Worker；换 Worker 时起不来，已经得到的结果照样交回", async () => {
  const lastBroken = healthy((test, request) => ({
    phases: [["program", null], ["cleanup", null]],
    response: test === request.tests.length - 1 ? { ...completed, restoreError } : completed,
  }));
  const last = fixture(lastBroken);
  assert.deepEqual(statuses(await last.runner.run(input)), ["completed", "completed", "completed"]);
  assert.equal(last.workers.filter((worker) => types(worker)?.includes("run")).length, 1);

  const notIsolated: Respond = (request, worker) => {
    if (request.type === "start") worker.send({ type: "failed", message: "Python 运行环境没有隔离" });
  };
  const { runner } = fixture([brokenAfterB, notIsolated]);
  assert.deepEqual((await runner.run(input)).tests, [
    { id: "a", ...completed },
    { id: "b", ...completed, restoreError },
    { id: "c", status: "failed", phase: "prepare", error: { type: "WorkerError", message: "Python 运行环境没有隔离" } },
  ]);
});

test("每次调用都用另一个 Worker：上一次结束后预热下一个，文件只下载一次", async () => {
  const { runner, workers, downloads } = fixture(healthy());
  await runner.run(input);
  await until(() => workers.length === 2, () => workers.length);
  assert.deepEqual(types(workers[1]), ["start"]);

  await runner.run(input);
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

test("卡在学习者代码之外时阶段照实写出：准备和收尾是 timeout；序列化会调用值自己的方法，卡住时与求值一样算 capture 阶段的 timeout", async () => {
  const preparing = fixture(healthy(() => ({ phases: [["prepare", null]] })), { testTimeoutMs: 20 });
  assert.deepEqual((await preparing.runner.run(input)).tests, [
    { id: "a", status: "timeout", phase: "prepare" },
    { id: "b", status: "not_run" },
    { id: "c", status: "not_run" },
  ]);

  const cleaning = fixture(healthy(() => ({ phases: [["program", null], ["cleanup", null]] })), { testTimeoutMs: 20 });
  assert.deepEqual((await cleaning.runner.run(input)).tests[0], { id: "a", status: "timeout", phase: "cleanup" });

  const serializing = fixture(healthy(() => ({ phases: [["capture", 0], ["serialize", 0]] })), { testTimeoutMs: 20 });
  assert.deepEqual((await serializing.runner.run(input)).tests[0], { id: "a", status: "timeout", phase: "capture" });
});

test("每个测试单独计时：各自没超时的测试加起来超过期限也照常完成", async () => {
  const slow: Respond = (request, worker) => {
    if (request.type === "start") return worker.send({ type: "ready", runtime: loaded });
    void (async () => {
      for (const [test] of request.tests.entries()) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        worker.send({ type: "tested", test, response: completed });
      }
    })();
  };
  // 每个测试 200 毫秒，三个加起来超过 500 毫秒的期限；单个测试离期限留足余量，机器忙时计时器晚一些也不误报。
  const { runner } = fixture(slow, { testTimeoutMs: 500 });
  assert.deepEqual(statuses(await runner.run(input)), ["completed", "completed", "completed"]);
});

test("准备、被测代码和收尾各自计时：被测代码用掉大半期限后进入收尾，不会被算成收尾超时", async () => {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const segments: Respond = (request, worker) => {
    if (request.type === "start") return worker.send({ type: "ready", runtime: loaded });
    void (async () => {
      for (const [test] of request.tests.entries()) {
        worker.send({ type: "phase", test, phase: "prepare", index: null });
        await pause(200);
        worker.send({ type: "phase", test, phase: "program", index: null });
        await pause(200);
        worker.send({ type: "phase", test, phase: "cleanup", index: null });
        await pause(200);
        worker.send({ type: "tested", test, response: completed });
      }
    })();
  };
  // 每段 200 毫秒，离 500 毫秒的期限留足余量；三段加起来超过期限。
  const { runner } = fixture(segments, { testTimeoutMs: 500 });
  assert.deepEqual(statuses(await runner.run({ ...input, tests: input.tests.slice(0, 1) })), ["completed"]);
});

test("加载测试引入的包按启动的时限计时：比测试的一段长也照常完成；卡在加载里时超时归在准备阶段", async () => {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const loading = (stuck: boolean): Respond => (request, worker) => {
    if (request.type === "start") return worker.send({ type: "ready", runtime: loaded });
    void (async () => {
      worker.send({ type: "loading", test: 0, packages: ["pandas"] });
      if (stuck) return;
      await pause(200);
      worker.send({ type: "phase", test: 0, phase: "prepare", index: null });
      worker.send({ type: "phase", test: 0, phase: "program", index: null });
      worker.send({ type: "tested", test: 0, response: completed });
    })();
  };
  const single = { ...input, tests: input.tests.slice(0, 1) };
  // 加载 200 毫秒，超过一段的 50 毫秒，在启动的 2 秒之内；机器忙时计时器晚一些也不误报。
  const slow = fixture(loading(false), { testTimeoutMs: 50, startTimeoutMs: 2_000 });
  const result = await slow.runner.run(single);
  assert.deepEqual(statuses(result), ["completed"]);
  assert.deepEqual(result.loaded, ["pandas"]);
  const stuck = fixture(loading(true), { testTimeoutMs: 20, startTimeoutMs: 100 });
  assert.deepEqual((await stuck.runner.run(single)).tests, [{ id: "a", status: "timeout", phase: "prepare" }]);
});

test("没有测试时不运行，直接交回空结果", async () => {
  const { runner, workers } = fixture(healthy());
  const result = await runner.run({ ...input, tests: [] });
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

/** 再过 count 个微任务执行 action；0 表示立即执行。 */
function afterMicrotasks(count: number, action: () => void): void {
  if (count === 0) {
    action();
    return;
  }
  queueMicrotask(() => afterMicrotasks(count - 1, action));
}

test("领取预热的 Worker 之后、发出 run 之前取消，调用照样以 cancelled 结束，不留下运行着的 Worker", async () => {
  // 依次在调用后的第 0 到 39 个微任务时取消，覆盖从领取预热 Worker 到发出 run 之间的每一步。
  for (let delay = 0; delay < 40; delay += 1) {
    const { runner, workers } = fixture(healthy(() => ({ phases: [["program", null]] })), { testTimeoutMs: 50 });
    await warmed(runner, workers);
    const controller = new AbortController();
    const running = runner.run(input, controller.signal);
    afterMicrotasks(delay, () => controller.abort());
    await rejectsWith(running, "cancelled");
    const ran = workers.filter((worker) => types(worker)?.includes("run"));
    assert.deepEqual(ran.map((worker) => worker.terminated), ran.map(() => true), `第 ${delay} 个微任务时取消`);
    runner.close();
  }
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

test("领取还在启动的预热 Worker 时被取消，这个 Worker 启动完也会被结束", async () => {
  let booting: FakeWorker | undefined;
  const delayed: Respond = (request, worker) => {
    if (request.type === "start") booting = worker;
  };
  const { runner, workers } = fixture(delayed);
  runner.warm();
  const controller = new AbortController();
  const running = runner.run(input, controller.signal);
  await until(() => booting !== undefined);
  controller.abort();
  await rejectsWith(running, "cancelled");

  booting?.send({ type: "ready", runtime: loaded });
  await until(() => workers[0]?.terminated === true, () => types(workers[0]));
  assert.equal(workers.length, 1);
});

test("close 之后，之前排队的调用轮到时直接作废，不再新建 Worker 运行代码", async () => {
  const stuck = healthy(() => ({ phases: [["program", null]] }));
  const { runner, workers } = fixture([stuck, healthy()]);
  const first = runner.run(input);
  const queued = runner.run(input);
  await until(() => workers[0]?.requests.length === 2, () => types(workers[0]));
  runner.close();

  await rejectsWith(first, "cancelled");
  await rejectsWith(queued, "cancelled");
  assert.equal(workers.length, 1);
  assert.deepEqual(statuses(await runner.run(input)), ["completed", "completed", "completed"]);
});

test("预热失败不报错，下一次调用重新启动 Worker，不一直拿到这次的失败", async () => {
  const notIsolated: Respond = (request, worker) => {
    if (request.type === "start") worker.send({ type: "failed", message: "缺少 Pyodide" });
  };
  const { runner, workers } = fixture([notIsolated, healthy()]);
  runner.warm();
  await until(() => workers[0]?.terminated === true, () => types(workers[0]));
  assert.deepEqual(statuses(await runner.run(input)), ["completed", "completed", "completed"]);
  assert.deepEqual(types(workers[1]), ["start", "run"]);
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
      numpy: { version: "2.4.6", file_name: "numpy.whl", sha256: sha, imports: ["numpy"], depends: [] },
      pandas: { version: "3.0.2", file_name: "pandas.whl", sha256: sha, imports: ["pandas"], depends: ["numpy", "six"] },
      six: { version: "1.17.0", file_name: sixFile, sha256: sha, imports: ["six"], depends: [] },
      scipy: { version: "1.18.0", file_name: "scipy.whl", sha256: sha, imports: ["scipy"], depends: [] },
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

test("按 pyodide-lock.json 取带的包及依赖，核对 SHA-256；交给 Worker 的 import 名只有这些包的", async (t) => {
  const requested = serve(t, await sha256(wheel));
  const result = await loadRuntimeFiles(ASSETS_URL);

  assert.deepEqual(result.versions, { numpy: "2.4.6", pandas: "3.0.2" });
  assert.deepEqual(result.imports, { numpy: "numpy", pandas: "pandas", six: "six" });
  assert.deepEqual(Object.keys(result.files).sort(), ["numpy.whl", "pandas.whl", "pyodide.asm.wasm", "python_stdlib.zip", "six.whl"]);
  assert.ok(requested.includes("/__repa/pyodide/packages/six.whl"));
});

test("缺少 wheel 时说明缺的是应用带的包，不叫学习者运行 npm", async (t) => {
  serve(t, await sha256(wheel), "missing.whl");
  await rejectsWith(
    loadRuntimeFiles(ASSETS_URL),
    "runtime_unavailable",
    "缺少应用带的 Pyodide 包：/__repa/pyodide/packages/missing.whl 返回 HTTP 404",
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
