import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { zstdDecompressSync } from "node:zlib";

import { Type, type Model } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

import { createRequestProbe } from "../scripts/real-model/request.js";
import { summarizeUsage } from "../scripts/real-model/usage.js";
import { entryToPublic } from "../src/agent/events.js";

const deepseek = deepseekProvider().getModels().find(value => value.id === "deepseek-v4-pro");
assert(deepseek);
const selectedDeepseek = deepseek;
const codex = openaiCodexProvider().getModels()[0];
assert(codex);
const selectedCodex = codex;
const fakeCodexKey = `mock.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "mock-only" } })).toString("base64")}.mock`;

function response(model: Model<string>, text = "回复🌱"): Response {
  if (model.provider === "openai-codex") {
    const output = { id: "mock-item", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
    const events = [
      { type: "response.created", response: { id: "mock-response" } },
      { type: "response.output_item.added", output_index: 0, item: { ...output, content: [] } },
      { type: "response.content_part.added", item_id: output.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", item_id: output.id, output_index: 0, content_index: 0, delta: text },
      { type: "response.output_item.done", output_index: 0, item: output },
      { type: "response.completed", response: { id: "mock-response", status: "completed", output: [output], usage: { input_tokens: 100, output_tokens: 7, input_tokens_details: { cached_tokens: 60 } } } },
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
  }
  const event = { id: "mock", object: "chat.completion.chunk", created: 0, model: model.id,
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 7, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20,
      prompt_tokens_details: { cached_tokens: 60 } } };
  return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
}

async function fixture(t: TestContext, options: { model?: Model<string>; requestLimit?: number; costLimit?: number; fail?: boolean; long?: boolean; tool?: boolean } = {}) {
  const model = options.model ?? selectedDeepseek;
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-request-probe-"));
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir);
  const originalFetch = globalThis.fetch;
  const requests: Record<string, unknown>[] = [];
  const providerPayloads: unknown[] = [];
  const logs: Record<string, unknown>[] = [];
  const signals: Array<boolean | undefined> = [];
  let phase = "first";
  let fail = options.fail ?? false;
  let instructions = '<repa-instructions source="plugin:notes">初始私密提示</repa-instructions>';
  globalThis.fetch = async (_url, init) => {
    signals.push(init?.signal?.aborted);
    const body = init?.body;
    assert(typeof body === "string" || body instanceof Uint8Array);
    const serialized = typeof body === "string" ? body : zstdDecompressSync(body).toString("utf8");
    const payload: unknown = JSON.parse(serialized);
    assert(payload !== null && typeof payload === "object" && !Array.isArray(payload));
    requests.push(payload as Record<string, unknown>);
    if (fail) return new Response("mock-error", { status: 400 });
    return response(model, options.long ? "私密回答".repeat(300) : undefined);
  };
  const probe = createRequestProbe({ model, costLimit: options.costLimit ?? 1, requestLimit: options.requestLimit ?? 25,
    phase: () => phase, log: record => logs.push(record) });
  if (model.provider === "openai-codex") {
    await writeFile(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", access: fakeCodexKey, refresh: "mock-refresh", expires: Date.now() + 3600000 } }));
  }
  const models = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false });
  if (model.provider !== "openai-codex") await models.setRuntimeApiKey(model.provider, "mock-only");
  const settings = SettingsManager.inMemory({ transport: "sse", defaultThinkingLevel: "off", retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    compaction: { enabled: false, keepRecentTokens: 128, reserveTokens: 2048 }, cacheWarming: "idle" });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: "核实回复后缀为 A。私密基座",
    extensionFactories: [probe.extensionFactory, pi => {
      pi.on("before_agent_start", event => { event.systemPromptOptions.sections.plugin = instructions; });
      pi.on("before_provider_request", event => { providerPayloads.push(structuredClone(event.payload)); });
    }] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime: models, model,
    settingsManager: settings, sessionManager: SessionManager.inMemory(root), resourceLoader: loader,
    tools: options.tool ? ["test_state"] : [],
    customTools: options.tool ? [{ name: "test_state", label: "测试状态", description: "读取私密状态", parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "状态" }], details: {} }) }] : [] });
  t.after(async () => {
    await session.abort();
    session.dispose();
    probe.close();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  });
  const history = () => session.sessionManager.getEntries().flatMap(entry => {
    const value = entryToPublic(entry);
    return value ? [value] : [];
  });
  let last = 0;
  function settle() {
    const current = history();
    probe.settle(phase, summarizeUsage(current.slice(last)));
    last = current.length;
  }
  return { session, probe, requests, providerPayloads, logs, signals, settle, history, phase(value: string) { phase = value; },
    instructions(value: string) { instructions = value; },
    fail() { fail = true; } };
}

test("真实 Pi DeepSeek 事件限制输出并观察脱敏结构，结算采用历史中的 cached_tokens 优先级", async t => {
  const f = await fixture(t);
  await f.session.prompt('<repa-view source="private">最新私密状态 CHECK_12</repa-view>');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]?.max_tokens, 2048);
  assert(f.probe.snapshot().reservedUsd > 0);
  f.settle();
  assert.equal(f.probe.snapshot().fullInput, 100);
  assert.equal(f.probe.snapshot().input, 40);
  assert.equal(f.probe.snapshot().cacheRead, 60);
  assert.equal(f.probe.snapshot().incompleteRequests, 0);
  assert.equal(f.probe.snapshot().observedRequests, 1);
  assert.equal(f.probe.snapshot().unobservedRequestUpperBound, 0);
  const record = f.logs.find(value => value.type === "provider-request");
  assert.equal(record?.viewCopies, 1);
  assert.equal(record?.latestViewVersion, 12);
  assert.equal(record?.instructionSuffixACopies, 1);
  assert.equal(record?.thinkingDisabled, true);
  assert(!JSON.stringify(f.logs).includes("私密"));
  assert(!JSON.stringify(f.logs).includes("mock-only"));
  assert.equal(f.session.cacheWarmingStatus?.state, "inactive");
  f.phase("second");
  await f.session.prompt("继续");
  f.settle();
  const second = f.logs.filter(value => value.type === "provider-request").at(-1);
  assert.equal(second?.initialSystemUnchanged, true);
  assert.equal(second?.initialToolsUnchanged, true);
  assert(Number(second?.sharedMessages) > 0);
  assert.equal(f.probe.snapshot("second").requests, 1);
});

test("真实 Pi Codex 事件观察 input 和 instructions，保留原生负载且目录金额不充当门槛", async t => {
  const f = await fixture(t, { model: selectedCodex, costLimit: 0.000001 });
  await f.session.prompt('<repa-view source="private">私密状态 CHECK_3</repa-view>');
  assert.equal(f.requests.length, 1, JSON.stringify({ messages: f.session.messages.slice(-1), logs: f.logs }));
  assert.equal(f.requests[0]?.max_tokens, undefined);
  assert.equal(f.requests[0]?.max_output_tokens, undefined);
  assert.deepEqual(f.requests[0], f.providerPayloads[0]);
  f.settle();
  const record = f.logs.find(value => value.type === "provider-request");
  assert.equal(record?.instructionsPresent, true);
  assert.equal(record?.viewCopies, 1);
  assert.equal(record?.instructionSuffixACopies, 1);
  assert.equal(f.probe.snapshot().cacheRead, 60);
  assert.equal(f.probe.snapshot().incompleteRequests, 0);
  assert(!JSON.stringify(f.logs).includes("私密"));
});

for (const model of [selectedDeepseek, selectedCodex]) {
  test(`真实 Pi ${model.provider} 事件同步 abort，超出请求额度不进入网络边界`, async t => {
    const f = await fixture(t, { model, requestLimit: 1 });
    await f.session.prompt("第一个请求");
    f.settle();
    f.phase("second");
    await f.session.prompt("被预算拒绝的请求");
    assert.equal(f.requests.length, 1);
    assert.equal(f.probe.snapshot().requests, 1);
    assert.equal(f.logs.find(value => value.type === "request-rejected")?.reason, "request_probe_request_limit");
    assert.equal(f.session.messages.at(-1)?.role, "assistant");
    const assistant = f.session.messages.at(-1);
    assert(assistant?.role === "assistant");
    assert.equal(assistant.stopReason, "aborted");
    assert(f.signals.every(aborted => !aborted));
  });
}

test("真实 Pi DeepSeek 金额预留不足时首个请求在事件中取消", async t => {
  const f = await fixture(t, { costLimit: 0.000001 });
  await f.session.prompt("不得到达模型服务");
  assert.equal(f.requests.length, 0);
  assert.equal(f.probe.snapshot().requests, 0);
  assert.equal(f.logs.find(value => value.type === "request-rejected")?.reason, "request_probe_cost_limit");
});

test("模型服务失败后用量无法结算，保留预留并停止后续请求", async t => {
  const f = await fixture(t, { fail: true });
  await f.session.prompt("失败请求");
  assert.throws(f.settle, /request_probe_usage_unknown/u);
  assert.equal(f.probe.snapshot().incompleteRequests, 1);
  assert(f.probe.snapshot().reservedUsd > 0);
  f.phase("second");
  await f.session.prompt("不能继续消耗预算");
  assert.equal(f.requests.length, 1);
  assert.equal(f.logs.find(value => value.type === "request-rejected")?.reason, "request_probe_usage_unknown");
});

test("真实 Pi 压缩绕过 payload 事件，静态两请求上界覆盖子摘要并按历史合计结算", async t => {
  const f = await fixture(t, { long: true });
  await f.session.prompt("问题一");
  f.settle();
  f.phase("second");
  await f.session.prompt("问题二");
  f.settle();
  f.phase("compact");
  const before = f.requests.length;
  await f.session.compact();
  assert.equal(f.requests.length - before, 2);
  assert.equal(f.logs.filter(value => value.type === "provider-request").length, 2);
  assert.equal(f.probe.snapshot("compact").requests, 2);
  assert.equal(f.probe.snapshot("compact").observedRequests, 0);
  assert.equal(f.probe.snapshot("compact").unobservedRequestUpperBound, 2);
  assert(f.requests.slice(before).every(value => Number(value.max_tokens) <= 2048));
  f.settle();
  assert.equal(f.probe.snapshot("compact").output, 14);
  assert.equal(f.probe.snapshot("compact").incompleteRequests, 0);
  assert.equal(f.logs.find(value => value.type === "compaction-request-bound")?.source, "static-upper-bound");
});

test("压缩上界超出剩余额度时通过公开 cancel 结果阻止全部子摘要", async t => {
  const f = await fixture(t, { long: true, requestLimit: 3 });
  await f.session.prompt("问题一");
  f.settle();
  f.phase("second");
  await f.session.prompt("问题二");
  f.settle();
  f.phase("compact");
  await assert.rejects(f.session.compact(), /cancelled/u);
  assert.equal(f.requests.length, 2);
  assert.equal(f.probe.snapshot().requests, 2);
});


test("真实 Pi 的 Flash 折叠命名分段，Pro 保留首段并追加中途 system，工具声明稳定", async t => {
  for (const model of deepseekProvider().getModels()) {
    await t.test(model.id, async child => {
      const f = await fixture(child, { model, tool: true });
      await f.session.prompt('<repa-view source="private">私密状态 CHECK_1</repa-view>');
      f.settle();
      f.phase("second");
      f.instructions('<repa-instructions source="plugin:notes:override">更新私密提示</repa-instructions>');
      await f.session.prompt("再回答");
      f.settle();
      const last = f.logs.filter(value => value.type === "provider-request").at(-1);
      assert(last);
      assert.equal(last.initialSystemUnchanged, model.id === "deepseek-v4-pro");
      assert.equal(last.midConversationSystemMessages, model.id === "deepseek-v4-pro" ? 1 : 0);
      assert.equal(last.initialToolsUnchanged, true);
      assert.equal(last.previousToolsUnchanged, true);
      assert.equal(last.tools, 1);
      assert.equal(last.sharedMessages, model.id === "deepseek-v4-pro" ? 2 : 0);
      assert.equal(last.addedPromptSources, 1);
      assert.equal(last.viewCopies, 1);
      assert(!JSON.stringify(f.logs).includes("私密"));
    });
  }
});

test("真实 Pi Codex 压缩最多八请求的静态预留覆盖本地 WebSocket 回退，按合计历史结算", async t => {
  // 摘要不继承 Agent 的 transport:sse，真实 SDK 的 WS 只连接本机入口，失败后 SSE 使用上面的本地 mock。
  const server = createServer();
  let upgrades = 0;
  server.on("upgrade", (_request, socket) => {
    upgrades++;
    socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  const localCodex = structuredClone(selectedCodex);
  localCodex.baseUrl = `http://127.0.0.1:${address.port}`;
  const f = await fixture(t, { model: localCodex, long: true });
  await f.session.prompt("问题一");
  f.settle();
  f.phase("second");
  await f.session.prompt("问题二");
  f.settle();
  f.phase("compact");
  await f.session.compact();
  assert.equal(upgrades, 2);
  assert.equal(f.requests.length, 4);
  assert.equal(f.logs.filter(value => value.type === "provider-request").length, 2);
  assert.equal(f.probe.snapshot("compact").unobservedRequestUpperBound, 8);
  assert(f.probe.snapshot("compact").reservedUsd > 0);
  f.settle();
  assert.equal(f.probe.snapshot("compact").incompleteRequests, 0);
  assert.equal(f.probe.snapshot("compact").output, 14);
});

test("真实 Pi Codex 压缩八请求预留不足时取消，摘要不尝试 WebSocket 或 SSE", async t => {
  const f = await fixture(t, { model: selectedCodex, long: true, requestLimit: 9 });
  await f.session.prompt("问题一");
  f.settle();
  f.phase("second");
  await f.session.prompt("问题二");
  f.settle();
  f.phase("compact");
  await assert.rejects(f.session.compact(), /cancelled/u);
  assert.equal(f.requests.length, 2);
  assert.equal(f.probe.snapshot().requests, 2);
});


test("压缩子摘要失败后保留完整静态预留，结算拒绝且阻止下一次模型请求", async t => {
  const f = await fixture(t, { long: true });
  await f.session.prompt("问题一");
  f.settle();
  f.phase("second");
  await f.session.prompt("问题二");
  f.settle();
  f.phase("compact");
  f.fail();
  await assert.rejects(f.session.compact(), /failed/u);
  assert.equal(f.requests.length, 3);
  assert.equal(f.probe.snapshot("compact").incompleteRequests, 2);
  assert(f.probe.snapshot("compact").reservedUsd > 0);
  assert.throws(f.settle, /request_probe_usage_unknown/u);
  f.phase("after-failure");
  await f.session.prompt("不得继续消耗预算");
  assert.equal(f.requests.length, 3);
  assert.equal(f.logs.filter(value => value.type === "request-rejected").at(-1)?.reason, "request_probe_usage_unknown");
});
