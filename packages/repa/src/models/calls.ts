import { randomUUID } from "node:crypto";
import { getSupportedThinkingLevels, isContextOverflow, isRetryableAssistantError, retryAssistantCall, type AssistantMessage, type ModelThinkingLevel, type RetryPolicy } from "@earendil-works/pi-ai";
import type { ContentStore } from "../content/store.js";
import { RepaFault } from "../errors.js";
import { prepareInput } from "../requests/input.js";
import type { Input, ProcessingResult } from "../requests/schema.js";
import type { BoundModelFallback, ModelAttempt, ModelBinding } from "./schema.js";
import type { ModelConnections } from "./service.js";
import type { ModelOutputConstraint } from "./output.js";

export interface ModelCallOptions {
  binding: ModelBinding;
  fallback?: BoundModelFallback;
  input: Input;
  content: ContentStore;
  requestId: string;
  resourceOwner: string;
  system: string;
  thinkingLevel: ModelThinkingLevel;
  retry: RetryPolicy;
  maxTokens?: number;
  output?: ModelOutputConstraint;
  signal: AbortSignal;
  onCancel?(): void;
  onAttempt?(attempt: ModelAttempt): void | Promise<void>;
}

type ActiveCall = { connectionIds: string[]; controller: AbortController; done: Promise<void> };

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
      ...(options.fallback ? { fallback: structuredClone(options.fallback) } : {}),
      input: structuredClone(options.input),
      retry: structuredClone(options.retry),
      signal: AbortSignal.any([options.signal, controller.signal]),
    };
    let cancellationFailure: { error: unknown } | undefined;
    const notify = () => {
      try { call.onCancel?.(); } catch (error) { cancellationFailure = { error }; }
    };
    controller.signal.addEventListener("abort", notify, { once: true });
    const active: ActiveCall = {
      connectionIds: [call.binding, ...call.fallback?.models ?? []].map(binding => binding.connection.id),
      controller, done: Promise.resolve(),
    };
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
    const context = {
      systemPrompt: options.output ? [options.system, options.output.instruction].filter(Boolean).join("\n\n") : options.system,
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: prepared.text }, ...prepared.images], timestamp: Date.now() }],
    };
    const attempts: ModelAttempt[] = [];
    const callId = randomUUID();
    let binding = options.binding;
    for (let index = 0; ; index += 1) {
      options.signal.throwIfAborted();
      const attempt: ModelAttempt = { callId, index, binding, startedAt: Date.now(), status: "running" };
      await options.onAttempt?.(structuredClone(attempt));
      let message: AssistantMessage;
      let retryable = false;
      try {
        const { modelRuntime, model } = await this.#models.open(binding);
        options.signal.throwIfAborted();
        if (prepared.images.length && !model.input.includes("image"))
          throw new RepaFault("unsupported_input", "所选模型不支持图片输入，请选择视觉模型或先取得文本表示。");
        if (!getSupportedThinkingLevels(model).includes(options.thinkingLevel))
          throw new RepaFault("configuration", "所选模型不支持该思考强度。");
        message = await retryAssistantCall(async () => {
          const response = await modelRuntime.completeSimple(model, context, {
            signal: options.signal,
            ...(options.thinkingLevel !== "off" ? { reasoning: options.thinkingLevel } : {}),
            ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
          });
          const usage = attempt.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
          for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
            usage[key] += response.usage[key];
          attempt.usage = usage;
          return response;
        }, options.retry, options.signal);
        options.signal.throwIfAborted();
        retryable = isRetryableAssistantError(message) && !isContextOverflow(message, model.contextWindow);
      } catch (error) {
        attempt.status = options.signal.aborted ? "cancelled" : "failed";
        attempt.finishedAt = Date.now();
        attempt.error = {
          code: options.signal.aborted ? "cancelled" : error instanceof RepaFault ? error.code : "runtime",
          message: error instanceof Error ? error.message : String(error),
        };
        await options.onAttempt?.(structuredClone(attempt));
        throw error;
      }
      const failed = message.stopReason === "error" || message.stopReason === "aborted";
      let output: unknown;
      let outputError: RepaFault | undefined;
      if (!failed && options.output) {
        try { output = options.output.read(message); } catch (error) {
          if (!(error instanceof RepaFault)) throw error;
          outputError = error;
        }
      }
      attempt.status = message.stopReason === "aborted" ? "cancelled" : failed ? "failed" : "completed";
      attempt.finishedAt = Date.now();
      if (failed) attempt.error = { code: "provider", message: message.errorMessage ?? "独立模型调用未完成。" };
      if (outputError) {
        attempt.status = "failed";
        attempt.error = { code: outputError.code, message: outputError.message };
      }
      attempts.push(structuredClone(attempt));
      await options.onAttempt?.(structuredClone(attempt));
      if (!failed) {
        const result: ProcessingResult = {
          format: { id: "repa.model-response", version: "1" },
          value: { kind: "inline", data: { message, input: prepared.text, binding: structuredClone(binding), attempts,
            ...(options.output ? { outputFormat: structuredClone(options.output.specification) } : {}),
            ...(options.output && !outputError ? { output } : {}),
          } },
          sources: prepared.sources, resources: prepared.resources,
        };
        if (outputError) throw new RepaFault(outputError.code, outputError.message, result);
        return result;
      }
      // 只在同身份 SDK 重试结束后切换明确候选；准备、认证、取消和未知异常不触发回退。
      const next = options.fallback?.models[index];
      if (!retryable || options.fallback?.on !== "transient_error" || !next)
        throw new RepaFault("provider", message.errorMessage ?? "独立模型调用未完成。");
      binding = next;
    }
  }

  async cancel(connectionId: string): Promise<void> {
    const active = [...this.#active].filter((call) => call.connectionIds.includes(connectionId));
    for (const call of active) call.controller.abort();
    await Promise.all(active.map((call) => call.done));
  }
}
