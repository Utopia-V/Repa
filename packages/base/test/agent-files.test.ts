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

const writer = {
  id: "writer",
  instructions: () => "你在后台编写课程文件。",
  tools: ["read", "write", "edit", "ls", "find", "grep"],
};

test("插件 Agent 的读写和编辑只在空间内且不进 .repa/，也不能经符号链接离开", async t => {
  const f = await fixture(t, { agents: () => [writer] });
  await mkdir(path.join(f.root, "lessons"));
  await writeFile(path.join(f.root, "lessons", "one.md"), "第一课，（：\r\n");
  await writeFile(path.join(f.root, ".repa", "private.txt"), "插件私有数据");
  await writeFile(path.join(f.outside, "secret.txt"), "空间外的文件");
  await symlink(f.outside, path.join(f.root, "linked"));
  await symlink(path.join(f.outside, "secret.txt"), path.join(f.root, "lessons", "escape.md"));
  const session = await f.space.create({ agent: "writer" });
  f.faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("write", { path: "lessons/two.md", content: "第二课\r\n" }),
      fauxToolCall("write", { path: ".repa/injected.txt", content: "不应写入" }),
      fauxToolCall("write", { path: path.join(f.outside, "created.txt"), content: "不应写入" }),
      fauxToolCall("edit", { path: "lessons/one.md", edits: [{ oldText: "第一课", newText: "第 1 课" }] }),
      fauxToolCall("edit", { path: ".repa/private.txt", edits: [{ oldText: "私有", newText: "公开" }] }),
      fauxToolCall("read", { path: "linked/secret.txt" }),
      fauxToolCall("read", { path: "lessons/escape.md" }),
    ]),
    fauxAssistantMessage("已处理"),
  ]);
  await session.send("整理课程文件");
  assert.deepEqual(toolResults(session).map(result => [result.tool, result.isError]), [
    ["write", false], ["write", true], ["write", true], ["edit", false], ["edit", true], ["read", true], ["read", true],
  ]);
  assert.equal(await readFile(path.join(f.root, "lessons", "two.md"), "utf8"), "第二课\r\n");
  assert.equal(await readFile(path.join(f.root, "lessons", "one.md"), "utf8"), "第 1 课，（：\r\n");
  assert.equal(await readFile(path.join(f.root, ".repa", "private.txt"), "utf8"), "插件私有数据");
  await assert.rejects(readFile(path.join(f.root, ".repa", "injected.txt")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(f.outside, "created.txt")), { code: "ENOENT" });
  for (const result of toolResults(session).filter(item => item.isError)) assert.match(result.text, /只能访问当前空间内的文件，不含 \.repa\//u);
});

test("插件 Agent 列目录、查找和搜索都看不到 .repa/ 与空间外的内容", async t => {
  const f = await fixture(t, { agents: () => [writer] });
  const marker = "独特标记-42";
  await mkdir(path.join(f.root, "notes"));
  await writeFile(path.join(f.root, "notes", "a.md"), `第一行\r\n${marker} 在笔记里\r\n`);
  await mkdir(path.join(f.root, ".repa", "plugins", "learning"), { recursive: true });
  await writeFile(path.join(f.root, ".repa", "plugins", "learning", "state.md"), marker);
  await writeFile(path.join(f.outside, "outside.md"), marker);
  await symlink(f.outside, path.join(f.root, "linked"));
  const session = await f.space.create({ agent: "writer" });
  f.faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("ls", {}),
      fauxToolCall("ls", { path: ".repa" }),
      fauxToolCall("find", { pattern: "*.md" }),
      fauxToolCall("find", { pattern: "*.md", path: f.outside }),
      fauxToolCall("grep", { pattern: marker }),
      fauxToolCall("grep", { pattern: marker, path: ".repa" }),
      fauxToolCall("grep", { pattern: "笔记", glob: "notes/*.md", context: 1 }),
    ]),
    fauxAssistantMessage("已查看"),
  ]);
  // 用户消息先写进 .repa/sessions；从空间根目录搜索也不能读到这份会话记录。
  await session.send(`查找 ${marker}`);
  const results = toolResults(session);
  assert.deepEqual(results.map(result => [result.tool, result.isError]), [
    ["ls", false], ["ls", true], ["find", false], ["find", true], ["grep", false], ["grep", true], ["grep", false],
  ]);
  assert.deepEqual(results[0]?.text.split("\n"), ["notes/"]);
  assert.deepEqual(results[2]?.text.split("\n"), ["notes/a.md"]);
  assert.equal(results[4]?.text, `notes/a.md:2: ${marker} 在笔记里`);
  assert.equal(results[6]?.text, `notes/a.md-1- 第一行\nnotes/a.md:2: ${marker} 在笔记里\nnotes/a.md-3- `);
  for (const index of [1, 3, 5]) assert.match(results[index]?.text ?? "", /只能访问当前空间内的文件，不含 \.repa\//u);
});
