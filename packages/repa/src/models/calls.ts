import { getSupportedThinkingLevels, retryAssistantCall, type ModelThinkingLevel, type RetryPolicy } from "@earendil-works/pi-ai";
import type { ContentStore } from "../content/store.js";
import { RepaFault } from "../errors.js";
import { prepareInput } from "../requests/input.js";
import type { Input, ProcessingResult } from "../requests/schema.js";
import type { ModelBinding } from "./schema.js";
import type { ModelConnections } from "./service.js";

export interface ModelCallOptions {
  binding: ModelBinding;
  input: Input;
  content: ContentStore;
  requestId: string;
  resourceOwner: string;
  system: string;
  thinkingLevel: ModelThinkingLevel;
  retry: RetryPolicy;
  maxTokens?: number;
  signal: AbortSignal;
  onCancel?(): void;
}

type ActiveCall = { connectionId: string; controller: AbortController; done: Promise<void> };

/** 模型调用归真实调用者所有；这里只协调连接取消与 SDK 的实际结束。 */
export class ModelCalls {
  readonly #active = new Set<ActiveCall>();
  readonly #models: ModelConnections;

  constructor(models: ModelConnections) {
    this.#models = models;
  }

  complete(options: ModelCallOptions): Promise<ProcessingResult> {
    const controller = new AbortController();
    const call = {
      ...options,
      binding: structuredClone(options.binding),
      input: structuredClone(options.input),
      retry: structuredClone(options.retry),
      signal: AbortSignal.any([options.signal, controller.signal]),
    };
    let cancellationFailure: { error: unknown } | undefined;
    const notify = () => {
      try { call.onCancel?.(); } catch (error) { cancellationFailure = { error }; }
    };
    controller.signal.addEventListener("abort", notify, { once: true });
    const active: ActiveCall = { connectionId: call.binding.connection.id, controller, done: Promise.resolve() };
    // 在首次异步准备前登记，使同一轮收到的注销也能取消本次调用。
    this.#active.add(active);
    const result = Promise.resolve().then(() => this.#complete(call)).finally(() => {
      controller.signal.removeEventListener("abort", notify);
      this.#active.delete(active);
    });
    active.done = result.then(() => {}, () => {}).then(() => {
      if (cancellationFailure) throw cancellationFailure.error;
    });
    return result;
  }

  async #complete(options: ModelCallOptions): Promise<ProcessingResult> {
    options.signal.throwIfAborted();
    const prepared = await prepareInput(options.input, options.content, options.requestId, options.resourceOwner);
    options.signal.throwIfAborted();
    const { modelRuntime, model } = await this.#models.open(options.binding);
    options.signal.throwIfAborted();
    if (prepared.images.length && !model.input.includes("image"))
      throw new RepaFault("unsupported_input", "所选模型不支持图片输入，请选择视觉模型或先取得文本表示。");
    if (!getSupportedThinkingLevels(model).includes(options.thinkingLevel))
      throw new RepaFault("configuration", "所选模型不支持该思考强度。");
    const message = await retryAssistantCall(() => modelRuntime.completeSimple(model, {
      systemPrompt: options.system,
      messages: [{ role: "user", content: [{ type: "text", text: prepared.text }, ...prepared.images], timestamp: Date.now() }],
    }, {
      signal: options.signal,
      ...(options.thinkingLevel !== "off" ? { reasoning: options.thinkingLevel } : {}),
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    }), options.retry, options.signal);
    options.signal.throwIfAborted();
    if (message.stopReason === "error" || message.stopReason === "aborted")
      throw new RepaFault("provider", message.errorMessage ?? "独立模型调用未完成。");
    return {
      format: { id: "repa.model-response", version: "1" },
      value: { kind: "inline", data: { message, input: prepared.text, binding: structuredClone(options.binding) } },
      sources: prepared.sources,
      resources: prepared.resources,
    };
  }

  async cancel(connectionId: string): Promise<void> {
    const active = [...this.#active].filter((call) => call.connectionId === connectionId);
    for (const call of active) call.controller.abort();
    await Promise.all(active.map((call) => call.done));
  }
}
