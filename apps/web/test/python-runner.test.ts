import type { PythonRunInput, PythonRunResult } from "@repa/learning/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkerRequest } from "@/lib/python/messages";
import { loadRuntimeFiles, PythonRunner, type RunnerWorker, type RuntimeFiles } from "@/lib/python/runner";

const input: PythonRunInput = { data: [], program: "print(1)", captures: [], doctest: [] };
const result: PythonRunResult = { stdout: "1\n", error: null, captures: {}, doctest: [] };
const files: RuntimeFiles = { lock: "{}", packages: ["pandas"], files: { "pyodide.asm.wasm": new Uint8Array([1, 2]).buffer } };

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
    this.onmessage?.({ data });
  }
}

/** 正常的 Worker：启动后就绪，任务按 reply 回复。 */
function healthy(reply: (request: Extract<WorkerRequest, { type: "run" }>) => unknown = () => ({ ok: true, result })): Respond {
  return (request, worker) => {
    if (request.type === "start") worker.send({ type: "ready" });
    else worker.send({ type: "result", id: request.id, response: reply(request) });
  };
}

function setup(respond: Respond | Respond[], options: { runTimeoutMs?: number; startTimeoutMs?: number } = {}) {
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

describe("PythonRunner", () => {
  it("第一次运行时启动 Worker，交给它 Pyodide 文件的副本和 runner.py，之后的任务沿用同一个 Worker", async () => {
    const { runner, workers } = setup(healthy());
    await expect(runner.run(input)).resolves.toEqual(result);
    await expect(runner.run({ ...input, program: "print(2)" })).resolves.toEqual(result);

    expect(workers).toHaveLength(1);
    const [start, first, second] = workers[0]!.requests;
    expect(start?.type).toBe("start");
    if (start?.type !== "start") return;
    expect(start.indexURL).toBe(new URL("/__repa/pyodide/", location.href).href);
    expect(start.packageBaseUrl).toBe(new URL("/__repa/pyodide/packages/", location.href).href);
    expect(start.packages).toEqual(["pandas"]);
    expect(start.runner).toContain("def handle_job(line):");
    expect(start.files["pyodide.asm.wasm"]).not.toBe(files.files["pyodide.asm.wasm"]);
    expect(first).toMatchObject({ type: "run", input });
    expect(second).toMatchObject({ type: "run", input: { program: "print(2)" } });
  });

  it("任务超时就结束 Worker，下一次运行启动新的，文件不再重新下载", async () => {
    const stuck: Respond = (request, worker) => {
      if (request.type === "start") worker.send({ type: "ready" });
    };
    const hanging = setup([stuck, healthy()], { runTimeoutMs: 20 });

    await expect(hanging.runner.run(input)).rejects.toMatchObject({ code: "timeout", message: "运行超过 0.02 秒，已停止" });
    expect(hanging.workers[0]?.terminated).toBe(true);
    await expect(hanging.runner.run(input)).resolves.toEqual(result);
    expect(hanging.workers).toHaveLength(2);
    expect(hanging.loadFiles).toHaveBeenCalledOnce();
  });

  it("Pyodide 启动卡住或报告失败时以 runtime_unavailable 结束，下一次重新启动", async () => {
    const silent: Respond = () => {};
    const notIsolated: Respond = (request, worker) => {
      if (request.type === "start") worker.send({ type: "failed", message: "Python 运行环境没有隔离" });
    };
    const { runner, workers } = setup([silent, notIsolated, healthy()], { startTimeoutMs: 20 });

    await expect(runner.run(input)).rejects.toMatchObject({ code: "runtime_unavailable", message: "Pyodide 在 0.02 秒内没有就绪" });
    await expect(runner.run(input)).rejects.toMatchObject({ code: "runtime_unavailable", message: "Python 运行环境没有隔离" });
    await expect(runner.run(input)).resolves.toEqual(result);
    expect(workers.map((worker) => worker.terminated)).toEqual([true, true, false]);
  });

  it("取消正在进行的任务会结束 Worker", async () => {
    const stuck: Respond = (request, worker) => {
      if (request.type === "start") worker.send({ type: "ready" });
    };
    const { runner, workers } = setup(stuck);
    const controller = new AbortController();
    const running = runner.run(input, controller.signal);
    await vi.waitFor(() => expect(workers[0]?.requests).toHaveLength(2));
    controller.abort();

    await expect(running).rejects.toMatchObject({ code: "cancelled" });
    expect(workers[0]?.terminated).toBe(true);
    await expect(runner.run(input, AbortSignal.abort())).rejects.toMatchObject({ code: "cancelled" });
  });

  it("运行前导或数据出错是 run_failed，Worker 留着；认不出的回复是 runner_crashed", async () => {
    const { runner, workers } = setup(healthy((request) => request.input.program === "bad"
      ? { ok: true, result: { stdout: 1 } }
      : { ok: false, error: { type: "RuntimeError", message: "课程清单的运行前导出错" }, trace: "Traceback" }));

    await expect(runner.run(input)).rejects.toMatchObject({ code: "run_failed", message: "RuntimeError: 课程清单的运行前导出错" });
    await expect(runner.run({ ...input, program: "bad" })).rejects.toMatchObject({ code: "runner_crashed" });
    expect(workers).toHaveLength(1);
    expect(workers[0]?.terminated).toBe(false);
  });

  it("Worker 自己出错时结束它，正在等的任务以 runner_crashed 结束", async () => {
    const crashing: Respond = (request, worker) => {
      if (request.type === "start") worker.send({ type: "ready" });
      else worker.onerror?.({ message: "out of memory", preventDefault: () => {} });
    };
    const { runner, workers } = setup(crashing);

    await expect(runner.run(input)).rejects.toMatchObject({ code: "runner_crashed", message: "Python 运行器出错：out of memory" });
    expect(workers[0]?.terminated).toBe(true);
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
