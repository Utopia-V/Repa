import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as zlib from "node:zlib";

import { installTransportRecorder, type TransportRecorderOptions } from "../scripts/real-model/transport.js";

const MODEL_URL = "https://chatgpt.com/backend-api/codex/responses";
const OAUTH_URL = "https://auth.openai.com/oauth/token";

function fixture(t: TestContext, fakeFetch: typeof fetch, options: Partial<TransportRecorderOptions> = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  const recorder = installTransportRecorder({ limit: 10, phase: () => "offline", ...options });
  t.after(async () => {
    recorder.restore();
    await recorder.waitForIdle();
    globalThis.fetch = original;
  });
  return recorder;
}

function body(instructions = "secret-instructions", input: unknown[] = []) {
  return JSON.stringify({
    model: "gpt-5.4",
    instructions,
    input,
    tools: [{ type: "function", name: "private_tool", description: "secret-tool-description" }],
  });
}

function streamResponse(text: string, chunkSize = 7): Response {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

test("分块 SSE 保持响应字节，仅记录终态数值和安全状态", async (t) => {
  const terminal = {
    type: "response.completed",
    response: {
      id: "secret-response-id",
      status: "completed",
      output: [{ text: "秘密正文🙂" }],
      usage: { input_tokens: 160, output_tokens: 12, input_tokens_details: { cached_tokens: 128, cache_write_tokens: 16 } },
    },
  };
  const text = `: heartbeat\r\n\r\nevent: response.completed\r\ndata: ${JSON.stringify(terminal)}\r\n\r\ndata: [DONE]\n\n`;
  let forwarded: RequestInit | undefined;
  const recorder = fixture(t, async (_input, init) => {
    forwarded = init;
    return streamResponse(text, 3);
  });
  const requestBody = body("secret-instructions", [{ role: "developer", content: "<repa-view source=\"private\">secret-state</repa-view>" }]);
  const response = await fetch(MODEL_URL, {
    method: "POST",
    body: requestBody,
    headers: { authorization: "Bearer secret-token", "session-id": "secret-session-id" },
  });
  assert.equal(await response.text(), text);
  await recorder.waitForIdle();
  assert.equal(forwarded?.body, requestBody);
  assert.equal(new Headers(forwarded?.headers).get("authorization"), "Bearer secret-token");
  assert.equal(forwarded?.redirect, "error");
  const record = recorder.records[0];
  assert.deepEqual(record?.rawUsage, { input: 160, output: 12, cached: 128, cacheWrite: 16 });
  assert.equal(record?.status, 200);
  assert.equal(record?.responseStatus, "completed");
  assert.equal(record?.outcome, "completed");
  assert.equal(record?.request?.viewMarkers, 1);
  assert.equal(record?.request?.systemDeveloperItems, 1);
  assert.equal(record?.request?.instructionsCharacters, "secret-instructions".length);
  assert.equal(record?.request?.toolsUnchanged, null);
  assert.ok(typeof record?.elapsedMs === "number");
  const stored = JSON.stringify(recorder.records);
  for (const secret of ["secret-token", "secret-session-id", "secret-response-id", "secret-instructions", "secret-state", "secret-tool-description", "秘密正文"]) {
    assert.equal(stored.includes(secret), false);
  }
});

test("同一会话逐项比较请求前缀和提示工具，正文仅保留在内存", async (t) => {
  const recorder = fixture(t, async () => new Response(null, { status: 204 }));
  const firstInput = [{ role: "system", content: "private-prefix" }, { role: "user", content: "first" }];
  const send = async (session: string, instructions: string, input: unknown[]) => {
    await fetch(MODEL_URL, { method: "POST", headers: { "session-id": session }, body: body(instructions, input) });
  };
  await send("one", "original", firstInput);
  await send("two", "different", []);
  await send("one", "original", [...firstInput, { role: "assistant", content: "answer" }]);
  await send("one", "replacement", [{ role: "system", content: "private-prefix" }, { role: "user", content: "changed" }]);
  assert.equal(recorder.records[1]?.request?.previousInputPrefixItems, null);
  assert.equal(recorder.records[2]?.request?.previousInputPrefixItems, 2);
  assert.equal(recorder.records[2]?.request?.instructionsUnchanged, true);
  assert.equal(recorder.records[2]?.request?.toolsUnchanged, true);
  assert.equal(recorder.records[3]?.request?.previousInputPrefixItems, 1);
  assert.equal(recorder.records[3]?.request?.instructionsUnchanged, false);
  assert.equal(JSON.stringify(recorder.records).includes("private-prefix"), false);
});

test("实际失败重试与 OAuth 都消耗发送额度，超限调用不转发", async (t) => {
  let sends = 0;
  const recorder = fixture(t, async () => {
    sends++;
    if (sends === 1) throw new Error("private-network-error");
    return new Response(null, { status: 204 });
  }, { limit: 3 });
  await assert.rejects(fetch(MODEL_URL, { method: "POST", body: body() }));
  await fetch(MODEL_URL, { method: "POST", body: body() });
  await fetch(OAUTH_URL, { method: "POST", body: "secret-refresh-token" });
  await assert.rejects(fetch(MODEL_URL, { method: "POST", body: body() }), /transport_send_limit/);
  assert.equal(sends, 3);
  assert.deepEqual(recorder.records.map((record) => record.ordinal), [1, 2, 3]);
  assert.deepEqual(recorder.records.map((record) => record.kind), ["model", "model", "oauth"]);
  assert.deepEqual(recorder.records.map((record) => record.outcome), ["failed", "completed", "completed"]);
  assert.equal(recorder.records[2]?.request, null);
  assert.equal(JSON.stringify(recorder.records).includes("private-network-error"), false);
});

test("仅允许精确 HTTPS 白名单和 POST，重定向也由包装器禁止", async (t) => {
  let sends = 0;
  const recorder = fixture(t, async () => {
    sends++;
    return new Response(null, { status: 204 });
  });
  for (const url of [
    "https://example.com/responses", "http://chatgpt.com/backend-api/codex/responses",
    `${MODEL_URL}?token=secret`, `${MODEL_URL}/extra`, "https://secret@chatgpt.com/backend-api/codex/responses",
    "https://auth.openai.com/oauth/token?secret=1", "https://chatgpt.com/backend-api/responses",
  ]) {
    await assert.rejects(fetch(url, { method: "POST" }), /transport_network_blocked/);
  }
  await assert.rejects(fetch(MODEL_URL), /transport_method_blocked/);
  assert.equal(sends, 0);
  assert.deepEqual(recorder.records, []);
});

test("请求截止时间同时中断尚未返回的请求并完成安全记录", async (t) => {
  let observedSignal: AbortSignal | null | undefined;
  const recorder = fixture(t, async (_input, init) => {
    observedSignal = init?.signal;
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("private-abort-details")), { once: true });
    });
  }, { requestTimeoutMs: 10 });
  await assert.rejects(fetch(MODEL_URL, { method: "POST", body: body() }));
  await recorder.waitForIdle();
  assert.equal(observedSignal?.aborted, true);
  assert.equal(recorder.records[0]?.outcome, "timeout");
  assert.equal(JSON.stringify(recorder.records).includes("private-abort-details"), false);
});

test("流式响应迟迟不结束时超时也覆盖响应读取，取消沿管道传播", async (t) => {
  let cancelled = false;
  const recorder = fixture(t, async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("data: {}\n\n")); },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "text/event-stream" } }), { requestTimeoutMs: 20 });
  const response = await fetch(MODEL_URL, { method: "POST", body: body() });
  await assert.rejects(response.text());
  await recorder.waitForIdle();
  assert.equal(cancelled, true);
  assert.equal(recorder.records[0]?.outcome, "timeout");
});

test("服务错误仅允许固定 code，缺失或异常 usage 保持 null", async (t) => {
  let attempt = 0;
  const recorder = fixture(t, async () => {
    attempt++;
    if (attempt === 1) {
      return new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "private-error", id: "private-id" } }), { status: 429 });
    }
    if (attempt === 2) {
      return new Response(JSON.stringify({ error: { code: "secret_identifier", message: "private-error" } }), { status: 400 });
    }
    return streamResponse(`data: ${JSON.stringify({ type: "response.done", response: {
      status: "incomplete", error: { code: "context_length_exceeded", message: "private-terminal-error" },
      usage: { input_tokens: "secret", output_tokens: -1, input_tokens_details: { cached_tokens: null } },
    } })}\n\n`);
  });
  for (let i = 0; i < 3; i++) {
    const response = await fetch(MODEL_URL, { method: "POST", body: body() });
    await response.text();
  }
  assert.equal(recorder.records[0]?.errorCode, "rate_limit_exceeded");
  assert.equal(recorder.records[1]?.errorCode, null);
  assert.equal(recorder.records[2]?.errorCode, "context_length_exceeded");
  assert.equal(recorder.records[2]?.responseStatus, "incomplete");
  assert.deepEqual(recorder.records[2]?.rawUsage, { input: null, output: null, cached: null, cacheWrite: null });
  const stored = JSON.stringify(recorder.records);
  for (const secret of ["private-error", "private-id", "secret_identifier", "private-terminal-error"]) {
    assert.equal(stored.includes(secret), false);
  }
});

test("JSON Uint8Array 请求分析不改原字节", async (t) => {
  const requestText = body("secret-compressed", [{ role: "user", content: "<repa-view source=secret>" }]);
  const bytes = new TextEncoder().encode(requestText);
  let forwarded: BodyInit | null | undefined;
  const recorder = fixture(t, async (_input, init) => {
    forwarded = init?.body;
    return new Response(null, { status: 204 });
  });
  await fetch(MODEL_URL, {
    method: "POST",
    headers: {},
    body: bytes,
  });
  assert.equal(forwarded, bytes);
  assert.equal(recorder.records[0]?.request?.bodyEncoding, "json");
  assert.equal(recorder.records[0]?.request?.inputItems, 1);
  assert.equal(recorder.records[0]?.request?.viewMarkers, 1);
  assert.equal(JSON.stringify(recorder.records).includes("secret-compressed"), false);
});

test("无法分析的压缩正文仍原样传输，只记录 unavailable", async (t) => {
  const bytes = new Uint8Array([1, 2, 3]);
  let forwarded: BodyInit | null | undefined;
  const recorder = fixture(t, async (_input, init) => {
    forwarded = init?.body;
    return new Response(null, { status: 204 });
  });
  await fetch(MODEL_URL, { method: "POST", headers: { "content-encoding": "zstd" }, body: bytes });
  assert.equal(forwarded, bytes);
  assert.equal(recorder.records[0]?.request?.bodyEncoding, "unavailable");
  assert.equal(recorder.records[0]?.request?.inputItems, null);
});

test("消费者取消后发送结束且观察者失败不影响响应，restore 恢复原 fetch", async (t) => {
  let cancelled = false;
  const fakeFetch: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array([1])); },
    cancel() { cancelled = true; },
  }));
  const recorder = fixture(t, fakeFetch, { onRecord: () => { throw new Error("observer-failed"); } });
  const response = await fetch(MODEL_URL, { method: "POST", body: body() });
  await response.body?.cancel();
  await recorder.waitForIdle();
  assert.equal(cancelled, true);
  assert.equal(recorder.records[0]?.outcome, "failed");
  recorder.restore();
  assert.equal(globalThis.fetch, fakeFetch);
});

test("发送上限最多为 100，截止时间最多为 90 秒", () => {
  for (const limit of [0, -1, 101, 1.5, Infinity]) {
    assert.throws(() => installTransportRecorder({ limit, phase: () => "offline" }), /transport_limit_invalid/);
  }
  for (const requestTimeoutMs of [0, -1, 90_001, 1.5]) {
    assert.throws(() => installTransportRecorder({ limit: 1, phase: () => "offline", requestTimeoutMs }), /transport_timeout_invalid/);
  }
});

test("调用方 AbortSignal 中断透传请求，终态不会被服务错误原文污染", async (t) => {
  const controller = new AbortController();
  let started: () => void = () => {};
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const recorder = fixture(t, async (_input, init) => {
    started();
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("private-caller-abort")), { once: true });
    });
  });
  const pending = fetch(MODEL_URL, { method: "POST", body: body(), signal: controller.signal });
  await entered;
  controller.abort();
  await assert.rejects(pending);
  await recorder.waitForIdle();
  assert.equal(recorder.records[0]?.outcome, "aborted");
  assert.equal(JSON.stringify(recorder.records).includes("private-caller-abort"), false);
});

test("SSE response.failed 和顶层 error.code 只保存白名单状态与标识", async (t) => {
  let attempt = 0;
  const recorder = fixture(t, async () => {
    attempt++;
    const event = attempt === 1
      ? { type: "response.failed", response: { status: "private-status", error: { code: "server_error", message: "private-message" } } }
      : { type: "error", code: "rate_limit_exceeded", message: "private-message" };
    return streamResponse(`data: ${JSON.stringify(event)}\n\n`);
  });
  for (let i = 0; i < 2; i++) {
    const response = await fetch(MODEL_URL, { method: "POST", body: body() });
    await response.text();
  }
  assert.equal(recorder.records[0]?.responseStatus, "failed");
  assert.equal(recorder.records[0]?.errorCode, "server_error");
  assert.equal(recorder.records[1]?.errorCode, "rate_limit_exceeded");
  assert.equal(JSON.stringify(recorder.records).includes("private-message"), false);
  assert.equal(JSON.stringify(recorder.records).includes("private-status"), false);
});

test("原生 zstd 请求离线解压后得到同样摘要，压缩字节不被替换", async (t) => {
  const codec = zlib as unknown as { zstdCompressSync?: (input: string) => Uint8Array };
  if (!codec.zstdCompressSync) {
    t.skip("当前 Node 不提供 zstd，与 Pi 的 JSON 回退路径一致");
    return;
  }
  const bytes = new Uint8Array(codec.zstdCompressSync(body("private-zstd", [{ role: "developer", content: "<repa-view source=private>" }])));
  let forwarded: BodyInit | null | undefined;
  const recorder = fixture(t, async (_input, init) => {
    forwarded = init?.body;
    return new Response(null, { status: 204 });
  });
  await fetch(MODEL_URL, { method: "POST", body: bytes, headers: { "content-encoding": "zstd" } });
  assert.equal(forwarded, bytes);
  assert.equal(recorder.records[0]?.request?.bodyEncoding, "zstd");
  assert.equal(recorder.records[0]?.request?.instructionsCharacters, "private-zstd".length);
  assert.equal(recorder.records[0]?.request?.systemDeveloperItems, 1);
  assert.equal(recorder.records[0]?.request?.viewMarkers, 1);
  assert.equal(JSON.stringify(recorder.records).includes("private-zstd"), false);
});

test("Pi 在读取终态后取消 SSE，记录仍为完成并保留已观察 usage", async (t) => {
  let cancelled = false;
  const event = { type: "response.completed", response: { status: "completed", usage: { input_tokens: 42, output_tokens: 3 } } };
  const recorder = fixture(t, async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "text/event-stream" } }));
  const response = await fetch(MODEL_URL, { method: "POST", body: body() });
  const reader = response.body?.getReader();
  assert.ok(reader);
  await reader.read();
  await reader.cancel();
  reader.releaseLock();
  await recorder.waitForIdle();
  assert.equal(cancelled, true);
  assert.equal(recorder.records[0]?.outcome, "completed");
  assert.deepEqual(recorder.records[0]?.rawUsage, { input: 42, output: 3, cached: null, cacheWrite: null });
});

test("成功响应即使省略或误标 Content-Type 仍按 Pi 的 SSE 路径观察终态", async (t) => {
  let attempt = 0;
  const event = { type: "response.done", response: { status: "completed", usage: {
    input_tokens: 1734, output_tokens: 9, input_tokens_details: { cached_tokens: 1536 },
  } } };
  const recorder = fixture(t, async () => {
    attempt++;
    const headers = new Headers();
    if (attempt !== 1) headers.set("content-type", "application/json");
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); },
    }), { headers });
  });
  for (let i = 0; i < 2; i++) {
    const response = await fetch(MODEL_URL, { method: "POST", body: body() });
    const reader = response.body?.getReader();
    assert.ok(reader);
    await reader.read();
    await reader.cancel();
    reader.releaseLock();
    await recorder.waitForIdle();
  }
  for (const record of recorder.records) {
    assert.equal(record.outcome, "completed");
    assert.equal(record.responseStatus, "completed");
    assert.deepEqual(record.rawUsage, { input: 1734, output: 9, cached: 1536, cacheWrite: null });
  }
});

test("全局 WebSocket 构造被阻止且计数，不触发原构造器；restore 恢复原入口", async (t) => {
  const originalWebSocket = globalThis.WebSocket;
  let connections = 0;
  const fakeWebSocket = new Proxy(originalWebSocket, {
    construct() {
      connections++;
      throw new Error("fixture_network_must_not_be_called");
    },
  });
  globalThis.WebSocket = fakeWebSocket;
  t.after(() => { globalThis.WebSocket = originalWebSocket; });
  const recorder = fixture(t, async () => new Response(null, { status: 204 }), { limit: 1 });
  assert.equal(recorder.blockedWebSocketAttempts, 0);
  assert.throws(() => new WebSocket("wss://chatgpt.com/backend-api/codex/responses"), /transport_websocket_blocked/);
  assert.throws(() => new WebSocket("wss://example.com/private"), /transport_websocket_blocked/);
  assert.equal(connections, 0);
  assert.equal(recorder.blockedWebSocketAttempts, 2);
  assert.deepEqual(recorder.records, []);
  await fetch(MODEL_URL, { method: "POST", body: body() });
  assert.equal(recorder.records.length, 1);
  assert.equal(recorder.blockedWebSocketAttempts, 2);
  await assert.rejects(fetch(MODEL_URL, { method: "POST", body: body() }), /transport_send_limit/);
  recorder.restore();
  assert.equal(globalThis.WebSocket, fakeWebSocket);
});

test("只有显式登记的精确本机 RPC WebSocket 可构造，其他本机和远端仍被阻止", (t) => {
  const originalWebSocket = globalThis.WebSocket;
  const connections: unknown[][] = [];
  const fakeWebSocket = new Proxy(originalWebSocket, {
    construct(target, args) {
      connections.push(args);
      return Object.create(target.prototype) as WebSocket;
    },
  });
  globalThis.WebSocket = fakeWebSocket;
  t.after(() => { globalThis.WebSocket = originalWebSocket; });
  const recorder = fixture(t, async () => new Response(null, { status: 204 }));
  const localUrl = "ws://127.0.0.1:12345/rpc";
  assert.throws(() => new WebSocket(localUrl), /transport_websocket_blocked/);
  assert.equal(connections.length, 0);
  recorder.allowLocalWebSocket(localUrl);
  new WebSocket(localUrl);
  assert.deepEqual(connections, [[localUrl]]);
  for (const blocked of [
    "ws://127.0.0.1:12346/rpc", "ws://127.0.0.1:12345/other", `${localUrl}?token=secret`,
    "ws://localhost:12345/rpc", "wss://chatgpt.com/backend-api/codex/responses",
  ]) {
    assert.throws(() => new WebSocket(blocked), /transport_websocket_blocked/);
  }
  assert.equal(connections.length, 1);
  assert.equal(recorder.blockedWebSocketAttempts, 6);
  assert.deepEqual(recorder.records, []);
  recorder.restore();
  assert.equal(globalThis.WebSocket, fakeWebSocket);
});

test("本机 RPC 登记拒绝远端地址、其他路径、凭据和查询参数", (t) => {
  const recorder = fixture(t, async () => new Response(null, { status: 204 }));
  for (const url of [
    "wss://chatgpt.com/backend-api/codex/responses", "ws://example.com:12345/rpc",
    "ws://localhost:12345/rpc", "ws://127.0.0.1:12345/other", "ws://127.0.0.1:12345/rpc?token=secret",
    "ws://secret@127.0.0.1:12345/rpc", "ws://127.0.0.1:0/rpc", "ws://127.0.0.1:65536/rpc",
  ]) {
    assert.throws(() => recorder.allowLocalWebSocket(url), /transport_local_websocket_invalid/);
  }
});
