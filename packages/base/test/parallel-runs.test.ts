import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, type FauxResponseFactory, type FauxResponseStep } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAgentRuntimeForTest } from "../src/agent/runtime.js";
import type { AgentSession } from "../src/agent.js";
import { RepaClient, RpcError } from "../src/client.js";
import type { AgentDefinition, AgentWork, ChangeFeed, Plugin, Tool } from "../src/plugin.js";
import { startServer } from "../src/protocol/server.js";
import { parse, type AgentEvent } from "../src/schema.js";
import { createSpace, type SpaceWrites } from "../src/space.js";

function deferred<T = void>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

function deadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(value => {
      clearTimeout(timer);
      resolve(value);
    }, (error: unknown) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** 轮询到条件成立；超过截止时间就报错并停止轮询。 */
async function until(condition: () => boolean | Promise<boolean>, message: string, ms = 5000): Promise<void> {
  const stop = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > stop) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

type Faux = ReturnType<typeof fauxProvider>;

/** 按请求所属的 Agent 分派预设回复：并行的运行交错发出请求，不能按全局顺序排。 */
function script(faux: Faux, plan: Record<string, FauxResponseStep[]>): void {
  const total = Object.values(plan).reduce((count, steps) => count + steps.length, 0);
  const dispatch: FauxResponseFactory = async (context, options, state, model) => {
    const agent = /source="agent:([a-z0-9-]+)"/u.exec(getCurrentSystemPrompt(context.messages))?.[1] ?? "general";
    const step = plan[agent]?.shift();
    if (step === undefined) throw new Error(`没有为 ${agent} 安排回复`);
    return typeof step === "function" ? step(context, options, state, model) : step;
  };
  faux.setResponses(Array.from({ length: total }, () => dispatch));
}

const courseLookup: Tool = {
  name: "course_lookup",
  description: "查询课程",
  parameters: Type.Object({ topic: Type.String() }, { additionalProperties: false }),
  execute: async () => ({ text: "for 循环会重复执行代码块" }),
};
const tutor: AgentDefinition = { id: "tutor", description: "陪学习者练习", instructions: () => "你陪学习者练习 Python。", tools: ["course_lookup", "read"], direct: true };
const writer: AgentDefinition = { id: "writer", description: "编写课程", instructions: () => "你编写课程文件。", tools: ["read", "write", "edit"], direct: true };
const carder: AgentDefinition = { id: "carder", description: "编写卡片", instructions: () => "你编写复习卡片。", tools: ["read", "write"], direct: true };
const shell: AgentDefinition = { id: "shell", description: "用命令行整理文件", instructions: () => "你用命令行整理文件。", tools: ["bash", "read"], direct: true };

const StartSchema = Type.Object({ agent: Type.String(), text: Type.String() }, { additionalProperties: false });
const NoteSchema = Type.Object({ file: Type.String(), text: Type.String() }, { additionalProperties: false });

/**
 * 学习插件：声明 Agent，start 在后台运行一个 Agent，note 在运行之外写文件，save_progress 是供 Agent 调用的写入工具；
 * 变化处理看到新的进度文件时汇总到 progress/summary.md。
 */
function learningPlugin(agents: AgentDefinition[]) {
  const works: AgentWork[] = [];
  const plugin: Plugin = {
    id: "learning",
    async open(host) {
      let cursor: string | undefined;
      const saveProgress: Tool = {
        name: "save_progress",
        description: "记下练习进度",
        parameters: NoteSchema,
        async execute(input) {
          const { file, text } = parse(NoteSchema, input);
          await host.files.write(file, text);
          return { text: "进度已记下" };
        },
      };
      return {
        tools: () => [courseLookup, saveProgress],
        agents: () => agents,
        async onChange() {
          const feed = await host.history.changes(cursor);
          cursor = feed.revision;
          const progress = feed.revisions.flatMap(revision => revision.changes.map(change => change.path))
            .filter(file => file.startsWith("progress/") && file !== "progress/summary.md");
          if (progress.length > 0) await host.files.write("progress/summary.md", `已记录：${progress.join("、")}\n`);
        },
        methods: {
          start: {
            parameters: StartSchema,
            async invoke(input) {
              const work = await host.models.runAgent(parse(StartSchema, input));
              works.push(work);
              return { id: work.id };
            },
          },
          note: {
            parameters: NoteSchema,
            async invoke(input) {
              const { file, text } = parse(NoteSchema, input);
              await host.files.write(file, text);
              return null;
            },
          },
        },
      };
    },
  };
  return { plugin, works };
}

async function serve(t: TestContext, agents: AgentDefinition[]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-parallel-"));
  const root = path.join(directory, "space");
  const home = path.join(directory, "home");
  await mkdir(root);
  await mkdir(path.join(home, "agent"), { recursive: true });
  const faux = fauxProvider({ api: `parallel-${randomUUID()}`, provider: `parallel-${randomUUID()}`, models: [{ id: "scripted", contextWindow: 16384, maxTokens: 256 }], tokensPerSecond: 0 });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(home, "agent", "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const runtime = await createAgentRuntimeForTest({
    agentDir: path.join(home, "agent"),
    modelRuntime,
    defaultModel: { provider: faux.getModel().provider, id: "scripted" },
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
  });
  const learning = learningPlugin(agents);
  const server = await startServer({ home, plugins: [learning.plugin], runtime });
  const client = await RepaClient.connect(server.connection);
  const events: AgentEvent[] = [];
  client.on("session.event", event => events.push(event));
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  await client.call("space.open", { root });
  return { root, client, faux, events, works: learning.works };
}

type Served = Awaited<ReturnType<typeof serve>>;

function runOf(events: AgentEvent[], sessionId: string): string {
  const runId = events.find(event => event.type === "runStart" && event.sessionId === sessionId)?.runId;
  assert(runId !== undefined, `会话 ${sessionId} 没有开始运行`);
  return runId;
}

function ended(events: AgentEvent[], sessionId: string): boolean {
  return events.some(event => event.type === "runEnd" && event.sessionId === sessionId);
}

async function reply(f: Served, sessionId: string): Promise<string | undefined> {
  return (await f.client.call("session.history", { sessionId })).findLast(entry => entry.type === "assistant")?.text;
}

/** 历史中每个 Agent 提交的运行与改动路径，按时间顺序。 */
function commits(feed: ChangeFeed) {
  return feed.revisions.flatMap(revision => revision.source.kind === "agent" || revision.source.kind === "plugin"
    ? [{ source: revision.source, paths: revision.changes.map(change => change.path).sort() }]
    : []);
}

async function startWork(f: Served, agent: string, text: string): Promise<string> {
  const result: unknown = await deadline(f.client.call("plugin.call", { pluginId: "learning", method: "start", input: { agent, text } }), 5000, `没能启动 ${agent}`);
  assert(result !== null && typeof result === "object" && "id" in result && typeof result.id === "string");
  return result.id;
}

test("辅导 Agent 在后台写课 Agent 运行期间立即得到回复，写课的改动记在它自己的运行下", { timeout: 30000 }, async t => {
  const writerWaiting = deferred();
  const releaseWriter = deferred();
  // 收尾钩子按登记顺序执行：先放开被拦住的回复，服务关闭时才不会等它。
  t.after(() => releaseWriter.resolve());
  const f = await serve(t, [tutor, writer]);
  script(f.faux, {
    writer: [
      fauxAssistantMessage(fauxToolCall("write", { path: "lessons/one.md", content: "第一课：变量\n" })),
      async () => {
        writerWaiting.resolve();
        await releaseWriter.promise;
        return fauxAssistantMessage("第一课写好了");
      },
    ],
    tutor: [fauxAssistantMessage("for 循环会重复执行代码块。")],
  });
  const writerSession = await startWork(f, "writer", "编写第一课");
  // 写课 Agent 已经写完第一个文件，正在等下一次模型回复，运行还没有结束。
  await writerWaiting.promise;
  const tutorSession = await f.client.call("session.create", { agent: "tutor" });
  await deadline(f.client.call("session.send", { sessionId: tutorSession.id, text: "for 循环是什么？" }), 5000, "辅导回复在等写课 Agent 结束");
  assert.equal(await reply(f, tutorSession.id), "for 循环会重复执行代码块。");
  assert.equal(ended(f.events, writerSession), false);
  releaseWriter.resolve();
  await f.works[0]?.result;
  assert.equal(await reply(f, writerSession), "第一课写好了");
  assert.equal(await readFile(path.join(f.root, "lessons", "one.md"), "utf8"), "第一课：变量\n");
  // 写入在写的时候就按路径提交，归到写课的运行；辅导的运行没有提交，按运行撤回它得到 nothing_to_undo。
  assert.deepEqual(commits(await f.client.call("history.changes", {})), [
    { source: { kind: "agent", runId: runOf(f.events, writerSession) }, paths: ["lessons/one.md"] },
  ]);
  const tutorRun = runOf(f.events, tutorSession.id);
  await assert.rejects(f.client.call("history.undoRun", { runId: tutorRun }), (error: unknown) => {
    assert.ok(error instanceof RpcError);
    assert.deepEqual(error.data, { code: "nothing_to_undo", details: { runId: tutorRun } });
    return true;
  });
});

test("两个 Agent 并行写不同文件，改动各记在自己的运行下，按运行撤回一个不影响另一个", { timeout: 30000 }, async t => {
  // 两个运行的第二次模型请求必须同时在途才能放行；运行若仍一个接一个，这里就会超时。
  const bothWaiting = deferred();
  t.after(() => bothWaiting.resolve());
  const f = await serve(t, [writer, carder]);
  let arrived = 0;
  const meet = async (text: string) => {
    if (++arrived === 2) bothWaiting.resolve();
    await bothWaiting.promise;
    return fauxAssistantMessage(text);
  };
  script(f.faux, {
    writer: [fauxAssistantMessage(fauxToolCall("write", { path: "lessons/one.md", content: "第一课：变量\n" })), () => meet("第一课写好了")],
    carder: [fauxAssistantMessage(fauxToolCall("write", { path: "cards/one.md", content: "变量是什么？\n" })), () => meet("卡片写好了")],
  });
  const lesson = await startWork(f, "writer", "编写第一课");
  const cards = await startWork(f, "carder", "编写第一课的卡片");
  await deadline(bothWaiting.promise, 5000, "两个写入的运行没有同时进行");
  await Promise.all(f.works.map(work => work.result));
  const lessonRun = runOf(f.events, lesson);
  const cardsRun = runOf(f.events, cards);
  assert.deepEqual(commits(await f.client.call("history.changes", {})).sort((a, b) => a.paths[0]?.localeCompare(b.paths[0] ?? "") ?? 0), [
    { source: { kind: "agent", runId: cardsRun }, paths: ["cards/one.md"] },
    { source: { kind: "agent", runId: lessonRun }, paths: ["lessons/one.md"] },
  ]);
  const undone = await f.client.call("history.undoRun", { runId: lessonRun });
  assert.deepEqual([undone.restored, undone.conflicts], [["lessons/one.md"], []]);
  await assert.rejects(readFile(path.join(f.root, "lessons", "one.md")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(f.root, "cards", "one.md"), "utf8"), "变量是什么？\n");
});

test("带命令行的运行期间，其他写入者等它结束，只读的照常回复", { timeout: 30000 }, async t => {
  const shellWaiting = deferred();
  const releaseShell = deferred();
  t.after(() => releaseShell.resolve());
  const f = await serve(t, [tutor, writer, shell]);
  await f.client.call("settings.set", { commandPolicy: "fullAccess" });
  script(f.faux, {
    shell: [
      fauxAssistantMessage(fauxToolCall("bash", { command: "printf '命令行写的' > shell.txt" })),
      async () => {
        shellWaiting.resolve();
        await releaseShell.promise;
        return fauxAssistantMessage("整理完了");
      },
    ],
    writer: [fauxAssistantMessage(fauxToolCall("write", { path: "lessons/one.md", content: "第一课：变量\n" })), fauxAssistantMessage("写好了")],
    tutor: [fauxAssistantMessage("只读的回答")],
  });
  const shellSession = await f.client.call("session.create", { agent: "shell" });
  const shellRun = f.client.call("session.send", { sessionId: shellSession.id, text: "整理文件" });
  await shellWaiting.promise;
  const writerSession = await f.client.call("session.create", { agent: "writer" });
  const writerRun = f.client.call("session.send", { sessionId: writerSession.id, text: "编写第一课" });
  const tutorSession = await f.client.call("session.create", { agent: "tutor" });
  await deadline(f.client.call("session.send", { sessionId: tutorSession.id, text: "提问" }), 5000, "只读的运行在等命令行运行结束");
  assert.equal(await reply(f, tutorSession.id), "只读的回答");
  // 写课 Agent 的 write 已经开始执行，但在命令行运行结束前拿不到空间写锁。
  const writeEnded = () => f.events.some(event => event.sessionId === writerSession.id && event.type === "toolEnd" && event.tool === "write");
  await until(() => f.events.some(event => event.sessionId === writerSession.id && event.type === "toolStart" && event.tool === "write"), "写课 Agent 没有开始写入");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(writeEnded(), false);
  await assert.rejects(readFile(path.join(f.root, "lessons", "one.md")), { code: "ENOENT" });
  releaseShell.resolve();
  await shellRun;
  await writerRun;
  assert.equal(writeEnded(), true);
  assert.equal(await readFile(path.join(f.root, "shell.txt"), "utf8"), "命令行写的");
  assert.equal(await readFile(path.join(f.root, "lessons", "one.md"), "utf8"), "第一课：变量\n");
  // 命令行运行的改动由前后整体快照记到它名下；写课的提交排在它之后。
  assert.deepEqual(commits(await f.client.call("history.changes", {})), [
    { source: { kind: "agent", runId: runOf(f.events, shellSession.id) }, paths: ["shell.txt"] },
    { source: { kind: "agent", runId: runOf(f.events, writerSession.id) }, paths: ["lessons/one.md"] },
  ]);
});

test("命令行运行要写的文件正被等它的写入者排着队时，两边不会互相等待", { timeout: 30000 }, async t => {
  const shellWaiting = deferred();
  const releaseShell = deferred();
  t.after(() => releaseShell.resolve());
  const f = await serve(t, [writer, { ...shell, tools: ["bash", "read", "write"] }]);
  await f.client.call("settings.set", { commandPolicy: "fullAccess" });
  script(f.faux, {
    shell: [
      async () => {
        shellWaiting.resolve();
        await releaseShell.promise;
        return fauxAssistantMessage(fauxToolCall("write", { path: "lessons/one.md", content: "命令行运行写的\n" }));
      },
      fauxAssistantMessage("整理完了"),
    ],
    writer: [fauxAssistantMessage(fauxToolCall("write", { path: "lessons/one.md", content: "写课写的\n" })), fauxAssistantMessage("知道了")],
  });
  const shellSession = await f.client.call("session.create", { agent: "shell" });
  const shellRun = f.client.call("session.send", { sessionId: shellSession.id, text: "整理文件" });
  await shellWaiting.promise;
  const writerSession = await f.client.call("session.create", { agent: "writer" });
  const writerRun = f.client.call("session.send", { sessionId: writerSession.id, text: "编写第一课" });
  await until(() => f.events.some(event => event.sessionId === writerSession.id && event.type === "toolStart" && event.tool === "write"), "写课 Agent 没有开始写入");
  // 写课 Agent 的写入在空间写锁前等着，还没有占住这个文件的写入队列，命令行运行可以写它。
  releaseShell.resolve();
  await deadline(Promise.all([shellRun, writerRun]), 5000, "命令行运行和写课 Agent 互相等待");
  assert.equal(await readFile(path.join(f.root, "lessons", "one.md"), "utf8"), "命令行运行写的\n");
  // 写课 Agent 没读过这个已经存在的文件，整份覆盖被拒，拿到的是命令行运行写的内容。
  const writes = (await f.client.call("session.history", { sessionId: writerSession.id })).filter(entry => entry.type === "tool");
  assert.match(writes[0]?.text ?? "", /没有写入：lessons\/one\.md 已经存在，这次会话还没有读过它。[^]*命令行运行写的/u);
});

test("等命令行运行结束的写入可以取消，取消不必等命令行运行结束", { timeout: 30000 }, async t => {
  const shellWaiting = deferred();
  const releaseShell = deferred();
  t.after(() => releaseShell.resolve());
  const f = await serve(t, [writer, shell]);
  await f.client.call("settings.set", { commandPolicy: "fullAccess" });
  script(f.faux, {
    shell: [async () => {
      shellWaiting.resolve();
      await releaseShell.promise;
      return fauxAssistantMessage("整理完了");
    }],
    writer: [fauxAssistantMessage(fauxToolCall("write", { path: "lessons/one.md", content: "第一课：变量\n" })), fauxAssistantMessage("不应继续")],
  });
  const shellSession = await f.client.call("session.create", { agent: "shell" });
  const shellRun = f.client.call("session.send", { sessionId: shellSession.id, text: "整理文件" });
  await shellWaiting.promise;
  const writerSession = await f.client.call("session.create", { agent: "writer" });
  const writerRun = f.client.call("session.send", { sessionId: writerSession.id, text: "编写第一课" }).catch(() => undefined);
  await until(() => f.events.some(event => event.sessionId === writerSession.id && event.type === "toolStart" && event.tool === "write"), "写课 Agent 没有开始写入");
  await deadline(f.client.call("session.abort", { sessionId: writerSession.id }), 5000, "取消在等命令行运行结束");
  await writerRun;
  assert.equal(ended(f.events, shellSession.id), false);
  releaseShell.resolve();
  await shellRun;
  await assert.rejects(readFile(path.join(f.root, "lessons", "one.md")), { code: "ENOENT" });
  assert.deepEqual(f.events.filter(event => event.sessionId === writerSession.id && event.type === "runEnd").map(event => event.data), [{ status: "aborted" }]);
});

test("插件在运行之外的写入记在插件名下，Agent 调用插件工具写的记在这次运行名下，由此触发的变化处理仍记在插件名下", { timeout: 30000 }, async t => {
  const f = await serve(t, [{ ...tutor, tools: ["course_lookup", "save_progress"] }]);
  await f.client.call("plugin.call", { pluginId: "learning", method: "note", input: { file: "plans/week.md", text: "本周学循环\n" } });
  script(f.faux, {
    tutor: [fauxAssistantMessage(fauxToolCall("save_progress", { file: "progress/loops.md", text: "完成 for 循环练习\n" })), fauxAssistantMessage("进度已保存")],
  });
  const session = await f.client.call("session.create", { agent: "tutor" });
  await f.client.call("session.send", { sessionId: session.id, text: "我做完了" });
  let feed: ChangeFeed | undefined;
  await until(async () => {
    feed = await f.client.call("history.changes", {});
    return commits(feed).length >= 3;
  }, "插件没有处理进度变化");
  assert(feed);
  // 变化处理不属于触发这次提交的运行，撤回辅导的运行时不会连带撤掉插件自己的汇总。
  assert.deepEqual(commits(feed), [
    { source: { kind: "plugin", pluginId: "learning" }, paths: ["plans/week.md"] },
    { source: { kind: "agent", runId: runOf(f.events, session.id) }, paths: ["progress/loops.md"] },
    { source: { kind: "plugin", pluginId: "learning" }, paths: ["progress/summary.md"] },
  ]);
});

/** 直接接上真实空间的运行时：watcher 关着，写入前的外部改动只能由按路径记账的前置检查发现。 */
async function spaceFixture(t: TestContext, agents: AgentDefinition[], wrap: (writes: SpaceWrites) => SpaceWrites = writes => writes) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-parallel-space-"));
  const host = await createSpace(path.join(directory, "space"), { watch: false });
  const root = host.root;
  const agentDir = path.join(directory, "agent");
  await mkdir(agentDir, { recursive: true });
  const faux = fauxProvider({ api: `parallel-space-${randomUUID()}`, provider: `parallel-space-${randomUUID()}`, models: [{ id: "test", contextWindow: 16384, maxTokens: 512 }], tokensPerSecond: 0 });
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
  });
  const events: AgentEvent[] = [];
  const space = await runtime.openSpace({
    root,
    sessionsDir: host.sessionsDir,
    instructions: () => [],
    tools: () => [],
    views: async () => [],
    agents: () => agents,
    overrides: async () => ({ app: {}, space: {} }),
    commandPolicy: () => "ask",
    record: async (runId, action) => (await host.record({ kind: "agent", runId }, action)).value,
    writes: wrap(host.writes),
    onEvent: event => events.push(event),
    confirm: async () => false,
  });
  return { root, host, faux, space, events };
}

function toolResults(session: AgentSession) {
  return session.history().filter(entry => entry.type === "tool").map(entry => {
    const data = entry.data !== null && typeof entry.data === "object" ? entry.data : {};
    return { tool: "tool" in data ? data.tool : undefined, isError: "isError" in data ? data.isError : undefined, text: entry.text ?? "" };
  });
}

function lastRun(session: AgentSession): string {
  const data = session.history().findLast(entry => entry.type === "run")?.data;
  assert(data !== null && typeof data === "object" && "runId" in data && typeof data.runId === "string");
  return data.runId;
}

test("同一文件读过之后被别人改了：锚文本还在的编辑照常应用，整份覆盖被拒并拿到最新内容，据此重写后通过", async t => {
  const f = await spaceFixture(t, [writer]);
  const file = path.join(f.root, "lessons", "one.md");
  await mkdir(path.dirname(file));
  await writeFile(file, "第一课：变量\n练习：打印 1 到 3\n");
  const session = await f.space.create({ agent: "writer" });
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("read", { path: "lessons/one.md" })), fauxAssistantMessage("读过了")]);
  await session.send("先看看第一课");
  // 会话读过之后，插件补了一行提示。
  await f.host.filesFor({ kind: "plugin", pluginId: "learning" }).write("lessons/one.md", "第一课：变量\n练习：打印 1 到 3\n提示：用 range\n");
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("edit", { path: "lessons/one.md", edits: [{ oldText: "打印 1 到 3", newText: "打印 1 到 5" }] })),
    // 照旧读到的内容整份改写，会丢掉插件补的提示。
    fauxAssistantMessage(fauxToolCall("write", { path: "lessons/one.md", content: "第一课：变量\n练习：打印 1 到 5\n小结：range 不含终点\n" })),
    fauxAssistantMessage(fauxToolCall("write", { path: "lessons/one.md", content: "第一课：变量\n练习：打印 1 到 5\n提示：用 range\n小结：range 不含终点\n" })),
    fauxAssistantMessage("改好了"),
  ]);
  await session.send("把练习改成打印 1 到 5，再加一句小结");
  const results = toolResults(session).slice(1);
  assert.deepEqual(results.map(result => [result.tool, result.isError]), [["edit", false], ["write", true], ["write", false]]);
  assert.match(results[1]?.text ?? "", /没有写入：lessons\/one\.md 在这次会话上次读取之后被改过/u);
  // 被拒的结果里带着文件现在的内容：编辑已经生效，插件补的提示也在。
  assert.match(results[1]?.text ?? "", /第一课：变量\n练习：打印 1 到 5\n提示：用 range\n/u);
  assert.equal(await readFile(file, "utf8"), "第一课：变量\n练习：打印 1 到 5\n提示：用 range\n小结：range 不含终点\n");
  const run = lastRun(session);
  const feed = await f.host.history.changes();
  assert.deepEqual(feed.revisions.slice(-3).map(revision => revision.source), [
    { kind: "plugin", pluginId: "learning" },
    { kind: "agent", runId: run },
    { kind: "agent", runId: run },
  ]);
});

test("没读过的已有文件不能整份覆盖，被拒时拿到它的内容；没有的新文件可以直接写", async t => {
  const f = await spaceFixture(t, [writer]);
  await writeFile(path.join(f.root, "plan.md"), "已有的学习计划\n");
  const session = await f.space.create({ agent: "writer" });
  f.faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("write", { path: "plan.md", content: "覆盖掉的计划\n" }),
      fauxToolCall("write", { path: "lessons/new.md", content: "新的一课\n" }),
    ]),
    fauxAssistantMessage("完成"),
  ]);
  await session.send("写计划和新课");
  const results = toolResults(session);
  assert.deepEqual(results.map(result => [result.tool, result.isError]), [["write", true], ["write", false]]);
  assert.match(results[0]?.text ?? "", /没有写入：plan\.md 已经存在，这次会话还没有读过它。下面是它现在的内容，请据此重新决定怎样修改：\n\n已有的学习计划\n/u);
  assert.equal(await readFile(path.join(f.root, "plan.md"), "utf8"), "已有的学习计划\n");
  assert.equal(await readFile(path.join(f.root, "lessons", "new.md"), "utf8"), "新的一课\n");
});

test("用户在编辑器里的改动发生在 Agent 写入之前，被记成 external，撤回 Agent 的运行回到用户的版本", async t => {
  const f = await spaceFixture(t, [writer]);
  const file = path.join(f.root, "notes.md");
  await f.host.files.write("notes.md", "原文\n");
  const session = await f.space.create({ agent: "writer" });
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("read", { path: "notes.md" })), fauxAssistantMessage("读过了")]);
  await session.send("看看笔记");
  // watcher 关着：这次改动只有 Agent 写入前的检查能发现。
  await writeFile(file, "原文\n用户在编辑器里补的一行\n");
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("edit", { path: "notes.md", edits: [{ oldText: "原文", newText: "整理后的原文" }] })), fauxAssistantMessage("改好了")]);
  await session.send("整理笔记");
  assert.equal(await readFile(file, "utf8"), "整理后的原文\n用户在编辑器里补的一行\n");
  const run = lastRun(session);
  const [external, agent] = (await f.host.history.changes()).revisions.slice(-2);
  assert.deepEqual(external?.source, { kind: "external" });
  assert.deepEqual(external?.changes.map(change => change.path), ["notes.md"]);
  assert.deepEqual(agent?.source, { kind: "agent", runId: run });
  const undone = await f.host.history.undoRun(run);
  assert.deepEqual([undone.restored, undone.conflicts], [["notes.md"], []]);
  assert.equal(await readFile(file, "utf8"), "原文\n用户在编辑器里补的一行\n");
});

test("编辑读出之后、写回之前文件被外部改动时拒绝写回，交回最新内容", async t => {
  let file = "";
  let external = "";
  // 在写回进入历史队列之前插入一次外部保存，相当于编辑器恰好在这一刻存了盘。
  const f = await spaceFixture(t, [writer], writes => ({
    lock: (action, signal) => writes.lock(action, signal),
    async commit(target, action) {
      if (target === file && external !== "") await writeFile(target, external);
      return writes.commit(target, action);
    },
  }));
  file = path.join(f.root, "notes.md");
  await writeFile(file, "原文\n");
  external = "原文\n编辑器刚存的一行\n";
  const session = await f.space.create({ agent: "writer" });
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("edit", { path: "notes.md", edits: [{ oldText: "原文", newText: "改写" }] })), fauxAssistantMessage("没改成")]);
  await session.send("改写笔记");
  const [result] = toolResults(session);
  assert.equal(result?.isError, true);
  assert.match(result?.text ?? "", /没有写入：notes\.md 在这次编辑读取之后、写回之前被改过。下面是它现在的内容，请据此重新决定怎样修改：\n\n原文\n编辑器刚存的一行\n/u);
  assert.equal(await readFile(file, "utf8"), "原文\n编辑器刚存的一行\n");
});

test("同一会话的运行依次进行：不带命令行的会话并发收到两条消息，第二轮看得到第一轮的回答", async t => {
  const f = await spaceFixture(t, [writer]);
  const session = await f.space.create({ agent: "writer" });
  let second = "";
  f.faux.setResponses([
    fauxAssistantMessage("回答 A"),
    context => {
      second = JSON.stringify(context.messages);
      return fauxAssistantMessage("回答 B");
    },
  ]);
  await Promise.all([session.send("问题 A"), session.send("问题 B")]);
  assert.match(second, /问题 A/u);
  assert.match(second, /回答 A/u);
  assert.deepEqual(session.history().filter(entry => entry.type === "user").map(entry => entry.text), ["问题 A", "问题 B"]);
  // 第二个运行在第一个结束之后才开始，回答和起止都归到各自的运行。Pi 自己也会把收尾期间到达的提问往后推，
  // 但那样第二个运行会先报告结束，回答落在没有运行的上下文里。
  const runs = f.events.filter(event => event.type === "runStart").map(event => event.runId);
  assert.deepEqual(f.events.flatMap(event => {
    if (event.type === "runStart" || event.type === "runEnd") return [[event.type, event.runId]];
    if (event.type === "message" && event.data !== null && typeof event.data === "object" && "role" in event.data && event.data.role === "assistant") return [[event.text, event.runId]];
    return [];
  }), [["runStart", runs[0]], ["回答 A", runs[0]], ["runEnd", runs[0]], ["runStart", runs[1]], ["回答 B", runs[1]], ["runEnd", runs[1]]]);
});
