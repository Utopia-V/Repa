import type { Duplex } from "node:stream";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { CapabilitySelectionSchema } from "../capabilities/schema.js";
import { RepaFault } from "../errors.js";
import { object } from "../schema.js";

const ProgramInvokeParamsSchema = object({ ...CapabilitySelectionSchema.properties, input: Type.Unknown() });
export type ProgramInvokeParams = Static<typeof ProgramInvokeParamsSchema>;
export type ProgramMethod = "describe" | "invoke";
const requestId = Type.Integer({ minimum: 1 });
const RequestSchema = Type.Union([
  object({ id: requestId, method: Type.Literal("describe") }),
  object({ id: requestId, method: Type.Literal("invoke"), params: ProgramInvokeParamsSchema }),
]);
const MAX_LINE_LENGTH = 16 * 1024 * 1024;

export class ProgramBridge {
  #controller = new AbortController();
  #stream?: Duplex;
  #buffer = "";
  #pending = new Map<number, Promise<void>>();
  #closing?: Promise<void>;
  #abort: () => void;

  constructor(private readonly options: {
    signal?: AbortSignal;
    dispatch(method: ProgramMethod, params: ProgramInvokeParams | undefined, signal: AbortSignal): Promise<unknown>;
  }) {
    this.#abort = () => { this.close().catch(() => {}); };
    options.signal?.addEventListener("abort", this.#abort, { once: true });
    if (options.signal?.aborted) this.#abort();
  }

  attach(stream: Duplex): void {
    if (this.#stream || this.#controller.signal.aborted) {
      stream.destroy();
      throw new RepaFault("program_closed", "程序能力通道已经连接或关闭。");
    }
    this.#stream = stream;
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => { this.#receive(chunk); });
    stream.on("error", this.#abort);
    stream.on("end", this.#abort);
    stream.on("close", this.#abort);
  }

  #receive(chunk: string): void {
    if (this.#controller.signal.aborted) return;
    this.#buffer += chunk;
    let boundary: number;
    while ((boundary = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, boundary);
      this.#buffer = this.#buffer.slice(boundary + 1);
      let value: unknown;
      try {
        if (line.length > MAX_LINE_LENGTH) throw new Error("line too long");
        value = JSON.parse(line);
      } catch {
        this.#invalid(null);
        return;
      }
      if (!Check(RequestSchema, value) || this.#pending.has(value.id)) {
        const id = value && typeof value === "object" && "id" in value && Check(requestId, value.id) ? value.id : null;
        this.#invalid(id);
        return;
      }
      const request = value;
      const task = Promise.resolve().then(() => this.#dispatch(request.id, request.method,
        request.method === "invoke" ? request.params : undefined));
      this.#pending.set(request.id, task);
      task.then(() => { this.#pending.delete(request.id); });
    }
    if (this.#buffer.length > MAX_LINE_LENGTH) this.#invalid(null);
  }

  async #dispatch(id: number, method: ProgramMethod, params: ProgramInvokeParams | undefined): Promise<void> {
    try {
      this.#controller.signal.throwIfAborted();
      const result = await this.options.dispatch(method, params, this.#controller.signal);
      this.#send({ id, result: result === undefined ? null : result });
    } catch (error) {
      const fault = error instanceof RepaFault ? error : new RepaFault("program_invoke_failed", "程序能力调用失败。");
      this.#send({ id, error: { code: fault.code, message: fault.message, ...(fault.details === undefined ? {} : { details: fault.details }) } });
    }
  }

  #send(value: unknown): void {
    if (!this.#controller.signal.aborted && this.#stream && !this.#stream.destroyed) {
      try {
        this.#stream.write(`${JSON.stringify(value)}\n`);
      } catch {
        this.#abort();
      }
    }
  }

  #invalid(id: number | null): void {
    // 先送出协议错误，再关闭连接；在途调用同时收到取消，不可逃出父命令。
    this.#controller.abort();
    if (this.#stream) {
      this.#stream.end(`${JSON.stringify({ id, error: { code: "invalid_program_request", message: "程序请求必须符合 describe 或 invoke 协议。" } })}\n`, this.#abort);
    } else {
      this.#abort();
    }
  }

  close(): Promise<void> {
    if (!this.#closing) {
      this.#controller.abort();
      this.options.signal?.removeEventListener("abort", this.#abort);
      this.#closing = (async () => {
        await Promise.all(this.#pending.values());
        this.#stream?.destroy();
      })();
    }
    return this.#closing;
  }
}
