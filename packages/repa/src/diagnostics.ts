import { writeDiagnosticLine } from "./diagnostic-stderr.js";

const levels = { debug: 10, info: 20, warn: 30, error: 40, off: Infinity };
export type DiagnosticLevel = keyof typeof levels;
export interface DiagnosticOptions {
  level?: DiagnosticLevel;
  write?: (line: string) => void | Promise<void>;
}

const stringFields = [
  "spaceId", "sessionId", "requestId", "runId", "peerId", "method", "status", "phase",
  "code", "errorType", "toolName", "callId", "interactionId", "responseId", "interactionKind", "operation",
] as const;
const numberFields = ["textLength", "partCount", "submittedAt", "firstStatusAt", "firstTextAt", "durationMs"] as const;
export type DiagnosticFields = Partial<Record<typeof stringFields[number], string> & Record<typeof numberFields[number], number>> & {
  rpcId?: string | number;
};
export interface DiagnosticRecord extends DiagnosticFields {
  time: number;
  level: Exclude<DiagnosticLevel, "off">;
  event: string;
  applicationId: string;
}

/** 只输送明确列出的诊断字段；正文、凭据、错误 message 和 details 没有日志入口。 */
export class Diagnostics {
  readonly #level: number;
  readonly #write: (line: string) => void | Promise<void>;

  constructor(readonly applicationId: string, options: DiagnosticOptions = {}) {
    const level = options.level ?? process.env.REPA_LOG_LEVEL ?? "info";
    if (!Object.hasOwn(levels, level)) throw new Error("REPA_LOG_LEVEL 应为 debug、info、warn、error 或 off。");
    this.#level = levels[level as DiagnosticLevel];
    this.#write = options.write ?? writeDiagnosticLine;
  }

  record(level: Exclude<DiagnosticLevel, "off">, event: string, fields: DiagnosticFields = {}, time = Date.now()): void {
    if (levels[level] < this.#level) return;
    const entry: DiagnosticRecord = { time, level, event, applicationId: this.applicationId };
    for (const key of stringFields) if (typeof fields[key] === "string") entry[key] = fields[key];
    for (const key of numberFields) if (typeof fields[key] === "number") entry[key] = fields[key];
    if (typeof fields.rpcId === "string" || typeof fields.rpcId === "number") entry.rpcId = fields.rpcId;
    try {
      const pending = this.#write(`${JSON.stringify(entry)}\n`);
      void pending?.catch(() => {});
    } catch {
      // 可替换出口与默认 stderr 一样，只承担尽力诊断，不改变应用结果。
    }
  }
}
