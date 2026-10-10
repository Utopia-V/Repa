import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { normalizeContext, Type, type Context, type Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

import { installDeepseekProbe } from "../scripts/real-model/deepseek.js";

const model = deepseekProvider().getModels().find(value => value.id === "deepseek-v4-pro");
assert(model);
const selectedModel = model;
const usage = { prompt_tokens: 100, completion_tokens: 7, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 };

function response(rawUsage: unknown = usage, chunkSize = 13): Response {
  const event = { id: "test", object: "chat.completion.chunk", created: 0, model: selectedModel.id,
    choices: [{ index: 0, delta: { role: "assistant", content: "回复🌱" }, finish_reason: "stop" }], usage: rawUsage };
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify(event)}\r\n\r\ndata: [DONE]\n\n`);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < bytes.length; index += chunkSize) controller.enqueue(bytes.slice(index, index + chunkSize));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream", "x-test": "preserved" } });
}

function fixture(t: TestContext, options: { fetch?: typeof fetch; costLimit?: number; requestLimit?: number; model?: Model<string> } = {}) {
  const original = globalThis.fetch;
  const requests: Record<string, unknown>[] = [];
  const logs: Record<string, unknown>[] = [];
  let phase = "first";
  globalThis.fetch = options.fetch ?? (async (_input, init) => {
    assert.equal(typeof init?.body, "string");
    const payload: unknown = JSON.parse(String(init?.body));
    assert(payload !== null && typeof payload === "object");
    requests.push(payload as Record<string, unknown>);
    return response();
  });
  const fakeFetch = globalThis.fetch;
  const probe = installDeepseekProbe({ model: options.model ?? selectedModel, costLimit: options.costLimit ?? 1,
    requestLimit: options.requestLimit ?? 10, phase: () => phase, log: record => logs.push(record) });
  let cleaned = false;
  function close() {
    if (cleaned) return;
    cleaned = true;
    probe.close();
    assert.equal(globalThis.fetch, fakeFetch);
    globalThis.fetch = original;
  }
  t.after(close);
  return { close, probe, requests, logs, phase(value: string) { phase = value; } };
}

async function request(messages: unknown[] = [{ role: "user", content: "问题" }], extra: Record<string, unknown> = {}): Promise<Response> {
  return fetch("https://api.deepseek.com/chat/completions", { method: "POST", body: JSON.stringify({ model: selectedModel.id, stream: true, messages, ...extra }) });
}

test("透传任意 UTF-8 分块和响应头，按阶段结算原生 hit/miss，缺失 cached_tokens 不补零", async t => {
  const f = fixture(t);
  const first = await request(undefined, { max_tokens: 99999 });
  assert.equal(first.headers.get("x-test"), "preserved");
  assert.match(await first.text(), /回复🌱/u);
  assert.equal(f.requests[0]?.max_tokens, 2048);
  assert.deepEqual(f.probe.snapshot("first"), {
    requests: 1, fullInput: 100, output: 7, cacheRead: 80, input: 20,
    costUsd: (20 * selectedModel.cost.input + 80 * selectedModel.cost.cacheRead + 7 * selectedModel.cost.output) / 1_000_000,
    reservedUsd: 0, incompleteRequests: 0,
  });
  f.phase("second");
  await (await request(undefined, { max_tokens: 12 })).text();
  assert.equal(f.requests[1]?.max_tokens, 12);
  assert.equal(f.probe.snapshot().requests, 2);
  assert.equal(f.probe.snapshot("second").requests, 1);
  assert.equal(f.logs.find(record => record.type === "deepseek-usage")?.cachedTokens, null);
});

test("真实 Pi 适配器在最后 content chunk usage 上结算，并保留 cached_tokens 优先级冲突", async t => {
  const f = fixture(t, { fetch: async () => response({ ...usage, prompt_tokens_details: { cached_tokens: 60 }, cached_tokens: 50 }, 1) });
  const answer = await streamSimple(selectedModel, normalizeContext({ messages: [{ role: "user", content: "本地模拟", timestamp: 0 }] }), { apiKey: "mock-only" }).result();
  assert.equal(answer.stopReason, "stop");
  assert.equal(answer.usage.cacheRead, 60);
  assert.equal(answer.usage.input, 40);
  assert.equal(f.probe.snapshot().cacheRead, 80);
  assert.equal(f.probe.snapshot().input, 20);
  assert.equal(f.probe.snapshot().incompleteRequests, 0);
  assert.equal(f.logs.find(record => record.type === "deepseek-request")?.thinkingDisabled, true);
  assert.equal(f.logs.find(record => record.type === "deepseek-usage")?.cachedTokensDisagree, true);
  assert.equal(f.logs.find(record => record.type === "deepseek-usage")?.cachedTokens, 50);
  assert.equal(f.logs.find(record => record.type === "deepseek-usage")?.promptDetailsCachedTokens, 60);
});

test("真实 Pi 的 Flash 折叠更新系统提示，Pro 保留首段并追加中途 system，工具保持不变", async t => {
  for (const selected of deepseekProvider().getModels()) {
    const f = fixture(t, { model: selected });
    const initial: Context = { messages: [
      { role: "system", content: "固定基座", sections: { plugin: '<repa-instructions source="plugin:notes">初始私密提示</repa-instructions>' },
        toolsAdded: [{ name: "read", description: "读取私密文件", parameters: Type.Object({ path: Type.String() }) }], timestamp: 0 },
      { role: "user", content: '<repa-view source="private-view">私密状态</repa-view>', timestamp: 0 },
    ] };
    const answer = await streamSimple(selected, normalizeContext(initial), { apiKey: "mock-only" }).result();
    assert.equal(answer.stopReason, "stop");
    const updated: Context = { messages: [...initial.messages, answer,
      { role: "system", content: "", sections: { plugin: '<repa-instructions source="plugin:notes:override">更新私密提示</repa-instructions>' }, timestamp: 1 },
      { role: "user", content: "再回答", timestamp: 1 },
    ] };
    const second = await streamSimple(selected, normalizeContext(updated), { apiKey: "mock-only" }).result();
    assert.equal(second.stopReason, "stop");
    const records = f.logs.filter(record => record.type === "deepseek-request");
    const last = records.at(-1);
    assert(last);
    assert.equal(last.initialSystemUnchanged, selected.id === "deepseek-v4-pro");
    assert.equal(last.midConversationSystemMessages, selected.id === "deepseek-v4-pro" ? 1 : 0);
    assert.equal(last.initialToolsUnchanged, true);
    assert.equal(last.previousToolsUnchanged, true);
    assert.equal(last.sharedMessages, selected.id === "deepseek-v4-pro" ? 2 : 0);
    assert.equal(last.viewCopies, 1);
    assert.equal(last.addedPromptSources, 1);
    assert(!JSON.stringify(f.logs).includes("私密"));
    f.close();
  }
});

test("并发请求同步预留并计入额度，超出的请求不会发往模型服务", async t => {
  let release = () => {};
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const f = fixture(t, { requestLimit: 2, fetch: async () => { calls++; await barrier; return response(); } });
  const first = request();
  const second = request();
  assert.equal(f.probe.snapshot().requests, 2);
  assert(f.probe.snapshot().reservedUsd > 0);
  await assert.rejects(request(), /deepseek_probe_request_limit/u);
  assert.equal(calls, 2);
  release();
  await Promise.all([first.then(value => value.text()), second.then(value => value.text())]);
  assert.equal(f.probe.snapshot().incompleteRequests, 0);
});

test("保守预留超过金额上限时阻止首个请求，未知用量和失败则保留预留并停止后续", async t => {
  const low = fixture(t, { costLimit: 0.000001 });
  await assert.rejects(request(), /deepseek_probe_cost_limit/u);
  assert.equal(low.requests.length, 0);
  low.close();
  const missing = fixture(t, { fetch: async () => response({ prompt_tokens: 100, completion_tokens: 7 }) });
  await (await request()).text();
  assert.equal(missing.probe.snapshot().incompleteRequests, 1);
  assert(missing.probe.snapshot().reservedUsd > 0);
  assert.equal(missing.probe.snapshot().cacheRead, 0);
  assert.equal(missing.logs.find(record => record.type === "deepseek-usage")?.promptCacheHitTokens, null);
  await assert.rejects(request(), /deepseek_probe_usage_unknown/u);
  missing.close();
  const failed = fixture(t, { fetch: async () => { throw new Error("mock_failure"); } });
  await assert.rejects(request(), /mock_failure/u);
  assert.equal(failed.probe.snapshot().requests, 1);
  assert.equal(failed.probe.snapshot().incompleteRequests, 1);
  assert(failed.probe.snapshot().reservedUsd > 0);
  await assert.rejects(request(), /deepseek_probe_usage_unknown/u);
});

test("拒绝模型漂移、非文本和其他远端入口，本机服务继续通行", async t => {
  let calls = 0;
  const f = fixture(t, { fetch: async () => { calls++; return response(); } });
  await assert.rejects(request(undefined, { model: "different" }), /deepseek_probe_unsupported_payload/u);
  await assert.rejects(request([{ role: "user", content: [{ type: "image_url", image_url: { url: "private" } }] }]), /deepseek_probe_unsupported_payload/u);
  await assert.rejects(fetch("https://other.example/chat/completions"), /deepseek_probe_remote_endpoint_rejected/u);
  await assert.rejects(fetch("https://api.deepseek.com/other"), /deepseek_probe_remote_endpoint_rejected/u);
  assert.equal(calls, 0);
  await (await fetch("http://127.0.0.1:1234/health")).text();
  assert.equal(calls, 1);
  assert.equal(f.probe.snapshot().requests, 0);
});


test("后缀诊断只统计 wire system 的精确指令，版本诊断取最后含 view 的消息", async t => {
  const f = fixture(t);
  const messages = [
    { role: "system", content: "核实回复后缀为 A。核实回复后缀为 A。" },
    { role: "user", content: '<repa-view source="notes">旧状态 CHECK_1</repa-view>' },
    { role: "assistant", content: "摘要提及核实回复后缀为 B。CHECK_99" },
    { role: "system", content: "核实回复后缀为 B。" },
    { role: "user", content: [{ type: "text", text: '<repa-view source="notes">最新私密状态 CHECK_12</repa-view>' }] },
    { role: "user", content: "摘要引用核实回复后缀为 A。CHECK_42" },
  ];
  await (await request(messages)).text();
  const first = f.logs.find(record => record.type === "deepseek-request");
  assert.equal(first?.instructionSuffixACopies, 2);
  assert.equal(first?.instructionSuffixBCopies, 1);
  assert.equal(first?.latestViewVersion, 12);
  assert.deepEqual(f.requests[0]?.messages, messages);
  assert(!JSON.stringify(f.logs).includes("最新私密状态"));
  await (await request([{ role: "user", content: "CHECK_100 并非 view" }])).text();
  assert.equal(f.logs.filter(record => record.type === "deepseek-request").at(-1)?.latestViewVersion, null);
  await (await request([...messages, { role: "user", content: '<repa-view source="notes">暂无版本码</repa-view>' }])).text();
  assert.equal(f.logs.filter(record => record.type === "deepseek-request").at(-1)?.latestViewVersion, null);
});
