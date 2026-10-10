import type { Model } from "@earendil-works/pi-ai";

interface Summary {
  requests: number;
  fullInput: number;
  output: number;
  cacheRead: number;
  input: number;
  costUsd: number;
  reservedUsd: number;
  incompleteRequests: number;
}

interface Options {
  model: Model<string>;
  costLimit: number;
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
  return { requests: 0, fullInput: 0, output: 0, cacheRead: 0, input: 0, costUsd: 0, reservedUsd: 0, incompleteRequests: 0 };
}

/** 只观测 DeepSeek 核实任务；正文留在内存，原始 SSE 字节透传给 Pi。 */
export function installDeepseekProbe(options: Options) {
  const { model, log } = options;
  const rates = [model.cost, ...model.cost.tiers ?? []];
  if (!(options.costLimit > 0) || !Number.isFinite(options.costLimit)
    || !Number.isSafeInteger(options.requestLimit) || options.requestLimit < 1
    || model.provider !== "deepseek" || model.api !== "openai-completions"
    || !["https://api.deepseek.com", "https://api.deepseek.com/", "https://api.deepseek.com/v1", "https://api.deepseek.com/v1/"].includes(model.baseUrl)
    || rates.some(rate => [rate.input, rate.output, rate.cacheRead, rate.cacheWrite].some(value => !Number.isFinite(value) || value < 0))
    || Math.max(...rates.map(rate => rate.input)) <= 0 || Math.max(...rates.map(rate => rate.output)) <= 0) {
    throw new Error("deepseek_probe_invalid_budget_or_model");
  }
  const originalFetch = globalThis.fetch;
  const phases = new Map<string, Summary>();
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

  const wrappedFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "https://api.deepseek.com" || !["/chat/completions", "/v1/chat/completions"].includes(url.pathname)) {
      if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return originalFetch(input, init);
      throw new Error("deepseek_probe_remote_endpoint_rejected");
    }
    if (closed || uncertain) throw new Error("deepseek_probe_usage_unknown");
    const text = typeof init?.body === "string" ? init.body : input instanceof Request && init?.body === undefined ? await input.clone().text() : undefined;
    let payload: Record<string, unknown> | undefined;
    try {
      payload = object(text === undefined ? undefined : JSON.parse(text));
    } catch {
      throw new Error("deepseek_probe_unsupported_payload");
    }
    const messages = payload?.messages;
    if (!payload || payload.model !== model.id || payload.stream !== true || !Array.isArray(messages)
      || payload.max_completion_tokens !== undefined || payload.modalities !== undefined
      || messages.some(value => {
        const message = object(value);
        return !message || typeof message.role !== "string" || !(message.content === undefined || message.content === null
          || typeof message.content === "string" || Array.isArray(message.content) && message.content.every(part => {
            const content = object(part);
            return content?.type === "text" && typeof content.text === "string";
          }));
      })) throw new Error("deepseek_probe_unsupported_payload");
    const maxTokens = payload.max_tokens === undefined ? 2048 : tokens(payload.max_tokens);
    if (maxTokens === undefined || maxTokens < 1) throw new Error("deepseek_probe_invalid_max_tokens");
    payload.max_tokens = Math.min(maxTokens, 2048);
    const body = JSON.stringify(payload);
    const tools = Array.isArray(payload.tools) ? payload.tools : [];
    // UTF-8 字节上界再加每条消息/工具的 framing；按最贵的输入档预留，不假定缓存命中。
    const inputBound = Buffer.byteLength(body, "utf8") + messages.length * 64 + tools.length * 256 + 1024;
    const reservation = (inputBound * Math.max(...rates.flatMap(rate => [rate.input, rate.cacheRead, rate.cacheWrite]))
      + 2048 * Math.max(...rates.map(rate => rate.output))) / 1_000_000;
    const total = snapshot();
    if (total.requests >= options.requestLimit) throw new Error("deepseek_probe_request_limit");
    if (total.costUsd + total.reservedUsd + reservation > options.costLimit) throw new Error("deepseek_probe_cost_limit");
    const phase = options.phase();
    const summary = phases.get(phase) ?? emptySummary();
    phases.set(phase, summary);
    // 此处到 fetch 之前没有 await，并发请求也先完成额度预留。
    summary.requests++;
    summary.incompleteRequests++;
    summary.reservedUsd += reservation;
    const request = snapshot().requests;
    const serializedMessages = messages.map(message => JSON.stringify(message));
    const isSystem = (value: unknown) => ["system", "developer"].includes(String(object(value)?.role));
    let systemPrefix = 0;
    while (systemPrefix < messages.length && isSystem(messages[systemPrefix])) systemPrefix++;
    const system = JSON.stringify(messages.slice(0, systemPrefix));
    const serializedTools = JSON.stringify(tools);
    let sharedMessages = 0;
    while (sharedMessages < serializedMessages.length && serializedMessages[sharedMessages] === previousMessages[sharedMessages]) sharedMessages++;
    const messageText = JSON.stringify(messages);
    const systemText = JSON.stringify(messages.filter(isSystem));
    const latestView = serializedMessages.findLast(message => message.includes("<repa-view source="));
    const version = latestView === undefined ? undefined : [...latestView.matchAll(/CHECK_(\d+)/gu)].at(-1)?.[1];
    const latestViewVersion = version === undefined ? null : tokens(Number(version)) ?? null;
    const sources = new Set(Array.from(messageText.matchAll(/<repa-instructions source=\\?"([^"\\]+)\\?">/gu), match => match[1] ?? ""));
    if (initialSystem === undefined) {
      initialSystem = system;
      initialTools = serializedTools;
      initialSources = sources;
    }
    log({ type: "deepseek-request", phase, request, messages: messages.length, tools: tools.length, inputBound, outputLimit: payload.max_tokens, thinkingDisabled: object(payload.thinking)?.type === "disabled",
      initialSystemUnchanged: system === initialSystem, initialToolsUnchanged: serializedTools === initialTools,
      previousSystemUnchanged: previousSystem === undefined ? null : system === previousSystem,
      previousToolsUnchanged: previousTools === undefined ? null : serializedTools === previousTools,
      sharedMessages, leadingSystemMessages: systemPrefix, midConversationSystemMessages: messages.slice(systemPrefix).filter(isSystem).length,
      viewCopies: Array.from(messageText.matchAll(/<repa-view source=/gu)).length, latestViewVersion,
      instructionSuffixACopies: systemText.split("核实回复后缀为 A。").length - 1,
      instructionSuffixBCopies: systemText.split("核实回复后缀为 B。").length - 1,
      promptSources: sources.size, addedPromptSources: [...sources].filter(source => !initialSources.has(source)).length });
    previousMessages = serializedMessages;
    previousSystem = system;
    previousTools = serializedTools;
    let httpStatus: number | null = null;
    let rawUsage: Record<string, unknown> | undefined;
    let finalized = false;
    function finish() {
      if (finalized) return;
      finalized = true;
      const fullInput = tokens(rawUsage?.prompt_tokens);
      const output = tokens(rawUsage?.completion_tokens);
      const hit = tokens(rawUsage?.prompt_cache_hit_tokens);
      const miss = tokens(rawUsage?.prompt_cache_miss_tokens);
      const cached = tokens(rawUsage?.cached_tokens);
      const detailsCached = tokens(object(rawUsage?.prompt_tokens_details)?.cached_tokens);
      const cacheRead = hit ?? detailsCached ?? cached;
      const inputTokens = miss ?? (fullInput !== undefined && cacheRead !== undefined ? fullInput - cacheRead : undefined);
      const complete = fullInput !== undefined && output !== undefined && cacheRead !== undefined && inputTokens !== undefined
        && inputTokens >= 0 && inputTokens + cacheRead === fullInput;
      if (complete) {
        const rate = [...model.cost.tiers ?? []].sort((a, b) => b.inputTokensAbove - a.inputTokensAbove).find(tier => fullInput > tier.inputTokensAbove) ?? model.cost;
        const costUsd = (inputTokens * rate.input + cacheRead * rate.cacheRead + output * rate.output) / 1_000_000;
        summary.fullInput += fullInput;
        summary.output += output;
        summary.cacheRead += cacheRead;
        summary.input += inputTokens;
        summary.costUsd += costUsd;
        summary.reservedUsd -= reservation;
        summary.incompleteRequests--;
        if (snapshot().costUsd + snapshot().reservedUsd > options.costLimit) uncertain = true;
      } else {
        uncertain = true;
      }
      log({ type: "deepseek-usage", phase, request, httpStatus, complete, promptTokens: fullInput ?? null, completionTokens: output ?? null,
        promptCacheHitTokens: hit ?? null, promptCacheMissTokens: miss ?? null, cachedTokens: cached ?? null, promptDetailsCachedTokens: detailsCached ?? null,
        cachedTokensDisagree: hit !== undefined && (cached !== undefined && hit !== cached || detailsCached !== undefined && hit !== detailsCached) });
    }
    try {
      const response = await originalFetch(input, { ...init, body });
      httpStatus = response.status;
      if (!response.ok || !response.body) {
        finish();
        return response;
      }
      const decoder = new TextDecoder();
      let pending = "";
      function parseLine(line: string) {
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          finish();
          return;
        }
        try {
          const event = object(JSON.parse(data));
          if (object(event?.usage)) {
            rawUsage = object(event?.usage);
            // Pi 在带 finish_reason 的 content chunk 后可能停止读取，必须先结算再透传。
            finish();
          }
        } catch {
          // 非 JSON 行不影响原流；缺少可结算 usage 时保留预留并停止后续请求。
        }
      }
      const stream = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          pending += decoder.decode(chunk, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) parseLine(line.replace(/\r$/u, ""));
          // 不缓存整份响应；异常超长行也继续透传，但使本次用量不可结算。
          if (pending.length > 1_048_576) {
            uncertain = true;
            pending = "";
          }
          controller.enqueue(chunk);
        },
        flush() {
          pending += decoder.decode();
          parseLine(pending);
          finish();
        },
      });
      // pipeTo 的拒绝覆盖上游读取错误和下游提前取消，额度仍保留。
      void response.body.pipeTo(stream.writable).catch(() => finish());
      return new Response(stream.readable, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      finish();
      throw error;
    }
  };
  globalThis.fetch = wrappedFetch;
  return {
    snapshot,
    close() {
      closed = true;
      if (globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch;
      previousMessages = [];
      initialSources.clear();
      previousSystem = undefined;
      initialSystem = undefined;
      previousTools = undefined;
      initialTools = undefined;
    },
  };
}
