import { Socket } from "node:net";
import type { CapabilityDescriptor } from "./capabilities/schema.js";
import type { ProgramInvokeParams } from "./execution/program.js";

export type { ProgramInvokeParams } from "./execution/program.js";

export class ProgramClientError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

class ProgramClient {
  #read: Socket;
  #write: Socket;
  #buffer = "";
  #nextId = 1;
  #closed = false;
  #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  constructor(fd: number) {
    // 两个继承的真实管道不需要 socket 类型探测，受限环境中同样可以使用。
    this.#read = new Socket({ fd, readable: true, writable: false });
    this.#write = new Socket({ fd: fd + 1, readable: false, writable: true });
    this.#read.setEncoding("utf8");
    this.#read.on("data", (chunk: string) => { this.#receive(chunk); });
    for (const stream of [this.#read, this.#write]) {
      stream.on("error", () => { this.close(); });
      stream.on("close", () => { this.close(); });
    }
    this.#read.on("end", () => { this.close(); });
    this.#read.unref();
    this.#write.unref();
  }

  async describe(): Promise<CapabilityDescriptor[]> {
    const result = await this.#request("describe");
    // 描述内容由能力宿主按公开 schema 校验，客户端仅确认顶层返回约定。
    if (!Array.isArray(result)) throw new ProgramClientError("invalid_program_response", "能力描述必须是数组。");
    return result as CapabilityDescriptor[];
  }

  invoke(params: ProgramInvokeParams): Promise<unknown> {
    return this.#request("invoke", params);
  }

  #request(method: "describe" | "invoke", params?: ProgramInvokeParams): Promise<unknown> {
    if (this.#closed) return Promise.reject(new ProgramClientError("program_closed", "程序能力通道已经关闭。"));
    const id = this.#nextId++;
    let line: string;
    try {
      line = `${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`;
    } catch {
      return Promise.reject(new ProgramClientError("invalid_program_input", "程序请求必须能够序列化。"));
    }
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#read.ref();
      this.#write.ref();
      this.#write.write(line, (error) => { if (error) this.close(); });
    });
  }

  #receive(chunk: string): void {
    this.#buffer += chunk;
    let boundary: number;
    while ((boundary = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, boundary);
      this.#buffer = this.#buffer.slice(boundary + 1);
      let value: unknown;
      try { value = JSON.parse(line); }
      catch { this.close(); return; }
      if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "number") {
        this.close();
        return;
      }
      const pending = this.#pending.get(value.id);
      if (!pending) { this.close(); return; }
      this.#pending.delete(value.id);
      if ("error" in value && value.error && typeof value.error === "object" && "code" in value.error && typeof value.error.code === "string" && "message" in value.error && typeof value.error.message === "string") {
        pending.reject(new ProgramClientError(value.error.code, value.error.message, "details" in value.error ? value.error.details : undefined));
      } else if ("result" in value) {
        pending.resolve(value.result);
      } else {
        pending.reject(new ProgramClientError("invalid_program_response", "程序能力响应不符合协议。"));
        this.close();
        return;
      }
    }
    if (this.#pending.size === 0) {
      this.#read.unref();
      this.#write.unref();
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#read.destroy();
    this.#write.destroy();
    for (const pending of this.#pending.values()) {
      pending.reject(new ProgramClientError("program_closed", "程序能力通道已经关闭。"));
    }
    this.#pending.clear();
  }
}

let singleton: ProgramClient | undefined;

export function getProgramClient(): ProgramClient {
  if (!singleton) {
    const value = process.env.REPA_PROGRAM_FD;
    if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 3) {
      throw new ProgramClientError("program_unavailable", "当前程序没有父命令提供的能力通道。");
    }
    singleton = new ProgramClient(Number(value));
  }
  return singleton;
}
