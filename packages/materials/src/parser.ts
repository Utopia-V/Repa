import { Worker } from "node:worker_threads";
import { Type } from "repa/plugin";
import { Check } from "typebox/value";
import { RepaFault } from "repa/protocol";
import { ExtractDataSchema, type ExtractData, type ExtractInput } from "./schema.js";

/** 同步解析在独立 worker 中完成；取消返回前等待线程实际退出。 */
export async function parse(kind: "text" | "html" | "image", bytes: Uint8Array, input: ExtractInput, signal: AbortSignal, progress?: (message: string) => void): Promise<ExtractData> {
  signal.throwIfAborted();
  const worker = new Worker(new URL("./parser-worker.js", import.meta.url), { workerData: { kind, bytes,
    ...(input.range ? { range: input.range } : {}), ...(input.limit !== undefined ? { limit: input.limit } : {}) } });
  try {
    return await new Promise<ExtractData>((resolve, reject) => {
      const cancel = () => { void worker.terminate().catch(reject); };
      signal.addEventListener("abort", cancel, { once: true });
      worker.on("message", (raw: unknown) => {
        if (Check(Type.Object({ progress: Type.String() }, { additionalProperties: false }), raw)) {
          try { progress?.(raw.progress); } catch (error) { reject(error); }
          return;
        }
        if (signal.aborted) reject(signal.reason);
        else if (Check(ExtractDataSchema, raw)) resolve(raw);
        else reject(new RepaFault("material_parser", "材料解析器返回了无效结果。"));
      });
      worker.once("error", reject);
      worker.once("exit", code => {
        signal.removeEventListener("abort", cancel);
        reject(signal.aborted ? signal.reason : new RepaFault("material_parser", `材料解析线程退出 ${code}，没有完整结果。`));
      });
      if (signal.aborted) cancel();
    });
  } finally { await worker.terminate(); }
}
