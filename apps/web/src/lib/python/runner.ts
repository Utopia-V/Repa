import runnerSource from "@repa/learning/sandbox/runner.py?raw";
import { PythonRunResultSchema, type PythonRunInput, type PythonRunResult } from "@repa/learning/protocol";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import type { WorkerMessage, WorkerRequest } from "./messages";

/** 与课程核对相同：每个任务 10 秒，Pyodide 启动 60 秒。Pyodide 加载失败时会一直卡住、不报错，所以启动也要限时。 */
const RUN_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 60_000;
/** runner.py 在模块顶层导入它们；依赖由 pyodide-lock.json 补全。 */
const RUNNER_PACKAGES = ["numpy", "pandas"];
const CORE_FILES = ["pyodide.asm.wasm", "python_stdlib.zip"];

export type PythonRunErrorCode = "runtime_unavailable" | "runner_crashed" | "run_failed" | "timeout" | "cancelled";

/** code 原样作为 service.reply 的错误码交给调用方。 */
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
  runTimeoutMs?: number;
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

function readMessage(value: unknown): WorkerMessage | undefined {
  if (typeof value !== "object" || value === null || !("type" in value)) return undefined;
  if (value.type === "ready") return { type: "ready" };
  if (value.type === "failed" && "message" in value && typeof value.message === "string") return { type: "failed", message: value.message };
  if (value.type === "result" && "id" in value && typeof value.id === "number" && "response" in value) {
    return { type: "result", id: value.id, response: value.response };
  }
  return undefined;
}

/** runner.py 的回复：成功时是 program 任务的结果；失败是 prelude、data 或 setup 出错，与学习者代码里的异常不同。 */
function readResponse(response: unknown): PythonRunResult {
  if (typeof response === "object" && response !== null && "ok" in response) {
    if (response.ok === true && "result" in response && Value.Check(PythonRunResultSchema, response.result)) return response.result;
    const error = response.ok === false && "error" in response ? response.error : undefined;
    if (typeof error === "object" && error !== null && "type" in error && "message" in error
      && typeof error.type === "string" && typeof error.message === "string") {
      throw new PythonRunError("run_failed", `${error.type}: ${error.message}`);
    }
  }
  throw new PythonRunError("runner_crashed", "运行器返回了无法识别的结果");
}

interface Waiter {
  key: "start" | number;
  resolve(message: WorkerMessage): void;
  reject(error: PythonRunError): void;
}

/** 一个 Worker：一次只等一件事（启动或一个任务），超时、取消或出错就结束它。 */
class RunnerInstance {
  #waiter: Waiter | undefined;
  #ended: PythonRunError | undefined;

  constructor(private readonly worker: RunnerWorker, private readonly onEnd: () => void) {
    worker.onmessage = (event) => this.#receive(event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      this.end(new PythonRunError("runner_crashed", `Python 运行器出错：${event.message || "未知错误"}`));
    };
  }

  get ended(): boolean {
    return this.#ended !== undefined;
  }

  request(key: Waiter["key"], message: WorkerRequest, transfer: Transferable[], timeoutMs: number, timeout: PythonRunError, signal: AbortSignal | undefined): Promise<WorkerMessage> {
    if (this.#ended) return Promise.reject(this.#ended);
    return new Promise((resolve, reject) => {
      const onAbort = () => this.end(new PythonRunError("cancelled", "运行已取消"));
      const timer = setTimeout(() => this.end(timeout), timeoutMs);
      const settle = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.#waiter = undefined;
      };
      this.#waiter = {
        key,
        resolve: (value) => { settle(); resolve(value); },
        reject: (error) => { settle(); reject(error); },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.worker.postMessage(message, transfer);
    });
  }

  end(error: PythonRunError): void {
    if (this.#ended) return;
    this.#ended = error;
    this.worker.terminate();
    this.#waiter?.reject(error);
    this.onEnd();
  }

  #receive(value: unknown): void {
    const message = readMessage(value);
    const waiter = this.#waiter;
    if (!message || !waiter) return;
    if (message.type === "failed") {
      this.end(new PythonRunError(waiter.key === "start" ? "runtime_unavailable" : "runner_crashed", message.message));
    } else if ((message.type === "ready" && waiter.key === "start") || (message.type === "result" && message.id === waiter.key)) {
      waiter.resolve(message);
    }
  }
}

function cancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new PythonRunError("cancelled", "运行已取消");
}

/**
 * 在 Worker 里用 Pyodide 运行 python.run 任务。任务逐个执行；Worker 第一次用时启动，
 * 超时、取消或出错后结束，下一次再启动新的。取好的文件留在页面里，重启时不再下载。
 */
export class PythonRunner {
  readonly #options: PythonRunnerOptions;
  #files: Promise<RuntimeFiles> | undefined;
  #instance: RunnerInstance | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #nextId = 0;

  constructor(options: PythonRunnerOptions) {
    this.#options = options;
  }

  run(input: PythonRunInput, signal?: AbortSignal): Promise<PythonRunResult> {
    const turn = this.#queue.then(() => this.#run(input, signal));
    // 队列只管先后；每个任务的失败已经交给它自己的调用方。
    this.#queue = turn.catch(() => undefined);
    return turn;
  }

  /** 结束当前的 Worker；之后的任务会启动新的。 */
  close(): void {
    this.#instance?.end(new PythonRunError("cancelled", "Python 运行器已关闭"));
  }

  async #run(input: PythonRunInput, signal: AbortSignal | undefined): Promise<PythonRunResult> {
    cancelled(signal);
    const instance = this.#instance ?? await this.#start(signal);
    const id = ++this.#nextId;
    const timeoutMs = this.#options.runTimeoutMs ?? RUN_TIMEOUT_MS;
    const timeout = new PythonRunError("timeout", `运行超过 ${timeoutMs / 1000} 秒，已停止`);
    const message = await instance.request(id, { type: "run", id, input }, [], timeoutMs, timeout, signal);
    return readResponse(message.type === "result" ? message.response : undefined);
  }

  async #start(signal: AbortSignal | undefined): Promise<RunnerInstance> {
    this.#files ??= this.#options.loadFiles().catch((error: unknown) => {
      this.#files = undefined;
      throw error instanceof PythonRunError ? error : new PythonRunError("runtime_unavailable", "无法读取 Pyodide 文件");
    });
    const { lock, packages, files } = await this.#files;
    cancelled(signal);
    // 文件留在页面里给下次重启用，交给 Worker 的是副本。
    const copies = Object.fromEntries(Object.entries(files).map(([name, buffer]) => [name, buffer.slice(0)]));
    const instance = new RunnerInstance(this.#options.createWorker(), () => {
      if (this.#instance === instance) this.#instance = undefined;
    });
    const indexURL = new URL(this.#options.assetsUrl, location.href).href;
    const timeoutMs = this.#options.startTimeoutMs ?? START_TIMEOUT_MS;
    await instance.request("start", {
      type: "start", indexURL, packageBaseUrl: new URL("packages/", indexURL).href, lock, packages, runner: runnerSource, files: copies,
    }, Object.values(copies), timeoutMs, new PythonRunError("runtime_unavailable", `Pyodide 在 ${timeoutMs / 1000} 秒内没有就绪`), signal);
    this.#instance = instance;
    return instance;
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
