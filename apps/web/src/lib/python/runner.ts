import { contentVersion } from "@repa/base/protocol";
import runnerSource from "@repa/learning/sandbox/runner.py?raw";
import {
  PYTHON_BATCH, PythonBatchResultSchema, PythonPhaseSchema,
  type PythonBatchInput, type PythonBatchResult, type PythonPhase, type PythonTestResult,
} from "@repa/learning/protocol";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import type { WorkerMessage, WorkerRequest } from "./messages";

/**
 * 与课程核对相同：每个测试 10 秒。启动 60 秒，从下载 Pyodide 文件算起；Pyodide 加载失败时会一直卡住、不报错，所以启动也要限时。
 */
const TEST_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 60_000;
/** runner.py 在模块顶层导入它们，探测时报告的也是它们；依赖由 pyodide-lock.json 补全。 */
const RUNNER_PACKAGES = ["numpy", "pandas"];
const CORE_FILES = ["pyodide.asm.wasm", "python_stdlib.zip"];

export type PythonRunErrorCode = "runtime_unavailable" | "cancelled";

/** 什么都没有运行时的错误；code 原样作为 service.reply 的错误码交给调用方。Pyodide 启动之后的超时和失败写在结果里。 */
export class PythonRunError extends Error {
  constructor(readonly code: PythonRunErrorCode, message: string) {
    super(message);
    this.name = "PythonRunError";
  }
}

export interface RuntimeFiles {
  lock: string;
  packages: string[];
  files: Record<string, ArrayBuffer>;
}

/** Worker 里用到的部分，测试用替身代替真正的 Worker。 */
export type RunnerWorker = Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror">;

export interface PythonRunnerOptions {
  /** Pyodide 文件所在的目录，wheel 在其下的 packages/。 */
  assetsUrl: string;
  createWorker: () => RunnerWorker;
  loadFiles: () => Promise<RuntimeFiles>;
  testTimeoutMs?: number;
  startTimeoutMs?: number;
}

const LockSchema = Type.Object({
  packages: Type.Record(Type.String(), Type.Object({
    file_name: Type.String({ pattern: "^[A-Za-z0-9_.+-]+$" }),
    sha256: Type.String(),
    depends: Type.Array(Type.String()),
  })),
});
type Lock = Static<typeof LockSchema>;

async function download(url: URL, missing: string): Promise<ArrayBuffer> {
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-cache" });
  } catch {
    throw new PythonRunError("runtime_unavailable", `${missing}：无法读取 ${url.pathname}`);
  }
  if (!response.ok) throw new PythonRunError("runtime_unavailable", `${missing}：${url.pathname} 返回 HTTP ${response.status}`);
  return response.arrayBuffer();
}

type LockPackage = Lock["packages"][string];

/** 要加载的包连同依赖。 */
function closure(lock: Lock, names: readonly string[]): Map<string, LockPackage> {
  const found = new Map<string, LockPackage>();
  const visit = (name: string): void => {
    if (found.has(name)) return;
    const entry = lock.packages[name];
    if (!entry) throw new PythonRunError("runtime_unavailable", `pyodide-lock.json 里没有 ${name}`);
    found.set(name, entry);
    for (const dependency of entry.depends) visit(dependency);
  };
  for (const name of names) visit(name);
  return found;
}

async function sha256(buffer: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 取 Pyodide 文件和 runner.py 要的 wheel；wheel 按 pyodide-lock.json 核对 SHA-256，不符就不交给 Worker。 */
export async function loadRuntimeFiles(assetsUrl: string): Promise<RuntimeFiles> {
  const base = new URL(assetsUrl, location.href);
  const lock = new TextDecoder().decode(await download(new URL("pyodide-lock.json", base), "缺少 Pyodide"));
  let parsed: unknown;
  try {
    parsed = JSON.parse(lock);
  } catch {
    throw new PythonRunError("runtime_unavailable", "pyodide-lock.json 不是有效的 JSON");
  }
  if (!Value.Check(LockSchema, parsed)) throw new PythonRunError("runtime_unavailable", "pyodide-lock.json 的格式无法识别");
  const packages = closure(parsed, RUNNER_PACKAGES);
  const missingWheel = "缺少 Pyodide 包，先运行 npm run course:runtime 准备离线包";
  const entries = await Promise.all([
    ...CORE_FILES.map(async (name) => [name, await download(new URL(name, base), "缺少 Pyodide")] as const),
    ...[...packages.values()].map(async ({ file_name: file, sha256: expected }) => {
      const buffer = await download(new URL(`packages/${file}`, base), missingWheel);
      if ((await sha256(buffer)) !== expected) {
        throw new PythonRunError("runtime_unavailable", `${file} 的 SHA-256 与 pyodide-lock.json 不符`);
      }
      return [file, buffer] as const;
    }),
  ]);
  return { lock, packages: [...packages.keys()], files: Object.fromEntries(entries) };
}

/** 后端用同一个算法给 runner.py 记版本，课程核对算出的期望值绑定在这个版本上。 */
const runnerVersion = contentVersion(runnerSource);

/** Worker 实际加载的 Pyodide、Python 和全部包的版本。 */
const LoadedSchema = Type.Object({
  pyodide: Type.String(),
  python: Type.String(),
  packages: Type.Record(Type.String(), Type.String()),
});
type Loaded = Static<typeof LoadedSchema>;

/** 只报告问到的包；没有加载的包不出现，后端比较时就知道环境不符。 */
function environment(loaded: Loaded, packages: readonly string[]) {
  const versions = packages.flatMap((name) => {
    const version = loaded.packages[name];
    return version === undefined ? [] : [[name, version] as const];
  });
  return { pyodide: loaded.pyodide, python: loaded.python, packages: Object.fromEntries(versions) };
}

export interface PythonCapabilities {
  protocol: typeof PYTHON_BATCH;
  runtime: ReturnType<typeof environment>;
  runner: string;
  freshInterpreter: true;
}

function readMessage(value: unknown): WorkerMessage | undefined {
  if (typeof value !== "object" || value === null || !("type" in value)) return undefined;
  if (value.type === "ready" && "runtime" in value) return { type: "ready", runtime: value.runtime };
  if (value.type === "failed" && "message" in value && typeof value.message === "string") return { type: "failed", message: value.message };
  if (value.type === "phase" && "test" in value && typeof value.test === "number" && "phase" in value && typeof value.phase === "string"
    && "index" in value && (typeof value.index === "number" || value.index === null)) {
    return { type: "phase", test: value.test, phase: value.phase, index: value.index };
  }
  if (value.type === "tested" && "test" in value && typeof value.test === "number" && "response" in value) {
    return { type: "tested", test: value.test, response: value.response };
  }
  return undefined;
}

/** Worker 报告的阶段。serialize 是运行器序列化 capture 的值，不运行学习者的代码；对外归在 capture 下，但超时算执行失败。 */
type Step = PythonPhase | "serialize";
const TestResultSchema = PythonBatchResultSchema.properties.tests.items;

function workerFailure(id: string, step: Step, message: string): PythonTestResult {
  return { id, status: "failed", phase: step === "serialize" ? "capture" : step, error: { type: "WorkerError", message } };
}

function timedOut(id: string, step: Step, seconds: number): PythonTestResult {
  // 序列化慢不是学习者的错，记为执行失败，后端保留待恢复。
  if (step === "serialize") return { id, status: "failed", phase: "capture", error: { type: "TimeoutError", message: `序列化 capture 的值超过 ${seconds} 秒` } };
  return { id, status: "timeout", phase: step };
}

/** runner.py 的 program_test 的返回值：completed 是 program 任务的结果，failed 是前导、夹具或 setup 出错。其他的都当作 Worker 出了问题。 */
function readTested(id: string, step: Step, response: unknown): PythonTestResult {
  if (typeof response === "object" && response !== null && "status" in response
    && (response.status === "completed" || response.status === "failed")) {
    const result = { ...response, id };
    if (Value.Check(TestResultSchema, result)) return result;
  }
  return workerFailure(id, step, "运行器返回了无法识别的结果");
}

function readStep(phase: string): Step | undefined {
  return phase === "serialize" ? phase : Value.Check(PythonPhaseSchema, phase) ? phase : undefined;
}

/** 一个 Worker：启动一次、运行一批测试，之后销毁。出错时通知正在听的一方并结束。 */
class RunnerInstance {
  #receive: ((message: WorkerMessage) => void) | undefined;
  #crash: ((message: string) => void) | undefined;
  #ended = false;

  constructor(private readonly worker: RunnerWorker) {
    worker.onmessage = (event) => {
      const message = readMessage(event.data);
      if (message === undefined) this.#fail("Python 运行器发回了无法识别的消息");
      else if (message.type === "failed") this.#fail(message.message);
      else this.#receive?.(message);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      this.#fail(`Python 运行器出错：${event.message || "未知错误"}`);
    };
  }

  get usable(): boolean {
    return !this.#ended;
  }

  listen(receive: (message: WorkerMessage) => void, crash: (message: string) => void): void {
    this.#receive = receive;
    this.#crash = crash;
  }

  post(message: WorkerRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(message, transfer);
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#receive = undefined;
    this.#crash = undefined;
    this.worker.terminate();
  }

  #fail(message: string): void {
    const crash = this.#crash;
    this.end();
    crash?.(message);
  }
}

interface Started {
  instance: RunnerInstance;
  loaded: Loaded;
}

function cancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new PythonRunError("cancelled", "运行已取消");
}

/**
 * 在 Worker 里用 Pyodide 运行 python.run 的测试。每次调用用一个全新、没有运行过学习者代码的 Worker，用完就销毁；
 * 探测和每次调用之后在后台预热下一个。调用逐个执行。取好的文件留在页面里，启动新 Worker 时不再下载。
 */
export class PythonRunner {
  readonly #options: PythonRunnerOptions;
  #files: Promise<RuntimeFiles> | undefined;
  #standby: Promise<Started> | undefined;
  /** 正在进行的调用；close 用它取消。 */
  #running: AbortController | undefined;
  /** close 之后加一；关闭前开始的调用结束时不再预热。 */
  #generation = 0;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: PythonRunnerOptions) {
    this.#options = options;
  }

  /** 探测：启动（或复用）预热的 Worker，报告它实际加载的环境。不运行代码，也不占用那个 Worker。 */
  async capabilities(signal?: AbortSignal): Promise<PythonCapabilities> {
    cancelled(signal);
    if (!this.#standby) this.#prepare();
    const standby = this.#standby;
    if (!standby) throw new PythonRunError("runtime_unavailable", "Python 运行器已经关闭");
    const [{ loaded }, runner] = await abortable(Promise.all([standby, runnerVersion]), signal);
    return { protocol: PYTHON_BATCH, runtime: environment(loaded, RUNNER_PACKAGES), runner, freshInterpreter: true };
  }

  run(input: PythonBatchInput, signal?: AbortSignal): Promise<PythonBatchResult> {
    const turn = this.#queue.then(() => this.#run(input, signal));
    // 队列只管先后；每个调用的失败已经交给它自己的调用方。
    this.#queue = turn.catch(() => undefined);
    return turn;
  }

  /** 取消正在进行的调用，结束预热的 Worker；之后的调用会启动新的。 */
  close(): void {
    this.#generation += 1;
    this.#running?.abort();
    const standby = this.#standby;
    this.#standby = undefined;
    void standby?.then((started) => started.instance.end(), () => {
      // 预热失败，没有 Worker 要结束。
    });
  }

  async #run(input: PythonBatchInput, external: AbortSignal | undefined): Promise<PythonBatchResult> {
    cancelled(external);
    const generation = this.#generation;
    const controller = new AbortController();
    const forward = () => controller.abort();
    external?.addEventListener("abort", forward, { once: true });
    this.#running = controller;
    try {
      const started = await this.#take(controller.signal);
      try {
        return await this.#execute(started, input, controller.signal);
      } finally {
        started.instance.end();
        if (generation === this.#generation) this.#prepare();
      }
    } finally {
      external?.removeEventListener("abort", forward);
      this.#running = undefined;
    }
  }

  #prepare(): void {
    const standby = this.#start(undefined);
    standby.catch(() => {
      // 预热失败不在这里报告：下一次调用取用时会重新启动，失败在那里交给调用方。
    });
    this.#standby = standby;
  }

  async #take(signal: AbortSignal | undefined): Promise<Started> {
    const standby = this.#standby;
    this.#standby = undefined;
    if (standby) {
      try {
        const started = await standby;
        cancelled(signal);
        if (started.instance.usable) return started;
      } catch (error) {
        if (error instanceof PythonRunError && error.code === "cancelled") throw error;
        // 预热的 Worker 没能启动，下面重新启动一次。
      }
    }
    return this.#start(signal);
  }

  /** 启动一个 Worker，期限从下载文件算起。 */
  #start(signal: AbortSignal | undefined): Promise<Started> {
    const timeoutMs = this.#options.startTimeoutMs ?? START_TIMEOUT_MS;
    let instance: RunnerInstance | undefined;
    let failed = false;
    return new Promise<Started>((resolve, reject) => {
      const fail = (error: PythonRunError) => {
        failed = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        instance?.end();
        reject(error);
      };
      const onAbort = () => fail(new PythonRunError("cancelled", "运行已取消"));
      const timer = setTimeout(() => fail(new PythonRunError("runtime_unavailable", `Pyodide 在 ${timeoutMs / 1000} 秒内没有就绪`)), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#boot((created) => {
        instance = created;
        // 下载文件时已经超时或取消：Worker 一建好就结束，不再启动 Pyodide。
        if (failed) created.end();
      }).then((started) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(started);
      }, (error: unknown) => {
        if (!failed) fail(error instanceof PythonRunError ? error : new PythonRunError("runtime_unavailable", "Pyodide 启动失败"));
      });
    });
  }

  async #boot(created: (instance: RunnerInstance) => void): Promise<Started> {
    this.#files ??= this.#options.loadFiles().catch((error: unknown) => {
      this.#files = undefined;
      throw error instanceof PythonRunError ? error : new PythonRunError("runtime_unavailable", "无法读取 Pyodide 文件");
    });
    const { lock, packages, files } = await this.#files;
    // 文件留在页面里给下一个 Worker 用，交给 Worker 的是副本。
    const copies = Object.fromEntries(Object.entries(files).map(([name, buffer]) => [name, buffer.slice(0)]));
    const instance = new RunnerInstance(this.#options.createWorker());
    created(instance);
    if (!instance.usable) throw new PythonRunError("cancelled", "启动已放弃");
    const ready = await new Promise<unknown>((resolve, reject) => {
      instance.listen((message) => {
        if (message.type === "ready") resolve(message.runtime);
      }, (message) => reject(new PythonRunError("runtime_unavailable", message)));
      const indexURL = new URL(this.#options.assetsUrl, location.href).href;
      instance.post({
        type: "start", indexURL, packageBaseUrl: new URL("packages/", indexURL).href, lock, packages,
        runner: runnerSource, files: copies,
      }, Object.values(copies));
    });
    if (!Value.Check(LoadedSchema, ready)) {
      instance.end();
      throw new PythonRunError("runtime_unavailable", "Python 运行器报告的运行环境无法识别");
    }
    return { instance, loaded: ready };
  }

  /** 按顺序运行全部测试。每个测试单独计时；超时或失败就结束 Worker，停在的阶段写进结果，之后的测试记为未执行。 */
  async #execute({ instance, loaded }: Started, input: PythonBatchInput, signal: AbortSignal | undefined): Promise<PythonBatchResult> {
    const timeoutMs = this.#options.testTimeoutMs ?? TEST_TIMEOUT_MS;
    const runner = await runnerVersion;
    return new Promise<PythonBatchResult>((resolve, reject) => {
      const tests: PythonTestResult[] = [];
      let step: Step = "prepare";
      let timer: ReturnType<typeof setTimeout> | undefined;
      const current = () => input.tests[tests.length];
      const settle = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        instance.end();
      };
      const finish = (last?: PythonTestResult) => {
        settle();
        if (last) tests.push(last);
        for (const test of input.tests.slice(tests.length)) tests.push({ id: test.id, status: "not_run" });
        resolve({
          protocol: PYTHON_BATCH,
          submissionId: input.submissionId,
          gradeRevision: input.gradeRevision,
          runtime: environment(loaded, Object.keys(input.runtime.packages)),
          runner,
          freshInterpreter: true,
          tests,
        });
      };
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const test = current();
          if (test) finish(timedOut(test.id, step, timeoutMs / 1000));
        }, timeoutMs);
      };
      const onAbort = () => {
        settle();
        reject(new PythonRunError("cancelled", "运行已取消"));
      };
      if (!instance.usable) {
        reject(new PythonRunError("runtime_unavailable", "Python 运行器已经结束"));
        return;
      }
      if (input.tests.length === 0) {
        finish();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      instance.listen((message) => {
        const test = current();
        if (!test || (message.type !== "phase" && message.type !== "tested") || message.test !== tests.length) return;
        if (message.type === "phase") {
          step = readStep(message.phase) ?? step;
          return;
        }
        const result = readTested(test.id, step, message.response);
        if (result.status !== "completed") {
          finish(result);
          return;
        }
        tests.push(result);
        step = "prepare";
        if (tests.length === input.tests.length) finish();
        else arm();
      }, (message) => {
        const test = current();
        if (test) finish(workerFailure(test.id, step, message));
      });
      arm();
      instance.post({ type: "run", tests: input.tests });
    });
  }
}

/** 等 promise，signal 中止时以 cancelled 结束；promise 本身不受影响。 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new PythonRunError("cancelled", "探测已取消"));
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

const ASSETS_URL = "/__repa/pyodide/";

/** 页面用的运行器：Pyodide 文件由宿主在 /__repa/pyodide/ 提供，Worker 脚本的响应头由宿主加 CSP。 */
export function createPythonRunner(): PythonRunner {
  return new PythonRunner({
    assetsUrl: ASSETS_URL,
    createWorker: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
    loadFiles: () => loadRuntimeFiles(ASSETS_URL),
  });
}
