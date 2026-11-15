import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, getCurrentSystemPrompt, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAgentRuntimeForTest } from "../src/agent/runtime.js";
import type { AgentSpaceOptions } from "../src/agent.js";

const DAY = 24 * 60 * 60 * 1000;

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-date-view-")));
  const agentDir = path.join(root, ".repa", "test-agent");
  await mkdir(agentDir, { recursive: true });
  const faux = fauxProvider({ api: `date-${randomUUID()}`, provider: `date-${randomUUID()}`, models: [{ id: "test", contextWindow: 16384, maxTokens: 512 }], tokensPerSecond: 0 });
  const models = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  models.registerNativeProvider(faux.provider);
  // 2026-11-15 中午（UTC），任何时区里都还是 11 月 15 日或相邻的一天，测试按系统时区算出期望值。
  let now = Date.UTC(2026, 10, 15, 12);
  const runtime = await createAgentRuntimeForTest({
    agentDir, modelRuntime: models, defaultModel: { provider: faux.getModel().provider, id: "test" }, now: () => now,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
  });
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  const options: AgentSpaceOptions = {
    root, sessionsDir: path.join(root, ".repa", "sessions"),
    instructions: () => [], tools: () => [], views: async () => [],
    overrides: async () => ({ app: {}, space: {} }), commandPolicy: () => "ask",
    record: async (_runId, action) => action(), onEvent: () => {}, confirm: async () => false,
  };
  const space = await runtime.openSpace(options);
  return { faux, session: await space.create(), advance(ms: number) { now += ms; }, now: () => now };
}

function day(at: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

function viewTexts(context: TranscriptContext): string[] {
  return context.messages.flatMap(message => {
    if (message.role !== "user") return [];
    const text = typeof message.content === "string" ? message.content : message.content.map(part => (part.type === "text" ? part.text : "")).join("");
    return text.includes("今天是") ? [text] : [];
  });
}

test("通用 Agent 不执行命令就知道今天的日期：日期在视图里、不在系统提示里，同一天只给一次，换了一天再给新的", async t => {
  const f = await fixture(t);
  const contexts: TranscriptContext[] = [];
  const reply = (context: TranscriptContext) => { contexts.push(context); return fauxAssistantMessage("好"); };
  f.faux.setResponses([reply, reply, reply]);
  await f.session.send("今天几号？");
  await f.session.send("再问一次");
  f.advance(DAY);
  await f.session.send("过了一天");
  const [first, second, third] = contexts;
  assert.ok(first && second && third);
  const today = day(f.now() - DAY);
  const tomorrow = day(f.now());
  assert.ok(!getCurrentSystemPrompt(first.messages).includes("今天是"));
  assert.equal(viewTexts(first).length, 1);
  assert.match(viewTexts(first)[0] ?? "", new RegExp(`今天是 ${today}`, "u"));
  // 同一天的第二条消息不再追加，系统提示不变。
  assert.equal(viewTexts(second).length, 1);
  assert.equal(getCurrentSystemPrompt(second.messages), getCurrentSystemPrompt(first.messages));
  assert.match(viewTexts(third).at(-1) ?? "", new RegExp(`今天是 ${tomorrow}`, "u"));
  assert.equal(getCurrentSystemPrompt(third.messages), getCurrentSystemPrompt(first.messages));
});
