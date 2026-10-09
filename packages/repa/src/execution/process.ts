import { execFile, spawn } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { RepaFault } from "../errors.js";
import { prepareCommand } from "./sandbox.js";
import type { ExecutionPolicy } from "./schema.js";

export interface CommandResult {
  exitCode: number;
  signal?: string;
}

export interface RunCommandOptions {
  command: string;
  cwd: string;
  policy: ExecutionPolicy;
  protectedPaths: readonly string[];
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeout?: number;
  onData(stream: "stdout" | "stderr", data: Buffer): void;
  onStarted?(pid: number): void;
  onExited?(result: CommandResult): void;
}

async function commandPipes() {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-command-pipes-"));
  const descriptors = new Set<number>();
  const streams: Socket[] = [];
  const open = (value: string, flags: number) => {
    const fd = openSync(value, flags);
    descriptors.add(fd);
    return fd;
  };
  const release = () => {
    for (const fd of descriptors) closeSync(fd);
    descriptors.clear();
  };
  const destroy = () => {
    streams.forEach((stream) => { stream.destroy(); });
  };
  try {
    const names = ["stdout", "stderr"];
    await promisify(execFile)("/usr/bin/mkfifo", ["--mode=600", ...names.map((name) => path.join(root, name))]);
    const pipe = (name: string) => {
      const value = path.join(root, name);
      // 这里只打开 FIFO 描述符，不读写文件；临时双向端避免建立连接时阻塞。
      open(value, constants.O_RDWR | constants.O_NONBLOCK);
      const child = open(value, constants.O_WRONLY);
      const host = open(value, constants.O_RDONLY | constants.O_NONBLOCK);
      const stream = new Socket({ fd: host, readable: true, writable: false });
      descriptors.delete(host);
      streams.push(stream);
      return { child, stream };
    };
    const stdout = pipe("stdout");
    const stderr = pipe("stderr");
    const stdio = [stdout.child, stderr.child];
    // 路径立即消失；子进程只能使用继承的 FD，不需要额外文件授权。
    await rm(root, { recursive: true, force: true });
    return { stdout: stdout.stream, stderr: stderr.stream, stdio, release, destroy };
  } catch (error) {
    destroy();
    release();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function groupIsRunning(pid: number): Promise<boolean> {
  if (!signalGroup(pid, 0)) {
    return false;
  }
  const processes = (await readdir("/proc")).filter((value) => /^\d+$/.test(value));
  const states = await Promise.all(processes.map(async (value) => {
    try {
      const stat = await readFile(`/proc/${value}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return Number(fields[2]) === pid && fields[0] !== "Z" && fields[0] !== "X";
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")) {
        return false;
      }
      throw error;
    }
  }));
  return states.some(Boolean);
}

export async function runCommand(options: RunCommandOptions): Promise<CommandResult> {
  let pipes: Awaited<ReturnType<typeof commandPipes>> | undefined;
  let prepared: Awaited<ReturnType<typeof prepareCommand>> | undefined;
  let terminal: CommandResult | undefined;
  try {
    if (options.signal?.aborted) {
      throw new Error("aborted");
    }
    if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0 || options.timeout > 2147483.647)) {
      throw new RepaFault("invalid_execution_timeout", "命令超时必须是允许范围内的正数秒数。");
    }
    prepared = await prepareCommand(options);
    const command = prepared;
    pipes = await commandPipes();
    const commandStreams = pipes;
    if (options.signal?.aborted) {
      throw new Error("aborted");
    }
    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(command.executable, command.args, {
        cwd: options.cwd,
        env: command.env,
        detached: true,
        stdio: ["ignore", ...commandStreams.stdio],
      });
      let cancellation: "aborted" | "timeout" | undefined;
      let failure: unknown;
      let killTimer: NodeJS.Timeout | undefined;
      let timeoutTimer: NodeJS.Timeout | undefined;
      let stopping = false;
      const stop = () => {
        if (child.pid === undefined || stopping) {
          return;
        }
        stopping = true;
        try {
          signalGroup(child.pid, "SIGTERM");
        } catch (error) {
          failure ??= error;
        }
        if (options.policy.mode === "restricted") {
          // 固定 bwrap monitor 负责结束并回收 PID namespace；KILL 它会提前丢失等待者。
          return;
        }
        killTimer = setTimeout(() => {
          if (child.pid !== undefined) {
            try {
              signalGroup(child.pid, "SIGKILL");
            } catch (error) {
              failure ??= error;
            }
          }
        }, 250);
      };
      const abort = () => {
        cancellation ??= "aborted";
        stop();
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      child.on("spawn", () => {
        try {
          if (child.pid !== undefined) {
            options.onStarted?.(child.pid);
          }
          if (options.signal?.aborted) {
            abort();
          }
          if (options.timeout !== undefined) {
            timeoutTimer = setTimeout(() => {
              cancellation ??= "timeout";
              stop();
            }, options.timeout * 1000);
          }
        } catch (error) {
          failure = error;
          stop();
        }
      });
      const consume = (stream: "stdout" | "stderr", bytes: Buffer) => {
        if (failure) {
          return;
        }
        try {
          options.onData(stream, bytes);
        } catch (error) {
          failure = error;
          stop();
        }
      };
      // numeric stdio 不纳入 child.close；显式等待读端 EOF，保留退出前的全部输出。
      const outputDone = Promise.all((["stdout", "stderr"] as const).map((name) => new Promise<void>((done) => {
        const stream = commandStreams[name];
        stream.on("data", (bytes: Buffer) => { consume(name, bytes); });
        stream.on("end", done);
        stream.on("close", done);
        stream.on("error", (error) => { failure ??= error; stop(); });
      })));
      child.on("error", (error) => {
        failure = error;
        if (child.pid === undefined) commandStreams.destroy();
      });
      commandStreams.release();
      // 父 shell 普通结束时也终止留在本次独立进程组内的后台任务。
      child.on("exit", () => { stop(); });
      child.on("close", (code, signal) => {
        options.signal?.removeEventListener("abort", abort);
        clearTimeout(timeoutTimer);
        const finish = async () => {
          try {
            stop();
            if (child.pid !== undefined && options.policy.mode === "full-access") {
              const deadline = Date.now() + 250;
              while (await groupIsRunning(child.pid)) {
                if (Date.now() >= deadline) {
                  signalGroup(child.pid, "SIGKILL");
                }
                await delay(20);
              }
            }
          } finally {
            clearTimeout(killTimer);
          }
          await outputDone;
          const result: CommandResult = {
            exitCode: code ?? (signal ? 128 + os.constants.signals[signal] : 1),
            ...(signal ? { signal } : {}),
          };
          if (child.pid !== undefined) {
            terminal = result;
          }
          if (failure) {
            throw failure;
          }
          if (cancellation) {
            throw new Error(cancellation === "timeout" ? `timeout:${options.timeout}` : "aborted");
          }
          return result;
        };
        finish().then(resolve, reject);
      });
    });
  } finally {
    pipes?.release();
    pipes?.destroy();
    await prepared?.cleanup?.();
    if (terminal) {
      options.onExited?.(terminal);
    }
  }
}
