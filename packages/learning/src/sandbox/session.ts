/**
 * 课程检查的隔离运行：用系统 python3 运行 sandbox/launch.py，加上 Landlock 与 seccomp 限制后 exec 成 Node，
 * 再由 sandbox/runner.mjs 加载 Pyodide。父进程逐个发送任务、等待结果，超时就整个结束子进程。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";

import { PACKAGE_ROOT, type RuntimeAssets } from "./runtime.js";

export const DEFAULT_MEMORY_BYTES = 2 * 1024 ** 3;
export const DEFAULT_JOB_TIMEOUT_MS = 10_000;
const STARTUP_TIMEOUT_MS = 60_000;
const CPU_SECONDS = 600;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const STDERR_TAIL = 8 * 1024;
const SANDBOX_DIRECTORY = path.join(PACKAGE_ROOT, "sandbox");

export interface RuntimeVersions {
  pyodide: string;
  python: string;
  packages: Record<string, string>;
}

/** 沙箱建立不了：缺少 Landlock、libseccomp 或 python3 等。课程检查以错误结束，不会改用不受限的运行。 */
export class SandboxUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailable";
  }
}

export type JobOutcome =
  | { status: "done"; ok: true; result: unknown }
  | { status: "done"; ok: false; error: { type: string; message: string }; trace?: string }
  | { status: "timeout" }
  | { status: "crashed"; detail: string };

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
  response?: { ok: boolean; result?: unknown; error?: { type: string; message: string }; trace?: string };
}

export class PythonSandbox {
  private buffer = "";
  private stderr = "";
  private nextId = 1;
  /** 已结束或已下令结束的进程不再接任务。 */
  private alive = true;
  private readonly exited: Promise<void>;
  /** 启动阶段等待 ready；之后等待当前任务的结果。两者都只会有一个在等。 */
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

  static async start(options: SandboxOptions): Promise<{ sandbox: PythonSandbox; versions: RuntimeVersions }> {
    const { assets } = options;
    const node = await realpath(process.execPath);
    const runnerConfig = {
      pyodide: assets.pyodideDirectory,
      packages: assets.packagesDirectory,
      runner: path.join(SANDBOX_DIRECTORY, "runner.py"),
      load: assets.load,
    };
    const launchConfig = {
      // /usr 只读放行系统库；/etc/ld.so.cache 供动态链接器查找库；其余只有运行时文件。
      // wheel 逐个文件放行，不放行它们所在的目录：目录可以由使用者指定，不能借此读到旁边的文件。
      read: [
        "/usr", "/etc/ld.so.cache", "/dev/urandom", assets.pyodideDirectory, assets.wsDirectory, SANDBOX_DIRECTORY,
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

  private next(timeoutMs: number): Promise<RunnerMessage | undefined | "timeout"> {
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

  private deliver(message: RunnerMessage | undefined): void {
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.(message);
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

  /** 发送一个任务并等待结果。同一时间只运行一个任务；超时会结束整个子进程。 */
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
    if (message?.type !== "result" || message.id !== id || !message.response) {
      this.kill();
      const detail = message?.type === "fatal" ? message.message : undefined;
      return { status: "crashed", detail: detail || this.stderr.trim() || "运行器提前退出或发来意外的消息" };
    }
    const { response } = message;
    if (response.ok) return { status: "done", ok: true, result: response.result };
    return {
      status: "done", ok: false,
      error: response.error ?? { type: "Error", message: "未知错误" },
      ...(response.trace ? { trace: response.trace } : {}),
    };
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

/** 按需启动沙箱；某个任务超时或运行器崩溃后，下一个任务换一个新的沙箱。 */
export class SandboxRunner {
  private current: PythonSandbox | undefined;
  private started: RuntimeVersions | undefined;

  constructor(private readonly options: SandboxOptions) {}

  /** 启动（或沿用）沙箱，返回实际加载的版本。 */
  async start(): Promise<RuntimeVersions> {
    if (this.current?.running && this.started) return this.started;
    await this.current?.close();
    const { sandbox, versions } = await PythonSandbox.start(this.options);
    this.current = sandbox;
    this.started = versions;
    return versions;
  }

  async run(job: Record<string, unknown>, timeoutMs?: number): Promise<JobOutcome> {
    await this.start();
    if (!this.current) throw new SandboxUnavailable("沙箱没有启动");
    return this.current.run(job, timeoutMs);
  }

  async close(): Promise<void> {
    await this.current?.close();
    this.current = undefined;
  }
}
