import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAgentRuntimeForTest } from "../src/agent/runtime.js";
import type { AgentSession, AgentSpaceOptions } from "../src/agent.js";
import type { Confirmation } from "../src/schema.js";
import { createSpace, openSpace } from "../src/space.js";

// 用真实空间打开：.repa/ 里的锁、历史库和 .ignore 都由空间宿主放好，搜索工具面对的就是实际布局。
// approve 是用户对确认的回答，确认请求记在 confirmations 里。
async function fixture(t: TestContext, extra: Partial<AgentSpaceOptions> = {}, approve = false, linkedRoot = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-agent-files-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "repa-agent-outside-"));
  const inputRoot = path.join(directory, "space");
  if (linkedRoot) {
    const target = path.join(directory, "real-space");
    await mkdir(target);
    await symlink(target, inputRoot, "junction");
  }
  const host = await createSpace(inputRoot, { watch: linkedRoot });
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
  const confirmations: Confirmation[] = [];
  const space = await runtime.openSpace({
    root,
    sessionsDir: host.sessionsDir,
    instructions: () => [],
    tools: () => [],
    views: async () => [],
    overrides: async () => ({ app: {}, space: {} }),
    commandPolicy: () => "ask",
    record: async (_id, action) => action(),
    writes: host.writes,
    onEvent: () => undefined,
    confirm: async request => {
      confirmations.push(request);
      return approve;
    },
    ...extra,
  });
  return { root, inputRoot, host, runtime, outside: await realpath(outside), faux, space, confirmations };
}

function toolResults(session: AgentSession) {
  return session.history().filter(entry => entry.type === "tool").map(entry => {
    const data = entry.data !== null && typeof entry.data === "object" ? entry.data : {};
    return { tool: "tool" in data ? data.tool : undefined, isError: "isError" in data ? data.isError : undefined, text: entry.text ?? "" };
  });
}

/** 确认里写明的路径；确认框一律写明这次写入不进历史、不能撤回。 */
function approvals(confirmations: Confirmation[]): string[] {
  return confirmations.map(request => {
    assert.equal(request.kind, "command");
    assert.equal(request.title, "允许写入空间外的文件？");
    const [target, note] = (request.message ?? "").split("\n");
    assert.equal(note, "这次写入不会进入空间的历史，之后不能撤回。");
    return target ?? "";
  }).sort();
}

test("通用 Agent 写空间外的文件先问确认，拒绝时写入和编辑都不发生，确认里写明路径", async t => {
  const f = await fixture(t);
  const target = path.join(f.outside, "target.txt");
  await writeFile(target, "空间外原文\r\n");
  const session = await f.space.create();
  f.faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("write", { path: path.join(f.outside, "nested", "created.txt"), content: "不应出现" }),
      fauxToolCall("edit", { path: target, edits: [{ oldText: "原文", newText: "改写" }] }),
    ]),
    fauxAssistantMessage("已尝试"),
  ]);
  await session.send("写到空间外");
  // 父目录也要等用户同意之后才建。
  await assert.rejects(readFile(path.join(f.outside, "nested")), { code: "ENOENT" });
  assert.equal(await readFile(target, "utf8"), "空间外原文\r\n");
  assert.deepEqual(approvals(f.confirmations), [path.join(f.outside, "nested", "created.txt"), target].sort());
  const results = toolResults(session);
  assert.deepEqual(results.map(result => [result.tool, result.isError]), [["write", true], ["edit", true]]);
  for (const result of results) assert.match(result.text, /用户没有允许写入空间外的文件/u);
});

test("通用 Agent 经空间内的符号链接写到空间外，同样先问确认，确认里写的是实际写到的位置", async t => {
  const f = await fixture(t);
  await symlink(f.outside, path.join(f.root, "linked"));
  const session = await f.space.create();
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "linked/escape.txt", content: "不应出现" })),
    fauxAssistantMessage("已尝试"),
  ]);
  await session.send("经链接写入");
  await assert.rejects(readFile(path.join(f.outside, "escape.txt")), { code: "ENOENT" });
  assert.deepEqual(approvals(f.confirmations), [path.join(f.outside, "escape.txt")]);
  assert.equal(toolResults(session)[0]?.isError, true);
});

test("用户同意后写到空间外并注明不能撤回；没读过的已有文件先交回内容，不必问用户", async t => {
  const f = await fixture(t, {}, true);
  const target = path.join(f.outside, "target.txt");
  const unread = path.join(f.outside, "unread.txt");
  await writeFile(target, "空间外原文\r\n");
  await writeFile(unread, "没读过的内容");
  const session = await f.space.create();
  f.faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("write", { path: path.join(f.outside, "nested", "created.txt"), content: "新文件，（：\r\n" }),
      fauxToolCall("edit", { path: target, edits: [{ oldText: "原文", newText: "改写" }] }),
      fauxToolCall("write", { path: unread, content: "覆盖" }),
    ]),
    fauxAssistantMessage("已写好"),
  ]);
  await session.send("写到空间外");
  assert.equal(await readFile(path.join(f.outside, "nested", "created.txt"), "utf8"), "新文件，（：\r\n");
  assert.equal(await readFile(target, "utf8"), "空间外改写\r\n");
  assert.equal(await readFile(unread, "utf8"), "没读过的内容");
  assert.deepEqual(approvals(f.confirmations), [path.join(f.outside, "nested", "created.txt"), target].sort());
  const results = toolResults(session);
  assert.deepEqual(results.map(result => [result.tool, result.isError]), [["write", false], ["edit", false], ["write", true]]);
  for (const result of results.slice(0, 2)) assert.match(result.text, /这个文件在空间外，这次改动没有进入历史，不能撤回。$/u);
  assert.match(results[2]?.text ?? "", /这次会话还没有读过它[\s\S]*没读过的内容/u);
});

test("Full Access 时写空间外的文件不问用户", async t => {
  const f = await fixture(t, { commandPolicy: () => "fullAccess" });
  const session = await f.space.create();
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: path.join(f.outside, "created.txt"), content: "直接写入" })),
    fauxAssistantMessage("已写好"),
  ]);
  await session.send("写到空间外");
  assert.equal(await readFile(path.join(f.outside, "created.txt"), "utf8"), "直接写入");
  assert.deepEqual(f.confirmations, []);
  assert.match(toolResults(session)[0]?.text ?? "", /不能撤回/u);
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
  for (const result of results.slice(1, 3)) assert.match(result.text, /不能写入空间的 \.repa\//u);
  assert.match(results[3]?.text ?? "", /空间外的参考资料/u);
  // .repa/ 一律不写，也不问用户。
  assert.deepEqual(f.confirmations, []);
});

test("通用 Agent 加载 .agents/skills 和应用 skill，不加载旧空间位置；修改 skill 记入空间历史", async t => {
  const f = await fixture(t);
  const skillFile = ".agents/skills/space-demo/SKILL.md";
  const original = "---\nname: space-demo\ndescription: 空间里的通用位置技能\n---\n保持中文标点，（：\r\n";
  await f.host.files.write(skillFile, original);
  const appFile = path.join(f.root, ".repa", "test-agent", "skills", "app-demo", "SKILL.md");
  const legacyFile = path.join(f.root, ".repa", "skills", "legacy-demo", "SKILL.md");
  await mkdir(path.dirname(appFile), { recursive: true });
  await mkdir(path.dirname(legacyFile), { recursive: true });
  await writeFile(appFile, "---\nname: app-demo\ndescription: 应用级技能\n---\n应用说明\n");
  await writeFile(legacyFile, "---\nname: legacy-demo\ndescription: 旧空间位置技能\n---\n不应加载\n");
  const baseline = (await f.host.history.list())[0];
  assert(baseline);
  const session = await f.space.create();
  let system = "";
  f.faux.setResponses([
    context => {
      system = getCurrentSystemPrompt(context.messages);
      return fauxAssistantMessage(fauxToolCall("read", { path: skillFile }));
    },
    fauxAssistantMessage(fauxToolCall("edit", { path: skillFile, edits: [{ oldText: "保持中文标点", newText: "完整保留中文标点" }] })),
    fauxAssistantMessage("技能已更新"),
  ]);
  await session.send("修改空间技能的说明");
  assert.match(system, /空间里的通用位置技能/u);
  assert.match(system, /应用级技能/u);
  assert.doesNotMatch(system, /旧空间位置技能|legacy-demo/u);
  assert.deepEqual(toolResults(session).map(result => [result.tool, result.isError]), [["read", false], ["edit", false]]);
  assert.equal(await readFile(path.join(f.root, skillFile), "utf8"), original.replace("保持中文标点", "完整保留中文标点"));
  assert.deepEqual(f.confirmations, []);
  const feed = await f.host.history.changes(baseline.id);
  assert.equal(feed.revisions.length, 1);
  assert.equal(feed.revisions[0]?.source.kind, "agent");
  assert.deepEqual(feed.revisions[0]?.changes, [{ kind: "modified", path: skillFile }]);
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

test("约 200 KB 的单行 JSON 工具结果保留首尾和全文路径，插件 Agent 可读但不能写或编辑", async t => {
  const source = JSON.stringify({ 开始: "开头标记", 正文: "中文🙂".repeat(20_000), 结束: "结尾标记" });
  let outputPath = "";
  const f = await fixture(t, {
    agents: () => [{ ...writer, tools: [...writer.tools, "large_json"] }],
    tools: () => [{ name: "large_json", description: "大结果", parameters: Type.Object({}), execute: async () => ({ text: source }) }],
  });
  const session = await f.space.create({ agent: "writer" });
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("large_json", {})),
    (context: TranscriptContext) => {
      const result = context.messages.filter(message => message.role === "toolResult").at(-1);
      assert.ok(result);
      const text = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      assert.ok(text.startsWith('{"开始":"开头标记"'));
      assert.ok(text.endsWith('"结束":"结尾标记"}'));
      assert.equal(text.includes("�"), false);
      const match = /全文在 ([^，]+)，可用 read/u.exec(text);
      assert.ok(match?.[1]);
      outputPath = match[1];
      assert.ok(outputPath.startsWith(`.repa/tool-output/${session.info().id}/`));
      return fauxAssistantMessage([
        fauxToolCall("read", { path: outputPath, offset: 1, limit: 1 }),
        fauxToolCall("write", { path: outputPath, content: "不应写入" }),
        fauxToolCall("edit", { path: outputPath, edits: [{ oldText: "开头标记", newText: "已改写" }] }),
      ]);
    },
    fauxAssistantMessage("已核对"),
  ]);
  await session.send("读取大结果并核对全文路径");
  assert.deepEqual(await readFile(path.join(f.root, outputPath)), Buffer.from(source, "utf8"));
  const results = toolResults(session);
  assert.deepEqual(results.map(result => [result.tool, result.isError]), [["large_json", false], ["read", false], ["write", true], ["edit", true]]);
  // Pi 按行读取：单行本身超限时，读到文件后报告该行大小，不返回半行。
  assert.match(results[1]?.text ?? "", /Line 1 is .* exceeds/u);
  assert.deepEqual(f.confirmations, []);
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
  const upper = path.join(f.root, ".REPA");
  const canonical = await realpath(upper).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  // 大小写不敏感时复用已有 .repa，仍然验证混合大小写的访问与目录隐藏。
  if (canonical === undefined) await mkdir(upper);
  else assert.equal(canonical, path.join(f.root, ".repa"));
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

test("通过符号链接打开空间时，Agent 文件范围、历史、会话路径和 watcher 使用同一根目录", { timeout: 30000 }, async t => {
  const f = await fixture(t, { agents: () => [writer] }, false, true);
  assert.equal(f.root, await realpath(f.inputRoot));
  assert.notEqual(f.root, f.inputRoot);
  const session = await f.space.create({ agent: "writer" });
  f.faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("write", { path: "lessons/one.md", content: "符号链接空间里的原文\r\n" }),
      fauxToolCall("read", { path: ".repa/lock" }),
      fauxToolCall("write", { path: path.join(f.outside, "escape.txt"), content: "不能越界" }),
    ]),
    fauxAssistantMessage("完成"),
  ]);
  await session.send("写第一课");
  assert.deepEqual(toolResults(session).map(result => [result.tool, result.isError]), [["write", false], ["read", true], ["write", true]]);
  assert.equal(await readFile(path.join(f.inputRoot, "lessons", "one.md"), "utf8"), "符号链接空间里的原文\r\n");
  const run = session.history().find(entry => entry.type === "run")?.data;
  assert(run !== null && typeof run === "object" && "runId" in run && typeof run.runId === "string");
  const feed = await f.host.history.changes();
  assert.deepEqual(feed.revisions.filter(revision => revision.source.kind === "agent").map(revision => ({ source: revision.source, paths: revision.changes.map(change => change.path) })), [
    { source: { kind: "agent", runId: run.runId }, paths: ["lessons/one.md"] },
  ]);
  assert.equal((await f.space.list()).some(info => info.id === session.info().id), true);
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const file = SessionManager.findById(f.root, session.info().id, f.host.sessionsDir);
  assert(file);
  assert.equal(await realpath(path.dirname(file)), path.join(f.root, ".repa", "sessions"));
  assert.equal(SessionManager.open(file, f.host.sessionsDir).getCwd(), f.root);
  const changed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待符号链接空间的 watcher 超时")), 5000);
    const stop = f.host.onRevision(revision => {
      if (revision.source.kind === "external") {
        clearTimeout(timer);
        stop();
        resolve();
      }
    });
    t.after(() => { clearTimeout(timer); stop(); });
  });
  await writeFile(path.join(f.inputRoot, "external.txt"), "经别名路径外部编辑");
  await changed;
  const watched = await f.host.history.changes();
  assert.deepEqual(watched.revisions.filter(revision => revision.source.kind === "external").flatMap(revision => revision.changes.map(change => change.path)), ["external.txt"]);
  await f.runtime.close();
  await f.host.close();
  const reopened = await openSpace(f.inputRoot, { watch: false });
  try {
    assert.equal(reopened.root, f.root);
    assert.equal(reopened.sessionsDir, f.host.sessionsDir);
    assert.deepEqual((await reopened.history.undoRun(run.runId)).restored, ["lessons/one.md"]);
    assert.equal(await reopened.files.read("external.txt"), "经别名路径外部编辑");
  } finally {
    await reopened.close();
  }
});
