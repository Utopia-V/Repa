import * as zlib from "node:zlib";

export interface RawUsage {
  input: number | null;
  output: number | null;
  cached: number | null;
  cacheWrite: number | null;
}

export interface RequestSummary {
  model: string | null;
  inputItems: number | null;
  systemDeveloperItems: number | null;
  viewMarkers: number | null;
  instructionsCharacters: number | null;
  previousInputPrefixItems: number | null;
  instructionsUnchanged: boolean | null;
  toolsUnchanged: boolean | null;
  bodyEncoding: "json" | "zstd" | "unavailable";
}

export interface TransportRecord {
  ordinal: number;
  phase: string;
  kind: "model" | "oauth";
  status: number | null;
  startedAt: string;
  elapsedMs: number | null;
  outcome: "pending" | "completed" | "failed" | "aborted" | "timeout";
  responseStatus: "completed" | "incomplete" | "failed" | "cancelled" | null;
  errorCode: string | null;
  rawUsage: RawUsage;
  request: RequestSummary | null;
}

export interface TransportRecorderOptions {
  limit: number;
  phase: () => string;
  viewMarker?: string;
  requestTimeoutMs?: number;
  onRecord?: (record: TransportRecord) => void;
}

interface PreviousRequest {
  input: string[];
  instructions: string | undefined;
  tools: string | undefined;
}

const MODEL_URL = "https://chatgpt.com/backend-api/codex/responses";
const OAUTH_URL = "https://auth.openai.com/oauth/token";
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_CHARACTERS = 2 * 1024 * 1024;
const SAFE_ERROR_CODES = new Set([
  "usage_limit_reached", "usage_not_included", "rate_limit_exceeded",
  "invalid_api_key", "invalid_grant", "invalid_request_error", "server_error",
  "authentication_error", "permission_denied", "model_not_found",
  "context_length_exceeded", "insufficient_quota", "token_expired",
]);

function object(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function emptyUsage(): RawUsage {
  return { input: null, output: null, cached: null, cacheWrite: null };
}

function safeErrorCode(value: unknown): string | null {
  return typeof value === "string" && SAFE_ERROR_CODES.has(value) ? value : null;
}

function responseStatus(value: unknown): TransportRecord["responseStatus"] {
  if (value === "completed" || value === "incomplete" || value === "failed" || value === "cancelled") {
    return value;
  }
  return null;
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return object(value);
  } catch {
    return undefined;
  }
}

function decodeBody(body: BodyInit | null | undefined, headers: Headers): { text: string; encoding: "json" | "zstd" } | undefined {
  if (typeof body === "string" && Buffer.byteLength(body) <= MAX_BODY_BYTES) {
    return { text: body, encoding: "json" };
  }
  if (!(body instanceof Uint8Array) || body.byteLength > MAX_BODY_BYTES) return undefined;
  if (headers.get("content-encoding") !== "zstd") {
    return { text: new TextDecoder().decode(body), encoding: "json" };
  }
  // Node 的类型声明早于 zstd API，能力适配仅留在此入口；旧 Node 与 Pi 一样回退 JSON。
  const codec = zlib as unknown as {
    zstdDecompressSync?: (body: Uint8Array, options: { maxOutputLength: number }) => Uint8Array;
  };
  if (!codec.zstdDecompressSync) return undefined;
  try {
    const decoded = codec.zstdDecompressSync(body, { maxOutputLength: MAX_BODY_BYTES });
    return { text: new TextDecoder().decode(decoded), encoding: "zstd" };
  } catch {
    return undefined;
  }
}

function summarizeRequest(
  body: BodyInit | null | undefined,
  headers: Headers,
  previous: PreviousRequest | undefined,
  marker: string,
): { summary: RequestSummary; next?: PreviousRequest } {
  const summary: RequestSummary = {
    model: null,
    inputItems: null,
    systemDeveloperItems: null,
    viewMarkers: null,
    instructionsCharacters: null,
    previousInputPrefixItems: null,
    instructionsUnchanged: null,
    toolsUnchanged: null,
    bodyEncoding: "unavailable",
  };
  const decoded = decodeBody(body, headers);
  const payload = decoded ? parseJson(decoded.text) : undefined;
  if (!payload || !decoded) return { summary };
  summary.bodyEncoding = decoded.encoding;
  if (typeof payload.model === "string" && /^gpt-[a-z0-9._-]{1,64}$/.test(payload.model)) {
    summary.model = payload.model;
  }
  const input = Array.isArray(payload.input) ? payload.input : undefined;
  const instructions = typeof payload.instructions === "string" ? payload.instructions : undefined;
  summary.inputItems = input?.length ?? null;
  summary.systemDeveloperItems = input?.filter((item: unknown) => {
    const role = object(item)?.role;
    return role === "system" || role === "developer";
  }).length ?? null;
  summary.instructionsCharacters = instructions?.length ?? null;
  const serializedInput = input?.map((item: unknown) => JSON.stringify(item)) ?? [];
  const viewText = [instructions ?? "", ...serializedInput].join("\n");
  summary.viewMarkers = marker.length > 0 ? viewText.split(marker).length - 1 : 0;
  const next: PreviousRequest = { input: serializedInput, instructions, tools: JSON.stringify(payload.tools) };
  if (previous) {
    let prefix = 0;
    while (prefix < Math.min(previous.input.length, next.input.length) && previous.input[prefix] === next.input[prefix]) {
      prefix++;
    }
    summary.previousInputPrefixItems = prefix;
    summary.instructionsUnchanged = previous.instructions === next.instructions;
    summary.toolsUnchanged = previous.tools === next.tools;
  }
  return { summary, next };
}

function inspectEvent(record: TransportRecord, text: string): boolean {
  const event = parseJson(text);
  if (!event) return false;
  const response = object(event.response);
  record.errorCode = safeErrorCode(object(event.error)?.code ?? object(response?.error)?.code ?? event.code) ?? record.errorCode;
  if (event.type === "response.failed") record.responseStatus = "failed";
  const terminal = event.type === "response.completed" || event.type === "response.done" || event.type === "response.incomplete";
  if (!terminal) return false;
  record.responseStatus = responseStatus(response?.status);
  const usage = object(response?.usage);
  const details = object(usage?.input_tokens_details);
  record.rawUsage = {
    input: count(usage?.input_tokens),
    output: count(usage?.output_tokens),
    cached: count(details?.cached_tokens),
    cacheWrite: count(details?.cache_write_tokens),
  };
  return true;
}

function createInspector(record: TransportRecord, isSse: boolean): { push(chunk: Uint8Array): void; finish(): void; terminalSeen(): boolean } {
  const decoder = new TextDecoder();
  let pending = "";
  let data: string[] = [];
  let eventSize = 0;
  let droppedEvent = false;
  let droppedBody = false;
  let terminalSeen = false;
  const line = (value: string): void => {
    if (value === "") {
      if (!droppedEvent && data.length > 0) terminalSeen = inspectEvent(record, data.join("\n")) || terminalSeen;
      data = [];
      eventSize = 0;
      droppedEvent = false;
    } else if (value.startsWith("data:")) {
      const part = value.slice(5).replace(/^ /, "");
      eventSize += part.length;
      if (eventSize > MAX_EVENT_CHARACTERS) {
        droppedEvent = true;
        data = [];
      } else if (!droppedEvent) {
        data.push(part);
      }
    }
  };
  const append = (value: string): void => {
    if (droppedBody) return;
    pending += value;
    if (!isSse) {
      if (pending.length > MAX_EVENT_CHARACTERS) {
        pending = "";
        droppedBody = true;
      }
      return;
    }
    let index = pending.indexOf("\n");
    while (index >= 0) {
      line(pending.slice(0, index).replace(/\r$/, ""));
      pending = pending.slice(index + 1);
      index = pending.indexOf("\n");
    }
    if (pending.length > MAX_EVENT_CHARACTERS) {
      // 丢弃异常长的未终止行；观察失败不会改变服务传回的字节。
      pending = "";
      droppedEvent = true;
    }
  };
  return {
    push(chunk) { append(decoder.decode(chunk, { stream: true })); },
    terminalSeen() { return terminalSeen; },
    finish() {
      append(decoder.decode());
      if (isSse) {
        if (pending) line(pending.replace(/\r$/, ""));
        line("");
      } else if (!droppedBody) {
        record.errorCode = safeErrorCode(object(parseJson(pending)?.error)?.code);
      }
      pending = "";
      data = [];
    },
  };
}

export function installTransportRecorder(options: TransportRecorderOptions): {
  records: TransportRecord[];
  readonly blockedWebSocketAttempts: number;
  allowLocalWebSocket(url: string): void;
  restore(): void;
  waitForIdle(): Promise<void>;
} {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new Error("transport_limit_invalid");
  }
  const timeoutMs = options.requestTimeoutMs ?? 90_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 90_000) {
    throw new Error("transport_timeout_invalid");
  }
  const originalFetch = globalThis.fetch;
  const originalWebSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const originalWebSocket = globalThis.WebSocket;
  let blockedWebSocketAttempts = 0;
  const allowedLocalWebSockets = new Set<string>();
  // Pi 的自动传输会在构造失败后原生回退 SSE；不调用原构造器，避免连接绕过发送预算。
  const webSocketTarget = typeof originalWebSocket === "function"
    ? originalWebSocket
    : class {} as unknown as typeof WebSocket;
  const blockedWebSocket = new Proxy(webSocketTarget, {
    construct(target, args, newTarget) {
      const url = args[0];
      const address = typeof url === "string" || url instanceof URL ? String(url) : undefined;
      if (address && allowedLocalWebSockets.has(address)) {
        return Reflect.construct(target, args, newTarget);
      }
      blockedWebSocketAttempts++;
      throw new Error("transport_websocket_blocked");
    },
  });
  const records: TransportRecord[] = [];
  const previousRequests = new Map<string, PreviousRequest>();
  const active = new Map<AbortController, Promise<void>>();
  let restored = false;
  const wrappedFetch: typeof fetch = async (input, init) => {
    if (restored) throw new Error("transport_restored");
    const rawUrl = input instanceof Request ? input.url : String(input);
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error("transport_network_blocked");
    }
    const normalized = url.href;
    if ((normalized !== MODEL_URL && normalized !== OAUTH_URL) || url.username || url.password) {
      throw new Error("transport_network_blocked");
    }
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method.toUpperCase() !== "POST") throw new Error("transport_method_blocked");
    if (records.length >= options.limit) throw new Error("transport_send_limit");
    const phase = options.phase();
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(phase)) throw new Error("transport_phase_invalid");
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const kind = normalized === MODEL_URL ? "model" : "oauth";
    const record: TransportRecord = {
      ordinal: records.length + 1,
      phase,
      kind,
      status: null,
      startedAt: new Date().toISOString(),
      elapsedMs: null,
      outcome: "pending",
      responseStatus: null,
      errorCode: null,
      rawUsage: emptyUsage(),
      request: null,
    };
    records.push(record);
    if (kind === "model") {
      // session-id 只用于内存分组，不进入记录；恢复包装器时一并释放正文比较状态。
      const session = headers.get("session-id") ?? "";
      const result = summarizeRequest(init?.body, headers, previousRequests.get(session), options.viewMarker ?? "<repa-view source=");
      record.request = result.summary;
      if (result.next) previousRequests.set(session, result.next);
    }
    const controller = new AbortController();
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal;
    let timedOut = false;
    let finished = false;
    const started = performance.now();
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    active.set(controller, done);
    const finish = (outcome: TransportRecord["outcome"]): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      record.elapsedMs = Math.round(performance.now() - started);
      record.outcome = timedOut ? "timeout" : outcome;
      active.delete(controller);
      resolveDone();
      try {
        options.onRecord?.(record);
      } catch {
        // 外部观察者失败不改变传输结果。
      }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      finish("timeout");
    }, timeoutMs);
    try {
      // 禁止 fetch 自动跟随重定向，否则下一跳会绕过 URL 白名单和发送计数。
      const response = await originalFetch(input, { ...init, signal, redirect: "error" });
      record.status = response.status;
      if (!response.body) {
        finish(response.ok ? "completed" : "failed");
        return response;
      }
      // Pi 对成功的 Codex 响应直接解析 SSE，服务的 Content-Type 不参与判断。
      const inspector = createInspector(record, response.ok);
      const transform = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, target) {
          if (kind === "model") inspector.push(chunk);
          target.enqueue(chunk);
        },
        flush() {
          if (kind === "model") inspector.finish();
          finish(response.ok ? "completed" : "failed");
        },
      });
      // 单条 pass-through 管道沿用消费者背压，避免 clone/tee 的旁路堆积。
      void response.body.pipeTo(transform.writable, { signal }).catch(() => {
        // Pi 收到终态后取消 SSE reader；这属于成功收尾，不是传输失败。
        const outcome = response.ok && inspector.terminalSeen() ? "completed" : "failed";
        finish(signal.aborted ? "aborted" : outcome);
      });
      return new Response(transform.readable, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      finish(signal.aborted ? "aborted" : "failed");
      throw error;
    }
  };
  Object.defineProperty(globalThis, "WebSocket", {
    value: blockedWebSocket,
    writable: true,
    configurable: true,
  });
  globalThis.fetch = wrappedFetch;
  return {
    records,
    get blockedWebSocketAttempts() { return blockedWebSocketAttempts; },
    allowLocalWebSocket(url) {
      if (restored) throw new Error("transport_restored");
      // 只登记本次 server 给出的精确 RPC 地址，不放宽为任意本机连接。
      const match = /^ws:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/rpc$/.exec(url);
      const port = match?.[1] ? Number(match[1]) : 0;
      if (!match || port > 65_535) throw new Error("transport_local_websocket_invalid");
      allowedLocalWebSockets.add(url);
    },
    restore() {
      if (globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch;
      if (globalThis.WebSocket === blockedWebSocket) {
        if (originalWebSocketDescriptor) {
          Object.defineProperty(globalThis, "WebSocket", originalWebSocketDescriptor);
        } else {
          Reflect.deleteProperty(globalThis, "WebSocket");
        }
      }
      restored = true;
      previousRequests.clear();
      allowedLocalWebSockets.clear();
      for (const controller of active.keys()) controller.abort();
    },
    async waitForIdle() {
      await Promise.all(active.values());
    },
  };
}
