import childProcess from "node:child_process";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { RepaFault } from "repa/protocol";
import { normalizeParameters } from "./fsrs.js";
import {
  ReviewOptimizationResultSchema,
  ReviewTrainingSnapshotSchema,
  type ReviewOptimizationResult,
  type ReviewTrainingSnapshot,
} from "./schema.js";

const object = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const OptimizationJobInputSchema = object({
  snapshot: ReviewTrainingSnapshotSchema,
  timeoutSeconds: Type.Integer({ minimum: 1, maximum: 300 }),
});
export type OptimizationJobInput = Static<typeof OptimizationJobInputSchema>;

export const OptimizationJobMessageSchema = Type.Union([
  object({ type: Type.Literal("progress"), message: Type.String() }),
  object({ type: Type.Literal("result"), result: ReviewOptimizationResultSchema }),
  object({
    type: Type.Literal("error"),
    code: Type.Union([Type.Literal("optimizer_unavailable"), Type.Literal("review_optimization_failed")]),
    message: Type.String(),
  }),
]);
export type OptimizationJobMessage = Static<typeof OptimizationJobMessageSchema>;

export interface OptimizeOptions {
  signal: AbortSignal;
  timeoutSeconds?: number;
  progress?(message: string): void;
}

/** 原生优化只在独立进程中运行；取消的完成条件是进程和它的原生线程已经退出。 */
export async function optimize(
  snapshot: ReviewTrainingSnapshot,
  options: OptimizeOptions,
): Promise<ReviewOptimizationResult> {
  if (options.signal.aborted) {
    throw new RepaFault("cancelled", "参数优化已取消。");
  }
  const input = { snapshot, timeoutSeconds: options.timeoutSeconds ?? 60 };
  // 快照由数据服务产生；完整数据校验留在子进程的 IPC 消费入口。
  if (!Value.Check(OptimizationJobInputSchema.properties.timeoutSeconds, input.timeoutSeconds)) {
    throw new RepaFault("invalid_input", "参数优化的超时无效。");
  }
  return new Promise<ReviewOptimizationResult>((resolve, reject) => {
    // 开发源码加载 tsx；发布包直接运行 .js，不继承宿主的调试器或 --input-type。
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const child = childProcess.fork(new URL(`./optimizer-job.${extension}`, import.meta.url), [], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      execArgv: extension === "ts" ? ["--import", "tsx"] : [],
      serialization: "json",
    });
    let result: ReviewOptimizationResult | undefined;
    let failure: RepaFault | undefined;
    let stderr = "";
    const stop = (fault: RepaFault) => {
      failure ??= fault;
      // 不依赖同步原生回调有机会处理 abort，也不留等待它结束的宽限期。
      child.kill("SIGKILL");
    };
    const abort = () => stop(new RepaFault("cancelled", "参数优化已取消。"));
    options.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      stop(new RepaFault("review_optimization_timeout", "参数优化超过限定时间。"));
    }, input.timeoutSeconds * 1000);
    child.stderr?.on("data", (bytes: Buffer) => {
      stderr = (stderr + bytes.toString("utf8")).slice(-4096);
    });
    child.on("error", () => {
      stop(new RepaFault("review_optimization_failed", "无法启动或联系参数优化进程。"));
    });
    child.on("message", (message: unknown) => {
      if (failure) return;
      if (!Value.Check(OptimizationJobMessageSchema, message)) {
        stop(new RepaFault("review_optimization_failed", "参数优化进程返回无效结果。"));
        return;
      }
      if (message.type === "error") {
        stop(new RepaFault(message.code, message.message));
      } else if (message.type === "progress") {
        try {
          options.progress?.(message.message);
        } catch {
          stop(new RepaFault("review_optimization_failed", "无法报告参数优化进度。"));
        }
      } else {
        if (result) {
          stop(new RepaFault("review_optimization_failed", "参数优化进程重复返回结果。"));
          return;
        }
        try {
          if (message.result.status === "ready") {
            normalizeParameters({ ...snapshot.parameters.parameters, w: message.result.w });
          }
          result = message.result;
        } catch {
          stop(new RepaFault("review_optimization_failed", "优化参数不能用于当前 FSRS 调度。"));
        }
      }
    });
    child.once("spawn", () => {
      if (options.signal.aborted) {
        abort();
        return;
      }
      child.send(input, (error) => {
        if (error) {
          stop(new RepaFault("review_optimization_failed", "无法投递参数优化历史。"));
        }
      });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", abort);
      if (failure) {
        reject(failure);
      } else if (code !== 0 || !result) {
        reject(new RepaFault("review_optimization_failed", "参数优化进程未能完成。", {
          exitCode: code, signal, ...(stderr ? { stderr } : {}),
        }));
      } else {
        resolve(result);
      }
    });
    if (options.signal.aborted) abort();
  });
}
