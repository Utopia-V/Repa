import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createAgentRuntimeForTest } from "../src/agent/runtime.js";
import { RepaClient, RpcError } from "../src/client.js";
import {
  INTERACTION_CAPABILITIES,
  ItemSchema,
  type ClientCapabilities,
  type ItemDraft,
  type Notification,
  type NotificationParams,
  type SubmitResult,
} from "../src/protocol.js";
import type { AskOutcome, MethodContext, Plugin } from "../src/plugin.js";
import { record } from "../src/protocol/json-rpc.js";
import { startServer } from "../src/protocol/server.js";
import { object, parse } from "../src/schema.js";

function deferred<T = void>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

/** 等某个连接收到第一条符合条件的通知。 */
function next<N extends Notification>(client: RepaClient, method: N, accept: (params: NotificationParams<N>) => boolean = () => true): Promise<NotificationParams<N>> {
  return new Promise(resolve => {
    const stop = client.on(method, params => {
      if (!accept(params)) return;
      stop();
      resolve(params);
    });
  });
}

const rejectsWith = (code: string, details?: unknown) => (error: unknown): boolean => {
  assert.ok(error instanceof RpcError);
  assert.equal(record(error.data)?.code, code);
  if (details !== undefined) assert.deepEqual(record(error.data)?.details, details);
  return true;
};

function toolResults(context: TranscriptContext): { tool: string; isError: boolean; text: string }[] {
  return context.messages.flatMap(message => message.role === "toolResult"
    ? [{ tool: message.toolName, isError: message.isError, text: message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("") }]
    : []);
}

/** 官方前端会声明第一版的全部能力；测试里的假前端按需声明一部分。 */
const FULL: ClientCapabilities = { interaction: { vocabulary: 1, supports: [...INTERACTION_CAPABILITIES] } };

const practiceItem: ItemDraft = {
  id: "py01.k1.q1",
  body: [
    { type: "markdown", text: "运行下面的代码会输出什么？" },
    { type: "code", language: "python", text: "reading = 5\nprint(reading)" },
  ],
  slots: [{ id: "output", type: "text", format: "integer" }],
};

const RunSchema = object({ code: Type.String() });
const LeakSchema = object({ item: ItemSchema });

interface PracticeState {
  evaluated: unknown[];
  outcomes: AskOutcome[];
  failures: unknown[];
  controller?: AbortController;
  /** 判分时把作答写进空间文件，用来检查判分在提问的运行里执行。 */
  writeOnEvaluate: boolean;
}

// 学习插件的最小替身：一个出练习小题的工具、一个调用前端运行器的工具，以及几种界面方法。
function practicePlugin(state: PracticeState): Plugin {
  return {
    id: "practice",
    async open(host) {
      return {
        tools: () => [
          {
            name: "practice_once",
            description: "让学习者试一道题",
            parameters: object({}),
            async execute(_input, context) {
              try {
                const outcome = await context.ask({
                  item: practiceItem,
                  purpose: "practice",
                  async evaluate(response) {
                    state.evaluated.push(response);
                    const answer = response.answers.output;
                    if (state.writeOnEvaluate) await host.files.write("attempts/py01.k1.q1.txt", answer?.type === "text" ? answer.text : "");
                    const correct = answer?.type === "text" && answer.text === "5";
                    const result: SubmitResult = {
                      status: "recorded",
                      feedback: { item: response.item, verdict: correct ? "correct" : "incorrect", judge: "rule", score: { earned: correct ? 1 : 0, max: 1 } },
                    };
                    return result;
                  },
                });
                state.outcomes.push(outcome);
                const verdict = outcome.action === "submit" && outcome.result?.status === "recorded" ? outcome.result.feedback?.verdict : undefined;
                return { text: `练习结束：${outcome.action}${verdict === undefined ? "" : `，${verdict}`}` };
              } catch (error) {
                state.failures.push(error);
                throw error;
              }
            },
          },
          {
            name: "run_code",
            description: "在学习者的浏览器里运行代码",
            parameters: RunSchema,
            async execute(input, context) {
              const result = await host.services.call("python.run", parse(RunSchema, input), { signal: context.signal });
              return { text: JSON.stringify(result) };
            },
          },
        ],
        agents: () => [
          { id: "asker", instructions: () => "你向学习者提问。", tools: ["ask_user"], direct: true },
          { id: "quiet", instructions: () => "你只读课程。", tools: ["read"], direct: true },
        ],
        methods: {
          run: {
            parameters: RunSchema,
            async invoke(input) {
              state.controller = new AbortController();
              return host.services.call("python.run", parse(RunSchema, input), { signal: state.controller.signal });
            },
          },
          stop: { parameters: object({}), invoke: async () => { state.controller?.abort(); return null; } },
          inspect: { parameters: object({}), invoke: async (_input: unknown, context: MethodContext) => context.caller ?? null },
          leak: {
            parameters: object({}),
            result: LeakSchema,
            // 示意错误：把题库记录原样交出，多带了答案字段。
            invoke: async () => ({ item: { id: "py01.k1.q1", version: `sha256:${"1".repeat(64)}`, requires: ["slot.text"], body: [], slots: [{ id: "output", type: "text", answer: "5" }] } }),
          },
          serve: {
            parameters: object({}),
            result: LeakSchema,
            invoke: async () => ({ item: { id: "py01.k1.q1", version: `sha256:${"1".repeat(64)}`, requires: ["slot.text"], body: [], slots: [{ id: "output", type: "text" }] } }),
          },
        },
      };
    },
  };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-interaction-"));
  const root = path.join(directory, "space");
  const home = path.join(directory, "home");
  await mkdir(root);
  await mkdir(path.join(home, "agent"), { recursive: true });
  const faux = fauxProvider({ api: `interaction-${randomUUID()}`, provider: `interaction-${randomUUID()}`, models: [{ id: "scripted", contextWindow: 16384, maxTokens: 256 }], tokensPerSecond: 0 });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(home, "agent", "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const runtime = await createAgentRuntimeForTest({
    agentDir: path.join(home, "agent"),
    modelRuntime,
    defaultModel: { provider: faux.getModel().provider, id: "scripted" },
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
  });
  const state: PracticeState = { evaluated: [], outcomes: [], failures: [], writeOnEvaluate: false };
  const server = await startServer({ home, plugins: [practicePlugin(state)], runtime });
  const clients: RepaClient[] = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const connect = async (capabilities?: ClientCapabilities) => {
    const client = await RepaClient.connect(server.connection, capabilities === undefined ? {} : { capabilities });
    clients.push(client);
    return client;
  };
  const captures: TranscriptContext[] = [];
  const reply = (text: string) => (context: TranscriptContext) => {
    captures.push(structuredClone(context));
    return fauxAssistantMessage(text);
  };
  return { root, faux, state, server, connect, captures, reply };
}

test("询问只发给发起运行的连接，其他连接不能代答；格式不对时保持打开，提交后插件判分，反馈交回卡片和模型", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const owner = await f.connect(FULL);
  const other = await f.connect(FULL);
  await owner.call("space.open", { root: f.root });
  const session = await owner.call("session.create", {});
  const seenByOther: unknown[] = [];
  other.on("ask.request", request => seenByOther.push(request));
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("practice_once", {}, { id: "call-practice-1" })), f.reply("讲评完毕")]);
  const asked = next(owner, "ask.request");
  const running = owner.call("session.send", { sessionId: session.id, text: "给我一道练习" });
  const request = await asked;
  assert.deepEqual(request.origin, { kind: "plugin", pluginId: "practice", sessionId: session.id, callId: "call-practice-1" });
  assert.equal(request.purpose, "practice");
  assert.deepEqual(request.item.requires, ["block.code", "block.markdown", "slot.text"]);
  assert.match(request.item.version, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(Value.Check(ItemSchema, request.item), true);
  await assert.rejects(other.call("ask.reply", { id: request.id, action: "decline" }), rejectsWith("ask_not_found"));
  const closed: string[] = [];
  owner.on("ask.closed", ({ reason }) => closed.push(reason));
  const reference = { id: request.item.id, version: request.item.version };
  const rejected = await owner.call("ask.reply", { id: request.id, action: "submit", response: { item: reference, answers: {} } });
  assert.equal(rejected?.status, "rejected");
  assert.deepEqual(rejected?.status === "rejected" ? rejected.problems.map(problem => problem.slot) : [], ["output"]);
  assert.deepEqual(f.state.evaluated, []);
  assert.deepEqual(closed, []);
  await assert.rejects(owner.call("ask.reply", { id: request.id, action: "decline", response: { item: reference, answers: {} } }), rejectsWith("invalid_ask_reply"));
  const recorded = await owner.call("ask.reply", { id: request.id, action: "submit", response: { item: reference, answers: { output: { type: "text", text: "5" } } } });
  assert.deepEqual(recorded, { status: "recorded", feedback: { item: reference, verdict: "correct", judge: "rule", score: { earned: 1, max: 1 } } });
  await running;
  assert.deepEqual(closed, ["answered"]);
  assert.equal(f.state.evaluated.length, 1);
  assert.deepEqual(toolResults(f.captures[0] as TranscriptContext), [{ tool: "practice_once", isError: false, text: "练习结束：submit，correct" }]);
  assert.deepEqual(seenByOther, []);
  await assert.rejects(owner.call("ask.reply", { id: request.id, action: "cancel" }), rejectsWith("ask_not_found"));
});

test("前端没有声明题目需要的能力时不发送询问，插件工具直接得到 unsupported", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  // 练习题带代码块，只声明 Markdown 和文本作答位的前端显示不了。
  const textOnly = await f.connect({ interaction: { vocabulary: 1, supports: ["block.markdown", "slot.text"] } });
  await textOnly.call("space.open", { root: f.root });
  const received: unknown[] = [];
  textOnly.on("ask.request", request => received.push(request));
  const session = await textOnly.call("session.create", {});
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("practice_once", {})), f.reply("改用文字讲")]);
  await textOnly.call("session.send", { sessionId: session.id, text: "练习" });
  assert.deepEqual(f.state.outcomes, [{ action: "unsupported" }]);
  assert.deepEqual(toolResults(f.captures.at(-1) as TranscriptContext), [{ tool: "practice_once", isError: false, text: "练习结束：unsupported" }]);
  assert.deepEqual(received, []);
});

test("发起连接断线时询问取消，模型收到用户没有作答；运行中止时前端收到 ask.closed", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const leaving = await f.connect(FULL);
  const watcher = await f.connect(FULL);
  await leaving.call("space.open", { root: f.root });
  const session = await leaving.call("session.create", {});
  const continued = deferred<TranscriptContext>();
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("practice_once", {})),
    context => {
      continued.resolve(structuredClone(context));
      return fauxAssistantMessage("用户离开了，先停在这里");
    },
  ]);
  const asked = next(leaving, "ask.request");
  const finished = next(watcher, "session.event", event => event.sessionId === session.id && event.type === "runEnd");
  const running = leaving.call("session.send", { sessionId: session.id, text: "开始" });
  running.catch(() => undefined);
  await asked;
  await leaving.close();
  const context = await continued.promise;
  assert.deepEqual(toolResults(context), [{ tool: "practice_once", isError: true, text: "用户没有作答：连接已断开" }]);
  await finished;

  // 运行中止：询问以 aborted 结束，前端据此收起卡片。
  const aborting = await f.connect(FULL);
  const second = await aborting.call("session.create", {});
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("practice_once", {}))]);
  const practice = next(aborting, "ask.request");
  const sending = aborting.call("session.send", { sessionId: second.id, text: "练习" });
  sending.catch(() => undefined);
  const request = await practice;
  const closed = next(aborting, "ask.closed");
  await aborting.call("session.abort", { sessionId: second.id });
  assert.deepEqual(await closed, { id: request.id, reason: "aborted" });
  await sending.catch(() => undefined);
  const failure = f.state.failures.at(-1);
  assert.ok(failure instanceof Error && "code" in failure && failure.code === "ask_cancelled");
  assert.deepEqual("details" in failure ? failure.details : undefined, { reason: "aborted" });
  await assert.rejects(aborting.call("ask.reply", { id: request.id, action: "cancel" }), rejectsWith("ask_not_found"));
});

test("带命令行的运行持空间写锁等待回答，插件判分时写文件不会互相等待，写入算在这次运行里", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.state.writeOnEvaluate = true;
  const client = await f.connect(FULL);
  await client.call("space.open", { root: f.root });
  const session = await client.call("session.create", {});
  const [before] = await client.call("history.list", { limit: 1 });
  assert.ok(before);
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("practice_once", {})), f.reply("答对了")]);
  const asked = next(client, "ask.request");
  const running = client.call("session.send", { sessionId: session.id, text: "练习" });
  const request = await asked;
  const reference = { id: request.item.id, version: request.item.version };
  const result = await client.call("ask.reply", { id: request.id, action: "submit", response: { item: reference, answers: { output: { type: "text", text: "5" } } } });
  assert.equal(result?.status, "recorded");
  await running;
  assert.equal(await readFile(path.join(f.root, "attempts", "py01.k1.q1.txt"), "utf8"), "5");
  const run = (await client.call("session.history", { sessionId: session.id })).find(entry => entry.type === "run");
  const runId = record(run?.data)?.runId;
  const feed = await client.call("history.changes", { since: before.id });
  assert.deepEqual(feed.revisions.map(revision => [revision.source, revision.changes.map(change => change.path)]), [[{ kind: "agent", runId }, ["attempts/py01.k1.q1.txt"]]]);
});

test("服务请求交给声明了它的连接：发起连接自己声明时优先，否则交给最近声明的连接，结果原样交回", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const owner = await f.connect({ ...FULL, services: ["python.run"] });
  const provider = await f.connect({ services: ["python.run"] });
  const plain = await f.connect(FULL);
  await plain.call("space.open", { root: f.root });
  const served: string[] = [];
  for (const [name, client] of [["owner", owner], ["provider", provider]] as const) {
    client.on("service.request", ({ id, service, input }) => {
      served.push(name);
      assert.equal(service, "python.run");
      void client.call("service.reply", { id, result: { stdout: `${name}:${JSON.stringify(input)}` } });
    });
  }
  plain.on("service.request", () => served.push("plain"));
  assert.deepEqual(await plain.call("plugin.call", { pluginId: "practice", method: "run", input: { code: "print(1)" } }), { stdout: "provider:{\"code\":\"print(1)\"}" });
  assert.deepEqual(await owner.call("plugin.call", { pluginId: "practice", method: "run", input: { code: "print(2)" } }), { stdout: "owner:{\"code\":\"print(2)\"}" });
  assert.deepEqual(served, ["provider", "owner"]);
  // Agent 的工具在运行里调用服务，同样交给提供方。
  const session = await plain.call("session.create", {});
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("run_code", { code: "print(3)" })), f.reply("运行完了")]);
  await plain.call("session.send", { sessionId: session.id, text: "运行代码" });
  assert.deepEqual(toolResults(f.captures.at(-1) as TranscriptContext), [{ tool: "run_code", isError: false, text: JSON.stringify({ stdout: "provider:{\"code\":\"print(3)\"}" }) }]);
});

test("服务请求在调用方中止、提供方断线和空间关闭时收尾，没有提供方时报 service_unavailable", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const plain = await f.connect(FULL);
  await plain.call("space.open", { root: f.root });
  const run = () => plain.call("plugin.call", { pluginId: "practice", method: "run", input: { code: "while True: pass" } });
  await assert.rejects(run(), rejectsWith("service_unavailable", { service: "python.run" }));

  const provider = await f.connect({ services: ["python.run"] });
  let requested = next(provider, "service.request");
  const aborted = assert.rejects(run(), rejectsWith("service_cancelled", { service: "python.run", reason: "aborted" }));
  const first = await requested;
  const stopped = next(provider, "service.closed");
  await plain.call("plugin.call", { pluginId: "practice", method: "stop", input: {} });
  assert.deepEqual(await stopped, { id: first.id, reason: "aborted" });
  await aborted;
  await assert.rejects(provider.call("service.reply", { id: first.id, result: null }), rejectsWith("service_request_not_found"));

  requested = next(provider, "service.request");
  const failing = assert.rejects(run(), rejectsWith("service_failed", { service: "python.run", code: "runner_crashed" }));
  const second = await requested;
  await assert.rejects(plain.call("service.reply", { id: second.id, result: "冒充" }), rejectsWith("service_request_not_found"));
  await provider.call("service.reply", { id: second.id, error: { code: "runner_crashed", message: "Pyodide 未能加载" } });
  await failing;

  requested = next(provider, "service.request");
  const disconnected = assert.rejects(run(), rejectsWith("service_cancelled", { service: "python.run", reason: "disconnected" }));
  await requested;
  await provider.close();
  await disconnected;

  const remaining = await f.connect({ services: ["python.run"] });
  requested = next(remaining, "service.request");
  const closing = assert.rejects(run(), rejectsWith("service_cancelled", { service: "python.run", reason: "closed" }));
  const third = await requested;
  const closed = next(remaining, "service.closed");
  await plain.call("space.close", {});
  assert.deepEqual(await closed, { id: third.id, reason: "closed" });
  await closing;
});

test("插件方法收到调用方的能力声明，声明的结果 schema 拦下多带的答案字段", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const declared: ClientCapabilities = { ...FULL, services: ["python.run"] };
  const client = await f.connect(declared);
  await client.call("space.open", { root: f.root });
  assert.deepEqual(await client.call("plugin.call", { pluginId: "practice", method: "inspect", input: {} }), { capabilities: declared });
  const bare = await f.connect();
  assert.deepEqual(await bare.call("plugin.call", { pluginId: "practice", method: "inspect", input: {} }), { capabilities: {} });
  await assert.rejects(client.call("plugin.call", { pluginId: "practice", method: "leak", input: {} }), rejectsWith("invalid_plugin_result", { pluginId: "practice", methodName: "leak" }));
  const served = await client.call("plugin.call", { pluginId: "practice", method: "serve", input: {} });
  assert.equal(Value.Check(object({ item: ItemSchema }), served), true);
});

test("initialize 严格校验能力声明，旧版本客户端不能连接", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const invalid = { interaction: { vocabulary: 1, supports: ["slot.choice"], extra: true } } as unknown as ClientCapabilities;
  await assert.rejects(RepaClient.connect(f.server.connection, { capabilities: invalid }), (error: unknown) => error instanceof RpcError && error.code === -32602);
  const socket = new WebSocket(f.server.connection.url);
  t.after(() => socket.close());
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("无法连接")), { once: true });
  });
  const response = new Promise<unknown>(resolve => socket.addEventListener("message", event => resolve(JSON.parse(String(event.data))), { once: true }));
  socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { token: f.server.connection.token, version: "1" } }));
  assert.equal(record(record(await response)?.error)?.code, -32002);
});

test("前端没有声明题目需要的能力时不发送询问，Agent 得知卡片无法显示", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const textOnly = await f.connect({ interaction: { vocabulary: 1, supports: ["block.markdown", "slot.text"] } });
  const undeclared = await f.connect();
  await textOnly.call("space.open", { root: f.root });
  const received: unknown[] = [];
  for (const client of [textOnly, undeclared]) client.on("ask.request", request => received.push(request));
  const question = { questions: [{ question: "导出结果要用哪种格式？", options: [{ label: "CSV" }, { label: "Excel" }] }] };
  for (const client of [textOnly, undeclared]) {
    const session = await client.call("session.create", {});
    f.faux.setResponses([fauxAssistantMessage(fauxToolCall("ask_user", question)), f.reply("改用文字问")]);
    await client.call("session.send", { sessionId: session.id, text: "帮我导出" });
    assert.deepEqual(toolResults(f.captures.at(-1) as TranscriptContext), [{ tool: "ask_user", isError: false, text: "当前界面无法显示这张询问卡片，用户没有看到问题。请改用文字提问。" }]);
  }
  assert.deepEqual(received, []);
});

test("ask_user 把作答交回模型：选择交回选项名，填写原样交回，decline 附的一句话原样交回", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const client = await f.connect(FULL);
  await client.call("space.open", { root: f.root });
  const session = await client.call("session.create", {});
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("ask_user", { questions: [
    { question: "导出结果要用哪种格式？", header: "格式", multiple: true, options: [{ label: "CSV", description: "表格软件都能打开" }, { label: "Excel" }] },
    { id: "extra", question: "还有什么要求？", input: "longText" },
  ] }, { id: "call-ask-1" })), f.reply("按 Excel 导出")]);
  const asked = next(client, "ask.request");
  const running = client.call("session.send", { sessionId: session.id, text: "帮我导出" });
  const request = await asked;
  assert.deepEqual(request.origin, { kind: "agent", sessionId: session.id, callId: "call-ask-1" });
  assert.equal(request.purpose, "question");
  assert.match(request.item.id, /^ask:/u);
  assert.deepEqual(request.item.slots.map(slot => [slot.id, slot.type]), [["q1", "choice"], ["extra", "text"]]);
  const choice = request.item.slots[0];
  assert(choice?.type === "choice");
  assert.deepEqual(choice.options.map(option => [option.id, option.label, option.content]), [
    ["o1", "CSV", [{ type: "markdown", text: "**CSV**：表格软件都能打开" }]],
    ["o2", "Excel", [{ type: "markdown", text: "Excel" }]],
  ]);
  assert.deepEqual([choice.multiple, choice.other, choice.label], [true, { label: "其他" }, "格式"]);
  const reference = { id: request.item.id, version: request.item.version };
  const answers = { q1: { type: "choice" as const, selected: ["o2"], other: "再附一份 CSV" }, extra: { type: "text" as const, text: "每个工作表一个 sheet\n保留公式" } };
  assert.deepEqual(await client.call("ask.reply", { id: request.id, action: "submit", response: { item: reference, answers } }), { status: "recorded" });
  await running;
  assert.deepEqual(toolResults(f.captures.at(-1) as TranscriptContext), [{
    tool: "ask_user",
    isError: false,
    text: "用户已作答：\n- 导出结果要用哪种格式？ → Excel、其他：再附一份 CSV\n- 还有什么要求？ → 每个工作表一个 sheet\n保留公式",
  }]);
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("ask_user", { purpose: "practice", questions: [{ question: "`len([1, 2])` 等于几？", input: "number" }] })), f.reply("那我先解释")]);
  const practice = next(client, "ask.request");
  const second = client.call("session.send", { sessionId: session.id, text: "考考我" });
  const declined = await practice;
  assert.equal(declined.purpose, "practice");
  assert.deepEqual(declined.item.slots.map(slot => slot.type === "text" ? slot.format : undefined), ["number"]);
  assert.equal(await client.call("ask.reply", { id: declined.id, action: "decline", message: "我想先问一下 len 是什么意思" }), null);
  await second;
  assert.deepEqual(toolResults(f.captures.at(-1) as TranscriptContext).at(-1), { tool: "ask_user", isError: false, text: "用户没有按卡片作答，留言：我想先问一下 len 是什么意思" });
});

test("ask_user 的参数里不能带答案字段，模型得到校验错误，界面收不到询问", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const client = await f.connect(FULL);
  await client.call("space.open", { root: f.root });
  const session = await client.call("session.create", {});
  const received: unknown[] = [];
  client.on("ask.request", request => received.push(request));
  f.faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("ask_user", { questions: [{ question: "1 + 1 = ?", input: "number" }], answer: "2" }),
      fauxToolCall("ask_user", { questions: [{ question: "1 + 1 = ?", options: [{ label: "2", correct: true }, { label: "3" }] }] }),
    ]),
    f.reply("重新出题"),
  ]);
  await client.call("session.send", { sessionId: session.id, text: "出题" });
  const results = toolResults(f.captures.at(-1) as TranscriptContext);
  assert.deepEqual(results.map(result => [result.tool, result.isError]), [["ask_user", true], ["ask_user", true]]);
  for (const result of results) assert.match(result.text, /Validation failed for tool "ask_user"/u);
  assert.deepEqual(received, []);
});

test("通用 Agent 默认带 ask_user，插件 Agent 在定义里列出才有", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const client = await f.connect(FULL);
  await client.call("space.open", { root: f.root });
  const declared: string[][] = [];
  for (const agent of ["general", "asker", "quiet"]) {
    const session = await client.call("session.create", { agent });
    f.faux.setResponses([f.reply("好的")]);
    await client.call("session.send", { sessionId: session.id, text: "你好" });
    declared.push(getCurrentTools((f.captures.at(-1) as TranscriptContext).messages).map(tool => tool.name));
  }
  assert.ok(declared[0]?.includes("ask_user"));
  assert.deepEqual(declared.slice(1), [["ask_user"], ["read"]]);
});
