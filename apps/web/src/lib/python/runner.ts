import runnerSource from "@repa/learning/sandbox/runner.py?raw";
import {
  PythonRunPhaseSchema, PythonRunTestResultSchema, PythonRuntimeSchema,
  type PythonRunInput, type PythonRunPhase, type PythonRunResult, type PythonRunTestResult, type PythonRuntime,
} from "@repa/learning/protocol";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import type { WorkerMessage, WorkerRequest } from "./messages";

/**
 * 与课程核对相同：每个测试 10 秒。启动 60 秒，从下载 Pyodide 文件算起；Pyodide 加载失败时会一直卡住、不报错，所以启动也要限时。
 */
const TEST_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 60_000;
/** runner.py 在模块顶层导入它们；依赖由 pyodide-lock.json 补全。 */
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

let runnerHash: Promise<string> | undefined;

/** 结果里的 runner 版本：runner.py 源码的 SHA-256。 */
function hashRunner(): Promise<string> {
  runnerHash ??= sha256(new TextEncoder().encode(runnerSource).buffer);
  return runnerHash;
}

const ReadyRuntimeSchema = Type.Object({
  pyodide: Type.String(),
  python: Type.String(),
  packages: Type.Record(Type.String(), Type.String()),
});

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

function workerFailure(id: string, message: string): PythonRunTestResult {
  return { id, status: "failed", phase: "worker", error: { type: "WorkerError", message } };
}

/** frontend_test 的返回值：done 是 program 任务的结果，failed 是前导、数据或 setup 出错。其他的都当作 Worker 出了问题。 */
function readTested(id: string, response: unknown): PythonRunTestResult {
  if (typeof response === "object" && response !== null && "status" in response
    && (response.status === "done" || response.status === "failed")) {
    const result = { ...response, id };
    if (Value.Check(PythonRunTestResultSchema, result)) return result;
  }
  return workerFailure(id, "运行器返回了无法识别的结果");
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
  runtime: PythonRuntime;
}

function cancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new PythonRunError("cancelled", "运行已取消");
}

/**
 * 在 Worker 里用 Pyodide 运行 python.run 的测试。每次调用用一个全新、没有运行过学习者代码的 Worker，用完就销毁；
 * 调用之后在后台预热下一个。调用逐个执行。取好的文件留在页面里，启动新 Worker 时不再下载。
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

  run(input: PythonRunInput, signal?: AbortSignal): Promise<PythonRunResult> {
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

  async #run(input: PythonRunInput, external: AbortSignal | undefined): Promise<PythonRunResult> {
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
    const [{ lock, packages, files }, runner] = await Promise.all([this.#files, hashRunner()]);
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
        type: "start", indexURL, packageBaseUrl: new URL("packages/", indexURL).href, lock, packages, runner: runnerSource, files: copies,
      }, Object.values(copies));
    });
    const runtime = Value.Check(ReadyRuntimeSchema, ready) ? { ...ready, runner } : undefined;
    if (!runtime || !Value.Check(PythonRuntimeSchema, runtime)) {
      instance.end();
      throw new PythonRunError("runtime_unavailable", "Python 运行器报告的运行环境无法识别");
    }
    return { instance, runtime };
  }

  /** 按顺序运行全部测试。每个测试单独计时；超时或失败就结束 Worker，停在的阶段写进结果，之后的测试记为未执行。 */
  #execute({ instance, runtime }: Started, input: PythonRunInput, signal: AbortSignal | undefined): Promise<PythonRunResult> {
    const timeoutMs = this.#options.testTimeoutMs ?? TEST_TIMEOUT_MS;
    return new Promise<PythonRunResult>((resolve, reject) => {
      const tests: PythonRunTestResult[] = [];
      let at: { phase: PythonRunPhase; index: number | null } = { phase: "prelude", index: null };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const current = () => input.tests[tests.length];
      const settle = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        instance.end();
      };
      const finish = (last?: PythonRunTestResult) => {
        settle();
        if (last) tests.push(last);
        for (const test of input.tests.slice(tests.length)) tests.push({ id: test.id, status: "not_run" });
        resolve({ runtime, tests });
      };
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const test = current();
          if (test) finish({ id: test.id, status: "timeout", phase: at.phase, ...(at.index === null ? {} : { index: at.index }) });
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
      signal?.addEventListener("abort", onAbort, { once: true });
      instance.listen((message) => {
        const test = current();
        if (!test || (message.type !== "phase" && message.type !== "tested") || message.test !== tests.length) return;
        if (message.type === "phase") {
          if (Value.Check(PythonRunPhaseSchema, message.phase)) at = { phase: message.phase, index: message.index };
          return;
        }
        const result = readTested(test.id, message.response);
        if (result.status !== "done") {
          finish(result);
          return;
        }
        tests.push(result);
        at = { phase: "prelude", index: null };
        if (tests.length === input.tests.length) finish();
        else arm();
      }, (message) => {
        const test = current();
        if (test) finish(workerFailure(test.id, message));
      });
      arm();
      instance.post({ type: "run", input });
    });
  }
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
