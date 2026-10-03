import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { IdSchema, object } from "../schema.js";
import { RepaFault } from "../errors.js";
import { writeJsonSync, writeJson } from "../storage/atomic.js";
import type { ContentStore } from "../content/store.js";
import type { ResourceRef } from "../content/schema.js";
import { BackgroundRequestSchema, RepresentationSchema, type BackgroundRequest, type ProcessingResult, type Input } from "./schema.js";
import type { Dialog, DialogOptions } from "../pi-host.js";
import type { Interaction, Reply, InteractionReplyReceipt } from "../protocol.js";
import { remapInput } from "./store.js";
import { inputResources } from "./input.js";
import { CapabilityScopeSchema } from "../capabilities/schema.js";
import { interruptModelAttempts, updateModelAttempts, type ModelAttempt } from "../models/schema.js";

export interface ProcessingContext {
  signal: AbortSignal;
  content?: ContentStore;
  progress(message: string): void;
  ask(dialog: Dialog, options?: DialogOptions): Promise<Reply>;
}

export interface BackgroundRequestsOptions {
  directory: string;
  spaceId?: string;
  content?: ContentStore;
  assertOwned(): void;
  changed(request: BackgroundRequest): void;
  ask(requestId: string, signal: AbortSignal, dialog: Dialog, options?: DialogOptions): Promise<Reply>;
}

const storedRequestSchema = object({ version: Type.Literal(1), request: BackgroundRequestSchema });

/** 能力交付已解析的处理函数；本模块只持有受理、取消、持久结果和资源，不加载插件。 */
export class BackgroundRequests {
  readonly requests = new Map<string, BackgroundRequest>();
  readonly #active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  readonly #directory: string;

  constructor(readonly options: BackgroundRequestsOptions) {
    if ((options.spaceId !== undefined && !Check(IdSchema, options.spaceId)) ||
        (options.content !== undefined && options.content.options.spaceId !== options.spaceId))
      throw new RepaFault("invalid_request_scope", "后台处理的空间身份与内容入口不一致。");
    this.#directory = path.resolve(options.directory);
    mkdirSync(this.#directory, { recursive: true });
    for (const name of readdirSync(this.#directory).filter(name => name.endsWith(".json"))) {
      const raw: unknown = JSON.parse(readFileSync(path.join(this.#directory, name), "utf8"));
      if (!Check(storedRequestSchema, raw) || raw.request.spaceId !== options.spaceId)
        throw new RepaFault("invalid_request_record", "后台请求记录无法解析。");
      const request = raw.request;
      this.requests.set(request.requestId, request);
      const interrupted = ["accepted", "running", "cancelling"].includes(request.status);
      const attempts = request.modelAttempts?.some(attempt => attempt.status === "running")
        ? interruptModelAttempts(request.modelAttempts) : undefined;
      if (interrupted || attempts) this.#persist({ ...request,
        ...(interrupted ? { status: "interrupted", interactions: [], finishedAt: Date.now() } : {}),
        ...(attempts ? { modelAttempts: attempts } : {}),
      });
    }
  }

  get active(): boolean { return this.#active.size > 0; }

  #persist(request: BackgroundRequest): void {
    this.options.assertOwned();
    writeJsonSync(path.join(this.#directory, `${request.requestId}.json`), { version: 1, request });
    this.requests.set(request.requestId, structuredClone(request));
  }

  #save(request: BackgroundRequest): void {
    this.#persist(request);
    this.options.changed(request);
  }

  #retain(requestId: string, resources: readonly ResourceRef[]): void {
    const content = this.options.content;
    if (resources.length && !content)
      throw new RepaFault("space_required", "持有空间资源的后台处理需要明确的所属空间和内容入口。");
    content?.retention.retain(`processing:${requestId}`, resources);
  }

  submit(params: { requestId: string; operation: string; input: Input; options?: unknown; configuration?: unknown }, execute: (input: Input, context: ProcessingContext) => Promise<ProcessingResult>): BackgroundRequest {
    const old = this.requests.get(params.requestId);
    if (old) {
      if (old.operation !== params.operation || !isDeepStrictEqual(old.input, params.input) || !isDeepStrictEqual(old.options, params.options))
        throw new RepaFault("request_id_conflict", "相同请求标识已用于另一项处理。");
      return structuredClone(old);
    }
    const submitted = structuredClone(params);
    const request: BackgroundRequest = {
      requestId: submitted.requestId,
      operation: submitted.operation,
      input: submitted.input,
      ...(submitted.options !== undefined ? { options: submitted.options } : {}),
      ...(submitted.configuration !== undefined ? { configuration: submitted.configuration } : {}),
      ...(this.options.spaceId !== undefined ? { spaceId: this.options.spaceId } : {}),
      createdAt: Date.now(), status: "accepted", interactions: [],
    };
    if (!Check(BackgroundRequestSchema, request)) throw new RepaFault("invalid_input", "后台请求参数无效。");
    this.#retain(request.requestId, inputResources(request.input));
    this.#save(request);
    const controller = new AbortController();
    const done = Promise.resolve().then(async () => {
      try {
        if (controller.signal.aborted) return;
        this.#save({ ...request, status: "running" });
        const result = await execute(structuredClone(request.input), {
          signal: controller.signal,
          ...(this.options.content ? { content: this.options.content } : {}),
          ask: (dialog, options) => this.options.ask(request.requestId, controller.signal, dialog, options),
          progress: message => this.#save({ ...this.get(request.requestId), progress: message }),
        });
        if (!Check(RepresentationSchema, result)) throw new RepaFault("invalid_result", "后台处理结果不符合表示契约。");
        const resources = [...inputResources(request.input), ...result.resources,
          ...(result.value.kind === "resource" ? [result.value.resource] : [])];
        this.#retain(request.requestId, resources);
        this.#save({ ...this.get(request.requestId), status: controller.signal.aborted ? "cancelled" : "completed", result, finishedAt: Date.now() });
      } catch (error) {
        this.#save({ ...this.get(request.requestId), status: controller.signal.aborted ? "cancelled" : "failed", finishedAt: Date.now(),
          error: { code: error instanceof RepaFault ? error.code : "processing", message: error instanceof Error ? error.message : String(error) } });
      } finally {
        if (this.get(request.requestId).status === "cancelling")
          this.#save({ ...this.get(request.requestId), status: "cancelled", finishedAt: Date.now() });
        controller.abort();
        this.#active.delete(request.requestId);
        this.options.changed(this.get(request.requestId));
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

  recordModelAttempt(requestId: string, attempt: ModelAttempt): void {
    const request = this.get(requestId);
    this.#save({ ...request, modelAttempts: updateModelAttempts(request.modelAttempts ?? [], attempt) });
  }

  interaction(requestId: string, id: string, interaction: Interaction | null, receipt?: InteractionReplyReceipt): void {
    const request = this.get(requestId);
    this.#save({
      ...request,
      interactions: [...request.interactions.filter(item => item.id !== id), ...(interaction ? [interaction] : [])],
      ...(receipt ? { interactionReplies: [...request.interactionReplies ?? [], receipt] } : {}),
    });
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

  async settled(requestId?: string): Promise<void> {
    await Promise.all(requestId === undefined
      ? [...this.#active.values()].map(active => active.done)
      : [this.#active.get(requestId)?.done]);
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
    if (!Check(storedRequestSchema, raw) || raw.request.spaceId !== source)
      throw new RepaFault("invalid_request_record", "后台请求记录无法解析。");
    raw.request.spaceId = destination;
    const options = raw.request.options;
    if (["execution.run", "repa.capability.invoke", "package.install", "package.update", "package.remove"].includes(raw.request.operation) &&
      options !== null && typeof options === "object" && "scope" in options && Check(CapabilityScopeSchema, options.scope) &&
      options.scope.kind === "space" && options.scope.spaceId === source) options.scope.spaceId = destination;
    remapInput(raw.request.input, source, destination);
    if (raw.request.result) {
      remapInput({ parts: [{ kind: "data", representation: raw.request.result }] }, source, destination);
    }
    for (const interaction of raw.request.interactions) interaction.spaceId = destination;
    await writeJson(file, raw);
  }
}
