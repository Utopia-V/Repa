import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAgentRuntimeForTest } from "../src/agent/runtime.js";
import type { AgentSession, AgentSpaceOptions } from "../src/agent.js";

async function fixture(t: TestContext, extra: Partial<AgentSpaceOptions> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-agent-files-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "repa-agent-outside-"));
  const agentDir = path.join(root, ".repa", "test-agent");
  await mkdir(agentDir, { recursive: true });
  const faux = fauxProvider({ api: `files-api-${randomUUID()}`, provider: `files-provider-${randomUUID()}`, models: [{ id: "test", contextWindow: 16384, maxTokens: 512 }], tokensPerSecond: 0 });
  const models = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  models.registerNativeProvider(faux.provider);
  const runtime = await createAgentRuntimeForTest({
    agentDir,
    modelRuntime: models,
    defaultModel: { provider: faux.getModel().provider, id: "test" },
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
  });
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const space = await runtime.openSpace({
    root,
    sessionsDir: path.join(root, ".repa", "sessions"),
    instructions: () => [],
    tools: () => [],
    views: async () => [],
    overrides: async () => ({ app: {}, space: {} }),
    commandPolicy: () => "ask",
    record: async (_id, action) => action(),
    onEvent: () => undefined,
    confirm: async () => false,
    ...extra,
  });
  return { root, outside, faux, space };
}

function toolResults(session: AgentSession) {
  return session.history().filter(entry => entry.type === "tool").map(entry => {
    const data = entry.data !== null && typeof entry.data === "object" ? entry.data : {};
    return { tool: "tool" in data ? data.tool : undefined, isError: "isError" in data ? data.isError : undefined, text: entry.text ?? "" };
  });
}

test("通用 Agent 写入和编辑空间外的文件被拒绝，空间外原文保持不变", async t => {
  const f = await fixture(t);
  const target = path.join(f.outside, "target.txt");
  await writeFile(target, "空间外原文\r\n");
  const session = await f.space.create();
  f.faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("write", { path: path.join(f.outside, "created.txt"), content: "不应出现" }),
      fauxToolCall("edit", { path: target, edits: [{ oldText: "原文", newText: "改写" }] }),
    ]),
    fauxAssistantMessage("已尝试"),
  ]);
  await session.send("写到空间外");
  await assert.rejects(readFile(path.join(f.outside, "created.txt")), { code: "ENOENT" });
  assert.equal(await readFile(target, "utf8"), "空间外原文\r\n");
  const results = toolResults(session);
  assert.deepEqual(results.map(result => [result.tool, result.isError]), [["write", true], ["edit", true]]);
  for (const result of results) assert.match(result.text, /只能写入当前空间内的文件/u);
});

test("通用 Agent 不能经空间内的符号链接写到空间外", async t => {
  const f = await fixture(t);
  await symlink(f.outside, path.join(f.root, "linked"));
  const session = await f.space.create();
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "linked/escape.txt", content: "不应出现" })),
    fauxAssistantMessage("已尝试"),
  ]);
  await session.send("经链接写入");
  await assert.rejects(readFile(path.join(f.outside, "escape.txt")), { code: "ENOENT" });
  assert.equal(toolResults(session)[0]?.isError, true);
});

test("通用 Agent 仍能在空间内及其 .repa 中写入，并照旧读取空间外的文件", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.outside, "reference.txt"), "空间外的参考资料");
  const session = await f.space.create();
  f.faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("write", { path: "lessons/first.md", content: "第一课，（：\r\n" }),
      fauxToolCall("write", { path: ".repa/skills/demo/SKILL.md", content: "技能草稿" }),
      fauxToolCall("read", { path: path.join(f.outside, "reference.txt") }),
    ]),
    fauxAssistantMessage("已完成"),
  ]);
  await session.send("写入并读取");
  assert.equal(await readFile(path.join(f.root, "lessons", "first.md"), "utf8"), "第一课，（：\r\n");
  assert.equal(await readFile(path.join(f.root, ".repa", "skills", "demo", "SKILL.md"), "utf8"), "技能草稿");
  const results = toolResults(session);
  assert.deepEqual(results.map(result => [result.tool, result.isError]), [["write", false], ["write", false], ["read", false]]);
  assert.match(results[2]?.text ?? "", /空间外的参考资料/u);
});
