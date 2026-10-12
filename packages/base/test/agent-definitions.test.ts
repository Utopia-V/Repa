import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAgentRuntimeForTest } from "../src/agent/runtime.js";
import type { AgentSession, AgentSpaceOptions } from "../src/agent.js";
import { RepaClient, RpcError } from "../src/client.js";
import type { AgentDefinition, Plugin, Tool } from "../src/plugin.js";
import { record } from "../src/protocol/json-rpc.js";
import { startServer, type ServerOptions } from "../src/protocol/server.js";

const courseLookup: Tool = {
  name: "course_lookup",
  description: "查询课程",
  parameters: Type.Object({ topic: Type.String() }, { additionalProperties: false }),
  execute: async () => ({ text: "课程：for 循环" }),
};
const runCode: Tool = {
  name: "run_code",
  description: "在沙箱里运行代码",
  parameters: Type.Object({ code: Type.String() }, { additionalProperties: false }),
  execute: async () => ({ text: "输出：3" }),
};
const tutor: AgentDefinition = {
  id: "tutor",
  description: "陪学习者练习 Python",
  instructions: () => "你是 Python 辅导老师，只用学习工具帮助学习者。",
  tools: ["course_lookup", "read"],
  direct: true,
  view: async () => "当前课题：for 循环",
};

async function runtimeFixture(t: TestContext, extra: Partial<AgentSpaceOptions> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-agent-defs-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "repa-agent-defs-outside-"));
  const agentDir = path.join(root, "app", "agent");
  const sessionsDir = path.join(root, ".repa", "sessions");
  await mkdir(agentDir, { recursive: true });
  const faux = fauxProvider({ api: `defs-api-${randomUUID()}`, provider: `defs-provider-${randomUUID()}`, models: [{ id: "test", contextWindow: 16384, maxTokens: 512 }], tokensPerSecond: 0 });
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
  const confirmations: unknown[] = [];
  const options: AgentSpaceOptions = {
    root,
    sessionsDir,
    instructions: () => [{ id: "plugin:course", text: "课程插件说明" }],
    tools: () => [courseLookup, runCode],
    views: async () => [{ id: "plugin:course", text: "课程状态" }],
    agents: () => [tutor],
    overrides: async () => ({ app: {}, space: {} }),
    commandPolicy: () => "ask",
    record: async (_id, action) => action(),
    onEvent: () => undefined,
    confirm: async request => {
      confirmations.push(request);
      return false;
    },
    ...extra,
  };
  const space = await runtime.openSpace(options);
  const captures: TranscriptContext[] = [];
  const respond = (...replies: Parameters<typeof fauxAssistantMessage>[0][]) => {
    faux.setResponses(replies.map((reply, index) => (context: TranscriptContext) => {
      if (index === 0) captures.push(structuredClone(context));
      return fauxAssistantMessage(reply);
    }));
  };
  return { root, outside, sessionsDir, faux, runtime, options, space, captures, confirmations, respond };
}

function toolResults(session: AgentSession) {
  return session.history().filter(entry => entry.type === "tool").map(entry => {
    const data = entry.data !== null && typeof entry.data === "object" ? entry.data : {};
    return { tool: "tool" in data ? data.tool : undefined, isError: "isError" in data ? data.isError : undefined, text: entry.text ?? "" };
  });
}

function viewTexts(context: TranscriptContext): string[] {
  return context.messages.flatMap(message => {
    const text = JSON.stringify(message.content);
    return text.includes("<repa-view") ? [text] : [];
  });
}

// 固定样本由改动前的 04b0671d0 在 Pi 1.1.0 上生成：同一组插件说明、工具、view 与空间 AGENTS.md 下，
// 通用会话首个模型请求的系统段、工具声明和消息。去掉时间戳，把空间路径替换为 <root>。
// 加入 ask_user 时重新生成，与原样本相比只在工具声明末尾多了 ask_user，工具段的清单末尾多了“、ask_user”。
// 通用 Agent 能起子 Agent 后再次生成：工具声明在 ask_user 之前多了 subagent，可以起 general 和插件声明的 tutor；
// 工具段的清单相应多了“、subagent”。其余系统段、工具和消息与上一份相同。
test("通用 Agent 的首个请求与固定样本逐字相同，插件声明的 Agent 只出现在 subagent 工具里", async t => {
  const f = await runtimeFixture(t, { tools: () => [courseLookup] });
  await writeFile(path.join(f.root, "AGENTS.md"), "空间说明：保持中文回答。");
  const session = await f.space.create();
  assert.equal(session.info().agent, "general");
  f.respond("回答");
  await session.send("你好");
  const actual: unknown = JSON.parse(JSON.stringify(f.captures[0]?.messages, (key, value: unknown) => key === "timestamp" ? undefined : value).replaceAll(f.root, "<root>"));
  const expected: unknown = JSON.parse(await readFile(new URL("fixtures/general-agent-request.json", import.meta.url), "utf8"));
  assert.deepEqual(actual, expected);
});

test("辅导 Agent 的会话只声明定义中的工具，调用 bash、write 和读空间外或 .repa 的文件都被拒绝", async t => {
  const f = await runtimeFixture(t);
  await writeFile(path.join(f.root, "lesson.md"), "第一课：for 循环");
  await writeFile(path.join(f.root, ".repa", "private.txt"), "学习记录");
  const outsideFile = path.join(f.outside, "secret.txt");
  await writeFile(outsideFile, "空间外的文件");
  const session = await f.space.create({ agent: "tutor" });
  assert.equal(session.info().agent, "tutor");
  f.respond([
    fauxToolCall("bash", { command: "printf done > bash-effect.txt" }),
    fauxToolCall("write", { path: "write-effect.txt", content: "不应写入" }),
    fauxToolCall("read", { path: outsideFile }),
    fauxToolCall("read", { path: ".repa/private.txt" }),
    fauxToolCall("read", { path: "lesson.md" }),
    fauxToolCall("course_lookup", { topic: "循环" }),
  ], "已处理");
  await session.send("开始练习");
  const request = f.captures[0];
  assert(request);
  assert.deepEqual(getCurrentTools(request.messages).map(tool => tool.name), ["read", "course_lookup"]);
  const system = getCurrentSystemPrompt(request.messages);
  assert.match(system, /你是 Python 辅导老师/u);
  assert.match(system, /当前空间：/u);
  assert.doesNotMatch(system, /你是 Repa 中帮助用户|课程插件说明|可用工具/u);
  assert.deepEqual(viewTexts(request).length, 1);
  assert.match(viewTexts(request)[0] ?? "", /agent:tutor.*当前课题：for 循环/u);
  const results = toolResults(session);
  assert.deepEqual(results.map(result => [result.tool, result.isError]), [
    ["bash", true], ["write", true], ["read", true], ["read", true], ["read", false], ["course_lookup", false],
  ]);
  assert.match(results[0]?.text ?? "", /Tool bash not found/u);
  assert.match(results[1]?.text ?? "", /Tool write not found/u);
  assert.match(results[2]?.text ?? "", /只能访问当前空间内的文件，不含 \.repa\//u);
  assert.match(results[3]?.text ?? "", /只能访问当前空间内的文件，不含 \.repa\//u);
  assert.match(results[4]?.text ?? "", /第一课：for 循环/u);
  await assert.rejects(readFile(path.join(f.root, "bash-effect.txt")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(f.root, "write-effect.txt")), { code: "ENOENT" });
  assert.deepEqual(f.confirmations, []);
});

test("插件 Agent 的会话在重开和分支后仍属于原 Agent，没有记录的旧会话属于通用 Agent", async t => {
  const f = await runtimeFixture(t);
  const session = await f.space.create({ agent: "tutor" });
  f.respond("第一轮");
  await session.send("问题一");
  const legacy = SessionManager.create(f.root, f.sessionsDir);
  legacy.appendMessage({ role: "user", content: [{ type: "text", text: "旧会话" }], timestamp: Date.now() });
  await f.space.close();
  const reopened = await f.runtime.openSpace(f.options);
  const same = await reopened.get(session.info().id);
  assert.equal(same.info().agent, "tutor");
  f.respond("第二轮");
  await same.send("问题二");
  assert.deepEqual(getCurrentTools(f.captures.at(-1)?.messages ?? []).map(tool => tool.name), ["read", "course_lookup"]);
  const first = same.history().find(entry => entry.type === "user");
  assert(first);
  const fork = await same.fork(first.id);
  assert.equal(fork.info().agent, "tutor");
  const listed = await reopened.list();
  assert.deepEqual(listed.find(info => info.id === legacy.getSessionId())?.agent, "general");
  assert.deepEqual(listed.filter(info => info.agent === "tutor").map(info => info.id).sort(), [session.info().id, fork.info().id].sort());
  assert.equal((await reopened.get(legacy.getSessionId())).info().agent, "general");
});

async function protocolFixture(t: TestContext, plugin: Plugin, options: Pick<ServerOptions, "generalAgent" | "directAgents"> = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-agent-defs-protocol-"));
  const root = path.join(directory, "space");
  const home = path.join(directory, "home");
  await mkdir(root);
  await mkdir(path.join(home, "agent"), { recursive: true });
  const faux = fauxProvider({ api: `defs-e2e-${randomUUID()}`, provider: `defs-e2e-${randomUUID()}`, models: [{ id: "scripted", contextWindow: 16384, maxTokens: 256 }], tokensPerSecond: 0 });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(home, "agent", "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const runtime = await createAgentRuntimeForTest({
    agentDir: path.join(home, "agent"),
    modelRuntime,
    defaultModel: { provider: faux.getModel().provider, id: "scripted" },
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
  });
  const server = await startServer({ home, plugins: [plugin], runtime, ...options });
  const client = await RepaClient.connect(server.connection);
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  await client.call("space.open", { root });
  return { root, client, faux };
}

const rejectsWith = (code: string) => (error: unknown): boolean => {
  assert.ok(error instanceof RpcError);
  assert.equal(record(error.data)?.code, code);
  return true;
};

function learningPlugin(): Plugin {
  return {
    id: "learning",
    async open(host) {
      return {
        tools: () => [courseLookup, runCode],
        agents: () => [tutor, {
          id: "writer",
          description: "在后台编写课程文件",
          instructions: () => "你在后台编写课程文件。",
          tools: ["read", "write", "edit", "ls"],
        }],
        methods: {
          write: {
            parameters: Type.Object({}, { additionalProperties: false }),
            async invoke() {
              const work = await host.models.runAgent({ agent: "writer", text: "编写第二课" });
              await work.result;
              return { id: work.id };
            },
          },
        },
      };
    },
  };
}

test("关掉通用 Agent 后前端建不了通用会话，只能与可直接对话的插件 Agent 建会话", { timeout: 30000 }, async t => {
  const f = await protocolFixture(t, learningPlugin(), { generalAgent: false });
  assert.deepEqual(await f.client.call("agent.list", {}), [
    { id: "tutor", description: "陪学习者练习 Python", direct: true },
    { id: "writer", description: "在后台编写课程文件", direct: false },
  ]);
  await assert.rejects(f.client.call("session.create", {}), rejectsWith("agent_not_found"));
  await assert.rejects(f.client.call("session.create", { agent: "general" }), rejectsWith("agent_not_found"));
  await assert.rejects(f.client.call("session.create", { agent: "writer" }), rejectsWith("agent_not_direct"));
  await assert.rejects(f.client.call("prompt.preview", {}), rejectsWith("agent_not_found"));
  const session = await f.client.call("session.create", { agent: "tutor" });
  assert.equal(session.agent, "tutor");
  assert.deepEqual((await f.client.call("session.list", {})).map(info => [info.id, info.agent]), [[session.id, "tutor"]]);
  const preview = await f.client.call("prompt.preview", { agent: "tutor" });
  assert.deepEqual(preview.sections.map(section => section.id), ["space", "agent:tutor"]);
  assert.deepEqual(preview.views, [{ id: "agent:tutor", text: "当前课题：for 循环" }]);
  f.faux.setResponses([fauxAssistantMessage("你好，我们从循环开始。")]);
  await f.client.call("session.send", { sessionId: session.id, text: "你好" });
  assert.equal((await f.client.call("session.history", { sessionId: session.id })).findLast(entry => entry.type === "assistant")?.text, "你好，我们从循环开始。");
});

test("插件在后台运行不可直接对话的 Agent，前端能查看会话但不能向它发消息", { timeout: 30000 }, async t => {
  const f = await protocolFixture(t, learningPlugin());
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "lessons/second.md", content: "第二课" })),
    fauxAssistantMessage("第二课已写好"),
  ]);
  const { id } = record(await f.client.call("plugin.call", { pluginId: "learning", method: "write", input: {} })) ?? {};
  assert.equal(typeof id, "string");
  const sessionId = String(id);
  assert.equal(await readFile(path.join(f.root, "lessons", "second.md"), "utf8"), "第二课");
  const info = (await f.client.call("session.list", {})).find(item => item.id === sessionId);
  assert.equal(info?.agent, "writer");
  assert.equal((await f.client.call("session.history", { sessionId })).findLast(entry => entry.type === "assistant")?.text, "第二课已写好");
  await assert.rejects(f.client.call("session.send", { sessionId, text: "再写一课" }), rejectsWith("agent_not_direct"));
  await assert.rejects(f.client.call("session.followUp", { sessionId, text: "再写一课" }), rejectsWith("agent_not_direct"));
  const general = await f.client.call("session.create", {});
  assert.equal(general.agent, "general");
});

test("装配指定的直接对话 Agent 覆盖定义：通用 Agent 不在其中时也不能直接建会话", { timeout: 30000 }, async t => {
  const f = await protocolFixture(t, learningPlugin(), { directAgents: ["writer"] });
  assert.deepEqual((await f.client.call("agent.list", {})).map(agent => [agent.id, agent.direct]), [["general", false], ["tutor", false], ["writer", true]]);
  await assert.rejects(f.client.call("session.create", {}), rejectsWith("agent_not_direct"));
  await assert.rejects(f.client.call("session.create", { agent: "tutor" }), rejectsWith("agent_not_direct"));
  assert.equal((await f.client.call("session.create", { agent: "writer" })).agent, "writer");
});

test("装配指定的直接对话 Agent 写错 id 时打开空间失败，而不是让所有 Agent 都不能对话", { timeout: 30000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-agent-defs-typo-"));
  const root = path.join(directory, "space");
  await mkdir(root);
  const server = await startServer({ home: path.join(directory, "home"), plugins: [learningPlugin()], directAgents: ["tutr"] });
  const client = await RepaClient.connect(server.connection);
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  await assert.rejects(client.call("space.open", { root }), (error: unknown) => {
    assert.ok(error instanceof RpcError);
    assert.deepEqual(error.data, { code: "unknown_agent", details: { agent: "tutr" } });
    return true;
  });
});

test("关掉通用 Agent 以后，它的旧会话照样能列出、能读历史，只是不能再运行", { timeout: 30000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-agent-defs-dormant-"));
  const opened: { client: RepaClient; server: Awaited<ReturnType<typeof startServer>> }[] = [];
  // 先关闭服务，空间收尾时还要在目录里运行 git，之后才删除目录。
  t.after(async () => {
    for (const { client, server } of opened.reverse()) {
      await client.close();
      await server.close();
    }
    await rm(directory, { recursive: true, force: true });
  });
  const root = path.join(directory, "space");
  const home = path.join(directory, "home");
  await mkdir(root);
  await mkdir(path.join(home, "agent"), { recursive: true });
  const faux = fauxProvider({ api: `dormant-${randomUUID()}`, provider: `dormant-${randomUUID()}`, models: [{ id: "scripted", contextWindow: 16384, maxTokens: 256 }], tokensPerSecond: 0 });
  const serve = async (generalAgent: boolean) => {
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(home, "agent", "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const runtime = await createAgentRuntimeForTest({
      agentDir: path.join(home, "agent"),
      modelRuntime,
      defaultModel: { provider: faux.getModel().provider, id: "scripted" },
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
    });
    const server = await startServer({ home, plugins: [learningPlugin()], runtime, generalAgent });
    const client = await RepaClient.connect(server.connection);
    opened.push({ client, server });
    await client.call("space.open", { root });
    return { server, client };
  };
  const before = await serve(true);
  const session = await before.client.call("session.create", {});
  faux.setResponses([fauxAssistantMessage("之前的回答")]);
  await before.client.call("session.send", { sessionId: session.id, text: "之前的问题" });
  await before.client.close();
  await before.server.close();
  const after = await serve(false);
  const listed = (await after.client.call("session.list", {})).find(info => info.id === session.id);
  assert.equal(listed?.agent, "general");
  assert.deepEqual(listed?.model, { provider: faux.getModel().provider, id: "scripted" });
  const history = await after.client.call("session.history", { sessionId: session.id });
  assert.deepEqual(history.filter(entry => entry.type === "user" || entry.type === "assistant").map(entry => entry.text), ["之前的问题", "之前的回答"]);
  await assert.rejects(after.client.call("session.send", { sessionId: session.id, text: "还能继续吗" }), rejectsWith("agent_not_found"));
  await assert.rejects(after.client.call("session.compact", { sessionId: session.id }), rejectsWith("agent_not_found"));
  await after.client.call("session.abort", { sessionId: session.id });
  assert.equal(faux.state.callCount, 1);
});
