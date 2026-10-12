import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAgentRuntimeForTest } from "../src/agent/runtime.js";
import type { AgentSession, AgentSpaceOptions } from "../src/agent.js";
import { createSpace } from "../src/space.js";

// 用真实空间打开：.repa/ 里的锁、历史库和 .ignore 都由空间宿主放好，搜索工具面对的就是实际布局。
async function fixture(t: TestContext, extra: Partial<AgentSpaceOptions> = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-agent-files-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "repa-agent-outside-"));
  const host = await createSpace(path.join(directory, "space"), { watch: false });
  const root = host.root;
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
    await host.close();
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const space = await runtime.openSpace({
    root,
    sessionsDir: host.sessionsDir,
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
  for (const result of results) assert.match(result.text, /只能访问当前空间内的文件，不含 \.repa\//u);
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

test("通用 Agent 在空间内照常写入，写不进 .repa/，读取空间外的文件不变", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.outside, "reference.txt"), "空间外的参考资料");
  await writeFile(path.join(f.root, ".repa", "plugins", "state.txt"), "插件数据");
  const session = await f.space.create();
  f.faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("write", { path: "lessons/first.md", content: "第一课，（：\r\n" }),
      fauxToolCall("write", { path: ".repa/skills/demo/SKILL.md", content: "不应写入" }),
      fauxToolCall("edit", { path: ".repa/plugins/state.txt", edits: [{ oldText: "插件", newText: "改写" }] }),
      fauxToolCall("read", { path: path.join(f.outside, "reference.txt") }),
    ]),
    fauxAssistantMessage("已完成"),
  ]);
  await session.send("写入并读取");
  assert.equal(await readFile(path.join(f.root, "lessons", "first.md"), "utf8"), "第一课，（：\r\n");
  await assert.rejects(readFile(path.join(f.root, ".repa", "skills", "demo", "SKILL.md")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(f.root, ".repa", "plugins", "state.txt"), "utf8"), "插件数据");
  const results = toolResults(session);
  assert.deepEqual(results.map(result => [result.tool, result.isError]), [["write", false], ["write", true], ["edit", true], ["read", false]]);
  assert.match(results[1]?.text ?? "", /只能访问当前空间内的文件，不含 \.repa\//u);
  assert.match(results[3]?.text ?? "", /空间外的参考资料/u);
});

const writer = {
  id: "writer",
  instructions: () => "你在后台编写课程文件。",
  tools: ["read", "write", "edit", "ls", "find"],
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

test("插件 Agent 列目录和查找都看不到 .repa/ 与空间外的内容，查找不沿符号链接离开空间", async t => {
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
      fauxToolCall("find", { pattern: "linked/*" }),
      fauxToolCall("find", { pattern: ".repa/**" }),
      fauxToolCall("find", { pattern: "../*" }),
      // 绝对路径的 pattern 按字面目录展开，fs.glob 不经过排除，要靠结果过滤挡住。
      fauxToolCall("find", { pattern: path.join(f.root, "linked", "*") }),
      fauxToolCall("find", { pattern: path.join(f.root, ".repa", "plugins", "learning", "*") }),
    ]),
    fauxAssistantMessage("已查看"),
  ]);
  await session.send(`查找 ${marker}`);
  const results = toolResults(session);
  assert.deepEqual(results.map(result => [result.tool, result.isError]), [
    ["ls", false], ["ls", true], ["find", false], ["find", true], ["find", false], ["find", false], ["find", true], ["find", false], ["find", false],
  ]);
  assert.deepEqual(results[0]?.text.split("\n"), ["notes/"]);
  assert.deepEqual(results[2]?.text.split("\n"), ["notes/a.md"]);
  for (const index of [4, 5, 7, 8]) assert.equal(results[index]?.text, "No files found matching pattern");
  for (const index of [1, 3]) assert.match(results[index]?.text ?? "", /只能访问当前空间内的文件，不含 \.repa\//u);
  assert.match(results[6]?.text ?? "", /pattern 不能用 \.\. 离开搜索目录/u);
});

test("插件 Agent 的查找从空间根目录开始也不列出 .repa/；显式指向 .repa/ 的起点被拒绝", async t => {
  const f = await fixture(t, { agents: () => [writer] });
  await mkdir(path.join(f.root, "notes", "deep"), { recursive: true });
  await writeFile(path.join(f.root, "notes", "a.md"), "笔记");
  await writeFile(path.join(f.root, "notes", "deep", "b.md"), "更深的笔记");
  await mkdir(path.join(f.root, ".repa", "plugins", "learning"));
  await writeFile(path.join(f.root, ".repa", "plugins", "learning", "state.md"), "插件数据");
  const session = await f.space.create({ agent: "writer" });
  f.faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("find", { pattern: "*" }),
      fauxToolCall("find", { pattern: "*.jsonl" }),
      fauxToolCall("find", { pattern: "notes/*.md" }),
      fauxToolCall("find", { pattern: "*", path: ".repa" }),
      fauxToolCall("find", { pattern: "*", path: ".repa/sessions" }),
    ]),
    fauxAssistantMessage("已查找"),
  ]);
  // 会话记录先写进 .repa/sessions/*.jsonl；从根目录查找也不能列出它。
  await session.send("查找全部文件");
  const results = toolResults(session);
  assert.deepEqual(results.map(result => [result.tool, result.isError]), [["find", false], ["find", false], ["find", false], ["find", true], ["find", true]]);
  assert.deepEqual(results[0]?.text.split("\n"), ["notes", "notes/a.md", "notes/deep", "notes/deep/b.md"]);
  assert.equal(results[1]?.text, "No files found matching pattern");
  assert.deepEqual(results[2]?.text.split("\n"), ["notes/a.md"]);
  for (const result of results.slice(3)) assert.match(result.text, /只能访问当前空间内的文件，不含 \.repa\//u);
});

test("通用 Agent 从空间根目录用 Pi 的 grep 和 find 搜索时，也不返回 .repa/ 的内容", async t => {
  const f = await fixture(t);
  const marker = "只在会话记录里的标记-7";
  const session = await f.space.create();
  f.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("grep", { pattern: marker }), fauxToolCall("find", { pattern: "*.jsonl" })]),
    fauxAssistantMessage("已搜索"),
  ]);
  // 标记只出现在这条用户消息里，也就只写进了 .repa/sessions 下的会话记录。
  await session.send(`查找 ${marker}`);
  assert.deepEqual(toolResults(session).map(result => [result.tool, result.isError, result.text]), [
    ["grep", false, "No matches found"],
    ["find", false, "No files found matching pattern"],
  ]);
});

test("插件 Agent 访问大小写不同的 .REPA 同样被拒绝，列目录也不显示它", async t => {
  const f = await fixture(t, { agents: () => [writer] });
  await mkdir(path.join(f.root, ".REPA"));
  await writeFile(path.join(f.root, ".REPA", "notes.txt"), "大小写不同的数据目录");
  const session = await f.space.create({ agent: "writer" });
  f.faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("write", { path: ".Repa/injected.txt", content: "不应写入" }),
      fauxToolCall("read", { path: ".REPA/notes.txt" }),
      fauxToolCall("ls", {}),
    ]),
    fauxAssistantMessage("已尝试"),
  ]);
  await session.send("访问数据目录");
  const results = toolResults(session);
  assert.deepEqual(results.map(result => [result.tool, result.isError]), [["write", true], ["read", true], ["ls", false]]);
  assert.equal(results[2]?.text, "(empty directory)");
  await assert.rejects(readFile(path.join(f.root, ".Repa", "injected.txt")), { code: "ENOENT" });
});

test("插件 Agent 的 find 不需要 fd：PATH 里没有 fd、Pi 也不能下载时照常查找", { timeout: 30000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-find-without-fd-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "space");
  const empty = path.join(directory, "empty-bin");
  await mkdir(path.join(root, "lessons"), { recursive: true });
  await mkdir(empty);
  await writeFile(path.join(root, "lessons", "one.md"), "第一课");
  // Pi 先查自己的工具目录，再查 PATH，都没有时联网下载；这里三条路都断开。
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "test/fixtures/find-without-fd.ts", root], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { PATH: empty, HOME: directory, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: path.join(directory, "pi-agent") },
  });
  assert.deepEqual(JSON.parse(stdout), { text: "lessons/one.md", isError: false });
});
