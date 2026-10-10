import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Result } from "@repa/base/protocol";

import { guardProbeRuntime } from "../scripts/real-model/guard.js";
import { assertModelBudget, summarizeUsage } from "../scripts/real-model/usage.js";
import { entryToPublic } from "../src/agent/events.js";
import { createAgentRuntimeForTest } from "../src/agent/runtime.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-model-usage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir);
  const faux = fauxProvider({ api: `usage-api-${randomUUID()}`, provider: `usage-provider-${randomUUID()}`, models: [{ id: "test", contextWindow: 16384, maxTokens: 512 }], tokensPerSecond: 0 });
  const models = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  models.registerNativeProvider(faux.provider);
  const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 16, reserveTokens: 400 }, cacheWarming: "off" });
  return { root, agentDir, faux, models, settings };
}

test("完整输入含缓存读写各一次，保温也计入用量与模型操作额度", () => {
  const entries: Result<"session.history"> = [
    { id: "assistant", timestamp: "", type: "assistant", usage: { input: 100, output: 9, cacheRead: 1000, cacheWrite: 20 } },
    { id: "compact", timestamp: "", type: "compaction", usage: { input: 762, output: 336, cacheRead: 0, cacheWrite: 0 } },
    { id: "warm", timestamp: "", type: "usage", data: { kind: "cache_warm" }, usage: { input: 0, output: 1, cacheRead: 900, cacheWrite: 0 } },
    { id: "tool", timestamp: "", type: "usage", data: { kind: "tool" }, usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 } },
    { id: "view", timestamp: "", type: "view" },
  ];
  assert.deepEqual(summarizeUsage(entries), {
    input: 865, output: 348, cacheRead: 1900, cacheWrite: 20,
    fullInput: 2785, cacheHitRate: 1900 / 2785,
    assistantMessages: 1, compactions: 1, cacheWarmOperations: 1, modelOperations: 3,
  });
  assert.doesNotThrow(() => assertModelBudget(entries, 4));
  assert.throws(() => assertModelBudget(entries, 3), /model_operation_limit/u);
  assert.equal(summarizeUsage([]).cacheHitRate, null);
});

test("真实 Pi 的助手与两份压缩摘要按原生合计统计，不把子请求当作压缩次数", async t => {
  const f = await fixture(t);
  const loader = new DefaultResourceLoader({ cwd: f.root, agentDir: f.agentDir, settingsManager: f.settings, systemPrompt: "用量核实", noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: f.root, agentDir: f.agentDir, modelRuntime: f.models, model: f.faux.getModel(), settingsManager: f.settings, sessionManager: SessionManager.inMemory(f.root), resourceLoader: loader, tools: [] });
  t.after(() => session.dispose());
  f.faux.setResponses([fauxAssistantMessage("第一份回答".repeat(300)), fauxAssistantMessage("第二份回答".repeat(300))]);
  await session.prompt("问题一");
  await session.prompt("问题二");
  f.faux.setResponses([fauxAssistantMessage("历史摘要"), fauxAssistantMessage("截断回合摘要")]);
  await session.compact();
  const entries = session.sessionManager.getEntries().flatMap(entry => {
    const value = entryToPublic(entry);
    return value ? [value] : [];
  });
  const summary = summarizeUsage(entries);
  const stats = session.getSessionStats();
  assert.equal(f.faux.state.callCount, 4);
  assert.equal(summary.assistantMessages, stats.assistantMessages);
  assert.equal(summary.assistantMessages, 2);
  assert.equal(summary.compactions, 1);
  assert.equal(summary.modelOperations, 3);
  assert.deepEqual({ input: summary.input, output: summary.output, cacheRead: summary.cacheRead, cacheWrite: summary.cacheWrite }, {
    input: stats.tokens.input, output: stats.tokens.output, cacheRead: stats.tokens.cacheRead, cacheWrite: stats.tokens.cacheWrite,
  });
  assert(entries.find(entry => entry.type === "compaction")?.usage?.output);
  assert.throws(() => assertModelBudget(entries, 3), /model_operation_limit/u);
});

test("核实宿主在真实 SDK 助手请求工具时同步取消，工具与续轮都不执行", async t => {
  const f = await fixture(t);
  const raw = await createAgentRuntimeForTest({ agentDir: f.agentDir, modelRuntime: f.models, defaultModel: { provider: f.faux.getModel().provider, id: "test" }, settingsManager: f.settings });
  const runtime = guardProbeRuntime(raw);
  t.after(() => runtime.close());
  const space = await runtime.openSpace({ root: f.root, sessionsDir: path.join(f.root, "sessions"), instructions: () => [], tools: () => [], views: async () => [], overrides: async () => ({ app: {}, space: {} }), commandPolicy: () => "fullAccess", record: async (_id, action) => action(), onEvent: () => undefined, confirm: async () => true });
  const session = await space.create();
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("write", { path: "should-not-exist", content: "禁止执行" }), { stopReason: "toolUse" }), fauxAssistantMessage("不应开始的续轮")]);
  await assert.rejects(session.send("只回复，不调用工具"), error => error !== null && typeof error === "object" && "code" in error && error.code === "cancelled");
  assert.equal(f.faux.state.callCount, 1);
  assert.equal(summarizeUsage(session.history()).modelOperations, 2);
  assert(session.history().filter(entry => entry.type === "tool").every(entry => entry.data !== null && typeof entry.data === "object" && "isError" in entry.data && entry.data.isError === true));
  await assert.rejects(access(path.join(f.root, "should-not-exist")), error => error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT");
  await space.close();
});
