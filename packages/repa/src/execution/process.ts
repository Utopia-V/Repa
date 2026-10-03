import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
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
  if (options.signal?.aborted) {
    throw new Error("aborted");
  }
  if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0 || options.timeout > 2147483.647)) {
    throw new RepaFault("invalid_execution_timeout", "命令超时必须是允许范围内的正数秒数。");
  }
  const prepared = await prepareCommand(options);
  let terminal: CommandResult | undefined;
  try {
    if (options.signal?.aborted) {
      throw new Error("aborted");
    }
    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(prepared.executable, prepared.args, {
        cwd: options.cwd,
        env: prepared.env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let cancellation: "aborted" | "timeout" | undefined;
      let failure: unknown;
      let killTimer: NodeJS.Timeout | undefined;
      let timeoutTimer: NodeJS.Timeout | undefined;
      const stop = () => {
        if (child.pid === undefined || killTimer) {
          return;
        }
        try {
          signalGroup(child.pid, "SIGTERM");
        } catch (error) {
          failure ??= error;
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
      child.stdout.on("data", (bytes: Buffer) => { consume("stdout", bytes); });
      child.stderr.on("data", (bytes: Buffer) => { consume("stderr", bytes); });
      child.on("error", (error) => { failure = error; });
      // 父 shell 普通结束时也终止留在本次独立进程组内的后台任务。
      child.on("exit", () => { stop(); });
      child.on("close", (code, signal) => {
        options.signal?.removeEventListener("abort", abort);
        clearTimeout(timeoutTimer);
        const finish = async () => {
          try {
            stop();
            if (child.pid !== undefined) {
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
    await prepared.cleanup?.();
    if (terminal) {
      options.onExited?.(terminal);
    }
  }
}
