import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { object } from "../schema.js";
import { RepaFault } from "../errors.js";
import { writeJsonSync, writeJson } from "../storage/atomic.js";
import type { ContentStore } from "../content/store.js";
import { BackgroundRequestSchema, RepresentationSchema, type BackgroundRequest, type ProcessingResult, type Input } from "./schema.js";
import type { Dialog, DialogOptions } from "../pi-host.js";
import type { Interaction, Reply } from "../protocol.js";
import { remapInput } from "./store.js";
import { inputResources } from "./input.js";

export interface ProcessingContext {
  signal: AbortSignal;
  content: ContentStore;
  progress(message: string): void;
  ask(dialog: Dialog, options?: DialogOptions): Promise<Reply>;
}

/** 能力交付已解析的处理函数；本模块只持有受理、取消、持久结果和资源，不加载插件。 */
export class BackgroundRequests {
  readonly requests = new Map<string, BackgroundRequest>();
  readonly #active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  readonly #directory: string;

  constructor(readonly content: ContentStore, readonly assertOwned: () => void, readonly changed: (request: BackgroundRequest) => void, readonly ask: (requestId: string, signal: AbortSignal, dialog: Dialog, options?: DialogOptions) => Promise<Reply>) {
    this.#directory = path.join(content.options.root, ".repa", "runtime", "processing");
    mkdirSync(this.#directory, { recursive: true });
    for (const name of readdirSync(this.#directory).filter(name => name.endsWith(".json"))) {
      const raw: unknown = JSON.parse(readFileSync(path.join(this.#directory, name), "utf8"));
      if (!Check(object({ version: Type.Literal(1), request: BackgroundRequestSchema }), raw))
        throw new RepaFault("invalid_request_record", "后台请求记录无法解析。");
      const request = raw.request;
      this.requests.set(request.requestId, request);
      if (["accepted", "running", "cancelling"].includes(request.status)) this.#save({ ...request, status: "interrupted", interactions: [], finishedAt: Date.now() });
    }
  }

  get active(): boolean { return this.#active.size > 0; }

  #save(request: BackgroundRequest): void {
    this.assertOwned();
    writeJsonSync(path.join(this.#directory, `${request.requestId}.json`), { version: 1, request });
    this.requests.set(request.requestId, structuredClone(request));
    this.changed(request);
  }

  submit(params: { requestId: string; operation: string; input: Input }, execute: (input: Input, context: ProcessingContext) => Promise<ProcessingResult>): BackgroundRequest {
    const old = this.requests.get(params.requestId);
    if (old) {
      if (old.operation !== params.operation || !isDeepStrictEqual(old.input, params.input))
        throw new RepaFault("request_id_conflict", "相同请求标识已用于另一项处理。");
      return structuredClone(old);
    }
    const request: BackgroundRequest = {
      ...structuredClone(params), spaceId: this.content.options.spaceId, createdAt: Date.now(), status: "accepted", interactions: [],
    };
    if (!Check(BackgroundRequestSchema, request)) throw new RepaFault("invalid_input", "后台请求参数无效。");
    const owner = `processing:${request.requestId}`;
    this.content.retention.retain(owner, inputResources(request.input));
    this.#save(request);
    const controller = new AbortController();
    const done = Promise.resolve().then(async () => {
      try {
        if (controller.signal.aborted) return;
        this.#save({ ...request, status: "running" });
        const result = await execute(structuredClone(request.input), {
          signal: controller.signal, content: this.content,
          ask: (dialog, options) => this.ask(request.requestId, controller.signal, dialog, options),
          progress: message => this.#save({ ...this.get(request.requestId), progress: message }),
        });
        if (!Check(RepresentationSchema, result)) throw new RepaFault("invalid_result", "后台处理结果不符合表示契约。");
        const resources = [...inputResources(request.input), ...result.resources,
          ...(result.value.kind === "resource" ? [result.value.resource] : [])];
        this.content.retention.retain(owner, resources);
        this.#save({ ...this.get(request.requestId), status: "completed", result, finishedAt: Date.now() });
      } catch (error) {
        this.#save({ ...this.get(request.requestId), status: controller.signal.aborted ? "cancelled" : "failed", finishedAt: Date.now(),
          error: { code: error instanceof RepaFault ? error.code : "processing", message: error instanceof Error ? error.message : String(error) } });
      } finally {
        if (this.get(request.requestId).status === "cancelling")
          this.#save({ ...this.get(request.requestId), status: "cancelled", finishedAt: Date.now() });
        controller.abort();
        this.#active.delete(request.requestId);
        this.changed(this.get(request.requestId));
      }
    });
    this.#active.set(request.requestId, { controller, done });
    return structuredClone(request);
  }

  get(requestId: string): BackgroundRequest {
    const request = this.requests.get(requestId);
    if (!request) throw new RepaFault("not_found", "后台请求不存在。");
    return structuredClone(request);
  }

  interaction(requestId: string, id: string, interaction: Interaction | null): void {
    const request = this.get(requestId);
    this.#save({ ...request, interactions: [...request.interactions.filter(item => item.id !== id), ...(interaction ? [interaction] : [])] });
  }

  cancel(requestId: string): BackgroundRequest {
    const active = this.#active.get(requestId);
    if (active) {
      active.controller.abort();
      this.#save({ ...this.get(requestId), status: "cancelling" });
    }
    return this.get(requestId);
  }

  cancelAll(): void {
    for (const id of this.#active.keys()) this.cancel(id);
  }

  async settled(): Promise<void> {
    await Promise.all([...this.#active.values()].map(active => active.done));
  }
}

export async function copyProcessingRecords(root: string, source: string, destination: string): Promise<void> {
  const directory = path.join(root, ".repa", "runtime", "processing");
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names.filter(name => name.endsWith(".json"))) {
    const file = path.join(directory, name);
    const raw: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!Check(object({ version: Type.Literal(1), request: BackgroundRequestSchema }), raw))
      throw new RepaFault("invalid_request_record", "后台请求记录无法解析。");
    raw.request.spaceId = destination;
    remapInput(raw.request.input, source, destination);
    if (raw.request.result) remapInput({ parts: [{ kind: "data", representation: raw.request.result }] }, source, destination);
    for (const interaction of raw.request.interactions) interaction.spaceId = destination;
    await writeJson(file, raw);
  }
}
