import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAgentRuntimeForTest } from "../src/agent/runtime.js";
import { RepaClient, RpcError } from "../src/client.js";
import type { Plugin, UserMessage } from "../src/plugin.js";
import { record } from "../src/protocol/json-rpc.js";
import { startServer } from "../src/protocol/server.js";
import type { AgentEvent, MessageDecision } from "../src/schema.js";

function deferred<T = void>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

interface LearningState {
  quiz: boolean;
  practice: boolean;
  failing: boolean;
  asked: UserMessage[];
  // 设置后，判断要等它完成，用来构造判断期间发生取消的时序。
  hold?: Promise<void>;
  judging?: () => void;
  beforeRun?: () => Promise<MessageDecision | void>;
  viewError?: Error;
}

// 学习插件的判断只依赖它自己的状态：测验中拒收求助，练习中把提问记为求助后放行。
function learningPlugin(state: LearningState): Plugin {
  return {
    id: "learning",
    async open(host) {
      return {
        agents: () => [{
          id: "tutor",
          instructions: () => "你陪学习者练习 Python。",
          tools: [],
          direct: true,
          ...(state.beforeRun === undefined ? {} : { beforeRun: () => state.beforeRun?.() ?? Promise.resolve() }),
          async view() {
            if (state.viewError) throw state.viewError;
            return "当前课题";
          },
          async beforeMessage(message) {
            state.judging?.();
            await state.hold;
            if (state.failing) throw new Error("学习记录不可用");
            if (state.quiz) return { status: "rejected", reason: "quiz_in_progress", message: "测验进行中，暂时不能求助", data: { quizId: "quiz-1" } };
            if (state.practice) state.asked.push(message);
            return undefined;
          },
        }],
        methods: {
          abort: {
            parameters: Type.Object({ agent: Type.String() }, { additionalProperties: false }),
            async invoke(input) {
              const { agent } = record(input) ?? {};
              assert.equal(typeof agent, "string");
              await host.abortAgent(String(agent));
              return {};
            },
          },
          prepare: {
            parameters: Type.Object({}, { additionalProperties: false }),
            async invoke() {
              const work = await host.models.runAgent({ agent: "tutor", text: "后台准备下一题" });
              await work.result;
              return { id: work.id };
            },
          },
        },
      };
    },
  };
}

async function fixture(t: TestContext, beforeRun?: LearningState["beforeRun"]) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-agent-messages-")));
  const root = path.join(directory, "space");
  const home = path.join(directory, "home");
  await mkdir(root);
  await mkdir(path.join(home, "agent"), { recursive: true });
  const faux = fauxProvider({ api: `messages-${randomUUID()}`, provider: `messages-${randomUUID()}`, models: [{ id: "scripted", contextWindow: 16384, maxTokens: 256 }], tokensPerSecond: 0 });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(home, "agent", "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const runtime = await createAgentRuntimeForTest({
    agentDir: path.join(home, "agent"),
    modelRuntime,
    defaultModel: { provider: faux.getModel().provider, id: "scripted" },
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
  });
  const state: LearningState = { quiz: false, practice: false, failing: false, asked: [], ...(beforeRun === undefined ? {} : { beforeRun }) };
  const server = await startServer({ home, plugins: [learningPlugin(state), {
    id: "other",
    open: async () => ({ agents: () => [{ id: "other-agent", tools: [], instructions: () => "另一个插件" }] }),
  }], runtime, generalAgent: false });
  const client = await RepaClient.connect(server.connection);
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  await client.call("space.open", { root });
  const session = await client.call("session.create", { agent: "tutor" });
  const users = async (sessionId = session.id) => (await client.call("session.history", { sessionId })).filter(entry => entry.type === "user").map(entry => entry.text);
  return { root, client, faux, state, session, users };
}

function rejection(details: unknown) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof RpcError);
    assert.equal(error.message, "测验进行中，暂时不能求助");
    assert.deepEqual(error.data, { code: "message_rejected", details });
    return true;
  };
}

test("测验期间插件拒收用户消息，前端收到说明原因、带判断依据的错误，消息不进入会话", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const details = { agent: "tutor", reason: "quiz_in_progress", data: { quizId: "quiz-1" } };
  f.state.quiz = true;
  await assert.rejects(f.client.call("session.send", { sessionId: f.session.id, text: "这题答案是什么" }), rejection(details));
  await assert.rejects(f.client.call("session.steer", { sessionId: f.session.id, text: "给个提示" }), rejection(details));
  await assert.rejects(f.client.call("session.followUp", { sessionId: f.session.id, text: "再给个提示" }), rejection(details));
  assert.deepEqual(await f.users(), []);
  assert.equal(f.faux.state.callCount, 0);
  // 运行中开始测验后，插话和追加同样被拒收，不进入当前运行。
  f.state.quiz = false;
  const started = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  f.faux.setResponses([async () => {
    started.resolve();
    await release.promise;
    return fauxAssistantMessage("先做第一题");
  }]);
  const running = f.client.call("session.send", { sessionId: f.session.id, text: "开始测验" });
  await started.promise;
  f.state.quiz = true;
  await assert.rejects(f.client.call("session.steer", { sessionId: f.session.id, text: "偷偷问一下" }), rejection(details));
  await assert.rejects(f.client.call("session.followUp", { sessionId: f.session.id, text: "再问一下" }), rejection(details));
  release.resolve();
  await running;
  assert.equal(f.faux.state.callCount, 1);
  assert.deepEqual(await f.users(), ["开始测验"]);
});

test("练习中插件只记下提问，消息照常进入会话；后台任务不经过判断", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.state.practice = true;
  f.faux.setResponses([fauxAssistantMessage("先想想循环变量的取值")]);
  await f.client.call("session.send", { sessionId: f.session.id, text: "这题怎么做" });
  assert.deepEqual(f.state.asked, [{ sessionId: f.session.id, agent: "tutor", mode: "send", text: "这题怎么做" }]);
  const started = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  f.faux.setResponses([
    async () => {
      started.resolve();
      await release.promise;
      return fauxAssistantMessage("看第二行");
    },
    fauxAssistantMessage("range(3) 从 0 开始"),
  ]);
  const running = f.client.call("session.send", { sessionId: f.session.id, text: "还是不懂" });
  await started.promise;
  await f.client.call("session.steer", { sessionId: f.session.id, text: "range 从几开始" });
  release.resolve();
  await running;
  assert.deepEqual(await f.users(), ["这题怎么做", "还是不懂", "range 从几开始"]);
  const runs = (await f.client.call("session.history", { sessionId: f.session.id })).flatMap(entry => entry.type === "run" ? [record(entry.data)?.runId] : []);
  assert.deepEqual(f.state.asked.slice(1), [
    { sessionId: f.session.id, agent: "tutor", mode: "send", text: "还是不懂" },
    { sessionId: f.session.id, agent: "tutor", mode: "steer", text: "range 从几开始", runId: runs[1] },
  ]);
  f.faux.setResponses([fauxAssistantMessage("下一题已准备")]);
  const { id } = record(await f.client.call("plugin.call", { pluginId: "learning", method: "prepare", input: {} })) ?? {};
  assert.deepEqual(await f.users(String(id)), ["后台准备下一题"]);
  assert.equal(f.state.asked.length, 3);
});

test("插件判断失败时消息不进入会话，前端收到可处理的错误码", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.state.failing = true;
  await assert.rejects(f.client.call("session.send", { sessionId: f.session.id, text: "你好" }), (error: unknown) => {
    assert.ok(error instanceof RpcError);
    assert.deepEqual(error.data, { code: "message_check_failed", details: { agent: "tutor" } });
    assert.doesNotMatch(error.message, /学习记录不可用/u);
    return true;
  });
  assert.deepEqual(await f.users(), []);
  assert.equal(f.faux.state.callCount, 0);
});

test("插件判断期间用户取消运行，这条插话不在取消之后补投", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.state.practice = true;
  const started = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  f.faux.setResponses([async (_context, options) => {
    started.resolve();
    await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
    await release.promise;
    return fauxAssistantMessage("不应完成");
  }]);
  const running = f.client.call("session.send", { sessionId: f.session.id, text: "开始" });
  await started.promise;
  const hold = deferred();
  const judging = deferred();
  f.state.hold = hold.promise;
  f.state.judging = () => judging.resolve();
  const steering = f.client.call("session.steer", { sessionId: f.session.id, text: "判断中的插话" });
  await judging.promise;
  const cancelling = f.client.call("session.abort", { sessionId: f.session.id });
  release.resolve();
  await cancelling;
  await running.catch(() => undefined);
  hold.resolve();
  await assert.rejects(steering, (error: unknown) => {
    assert.ok(error instanceof RpcError);
    assert.equal(record(error.data)?.code, "cancelled");
    return true;
  });
  assert.equal(f.faux.state.callCount, 1);
  assert.deepEqual(await f.users(), ["开始"]);
  assert.deepEqual(f.state.asked.map(message => message.text), ["开始", "判断中的插话"]);
});


test("插件只能中止自己的 Agent，等待回复终态并清掉已排队的追加消息", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const abort = (agent = "tutor") => f.client.call("plugin.call", {
    pluginId: "learning",
    method: "abort",
    input: { agent },
  });
  await assert.rejects(abort("other-agent"), (error: unknown) => {
    assert.ok(error instanceof RpcError);
    assert.equal(record(error.data)?.code, "agent_not_owned");
    return true;
  });
  await assert.rejects(abort("general"), (error: unknown) => {
    assert.ok(error instanceof RpcError);
    assert.equal(record(error.data)?.code, "agent_not_owned");
    return true;
  });
  const started = deferred();
  const cancelled = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  f.faux.setResponses([async (_context, options) => {
    started.resolve();
    await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
    cancelled.resolve();
    await release.promise;
    return fauxAssistantMessage("不应完成");
  }]);
  const running = f.client.call("session.send", { sessionId: f.session.id, text: "开始" });
  await started.promise;
  await f.client.call("session.followUp", { sessionId: f.session.id, text: "排队消息" });
  let stopped = false;
  const stopping = abort().then(() => { stopped = true; });
  await cancelled.promise;
  assert.equal(stopped, false);
  release.resolve();
  await stopping;
  await running.catch(() => undefined);
  assert.equal(f.faux.state.callCount, 1);
  assert.deepEqual(await f.users(), ["开始"]);
  f.faux.setResponses([fauxAssistantMessage("恢复聊天")]);
  await f.client.call("session.send", { sessionId: f.session.id, text: "新消息" });
  assert.deepEqual(await f.users(), ["开始", "新消息"]);
});


test("中止辅导 Agent 不枚举或加载磁盘上的未加载旧会话", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("旧辅导回复")]);
  await f.client.call("session.send", { sessionId: f.session.id, text: "旧辅导提问" });
  await f.client.call("space.close", {});
  await f.client.call("space.open", { root: f.root });
  const listed = t.mock.method(SessionManager, "listAll");
  const opened = t.mock.method(SessionManager, "open");
  await f.client.call("plugin.call", {
    pluginId: "learning",
    method: "abort",
    input: { agent: "tutor" },
  });
  assert.equal(listed.mock.callCount(), 0);
  assert.equal(opened.mock.callCount(), 0);
  assert.deepEqual(await f.users(), ["旧辅导提问"]);
  assert.equal(listed.mock.callCount(), 0);
  assert.equal(opened.mock.callCount(), 1);
});


test("排队消息在真正运行前被拒收，不写消息和运行标记，后续消息照常运行", { timeout: 30000 }, async t => {
  let restricted = false;
  let checks = 0;
  const f = await fixture(t, async () => {
    checks++;
    if (restricted) {
      restricted = false;
      return { status: "rejected", reason: "restricted", message: "复习期间不能求助", data: { taskId: "review" } };
    }
  });
  const events: AgentEvent[] = [];
  const completed = deferred();
  t.after(f.client.on("session.event", event => {
    events.push(event);
    if (events.filter(item => item.type === "runEnd").length === 2) completed.resolve();
  }));
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  f.faux.setResponses([
    async () => {
      entered.resolve();
      await release.promise;
      return fauxAssistantMessage("第一条完成");
    },
    fauxAssistantMessage("后续消息完成"),
  ]);
  const first = f.client.call("session.send", { sessionId: f.session.id, text: "第一条" });
  await entered.promise;
  await f.client.call("session.followUp", { sessionId: f.session.id, text: "排队时放行，运行时拒绝" });
  await f.client.call("session.steer", { sessionId: f.session.id, text: "后续消息" });
  restricted = true;
  release.resolve();
  await first;
  await completed.promise;
  assert.equal(checks, 3);
  assert.equal(f.faux.state.callCount, 2);
  assert.deepEqual(await f.users(), ["第一条", "后续消息"]);
  const rejected = events.find(event => event.type === "error");
  assert.ok(rejected);
  assert.equal(rejected.text, "复习期间不能求助");
  assert.deepEqual(rejected.data, { code: "message_rejected", details: { agent: "tutor", reason: "restricted", data: { taskId: "review" } } });
  assert.ok(!events.some(event => event.runId === rejected.runId && (event.type === "runStart" || event.type === "runEnd")));
  const runs = (await f.client.call("session.history", { sessionId: f.session.id })).filter(entry => entry.type === "run");
  assert.equal(runs.length, 2);
});

test("新消息的运行关卡拒绝时请求返回 message_rejected，视图尚未读取", async t => {
  const f = await fixture(t, async () => ({ status: "rejected", reason: "restricted", message: "当前不能求助" }));
  f.state.viewError = new Error("不应该读取视图");
  await assert.rejects(f.client.call("session.send", { sessionId: f.session.id, text: "提问" }), (error: unknown) => {
    assert.ok(error instanceof RpcError);
    assert.equal(record(error.data)?.code, "message_rejected");
    return true;
  });
  assert.deepEqual(await f.users(), []);
  assert.equal(f.faux.state.callCount, 0);
});

test("视图普通错误按原错误报告，运行关卡抛错也保留自身错误", async t => {
  const f = await fixture(t, async () => undefined);
  const events: AgentEvent[] = [];
  t.after(f.client.on("session.event", event => events.push(event)));
  f.state.viewError = new Error("渲染视图失败的原始原因");
  await assert.rejects(f.client.call("session.send", { sessionId: f.session.id, text: "触发视图" }));
  assert.equal(events.findLast(event => event.type === "error")?.text, f.state.viewError.message);
  f.state.beforeRun = async () => { throw new Error("运行关卡失败的原始原因"); };
  await assert.rejects(f.client.call("session.send", { sessionId: f.session.id, text: "触发关卡" }));
  assert.equal(events.findLast(event => event.type === "error")?.text, "运行关卡失败的原始原因");
  assert.deepEqual(await f.users(), []);
  assert.equal(f.faux.state.callCount, 0);
});
