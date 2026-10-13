import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAgentRuntimeForTest } from "../src/agent/runtime.js";
import type { AgentSession, AgentSpaceOptions } from "../src/agent.js";
import { RepaClient } from "../src/client.js";
import { currentRun, type AgentDefinition, type Plugin, type RunContext, type Tool } from "../src/plugin.js";
import { startServer } from "../src/protocol/server.js";
import type { AgentEvent } from "../src/schema.js";

function deferred<T = void>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

const agents: AgentDefinition[] = [
  { id: "lead", instructions: () => "你安排练习并检查答案。", tools: ["course_lookup", "read", "write"], subagents: ["checker"], direct: true },
  { id: "checker", description: "检查练习答案", instructions: () => "你只检查答案。", tools: ["course_lookup"] },
  { id: "other", instructions: () => "未被列为子 Agent。", tools: ["course_lookup"] },
  // 可以把自己列为子 Agent；失控的重入由嵌套层数上限挡住。
  { id: "loop", description: "再拆一层任务", instructions: () => "你把任务交给下一层。", tools: ["course_lookup"], subagents: ["loop"], direct: true },
];

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-subagents-"));
  const agentDir = path.join(root, ".repa", "test-agent");
  await mkdir(agentDir, { recursive: true });
  const faux = fauxProvider({ api: `sub-api-${randomUUID()}`, provider: `sub-provider-${randomUUID()}`, models: [{ id: "test", contextWindow: 16384, maxTokens: 512 }], tokensPerSecond: 0 });
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
  });
  const runs: (RunContext | undefined)[] = [];
  const courseLookup: Tool = {
    name: "course_lookup",
    description: "查询课程",
    parameters: Type.Object({ topic: Type.String() }, { additionalProperties: false }),
    execute: async () => {
      runs.push(currentRun());
      return { text: "for 循环会重复执行代码块" };
    },
  };
  const events: AgentEvent[] = [];
  const recorded: string[] = [];
  const options: AgentSpaceOptions = {
    root,
    sessionsDir: path.join(root, ".repa", "sessions"),
    instructions: () => [],
    tools: () => [courseLookup],
    views: async () => [],
    agents: () => agents,
    overrides: async () => ({ app: {}, space: {} }),
    commandPolicy: () => "ask",
    record: async (runId, action) => {
      recorded.push(runId);
      return action();
    },
    onEvent: event => events.push(event),
    confirm: async () => false,
  };
  const space = await runtime.openSpace(options);
  const lead = await space.create({ agent: "lead" });
  return { root, faux, runtime, options, space, lead, runs, events, recorded };
}

function runEntry(session: AgentSession): Record<string, unknown> {
  const entry = session.history().find(item => item.type === "run");
  assert(entry?.data !== null && typeof entry?.data === "object");
  return { ...entry.data };
}

function toolResults(session: AgentSession) {
  return session.history().filter(entry => entry.type === "tool").map(entry => {
    const data = entry.data !== null && typeof entry.data === "object" ? entry.data : {};
    return { tool: "tool" in data ? data.tool : undefined, isError: "isError" in data ? data.isError : undefined, text: entry.text ?? "" };
  });
}

function runEnds(events: AgentEvent[], sessionId: string): unknown[] {
  return events.filter(event => event.type === "runEnd" && event.sessionId === sessionId).map(event => event.data);
}

test("子 Agent 的回复作为工具结果交回父 Agent，子运行有自己的 runId 并记下父运行", async t => {
  const f = await fixture(t);
  const captures: TranscriptContext[] = [];
  f.faux.setResponses([
    context => {
      captures.push(structuredClone(context));
      return fauxAssistantMessage(fauxToolCall("subagent", { agent: "checker", task: "检查答案：for i in range(3): print(i)" }, { id: "call-check" }));
    },
    context => {
      captures.push(structuredClone(context));
      return fauxAssistantMessage(fauxToolCall("course_lookup", { topic: "循环" }));
    },
    fauxAssistantMessage("答案正确"),
    context => {
      captures.push(structuredClone(context));
      return fauxAssistantMessage("检查完成");
    },
  ]);
  await f.lead.send("帮我检查答案");
  const [leadRequest, childRequest, leadFollowUp] = captures;
  assert(leadRequest && childRequest && leadFollowUp);
  const subagent = getCurrentTools(leadRequest.messages).find(tool => tool.name === "subagent");
  assert.match(subagent?.description ?? "", /checker：检查练习答案/u);
  assert.deepEqual(getCurrentTools(childRequest.messages).map(tool => tool.name), ["course_lookup"]);
  assert.match(JSON.stringify(childRequest.messages), /检查答案：for i in range\(3\)/u);
  assert.doesNotMatch(JSON.stringify(childRequest.messages), /帮我检查答案/u);
  assert.match(JSON.stringify(leadFollowUp.messages), /答案正确/u);
  assert.deepEqual(toolResults(f.lead), [{ tool: "subagent", isError: false, text: "答案正确" }]);
  const leadRun = runEntry(f.lead).runId;
  const child = (await f.space.list()).find(info => info.agent === "checker");
  assert(child);
  const childSession = await f.space.get(child.id);
  const childRun = runEntry(childSession);
  assert.equal(typeof childRun.runId, "string");
  assert.notEqual(childRun.runId, leadRun);
  assert.deepEqual(childRun, { runId: childRun.runId, parentRunId: leadRun, parentSessionId: f.lead.info().id });
  assert.deepEqual(f.runs, [{ runId: childRun.runId, ancestorRunIds: [leadRun], sessionId: child.id, agent: "checker" }]);
  assert.deepEqual(f.events.find(event => event.type === "runStart" && event.sessionId === child.id)?.data, { parentRunId: leadRun, parentSessionId: f.lead.info().id });
  const parent = { sessionId: f.lead.info().id, runId: String(leadRun), callId: "call-check" };
  assert.deepEqual(child.parent, parent);
  assert.deepEqual(childSession.info().parent, parent);
  assert.deepEqual(f.events.find(event => event.type === "runStart" && event.sessionId === child.id)?.parent, parent);
  assert.equal(Object.hasOwn(f.lead.info(), "parent"), false);
  const details = { sessionId: child.id, runId: childRun.runId, agent: "checker" };
  const toolData = f.lead.history().find(entry => entry.type === "tool")?.data;
  assert(toolData !== null && typeof toolData === "object" && "details" in toolData);
  assert.deepEqual(toolData.details, details);
  const toolEnd = f.events.find(event => event.type === "toolEnd" && event.tool === "subagent")?.data;
  assert(toolEnd !== null && typeof toolEnd === "object" && "details" in toolEnd);
  assert.deepEqual(toolEnd.details, details);
  const fork = await childSession.fork(childSession.history().find(entry => entry.type === "user")?.id ?? "");
  assert.equal(Object.hasOwn(fork.info(), "parent"), false);
  await f.space.close();
  // 卸载 Agent 后仍能列出并只读打开旧子会话，父关联不依赖运行实例或工具结果。
  const reopened = await f.runtime.openSpace({ ...f.options, agents: () => [] });
  assert.deepEqual((await reopened.list()).find(info => info.id === child.id)?.parent, parent);
  assert.deepEqual((await reopened.get(child.id)).info().parent, parent);
  assert.equal(Object.hasOwn((await reopened.get(fork.info().id)).info(), "parent"), false);
  // 父运行没有命令行，不整次进 record；子运行也不进。
  assert.deepEqual(f.recorded, []);
});

test("子 Agent 只能起定义里列出的那些，没列出的请求作为工具错误交回", async t => {
  const f = await fixture(t);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("subagent", { agent: "other", task: "未列出的子 Agent" })),
    fauxAssistantMessage("没有启动"),
  ]);
  await f.lead.send("试着启动子 Agent");
  assert.deepEqual(toolResults(f.lead).map(result => [result.tool, result.isError]), [["subagent", true]]);
  assert.equal(f.faux.state.callCount, 2);
  assert.deepEqual((await f.space.list()).map(info => info.agent), ["lead"]);
});

test("子 Agent 可以重入自己，嵌套超过默认的 3 层时启动请求作为工具错误交回，祖先链从近到远", async t => {
  const f = await fixture(t);
  const top = await f.space.create({ agent: "loop" });
  const descend = (level: number) => fauxAssistantMessage(fauxToolCall("subagent", { agent: "loop", task: `第 ${level} 层任务` }));
  f.faux.setResponses([
    descend(1),
    descend(2),
    descend(3),
    // 第 3 层的子 Agent 再读一次运行上下文，并尝试启动第 4 层。
    fauxAssistantMessage([fauxToolCall("course_lookup", { topic: "层数" }), fauxToolCall("subagent", { agent: "loop", task: "第 4 层任务" })]),
    fauxAssistantMessage("第 3 层完成"),
    fauxAssistantMessage("第 2 层完成"),
    fauxAssistantMessage("第 1 层完成"),
    fauxAssistantMessage("全部完成"),
  ]);
  await top.send("开始拆分");
  assert.equal(f.faux.state.callCount, 8);
  const sessions = (await f.space.list()).filter(info => info.agent === "loop");
  assert.equal(sessions.length, 4);
  // 按运行记录里的父运行串起四层：第 0 层是直接对话的会话。
  const runs = new Map<string, { runId: unknown; parentRunId: unknown; session: AgentSession }>();
  for (const info of sessions) {
    const session = await f.space.get(info.id);
    const entry = runEntry(session);
    runs.set(String(entry.runId), { runId: entry.runId, parentRunId: entry.parentRunId, session });
  }
  const chain: string[] = [];
  let current = [...runs.values()].find(run => run.parentRunId === undefined);
  while (current) {
    chain.push(String(current.runId));
    const parent = String(current.runId);
    current = [...runs.values()].find(run => run.parentRunId === parent);
  }
  assert.equal(chain.length, 4);
  const deepest = runs.get(chain[3] ?? "");
  assert(deepest);
  assert.deepEqual(f.runs, [{ runId: chain[3], ancestorRunIds: [chain[2], chain[1], chain[0]], sessionId: deepest.session.info().id, agent: "loop" }]);
  const results = toolResults(deepest.session);
  assert.deepEqual(results.map(result => [result.tool, result.isError]), [["course_lookup", false], ["subagent", true]]);
  assert.match(results[1]?.text ?? "", /子 Agent 最多嵌套 3 层/u);
  assert.equal(top.history().findLast(entry => entry.type === "assistant")?.text, "全部完成");
});

test("取消父运行会连带取消正在进行的子运行，取消完成时子运行已经结束", async t => {
  const f = await fixture(t);
  const childStarted = deferred();
  const childAborted = deferred();
  const releaseChild = deferred();
  t.after(() => releaseChild.resolve());
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("subagent", { agent: "checker", task: "慢慢检查" })),
    async (_context, options) => {
      childStarted.resolve();
      await new Promise<void>(resolve => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      childAborted.resolve();
      await releaseChild.promise;
      return fauxAssistantMessage(fauxToolCall("course_lookup", { topic: "不应执行" }));
    },
  ]);
  const running = f.lead.send("开始检查").then(() => "resolved", (error: unknown) => error !== null && typeof error === "object" && "code" in error ? error.code : "failed");
  await childStarted.promise;
  const child = (await f.space.list()).find(info => info.agent === "checker");
  assert(child);
  assert.equal(runEntry(await f.space.get(child.id)).parentRunId, runEntry(f.lead).runId);
  const call = f.events.find(event => event.type === "toolStart" && event.tool === "subagent")?.data;
  assert(call !== null && typeof call === "object" && "callId" in call);
  assert.deepEqual(child.parent, { sessionId: f.lead.info().id, runId: runEntry(f.lead).runId, callId: call.callId });
  assert.deepEqual(f.events.find(event => event.type === "runStart" && event.sessionId === child.id)?.parent, child.parent);
  assert.equal(f.events.some(event => event.type === "toolEnd" && event.tool === "subagent"), false);

  let cancelled = false;
  const cancelling = f.lead.abort().then(() => { cancelled = true; });
  await childAborted.promise;
  assert.equal(cancelled, false);
  releaseChild.resolve();
  await cancelling;
  assert.deepEqual(runEnds(f.events, child.id), [{ status: "aborted" }]);
  assert.match(String(await running), /resolved|cancelled/u);
  assert.deepEqual(runEnds(f.events, f.lead.info().id), [{ status: "aborted" }]);
  assert.deepEqual(f.runs, []);
  assert.equal(f.faux.state.callCount, 2);
});

test("空间关闭等待子运行结束后才完成", async t => {
  const f = await fixture(t);
  const childStarted = deferred();
  const childAborted = deferred();
  const releaseChild = deferred();
  t.after(() => releaseChild.resolve());
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("subagent", { agent: "checker", task: "慢慢检查" })),
    async (_context, options) => {
      childStarted.resolve();
      await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      childAborted.resolve();
      await releaseChild.promise;
      return fauxAssistantMessage("不应完成");
    },
  ]);
  const running = f.lead.send("开始检查").catch(() => undefined);
  await childStarted.promise;
  const child = (await f.space.list()).find(info => info.agent === "checker");
  assert(child);
  let closed = false;
  const closing = f.space.close().then(() => { closed = true; });
  await childAborted.promise;
  assert.equal(closed, false);
  assert.deepEqual(runEnds(f.events, child.id), []);
  releaseChild.resolve();
  await closing;
  await running;
  assert.deepEqual(runEnds(f.events, child.id), [{ status: "aborted" }]);
});

test("通用 Agent 能起空间里定义的任何插件 Agent，子会话只带插件定义的工具", async t => {
  const f = await fixture(t);
  const top = await f.space.create();
  const captures: TranscriptContext[] = [];
  f.faux.setResponses([
    context => {
      captures.push(structuredClone(context));
      return fauxAssistantMessage(fauxToolCall("subagent", { agent: "checker", task: "检查答案：print(1)" }));
    },
    context => {
      captures.push(structuredClone(context));
      return fauxAssistantMessage("答案正确");
    },
    fauxAssistantMessage("检查完成"),
  ]);
  await top.send("请检查答案");
  const [parent, child] = captures;
  assert(parent && child);
  const subagent = getCurrentTools(parent.messages).find(tool => tool.name === "subagent");
  // 自己排在最前，插件 Agent 按 id 排序；没被别的 Agent 列为子 Agent、不能直接对话的也在其中。
  assert.deepEqual([...(subagent?.description ?? "").matchAll(/^- ([a-z-]+)/gmu)].map(match => match[1]), ["general", "checker", "lead", "loop", "other"]);
  assert.match(subagent?.description ?? "", /general：通用 Agent，工具与你相同/u);
  assert.deepEqual(getCurrentTools(child.messages).map(tool => tool.name), ["course_lookup"]);
  assert.deepEqual(toolResults(top), [{ tool: "subagent", isError: false, text: "答案正确" }]);
});

test("通用 Agent 可以层层起通用子 Agent，嵌套超过默认的 3 层时启动请求作为工具错误交回", async t => {
  const f = await fixture(t);
  const top = await f.space.create();
  const descend = (level: number) => fauxAssistantMessage(fauxToolCall("subagent", { agent: "general", task: `第 ${level} 层任务` }));
  f.faux.setResponses([
    descend(1),
    descend(2),
    descend(3),
    descend(4),
    fauxAssistantMessage("第 3 层完成"),
    fauxAssistantMessage("第 2 层完成"),
    fauxAssistantMessage("第 1 层完成"),
    fauxAssistantMessage("全部完成"),
  ]);
  await top.send("开始拆分");
  assert.equal(f.faux.state.callCount, 8);
  const sessions = (await f.space.list()).filter(info => info.agent === "general");
  assert.equal(sessions.length, 4);
  const rejected: { tool: unknown; isError: unknown; text: string }[] = [];
  for (const info of sessions) rejected.push(...toolResults(await f.space.get(info.id)).filter(result => result.isError === true));
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.tool, "subagent");
  assert.match(rejected[0]?.text ?? "", /子 Agent 最多嵌套 3 层/u);
  assert.equal(top.history().findLast(entry => entry.type === "assistant")?.text, "全部完成");
});

async function courseServer(t: TestContext, agents: AgentDefinition[]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-subagents-e2e-"));
  const root = path.join(directory, "space");
  const home = path.join(directory, "home");
  await mkdir(root);
  await mkdir(path.join(home, "agent"), { recursive: true });
  const faux = fauxProvider({ api: `sub-e2e-${randomUUID()}`, provider: `sub-e2e-${randomUUID()}`, models: [{ id: "scripted", contextWindow: 16384, maxTokens: 256 }], tokensPerSecond: 0 });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(home, "agent", "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const runtime = await createAgentRuntimeForTest({
    agentDir: path.join(home, "agent"),
    modelRuntime,
    defaultModel: { provider: faux.getModel().provider, id: "scripted" },
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
  });
  const plugin: Plugin = { id: "course", open: async () => ({ agents: () => agents }) };
  const server = await startServer({ home, plugins: [plugin], runtime });
  const client = await RepaClient.connect(server.connection);
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  await client.call("space.open", { root });
  const runOf = async (sessionId: string) => {
    const run = (await client.call("session.history", { sessionId })).find(entry => entry.type === "run")?.data;
    assert(run !== null && typeof run === "object" && "runId" in run && typeof run.runId === "string");
    return { runId: run.runId, parentRunId: "parentRunId" in run ? run.parentRunId : undefined };
  };
  return { root, client, faux, runOf, connection: server.connection };
}

test("子 Agent 的写入记在自己的运行下并挂在父运行下，按父运行撤回时一起撤回", { timeout: 30000 }, async t => {
  const f = await courseServer(t, [
    { id: "lead", instructions: () => "你安排课程编写。", tools: ["read", "write"], subagents: ["drafter"], direct: true },
    { id: "drafter", description: "起草课程文件", instructions: () => "你起草课程文件。", tools: ["write"] },
  ]);
  const before = await f.client.call("history.list", {});
  const session = await f.client.call("session.create", { agent: "lead" });
  f.faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("write", { path: "lessons/index.md", content: "目录：第一课\n" }),
      fauxToolCall("subagent", { agent: "drafter", task: "写第一课到 lessons/one.md" }),
    ]),
    fauxAssistantMessage(fauxToolCall("write", { path: "lessons/one.md", content: "第一课：变量\r\n" })),
    fauxAssistantMessage("写好了"),
    fauxAssistantMessage("课程已安排"),
  ]);
  await f.client.call("session.send", { sessionId: session.id, text: "安排第一课" });
  const lead = await f.runOf(session.id);
  const drafter = (await f.client.call("session.list", {})).find(info => info.agent === "drafter");
  assert(drafter);
  const child = await f.runOf(drafter.id);
  assert.equal(child.parentRunId, lead.runId);
  const after = await f.client.call("history.list", {});
  // 父运行和子运行各自按路径提交，子运行的来源带着祖先链。
  assert.deepEqual(after.slice(0, after.length - before.length).map(revision => revision.source).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [
    { kind: "agent", runId: child.runId, ancestorRunIds: [lead.runId] },
    { kind: "agent", runId: lead.runId },
  ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  const undone = await f.client.call("history.undoRun", { runId: lead.runId });
  assert.deepEqual([undone.restored.sort(), undone.conflicts], [["lessons/index.md", "lessons/one.md"], []]);
  await assert.rejects(readFile(path.join(f.root, "lessons", "one.md")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(f.root, "lessons", "index.md")), { code: "ENOENT" });
});

test("带命令行的父运行窗口里，子 Agent 直接写文件，算在父运行的快照里，不会互相等待", { timeout: 30000 }, async t => {
  const f = await courseServer(t, [
    { id: "lead", instructions: () => "你安排课程编写。", tools: ["bash", "read", "write"], subagents: ["drafter"], direct: true },
    { id: "drafter", description: "起草课程文件", instructions: () => "你起草课程文件。", tools: ["write"] },
  ]);
  const before = await f.client.call("history.list", {});
  const session = await f.client.call("session.create", { agent: "lead" });
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("subagent", { agent: "drafter", task: "写第一课到 lessons/one.md" })),
    fauxAssistantMessage(fauxToolCall("write", { path: "lessons/one.md", content: "第一课：变量\r\n" })),
    fauxAssistantMessage("写好了"),
    fauxAssistantMessage("课程已安排"),
  ]);
  await f.client.call("session.send", { sessionId: session.id, text: "安排第一课" });
  assert.equal(await readFile(path.join(f.root, "lessons", "one.md"), "utf8"), "第一课：变量\r\n");
  const lead = await f.runOf(session.id);
  const after = await f.client.call("history.list", {});
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(after[0]?.source, { kind: "agent", runId: lead.runId });
  const drafter = (await f.client.call("session.list", {})).find(info => info.agent === "drafter");
  assert(drafter);
  assert.equal((await f.runOf(drafter.id)).parentRunId, lead.runId);
});

test("通用 Agent 在一条回复里起两个通用子 Agent，两个同时运行，工具与父 Agent 相同，写入算在父运行的快照里", { timeout: 30000 }, async t => {
  const f = await courseServer(t, [{ id: "drafter", description: "起草课程文件", instructions: () => "你起草课程文件。", tools: ["write"] }]);
  const before = await f.client.call("history.list", {});
  const session = await f.client.call("session.create", {});
  let parentTools: string[] = [];
  const childTools: string[][] = [];
  let active = 0;
  let peak = 0;
  let arrivals = 0;
  const bothArrived = deferred();
  // 两个子 Agent 的第一次请求都等对方也到了才回答。依次运行时第二个到不了，等两秒后照常回答，peak 停在 1。
  const child = async (context: TranscriptContext) => {
    childTools.push(getCurrentTools(context.messages).map(tool => tool.name));
    active++;
    peak = Math.max(peak, active);
    arrivals++;
    if (arrivals === 2) bothArrived.resolve();
    await Promise.race([bothArrived.promise, new Promise(resolve => setTimeout(resolve, 2000))]);
    active--;
    const name = JSON.stringify(context.messages).includes("写 a.md") ? "a.md" : "b.md";
    return fauxAssistantMessage(fauxToolCall("write", { path: name, content: `${name} 的内容\n` }));
  };
  f.faux.setResponses([
    context => {
      parentTools = getCurrentTools(context.messages).map(tool => tool.name);
      return fauxAssistantMessage([
        fauxToolCall("subagent", { agent: "general", task: "写 a.md" }),
        fauxToolCall("subagent", { agent: "general", task: "写 b.md" }),
      ]);
    },
    child,
    child,
    fauxAssistantMessage("写好了"),
    fauxAssistantMessage("写好了"),
    fauxAssistantMessage("两份都写好了"),
  ]);
  await f.client.call("session.send", { sessionId: session.id, text: "同时写两份文件" });
  assert.equal(peak, 2);
  assert.ok(parentTools.includes("bash") && parentTools.includes("subagent"));
  assert.deepEqual(childTools, [parentTools, parentTools]);
  assert.equal(await readFile(path.join(f.root, "a.md"), "utf8"), "a.md 的内容\n");
  assert.equal(await readFile(path.join(f.root, "b.md"), "utf8"), "b.md 的内容\n");
  const parent = await f.runOf(session.id);
  const children = (await f.client.call("session.list", {})).filter(info => info.agent === "general" && info.id !== session.id);
  assert.equal(children.length, 2);
  for (const info of children) assert.equal((await f.runOf(info.id)).parentRunId, parent.runId);
  // 父运行带命令行，整次进 record；两个子 Agent 在它的窗口里直接写，只有一条记到父运行名下的修订。
  const after = await f.client.call("history.list", {});
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(after[0]?.source, { kind: "agent", runId: parent.runId });
  const latest = before[0];
  assert(latest);
  const feed = await f.client.call("history.changes", { since: latest.id });
  assert.deepEqual(feed.revisions.flatMap(revision => revision.changes.map(change => change.path)).sort(), ["a.md", "b.md"]);
});

test("通用子 Agent 运行命令时，确认照旧发给发起这次运行的连接", { timeout: 30000 }, async t => {
  const f = await courseServer(t, []);
  const watcher = await RepaClient.connect(f.connection);
  t.after(() => watcher.close());
  const seenByWatcher: unknown[] = [];
  watcher.on("confirm.request", request => seenByWatcher.push(request));
  const asked = new Promise<{ id: string; request: { kind: string; message?: string } }>(resolve => f.client.on("confirm.request", resolve));
  const session = await f.client.call("session.create", {});
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("subagent", { agent: "general", task: "运行命令" })),
    fauxAssistantMessage(fauxToolCall("bash", { command: "printf child > child.txt" })),
    fauxAssistantMessage("命令完成"),
    fauxAssistantMessage("子 Agent 完成"),
  ]);
  const running = f.client.call("session.send", { sessionId: session.id, text: "让子 Agent 运行命令" });
  const { id, request } = await asked;
  assert.equal(request.kind, "command");
  assert.match(request.message ?? "", /printf child/u);
  await f.client.call("confirm.reply", { id, value: true });
  await running;
  assert.equal(await readFile(path.join(f.root, "child.txt"), "utf8"), "child");
  assert.deepEqual(seenByWatcher, []);
});
