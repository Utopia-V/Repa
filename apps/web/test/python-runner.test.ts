import type { PythonRunInput, PythonRunResult } from "@repa/learning/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkerRequest } from "@/lib/python/messages";
import { loadRuntimeFiles, PythonRunner, type RunnerWorker, type RuntimeFiles } from "@/lib/python/runner";

const job = { data: [], captures: [], doctest: [] };
const input: PythonRunInput = { program: "print(1)", tests: [{ id: "a", ...job }, { id: "b", ...job }, { id: "c", ...job }] };
const versions = { pyodide: "314.0.7", python: "3.14.2", packages: { pandas: "3.0.2" } };
const done = { status: "done" as const, stdout: "1\n", error: null, captures: {}, doctest: [] };
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
function healthy(script: Script = () => ({ phases: [["program", null]], response: done })): Respond {
  return (request, worker) => {
    if (request.type === "start") {
      worker.send({ type: "ready", runtime: versions });
      return;
    }
    for (const [test] of request.input.tests.entries()) {
      const { phases, response } = script(test, request);
      for (const [phase, index] of phases) worker.send({ type: "phase", test, phase, index });
      if (response === undefined) return;
      worker.send({ type: "tested", test, response });
      if ((response as { status?: unknown }).status !== "done") return;
    }
  };
}

function setup(respond: Respond | Respond[], options: { testTimeoutMs?: number; startTimeoutMs?: number } = {}) {
  const responders = Array.isArray(respond) ? respond : [respond];
  const workers: FakeWorker[] = [];
  const loadFiles = vi.fn(() => Promise.resolve(files));
  const runner = new PythonRunner({
    assetsUrl: "/__repa/pyodide/",
    loadFiles,
    createWorker: () => {
      const worker = new FakeWorker(responders[Math.min(workers.length, responders.length - 1)]!);
      workers.push(worker);
      return worker as unknown as RunnerWorker;
    },
    ...options,
  });
  return { runner, workers, loadFiles };
}

async function runnerHash(): Promise<string> {
  const { default: source } = await import("@repa/learning/sandbox/runner.py?raw");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("PythonRunner", () => {
  it("一批测试在一个新 Worker 里按顺序运行，结果带运行环境和 runner.py 的哈希，用完就销毁", async () => {
    const { runner, workers } = setup(healthy());
    const result = await runner.run(input);

    expect(result).toEqual({
      runtime: { ...versions, runner: await runnerHash() },
      tests: input.tests.map(({ id }) => ({ id, ...done })),
    } satisfies PythonRunResult);
    const [start, run] = workers[0]!.requests;
    expect(start?.type).toBe("start");
    if (start?.type !== "start") return;
    expect(start.indexURL).toBe(new URL("/__repa/pyodide/", location.href).href);
    expect(start.packageBaseUrl).toBe(new URL("/__repa/pyodide/packages/", location.href).href);
    expect(start.packages).toEqual(["pandas"]);
    expect(start.runner).toContain("def frontend_test(line):");
    expect(start.files["pyodide.asm.wasm"]).not.toBe(files.files["pyodide.asm.wasm"]);
    expect(run).toEqual({ type: "run", input });
    expect(workers[0]?.terminated).toBe(true);
  });

  it("每次调用都用另一个 Worker：上一次结束后预热下一个，文件只下载一次", async () => {
    const { runner, workers, loadFiles } = setup(healthy());
    await runner.run(input);
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    expect(workers[1]?.requests.map((request) => request.type)).toEqual(["start"]);

    await runner.run({ ...input, program: "print(2)" });
    expect(workers[1]?.requests.map((request) => request.type)).toEqual(["start", "run"]);
    expect(workers[1]?.terminated).toBe(true);
    expect(loadFiles).toHaveBeenCalledOnce();
  });

  it("测试超时就结束 Worker，结果写明停在哪个阶段和第几项，之后的测试未执行", async () => {
    const stuck = healthy((test) => test === 0
      ? { phases: [["program", null]], response: done }
      : { phases: [["program", null], ["captures", 0], ["serialize", 0], ["doctest", 1]] });
    const { runner, workers } = setup(stuck, { testTimeoutMs: 20 });

    await expect(runner.run(input)).resolves.toMatchObject({
      tests: [{ id: "a", status: "done" }, { id: "b", status: "timeout", phase: "doctest", index: 1 }, { id: "c", status: "not_run" }],
    });
    expect(workers[0]?.terminated).toBe(true);
  });

  it("卡在学习者代码之外的阶段时，超时的阶段照实写出，由后端判断不算作答", async () => {
    const { runner } = setup(healthy(() => ({ phases: [["prelude", null], ["data", null], ["setup", null]] })), { testTimeoutMs: 20 });
    await expect(runner.run(input)).resolves.toMatchObject({
      tests: [{ id: "a", status: "timeout", phase: "setup" }, { id: "b", status: "not_run" }, { id: "c", status: "not_run" }],
    });
  });

  it("每个测试单独计时：各自没超时的测试加起来超过期限也照常完成", async () => {
    const slow: Respond = (request, worker) => {
      if (request.type === "start") return worker.send({ type: "ready", runtime: versions });
      void (async () => {
        for (const [test] of request.input.tests.entries()) {
          await new Promise((resolve) => setTimeout(resolve, 15));
          worker.send({ type: "tested", test, response: done });
        }
      })();
    };
    const { runner } = setup(slow, { testTimeoutMs: 30 });
    const result = await runner.run(input);
    expect(result.tests.map((test) => test.status)).toEqual(["done", "done", "done"]);
  });

  it("前导、数据或 setup 出错时整批停下；Worker 出错或回复无法识别时记为 worker 阶段的失败", async () => {
    const setupFailed = { status: "failed", phase: "setup", error: { type: "RuntimeError", message: "测试的 setup 出错" } };
    const failing = setup(healthy((test) => ({ phases: [], response: test === 1 ? setupFailed : done })));
    await expect(failing.runner.run(input)).resolves.toMatchObject({
      tests: [{ id: "a", status: "done" }, { id: "b", ...setupFailed }, { id: "c", status: "not_run" }],
    });

    const garbled = setup(healthy(() => ({ phases: [], response: { status: "done", stdout: 1 } })));
    await expect(garbled.runner.run(input)).resolves.toMatchObject({
      tests: [{ id: "a", status: "failed", phase: "worker", error: { message: "运行器返回了无法识别的结果" } }, { status: "not_run" }, { status: "not_run" }],
    });

    const crashing: Respond = (request, worker) => {
      if (request.type === "start") worker.send({ type: "ready", runtime: versions });
      else worker.onerror?.({ message: "out of memory", preventDefault: () => {} });
    };
    const crashed = setup(crashing);
    await expect(crashed.runner.run(input)).resolves.toMatchObject({
      tests: [{ id: "a", status: "failed", phase: "worker", error: { type: "WorkerError", message: "Python 运行器出错：out of memory" } }, { status: "not_run" }, { status: "not_run" }],
    });
    expect(crashed.workers[0]?.terminated).toBe(true);
  });

  it("Pyodide 没在期限内就绪、报告失败或报告不出运行环境时以 runtime_unavailable 结束，下一次重新启动", async () => {
    const silent: Respond = () => {};
    const notIsolated: Respond = (request, worker) => {
      if (request.type === "start") worker.send({ type: "failed", message: "Python 运行环境没有隔离" });
    };
    const noVersions: Respond = (request, worker) => {
      if (request.type === "start") worker.send({ type: "ready", runtime: { pyodide: "314.0.7" } });
    };
    const { runner, workers } = setup([silent, notIsolated, noVersions, healthy()], { startTimeoutMs: 20 });

    await expect(runner.run(input)).rejects.toMatchObject({ code: "runtime_unavailable", message: "Pyodide 在 0.02 秒内没有就绪" });
    await expect(runner.run(input)).rejects.toMatchObject({ code: "runtime_unavailable", message: "Python 运行环境没有隔离" });
    await expect(runner.run(input)).rejects.toMatchObject({ code: "runtime_unavailable", message: "Python 运行器报告的运行环境无法识别" });
    await expect(runner.run(input)).resolves.toMatchObject({ tests: [{ status: "done" }, { status: "done" }, { status: "done" }] });
    expect(workers.slice(0, 3).map((worker) => worker.terminated)).toEqual([true, true, true]);
  });

  it("启动期限从下载文件算起", async () => {
    const workers: FakeWorker[] = [];
    const runner = new PythonRunner({
      assetsUrl: "/__repa/pyodide/",
      loadFiles: () => new Promise(() => {}),
      createWorker: () => {
        const worker = new FakeWorker(healthy());
        workers.push(worker);
        return worker as unknown as RunnerWorker;
      },
      startTimeoutMs: 20,
    });
    await expect(runner.run(input)).rejects.toMatchObject({ code: "runtime_unavailable" });
    expect(workers).toHaveLength(0);
  });

  it("取消正在进行的调用会结束 Worker，不交回结果；已取消的调用不启动 Worker", async () => {
    const { runner, workers } = setup(healthy(() => ({ phases: [["program", null]] })));
    const controller = new AbortController();
    const running = runner.run(input, controller.signal);
    await vi.waitFor(() => expect(workers[0]?.requests).toHaveLength(2));
    controller.abort();

    await expect(running).rejects.toMatchObject({ code: "cancelled" });
    expect(workers[0]?.terminated).toBe(true);
    const count = workers.length;
    await expect(runner.run(input, AbortSignal.abort())).rejects.toMatchObject({ code: "cancelled" });
    expect(workers).toHaveLength(count);
  });

  it("close 结束预热的 Worker，取消正在进行的调用，之后不再预热", async () => {
    const { runner, workers } = setup(healthy());
    await runner.run(input);
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    runner.close();
    await vi.waitFor(() => expect(workers[1]?.terminated).toBe(true));


    const stuck = setup(healthy(() => ({ phases: [["program", null]] })));
    const running = stuck.runner.run(input);
    await vi.waitFor(() => expect(stuck.workers[0]?.requests).toHaveLength(2));
    stuck.runner.close();
    await expect(running).rejects.toMatchObject({ code: "cancelled" });
    expect(stuck.workers[0]?.terminated).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stuck.workers).toHaveLength(1);
  });
});

describe("loadRuntimeFiles", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const wheel = new TextEncoder().encode("wheel");

  async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function serve(sha: string, sixFile = "six.whl") {
    const lock = {
      packages: {
        numpy: { file_name: "numpy.whl", sha256: sha, depends: [] },
        pandas: { file_name: "pandas.whl", sha256: sha, depends: ["numpy", "six"] },
        six: { file_name: sixFile, sha256: sha, depends: [] },
        scipy: { file_name: "scipy.whl", sha256: sha, depends: [] },
      },
    };
    const fetch = vi.fn((url: URL) => {
      const name = url.pathname.split("/").pop();
      if (name === "pyodide-lock.json") return Promise.resolve(new Response(JSON.stringify(lock)));
      if (name === "missing.whl") return Promise.resolve(new Response(null, { status: 404 }));
      return Promise.resolve(new Response(wheel.slice()));
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  it("按 pyodide-lock.json 取 runner.py 需要的包及依赖，核对 SHA-256", async () => {
    const fetch = serve(await sha256(wheel));
    const loaded = await loadRuntimeFiles("/__repa/pyodide/");

    expect(loaded.packages.sort()).toEqual(["numpy", "pandas", "six"]);
    expect(Object.keys(loaded.files).sort()).toEqual(["numpy.whl", "pandas.whl", "pyodide.asm.wasm", "python_stdlib.zip", "six.whl"]);
    expect(fetch.mock.calls.map(([url]) => url.pathname)).toContain("/__repa/pyodide/packages/six.whl");
  });

  it("缺少 wheel 时提示先准备离线包", async () => {
    serve(await sha256(wheel), "missing.whl");
    await expect(loadRuntimeFiles("/__repa/pyodide/")).rejects.toMatchObject({
      code: "runtime_unavailable",
      message: "缺少 Pyodide 包，先运行 npm run course:runtime 准备离线包：/__repa/pyodide/packages/missing.whl 返回 HTTP 404",
    });
  });

  it("wheel 的 SHA-256 不符时拒绝，不交给 Worker", async () => {
    serve("0".repeat(64));
    await expect(loadRuntimeFiles("/__repa/pyodide/")).rejects.toMatchObject({
      code: "runtime_unavailable",
      message: expect.stringMatching(/的 SHA-256 与 pyodide-lock\.json 不符$/),
    });
  });
});
