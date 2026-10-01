import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { RepaFault } from "../errors.js";
import { object, IdSchema } from "../schema.js";
import { writeJsonSync } from "../storage/atomic.js";
import { RequestSchema, type RequestRecord, type Input } from "./schema.js";
import type { ContentTarget } from "../content/schema.js";

const fileSchema = object({ version: Type.Literal(1), request: RequestSchema });
const queuesSchema = object({ version: Type.Literal(1), paused: Type.Array(IdSchema) });

/** 请求先持久受理，再投递；同步保存与 Pi 的同步历史追加构成同一通知顺序。 */
export class RequestStore {
  readonly requests = new Map<string, RequestRecord>();
  readonly paused = new Set<string>();
  readonly #directory: string;
  #sequence = 0;

  constructor(root: string, readonly assertOwned: () => void) {
    this.#directory = path.join(root, ".repa", "runtime", "requests");
    mkdirSync(this.#directory, { recursive: true });
    for (const name of readdirSync(this.#directory).filter(name => name.endsWith(".json") && name !== "queues.json")) {
      const raw: unknown = JSON.parse(readFileSync(path.join(this.#directory, name), "utf8"));
      if (!Check(fileSchema, raw)) throw new RepaFault("invalid_request_record", "请求记录无法解析。");
      this.requests.set(raw.request.requestId, raw.request);
      this.#sequence = Math.max(this.#sequence, raw.request.sequence + 1);
    }
    try {
      const raw: unknown = JSON.parse(readFileSync(path.join(this.#directory, "queues.json"), "utf8"));
      if (!Check(queuesSchema, raw)) throw new RepaFault("invalid_request_record", "队列记录无法解析。");
      for (const id of raw.paused) this.paused.add(id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  nextSequence(): number { return this.#sequence++; }

  get(requestId: string): RequestRecord {
    const request = this.requests.get(requestId);
    if (!request) throw new RepaFault("not_found", "请求不存在。");
    return structuredClone(request);
  }

  save(request: RequestRecord): void {
    this.assertOwned();
    if (!Check(RequestSchema, request)) throw new RepaFault("invalid_request_record", "请求记录不符合持久格式。");
    writeJsonSync(path.join(this.#directory, `${request.requestId}.json`), { version: 1, request });
    this.requests.set(request.requestId, structuredClone(request));
  }

  pause(sessionId: string, paused: boolean): void {
    this.assertOwned();
    const next = new Set(this.paused);
    if (paused) next.add(sessionId);
    else next.delete(sessionId);
    writeJsonSync(path.join(this.#directory, "queues.json"), { version: 1, paused: [...next] });
    this.paused.clear();
    for (const id of next) this.paused.add(id);
  }

  list(sessionId: string): RequestRecord[] {
    return [...this.requests.values()].filter(request => request.target.sessionId === sessionId)
      .sort((a, b) => a.sequence - b.sequence);
  }

  /** 空间复制只迁接已声明的引用字段，表示内的任意业务数据仍由能力解释。 */
  remapSpace(source: string, destination: string): void {
    for (const saved of this.requests.values()) {
      const request = structuredClone(saved);
      request.target.spaceId = destination;
      request.submission.target.spaceId = destination;
      remapInput(request.input, source, destination);
      if (request.submission.input) remapInput(request.submission.input, source, destination);
      this.save(request);
    }
  }
}

export function remapInput(value: Input, source: string, destination: string): void {
  const target = (value: ContentTarget) => {
    if (value.kind === "content") {
      if (value.ref.spaceId === source) value.ref.spaceId = destination;
    } else if (value.spaceId === source) value.spaceId = destination;
  };
  for (const part of value.parts) {
    if (part.kind === "reference") target(part.target);
    if (part.kind === "selection") target(part.source.target);
    if (part.kind === "resource" && part.resource.spaceId === source) part.resource.spaceId = destination;
    if (part.kind === "data") {
      for (const origin of part.representation.sources) target(origin.target);
      const resources = [...part.representation.resources,
        ...(part.representation.value.kind === "resource" ? [part.representation.value.resource] : [])];
      for (const resource of resources) if (resource.spaceId === source) resource.spaceId = destination;
    }
  }
}
