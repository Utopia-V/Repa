import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import type { summarizeUsage } from "./usage.js";

interface Summary {
  requests: number;
  observedRequests: number;
  unobservedRequestUpperBound: number;
  fullInput: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  input: number;
  costUsd: number;
  reservedUsd: number;
  incompleteRequests: number;
}

interface Options {
  model: Model<string>;
  costLimit?: number;
  requestLimit: number;
  phase: () => string;
  log: (record: Record<string, unknown>) => void;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function tokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function emptySummary(): Summary {
  return { requests: 0, observedRequests: 0, unobservedRequestUpperBound: 0, fullInput: 0, output: 0,
    cacheRead: 0, cacheWrite: 0, input: 0, costUsd: 0, reservedUsd: 0, incompleteRequests: 0 };
}

/** 仅供串行核实宿主使用；正文只用于内存比较，用量由完成后的公开历史结算。 */
export function createRequestProbe(options: Options) {
  const { model, log } = options;
  const deepseek = model.provider === "deepseek" && model.api === "openai-completions";
  const codex = model.provider === "openai-codex" && model.api === "openai-codex-responses";
  const rates = [model.cost, ...model.cost.tiers ?? []];
  if ((!deepseek && !codex) || !Number.isSafeInteger(options.requestLimit) || options.requestLimit < 1
    || deepseek && (!(options.costLimit !== undefined && options.costLimit > 0) || !Number.isFinite(options.costLimit))
    || Object.values(model.promptCache ?? {}).some(value => value > 0)
    || rates.some(rate => [rate.input, rate.output, rate.cacheRead, rate.cacheWrite].some(value => !Number.isFinite(value) || value < 0))) {
    throw new Error("request_probe_invalid_budget_or_model");
  }
  const inputRate = Math.max(...rates.flatMap(rate => [rate.input, rate.cacheRead, rate.cacheWrite]));
  const inputCostRate = Math.max(...rates.map(rate => rate.input));
  const cacheReadRate = Math.max(...rates.map(rate => rate.cacheRead));
  const cacheWriteRate = Math.max(...rates.map(rate => rate.cacheWrite));
  const outputRate = Math.max(...rates.map(rate => rate.output));
  const phases = new Map<string, Summary>();
  const operations = new Map<string, number>();
  const settled = new Set<string>();
  let uncertain = false;
  let closed = false;
  let previousMessages: string[] = [];
  let previousSystem: string | undefined;
  let previousTools: string | undefined;
  let initialSystem: string | undefined;
  let initialTools: string | undefined;
  let initialSources = new Set<string>();

  function snapshot(phase?: string): Summary {
    const result = emptySummary();
    for (const [name, summary] of phases) {
      if (phase !== undefined && name !== phase) continue;
      for (const key of Object.keys(result) as (keyof Summary)[]) result[key] += summary[key];
    }
    return result;
  }

  function rejectReason(phase: string, count: number, reservation: number): string | undefined {
    if (closed || uncertain || settled.has(phase)
      || [...phases].some(([name, value]) => name !== phase && value.incompleteRequests > 0)) return "request_probe_usage_unknown";
    const total = snapshot();
    if (total.requests + count > options.requestLimit) return "request_probe_request_limit";
    if (deepseek && options.costLimit !== undefined && total.costUsd + total.reservedUsd + reservation > options.costLimit) return "request_probe_cost_limit";
    return undefined;
  }

  function reserve(phase: string, count: number, reservation: number, observed: boolean): void {
    const summary = phases.get(phase) ?? emptySummary();
    phases.set(phase, summary);
    summary.requests += count;
    summary.incompleteRequests += count;
    summary.reservedUsd += reservation;
    if (observed) summary.observedRequests += count;
    else summary.unobservedRequestUpperBound += count;
    operations.set(phase, (operations.get(phase) ?? 0) + 1);
  }

  function rejected(phase: string, reason: string): void {
    log({ type: "request-rejected", phase, reason });
  }

  const extensionFactory: ExtensionFactory = pi => {
    pi.on("before_provider_request", (event, ctx) => {
      const phase = options.phase();
      const payload = object(event.payload);
      const messages = deepseek ? payload?.messages : payload?.input;
      if (!payload || payload.model !== model.id || !Array.isArray(messages)) {
        rejected(phase, "request_probe_unsupported_payload");
        ctx.abort();
        return;
      }
      if (deepseek) {
        const maxTokens = payload.max_tokens === undefined ? 2048 : tokens(payload.max_tokens);
        if (maxTokens === undefined || maxTokens < 1 || payload.max_completion_tokens !== undefined) {
          rejected(phase, "request_probe_invalid_max_tokens");
          ctx.abort();
          return;
        }
        payload.max_tokens = Math.min(maxTokens, 2048);
      }
      const tools = Array.isArray(payload.tools) ? payload.tools : [];
      // UTF-8 字节再加消息与工具 framing；不假定缓存命中，使用所有目录档位的最高价格。
      const inputBound = Buffer.byteLength(JSON.stringify(payload), "utf8") + messages.length * 64 + tools.length * 256 + 1024;
      const outputBound = deepseek ? Number(payload.max_tokens) : model.maxTokens;
      const reservation = (inputBound * inputRate + outputBound * outputRate) / 1_000_000;
      const reason = rejectReason(phase, 1, reservation);
      if (reason) {
        rejected(phase, reason);
        // Pi 吞掉扩展抛出的错误；公开的同步 abort 会在 provider 创建网络请求前取消 signal。
        ctx.abort();
        return;
      }
      reserve(phase, 1, reservation, true);
      const serializedMessages = messages.map(message => JSON.stringify(message));
      const isSystem = (value: unknown) => ["system", "developer"].includes(String(object(value)?.role));
      let systemPrefix = 0;
      while (systemPrefix < messages.length && isSystem(messages[systemPrefix])) systemPrefix++;
      const instructions = typeof payload.instructions === "string" ? payload.instructions : undefined;
      const system = JSON.stringify({ instructions, messages: messages.slice(0, systemPrefix) });
      const systemText = JSON.stringify({ instructions, messages: messages.filter(isSystem) });
      const serializedTools = JSON.stringify(tools);
      let sharedMessages = 0;
      while (sharedMessages < serializedMessages.length && serializedMessages[sharedMessages] === previousMessages[sharedMessages]) sharedMessages++;
      const messageText = JSON.stringify({ instructions, messages });
      const latestView = serializedMessages.findLast(message => message.includes("<repa-view source="));
      const version = latestView === undefined ? undefined : [...latestView.matchAll(/CHECK_(\d+)/gu)].at(-1)?.[1];
      const sources = new Set(Array.from(messageText.matchAll(/<repa-instructions source=\\?"([^"\\]+)\\?">/gu), match => match[1] ?? ""));
      if (initialSystem === undefined) {
        initialSystem = system;
        initialTools = serializedTools;
        initialSources = sources;
      }
      log({ type: "provider-request", phase, provider: model.provider, request: snapshot().requests,
        source: "before_provider_request", messages: messages.length, tools: tools.length, inputBound,
        outputLimit: deepseek ? payload.max_tokens : null, outputReservation: outputBound,
        thinkingDisabled: deepseek ? object(payload.thinking)?.type === "disabled" : null,
        instructionsPresent: instructions !== undefined,
        initialSystemUnchanged: system === initialSystem, initialToolsUnchanged: serializedTools === initialTools,
        previousSystemUnchanged: previousSystem === undefined ? null : system === previousSystem,
        previousToolsUnchanged: previousTools === undefined ? null : serializedTools === previousTools,
        sharedMessages, leadingSystemMessages: systemPrefix, midConversationSystemMessages: messages.slice(systemPrefix).filter(isSystem).length,
        viewCopies: Array.from(messageText.matchAll(/<repa-view source=/gu)).length,
        latestViewVersion: version === undefined ? null : tokens(Number(version)) ?? null,
        instructionSuffixACopies: systemText.split("核实回复后缀为 A。").length - 1,
        instructionSuffixBCopies: systemText.split("核实回复后缀为 B。").length - 1,
        promptSources: sources.size, addedPromptSources: [...sources].filter(source => !initialSources.has(source)).length });
      previousMessages = serializedMessages;
      previousSystem = system;
      previousTools = serializedTools;
      // Codex 原对象透传；只有 DeepSeek 的 max_tokens 在上述边界调整。
      return event.payload;
    });
    pi.on("session_before_compact", (event, ctx) => {
      const phase = options.phase();
      // Pi 1.1.0 的摘要 streamFunction 不经过 Agent onPayload。这里只提供静态上界，不声称看到了 wire。
      // Codex 摘要缺省 auto transport，两个独立 WebSocket 重试标记最多产生三次 WS 请求，再 SSE 回退。
      const count = codex ? 8 : 2;
      const preparation = JSON.stringify({ branchEntries: event.branchEntries, preparation: event.preparation, customInstructions: event.customInstructions });
      const inputBound = Buffer.byteLength(preparation, "utf8") + 16 * 1024;
      const outputBound = deepseek ? 2048 : model.maxTokens;
      const reservation = count * (inputBound * inputRate + outputBound * outputRate) / 1_000_000;
      const reason = rejectReason(phase, count, reservation);
      if (reason || deepseek && event.preparation.settings.reserveTokens > 2560
        || ctx.model?.provider !== model.provider || ctx.model.id !== model.id) {
        rejected(phase, reason ?? "request_probe_unsupported_compaction");
        return { cancel: true };
      }
      reserve(phase, count, reservation, false);
      log({ type: "compaction-request-bound", phase, source: "static-upper-bound", requests: count,
        inputBound, outputReservation: outputBound, splitTurn: event.preparation.isSplitTurn,
        messages: event.preparation.messagesToSummarize.length, turnPrefixMessages: event.preparation.turnPrefixMessages.length,
        viewCopies: Array.from(JSON.stringify([...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages]).matchAll(/<repa-view source=/gu)).length });
    });
    pi.on("session_compact_failed", () => { uncertain = true; });
    pi.on("message_end", event => {
      if (event.message.role === "assistant" && ["error", "aborted"].includes(event.message.stopReason)) uncertain = true;
    });
    pi.on("cache_warming_decision", event => {
      log({ type: "cache-warming-decision", phase: options.phase(), requestedWarm: event.action === "warm" });
    });
  };

  return {
    extensionFactory,
    snapshot,
    settle(phase: string, usage: ReturnType<typeof summarizeUsage>): void {
      const summary = phases.get(phase);
      if (settled.has(phase)) throw new Error("request_probe_phase_already_settled");
      if (!summary) throw new Error("request_probe_phase_not_reserved");
      const complete = !uncertain && [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.fullInput].every(value => tokens(value) !== undefined)
        && usage.fullInput === usage.input + usage.cacheRead + usage.cacheWrite && usage.fullInput > 0 && usage.output > 0
        && usage.modelOperations === operations.get(phase);
      if (complete) {
        summary.fullInput = usage.fullInput;
        summary.output = usage.output;
        summary.cacheRead = usage.cacheRead;
        summary.cacheWrite = usage.cacheWrite;
        summary.input = usage.input;
        // 压缩仅有合计用量，无法恢复子请求档位；统一按最贵目录档计算保守参考金额。
        summary.costUsd = (usage.input * inputCostRate + usage.cacheRead * cacheReadRate + usage.cacheWrite * cacheWriteRate + usage.output * outputRate) / 1_000_000;
        summary.reservedUsd = 0;
        summary.incompleteRequests = 0;
        if (deepseek && options.costLimit !== undefined && snapshot().costUsd + snapshot().reservedUsd > options.costLimit) uncertain = true;
      } else {
        uncertain = true;
      }
      settled.add(phase);
      log({ type: "request-settlement", phase, source: "pi-session-history", complete, catalogCostUpperBound: true,
        requests: summary.requests, observedRequests: summary.observedRequests, unobservedRequestUpperBound: summary.unobservedRequestUpperBound,
        fullInput: usage.fullInput, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, input: usage.input });
      if (!complete || uncertain) throw new Error("request_probe_usage_unknown");
    },
    close(): void {
      closed = true;
      previousMessages = [];
      initialSources.clear();
      previousSystem = undefined;
      initialSystem = undefined;
      previousTools = undefined;
      initialTools = undefined;
    },
  };
}
