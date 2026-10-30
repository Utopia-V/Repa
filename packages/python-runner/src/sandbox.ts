/**
 * Linux 上的隔离运行：用系统 python3 运行 sandbox/launch.py，加上 Landlock 与 seccomp 限制后 exec 成 Node，
 * 再由 sandbox/runner.mjs 加载 Pyodide 和 runner.py。父进程逐个发送任务、等待结果，超时就整个结束子进程。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";

import { endsBatch, type PythonTest, type PythonTestResult } from "./protocol.js";
import { PACKAGE_ROOT, RUNNER_FILE, type RuntimeAssets } from "./runtime.js";
import { failedAt, readStep, readTested, restartsTimer, timedOut, type Step } from "./test-results.js";

/** 沙箱的私有内存上限，2 GiB。 */
export const DEFAULT_MEMORY_BYTES = 2 * 1024 ** 3;
/** 单个任务默认的时限，10 秒；超时就结束整个沙箱。 */
export const DEFAULT_JOB_TIMEOUT_MS = 10_000;
const STARTUP_TIMEOUT_MS = 60_000;
const CPU_SECONDS = 600;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const STDERR_TAIL = 8 * 1024;
const SANDBOX_DIRECTORY = path.join(PACKAGE_ROOT, "sandbox");

/** 沙箱里实际加载的 Pyodide、Python 和包的版本。 */
export interface RuntimeVersions {
  pyodide: string;
  python: string;
  packages: Record<string, string>;
}

/** 沙箱建立不了：缺少 Landlock、libseccomp 或 python3 等。调用方应当报错，不改用不受限的运行。 */
export class SandboxUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailable";
  }
}

/** 一个任务的结局：done 是 runner.py 交回了结果（ok 为 false 时是任务本身出错），timeout 和 crashed 时沙箱已经结束。 */
export type JobOutcome =
  | { status: "done"; ok: true; result: unknown }
  | { status: "done"; ok: false; error: { type: string; message: string }; trace?: string }
  | { status: "timeout" }
  | { status: "crashed"; detail: string };

/** 启动沙箱的选项：要加载的运行时文件、内存上限和启动沙箱用的系统 python3。 */
export interface SandboxOptions {
  assets: RuntimeAssets;
  memoryBytes?: number;
  python?: string;
}

interface RunnerMessage {
  type: string;
  id?: number;
  versions?: RuntimeVersions;
  message?: string;
  phase?: unknown;
  response?: unknown;
}

interface JobResponse { ok: boolean; result?: unknown; error?: { type: string; message: string }; trace?: string }

function isJobResponse(value: unknown): value is JobResponse {
  return typeof value === "object" && value !== null && "ok" in value && typeof value.ok === "boolean";
}

/** 一个沙箱进程：启动时加载 Pyodide，之后逐个运行任务；超时或崩溃后不再可用。 */
export class PythonSandbox {
  private buffer = "";
  private stderr = "";
  private nextId = 1;
  /** 已结束或已下令结束的进程不再接任务。 */
  private alive = true;
  private readonly exited: Promise<void>;
  /** 收到还没人取走的消息；一个测试会先后发来几条阶段消息和结果。 */
  private readonly queue: RunnerMessage[] = [];
  /** 启动阶段等待 ready；之后等待当前任务的消息。两者都只会有一个在等。 */
  private waiting: ((message: RunnerMessage | undefined) => void) | undefined;

  private constructor(private readonly child: ChildProcess) {
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.receive(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL);
    });
    child.on("error", (error) => {
      this.stderr += String(error);
    });
    // close 在输出流都读完之后才触发，此时 stderr 里已经有完整的退出原因。
    this.exited = new Promise((resolve) => {
      child.on("close", () => {
        this.alive = false;
        this.deliver(undefined);
        resolve();
      });
    });
  }

  /** 启动一个沙箱，等它加载好 Pyodide、要求的包和 runner.py；建立不了时抛 SandboxUnavailable。 */
  static async start(options: SandboxOptions): Promise<{ sandbox: PythonSandbox; versions: RuntimeVersions }> {
    const { assets } = options;
    const node = await realpath(process.execPath);
    const runnerConfig = {
      pyodide: assets.pyodideDirectory,
      packages: assets.packagesDirectory,
      runner: RUNNER_FILE,
      load: assets.load,
    };
    const launchConfig = {
      // /usr 只读放行系统库；/etc/ld.so.cache 供动态链接器查找库；其余只有运行时文件。
      // runner.py 和 wheel 逐个文件放行，不放行它们所在的目录：wheel 的目录可以由使用者指定，不能借此读到旁边的文件。
      read: [
        "/usr", "/etc/ld.so.cache", "/dev/urandom", assets.pyodideDirectory, assets.wsDirectory, SANDBOX_DIRECTORY, RUNNER_FILE,
        ...assets.wheels.map((wheel) => path.join(assets.packagesDirectory, wheel.file)),
      ],
      write: ["/dev/null"],
      memory: options.memoryBytes ?? DEFAULT_MEMORY_BYTES,
      cpuSeconds: CPU_SECONDS,
      // Node 读不到系统 OpenSSL 配置时会直接退出，指向 /dev/null 让它使用内置配置。
      env: { OPENSSL_CONF: "/dev/null" },
      // 不加载原生插件，不从字符串生成代码（配合 runner.mjs 里空的 jsglobals，Python 拿不到 Function 构造器）。
      argv: [
        node, "--no-addons", "--disallow-code-generation-from-strings", "--max-old-space-size=768",
        path.join(SANDBOX_DIRECTORY, "runner.mjs"), JSON.stringify(runnerConfig),
      ],
    };
    const child = spawn(options.python ?? "/usr/bin/python3", ["-I", "-S", path.join(SANDBOX_DIRECTORY, "launch.py"), JSON.stringify(launchConfig)], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {},
    });
    const sandbox = new PythonSandbox(child);
    const message = await sandbox.next(STARTUP_TIMEOUT_MS);
    if (message === "timeout") {
      sandbox.kill();
      throw new SandboxUnavailable(`Pyodide 在 ${STARTUP_TIMEOUT_MS / 1000} 秒内没有就绪`);
    }
    if (message?.type === "ready" && message.versions) return { sandbox, versions: message.versions };
    sandbox.kill();
    const reason = message?.type === "fatal" ? `Pyodide 启动失败：${message.message ?? ""}` : `隔离环境没有建立起来：${sandbox.stderr.trim() || "运行器提前退出"}`;
    throw new SandboxUnavailable(reason);
  }

  /** 取下一条消息；进程已经结束、没有剩下的消息时得到 undefined。 */
  private next(timeoutMs: number): Promise<RunnerMessage | undefined | "timeout"> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (!this.alive) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting = undefined;
        resolve("timeout");
      }, timeoutMs);
      this.waiting = (message) => {
        clearTimeout(timer);
        resolve(message);
      };
    });
  }

  /** 交给正在等的一方；没有人在等就排进队列。undefined 表示进程已经结束。 */
  private deliver(message: RunnerMessage | undefined): void {
    const waiting = this.waiting;
    if (!waiting) {
      if (message) this.queue.push(message);
      return;
    }
    this.waiting = undefined;
    waiting(message);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.stderr += "\n运行器的一条消息超过 16 MiB";
      this.kill();
      return;
    }
    for (let newline = this.buffer.indexOf("\n"); newline >= 0; newline = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      try {
        this.deliver(JSON.parse(line) as RunnerMessage);
      } catch {
        this.stderr += `\n运行器输出了无法解析的内容：${line.slice(0, 200)}`;
        this.kill();
      }
    }
  }

  get running(): boolean {
    return this.alive;
  }

  /** 发送一个任务（目前只有 verify）并等待结果。同一时间只运行一个任务；超时会结束整个子进程。测试用 runTest。 */
  async run(job: Record<string, unknown>, timeoutMs = DEFAULT_JOB_TIMEOUT_MS): Promise<JobOutcome> {
    if (this.waiting) throw new Error("上一个任务还没有结束");
    const id = this.nextId++;
    const reply = this.next(timeoutMs);
    this.child.stdin?.write(`${JSON.stringify({ ...job, id })}\n`);
    const message = await reply;
    if (message === "timeout") {
      this.kill();
      return { status: "timeout" };
    }
    if (message?.type !== "result" || message.id !== id || !isJobResponse(message.response)) {
      this.kill();
      return { status: "crashed", detail: this.crashDetail(message) };
    }
    const { response } = message;
    if (response.ok) return { status: "done", ok: true, result: response.result };
    return {
      status: "done", ok: false,
      error: response.error ?? { type: "Error", message: "未知错误" },
      ...(response.trace ? { trace: response.trace } : {}),
    };
  }

  /**
   * 运行一个 python.run 的测试，与页面的 Worker 相同：runner.py 的 program_test 每个阶段开始前报告阶段，
   * 准备、被测代码和收尾各自计时，超时就结束整个子进程，按最后报告的阶段写进结果。计时与归类见 test-results.ts。
   */
  async runTest(test: PythonTest, timeoutMs = DEFAULT_JOB_TIMEOUT_MS): Promise<PythonTestResult> {
    if (this.waiting) throw new Error("上一个任务还没有结束");
    const id = this.nextId++;
    let deadline = performance.now() + timeoutMs;
    let step: Step = "prepare";
    this.child.stdin?.write(`${JSON.stringify({ op: "test", id, test })}\n`);
    for (;;) {
      const message = await this.next(Math.max(0, deadline - performance.now()));
      if (message === "timeout") {
        this.kill();
        return timedOut(test.id, step);
      }
      if (message?.type === "phase" && message.id === id) {
        const entered: Step = readStep(message.phase) ?? step;
        if (entered !== step && restartsTimer(entered)) deadline = performance.now() + timeoutMs;
        step = entered;
        continue;
      }
      if (message?.type === "result" && message.id === id) return readTested(test.id, step, message.response);
      this.kill();
      return failedAt(test.id, step, this.crashDetail(message));
    }
  }

  private crashDetail(message: RunnerMessage | undefined): string {
    const detail = message?.type === "fatal" ? message.message : undefined;
    return detail || this.stderr.trim() || "运行器提前退出或发来意外的消息";
  }

  kill(): void {
    if (!this.alive) return;
    this.alive = false;
    this.child.kill("SIGKILL");
  }

  /** 关闭输入让运行器自行结束，两秒内没结束就强制结束；等进程真正退出后返回。 */
  async close(): Promise<void> {
    if (this.alive) {
      this.child.stdin?.end();
      const timer = setTimeout(() => this.kill(), 2_000);
      await this.exited;
      clearTimeout(timer);
      return;
    }
    await this.exited;
  }
}

/** 按需启动沙箱，之后的任务都在同一个解释器里运行；某个任务超时、运行器崩溃或恢复解释器状态失败后，下一个任务换一个新的沙箱。 */
export class SandboxRunner {
  #starts = 0;
  private current: PythonSandbox | undefined;
  private started: RuntimeVersions | undefined;

  constructor(private readonly options: SandboxOptions) {}

  /** 到目前为止启动过几个沙箱：第一个，加上每次超时、崩溃或恢复失败之后各一个。代价关卡按它核对。 */
  get starts(): number {
    return this.#starts;
  }

  /** 启动（或沿用）沙箱，返回实际加载的版本。 */
  async start(): Promise<RuntimeVersions> {
    if (this.current?.running && this.started) return this.started;
    await this.current?.close();
    const { sandbox, versions } = await PythonSandbox.start(this.options);
    this.#starts += 1;
    this.current = sandbox;
    this.started = versions;
    return versions;
  }

  /** 运行一个任务（目前只有 verify）。每个任务都带上运行环境声明的前导，运行器在任务的命名空间里先运行它。 */
  async run(job: Record<string, unknown>, timeoutMs?: number): Promise<JobOutcome> {
    await this.start();
    if (!this.current) throw new SandboxUnavailable("沙箱没有启动");
    return this.current.run({ prelude: this.options.assets.prelude, ...job }, timeoutMs);
  }

  /**
   * 按 python.run 的约定运行一批测试（见 @repa/python-runner/protocol）：在当前的沙箱里依次运行，测试之间由 runner.py 恢复状态，
   * 恢复失败就换一个新的沙箱运行余下的测试；某个测试超时或失败后整批停下，余下的记为 not_run，并结束这个沙箱。
   * 与页面不同的是，没有出问题的沙箱留给下一次调用接着用。测试自带前导，不另加运行环境的前导。
   */
  async runTests(tests: readonly PythonTest[], timeoutMs?: number): Promise<PythonTestResult[]> {
    const results: PythonTestResult[] = [];
    let stopped = false;
    for (const test of tests) {
      if (stopped) {
        results.push({ id: test.id, status: "not_run" });
        continue;
      }
      try {
        await this.start();
      } catch (error) {
        // 恢复失败后换沙箱时起不来：已经得到的结果留下，这个测试记为准备阶段的执行失败，其余未执行，与页面相同。
        if (results.length === 0) throw error;
        results.push(failedAt(test.id, "prepare", error instanceof Error ? error.message : "Python 沙箱启动失败"));
        stopped = true;
        continue;
      }
      if (!this.current) throw new SandboxUnavailable("沙箱没有启动");
      const result = await this.current.runTest(test, timeoutMs);
      results.push(result);
      stopped = endsBatch(result);
      if (stopped || (result.status === "completed" && result.restoreError !== undefined)) await this.close();
    }
    return results;
  }

  /** 关闭当前的沙箱；之后再运行任务会启动新的。 */
  async close(): Promise<void> {
    await this.current?.close();
    this.current = undefined;
  }
}
