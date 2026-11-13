import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { WebSocket } from "ws";
import { createAgentRuntimeForTest } from "../src/agent/runtime.js";
import { RepaClient, RpcError } from "../src/client.js";
import { INTERACTION_CAPABILITIES } from "../src/interaction.js";
import type { Host, Plugin, Tool } from "../src/plugin.js";
import { PROTOCOL_VERSION, type Notification, type NotificationParams } from "../src/protocol.js";
import { record } from "../src/protocol/json-rpc.js";
import { startServer, type Reassembly } from "../src/protocol/server.js";
import { currentRun, withRun } from "../src/run-context.js";
import { RepaFault, type AgentEvent } from "../src/schema.js";

function deferred<T = void>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

function next<N extends Notification>(client: RepaClient, method: N, accept: (params: NotificationParams<N>) => boolean = () => true): Promise<NotificationParams<N>> {
  return new Promise(resolve => {
    const stop = client.on(method, params => {
      if (!accept(params)) return;
      stop();
      resolve(params);
    });
  });
}

const rejectsWith = (code: string) => (error: unknown): boolean => {
  if (error instanceof RpcError) {
    assert.equal(record(error.data)?.code, code);
    return true;
  }
  assert.ok(error instanceof RepaFault, String(error));
  assert.equal(error.code, code);
  return true;
};

/** 记下 promise 是否已经结束；断言“还在等”时先走一次协议往返，让已经就绪的回调都执行过。 */
function watch<T>(promise: Promise<T>) {
  const state = { settled: false };
  promise.then(() => { state.settled = true; }, () => { state.settled = true; });
  return state;
}

const empty = Type.Object({}, { additionalProperties: false });

/**
 * 探针插件的可控行为。每次 open 记一次并留下 Host，测试在插件代码之外用它模拟定时器发起的工作。
 * 各个 gate 设上时，对应的插件代码停在那里，等测试放行。
 */
interface Probe {
  opens: number;
  closes: number;
  hosts: Host[];
  hold?: Promise<void>;
  closeEntered?: () => void;
  closeGate?: Promise<void>;
  closeError?: Error;
  submitEntered?: () => void;
  submitGate?: Promise<void>;
  onOpen?: (host: Host) => Promise<void>;
  /** 设上时，之后打开的实例在变化处理（含 start 的追赶）里调用它。 */
  onChange?: (host: Host) => Promise<void>;
}

function probePlugin(probe: Probe, toolName = "probe_lookup"): Plugin {
  return {
    id: "probe",
    async open(host) {
      probe.opens++;
      probe.hosts.push(host);
      host.emit({ type: "opened", opens: probe.opens });
      await probe.onOpen?.(host);
      const lookup: Tool = {
        name: toolName,
        description: "查询课程",
        parameters: empty,
        execute: async () => ({ text: "课程内容" }),
      };
      const ask: Tool = {
        name: "probe_ask",
        description: "请用户回答一个问题",
        parameters: empty,
        async execute(_input, context) {
          const outcome = await context.ask({
            item: { id: "probe.question", body: [], slots: [{ id: "answer", type: "text" }] },
            async onSubmit() {
              probe.submitEntered?.();
              await probe.submitGate;
              await host.files.write("answers.txt", "已作答");
              return { status: "accepted" };
            },
          });
          return { text: outcome.action };
        },
      };
      return {
        tools: () => [lookup, ask],
        methods: {
          hold: { parameters: empty, async invoke() { await probe.hold; return null; } },
          background: {
            parameters: empty,
            async invoke() {
              const work = await host.models.runAgent({ text: "后台整理" });
              return { id: work.id };
            },
          },
          complete: { parameters: empty, invoke: async () => host.models.complete({ system: "说明", prompt: "补判" }) },
          service: { parameters: empty, invoke: async () => host.services.call("probe.run", {}) },
          emit: { parameters: empty, async invoke() { host.emit({ type: "changed" }); return null; } },
        },
        async onChange() {
          await probe.onChange?.(host);
        },
        async close() {
          probe.closes++;
          probe.closeEntered?.();
          await probe.closeGate;
          if (probe.closeError) throw probe.closeError;
        },
      };
    },
  };
}

async function fixture(t: TestContext, options: { plugins?: (probe: Probe) => Plugin[] } = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-reassembly-")));
  const root = path.join(directory, "space");
  const home = path.join(directory, "home");
  await mkdir(root);
  await mkdir(path.join(home, "agent"), { recursive: true });
  const faux = fauxProvider({ api: `reassembly-${randomUUID()}`, provider: `reassembly-${randomUUID()}`, models: [{ id: "scripted", contextWindow: 16384, maxTokens: 256 }], tokensPerSecond: 0 });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(home, "agent", "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const runtime = await createAgentRuntimeForTest({
    agentDir: path.join(home, "agent"),
    modelRuntime,
    defaultModel: { provider: faux.getModel().provider, id: "scripted" },
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
  });
  const probe: Probe = { opens: 0, closes: 0, hosts: [] };
  const plugins = options.plugins?.(probe) ?? [probePlugin(probe)];
  const server = await startServer({ home, plugins, runtime });
  const clients: RepaClient[] = [];
  const connect = async (services: string[] = []) => {
    const client = await RepaClient.connect(server.connection, { capabilities: { interaction: { supports: [...INTERACTION_CAPABILITIES] }, services } });
    clients.push(client);
    return client;
  };
  const client = await connect();
  const events: AgentEvent[] = [];
  client.on("session.event", event => events.push(event));
  const pluginEvents: NotificationParams<"plugin.event">[] = [];
  client.on("plugin.event", event => pluginEvents.push(event));
  t.after(async () => {
    for (const opened of clients) await opened.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const opened = await client.call("space.open", { root });
  return { directory, root, home, faux, runtime, server, client, connect, probe, events, pluginEvents, opened, plugins };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** 走一次不经过闸门的协议往返：此前已经就绪的回调都执行过，仍未结束的确实在等。 */
async function roundTrip(f: Fixture): Promise<void> {
  await f.client.call("space.list", {});
  await new Promise(resolve => setImmediate(resolve));
}

function toolNames(context: TranscriptContext): string[] {
  return getCurrentTools(context.messages).map(tool => tool.name).sort();
}

test("空闲时重组：每个插件 open 一次，已开会话下一次请求用新的工具清单，历史与父关联都在", async t => {
  const f = await fixture(t);
  const seen: string[][] = [];
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("subagent", { agent: "general", task: "查一下第一课" })),
    context => { seen.push(toolNames(context)); return fauxAssistantMessage("子任务查好了"); },
    context => { seen.push(toolNames(context)); return fauxAssistantMessage("第一轮回复"); },
    context => { seen.push(toolNames(context)); return fauxAssistantMessage("重组后的回复"); },
  ]);
  const session = await f.client.call("session.create", {});
  await f.client.call("session.send", { sessionId: session.id, text: "开始" });
  assert.ok(seen[1]?.includes("probe_lookup"));
  const before = await f.client.call("session.history", { sessionId: session.id });
  const children = (await f.client.call("session.list", {})).filter(info => info.parent !== undefined);
  assert.equal(children.length, 1);
  assert.equal(children[0]?.parent?.sessionId, session.id);

  const assembled = next(f.client, "space.assembled");
  const result = await f.server.reassemble([probePlugin(f.probe, "probe_renamed")]);
  assert.equal(result.status, "applied");
  assert.equal(f.probe.opens, 2);
  assert.equal(f.probe.closes, 1);
  const notice = await assembled;
  assert.deepEqual(notice, { root: f.opened.root, assembly: result.status === "applied" ? result.assembly : -1, disabledPlugins: [] });
  assert.ok(result.status === "applied" && result.assembly > f.opened.assembly);

  assert.deepEqual(await f.client.call("session.history", { sessionId: session.id }), before);
  await f.client.call("session.send", { sessionId: session.id, text: "继续" });
  const latest = seen.at(-1) ?? [];
  assert.ok(latest.includes("probe_renamed"));
  assert.ok(!latest.includes("probe_lookup"));
  const after = await f.client.call("session.list", {});
  assert.deepEqual(after.filter(info => info.parent !== undefined).map(info => info.parent), children.map(info => info.parent));
  assert.equal((await f.client.call("session.history", { sessionId: session.id })).findLast(entry => entry.type === "assistant")?.text, "重组后的回复");
});

test("在途的插件调用、后台 Agent、模型调用和服务请求都使重组等待，结束以后才重组", async t => {
  const f = await fixture(t);
  const provider = await f.connect(["probe.run"]);
  const { assembly } = f.opened;

  // 在途的插件方法。
  const hold = deferred();
  f.probe.hold = hold.promise;
  const holding = f.client.call("plugin.call", { pluginId: "probe", method: "hold", input: {}, assembly });
  await roundTrip(f);
  const first = f.server.reassemble();
  const firstState = watch(first);
  await roundTrip(f);
  assert.equal(firstState.settled, false);
  assert.equal(f.probe.opens, 1);
  hold.resolve();
  await holding;
  assert.equal((await first).status, "applied");
  assert.equal(f.probe.opens, 2);
  const current = () => f.client.call("space.open", { root: f.root }).then(opened => opened.assembly);

  // 插件发起的后台 Agent 运行。
  const replying = deferred();
  const release = deferred();
  f.faux.setResponses([async () => { replying.resolve(); await release.promise; return fauxAssistantMessage("整理好了"); }]);
  await f.client.call("plugin.call", { pluginId: "probe", method: "background", input: {}, assembly: await current() });
  await replying.promise;
  const second = f.server.reassemble();
  const secondState = watch(second);
  await roundTrip(f);
  assert.equal(secondState.settled, false);
  assert.equal(f.probe.opens, 2);
  release.resolve();
  assert.equal((await second).status, "applied");
  assert.equal(f.probe.opens, 3);

  // 插件定时器发起的模型调用，不属于任何协议请求。
  const completing = deferred();
  const finish = deferred();
  f.faux.setResponses([async () => { completing.resolve(); await finish.promise; return fauxAssistantMessage("补判完成"); }]);
  const timer = f.probe.hosts.at(-1)?.models.complete({ system: "说明", prompt: "补判" });
  assert.ok(timer);
  await completing.promise;
  const third = f.server.reassemble();
  const thirdState = watch(third);
  await roundTrip(f);
  assert.equal(thirdState.settled, false);
  finish.resolve();
  assert.equal(await timer, "补判完成");
  assert.equal((await third).status, "applied");
  assert.equal(f.probe.opens, 4);

  // 交给前端的服务请求。
  const requested = next(provider, "service.request");
  const serving = f.client.call("plugin.call", { pluginId: "probe", method: "service", input: {}, assembly: await current() });
  const request = await requested;
  const fourth = f.server.reassemble();
  const fourthState = watch(fourth);
  await roundTrip(f);
  assert.equal(fourthState.settled, false);
  await provider.call("service.reply", { id: request.id, result: { ok: true } });
  assert.deepEqual(await serving, { ok: true });
  assert.equal((await fourth).status, "applied");
  assert.equal(f.probe.opens, 5);
});

test("插件经 Host 发起的历史记录在进行时重组等它结束；开始关闭以后旧实例新发起的模型与服务调用立即被拒绝，不等闸门", async t => {
  const f = await fixture(t);
  const host = f.probe.hosts[0];
  assert.ok(host);
  const inside = deferred();
  const leave = deferred();
  const recording = host.history.record({ kind: "plugin", pluginId: "probe" }, async () => {
    inside.resolve();
    await leave.promise;
  });
  await inside.promise;
  const closing = deferred();
  const closeGate = deferred();
  f.probe.closeEntered = () => closing.resolve();
  f.probe.closeGate = closeGate.promise;
  const reassembling = f.server.reassemble();
  const state = watch(reassembling);
  await roundTrip(f);
  assert.equal(state.settled, false);
  assert.equal(f.probe.closes, 0);
  leave.resolve();
  await recording;
  await closing.promise;

  // 旧实例的关闭停在插件代码里：闸门已落下，旧 Host 上新发起的模型与服务调用都立即失败，没有一项等待重组。
  // 文件与历史操作在这个插件的 close 执行期间放行，见下面的用例。
  await assert.rejects(host.models.complete({ system: "说明", prompt: "迟到的补判" }), rejectsWith("models_closed"));
  await assert.rejects(host.models.runAgent({ text: "迟到的后台任务" }), rejectsWith("models_closed"));
  await assert.rejects(host.services.call("probe.run", {}), rejectsWith("plugins_closed"));
  assert.equal(f.faux.state.callCount, 0);
  closeGate.resolve();
  assert.equal((await reassembling).status, "applied");
  assert.equal(f.probe.opens, 2);
});

/**
 * 方法返回以后在后台继续的插件：后台工作等 close 放行才写结果，close 等它写完。
 * 每个实例的 Host 都留在 hosts 里，log 按发生次序记下写入结果与开关。
 */
function backgroundPlugin(hosts: Host[], log: string[]): Plugin {
  return {
    id: "bg",
    async open(host) {
      hosts.push(host);
      const generation = hosts.length;
      log.push(`open ${generation}`);
      if (generation > 1) {
        // 新装配已经开始：旧实例这时再写，必须被拒绝。
        const old = hosts[generation - 2];
        await old?.files.write("stale.txt", "旧实例").then(
          () => { log.push("stale written"); },
          (error: unknown) => { log.push(`stale ${error instanceof RepaFault ? error.code : String(error)}`); },
        );
      }
      let release: () => void = () => undefined;
      let background: Promise<void> = Promise.resolve();
      return {
        methods: {
          start: {
            parameters: empty,
            async invoke() {
              const go = new Promise<void>(resolve => { release = resolve; });
              background = (async () => {
                await go;
                await host.files.write("bg.txt", `后台结果 ${generation}`);
                log.push(`background ${generation} written`);
              })().catch((error: unknown) => { log.push(`background ${generation} ${error instanceof RepaFault ? error.code : String(error)}`); });
              return null;
            },
          },
        },
        async close() {
          release();
          await background;
          log.push(`close ${generation} returned`);
        },
      };
    },
  };
}

test("重组时插件 close 等待的后台工作可以经 Host 写入结果；close 返回以后旧实例的写入被拒绝，不会落在新装配里", async t => {
  const hosts: Host[] = [];
  const log: string[] = [];
  const f = await fixture(t, { plugins: () => [backgroundPlugin(hosts, log)] });
  assert.equal(await f.client.call("plugin.call", { pluginId: "bg", method: "start", input: {}, assembly: f.opened.assembly }), null);
  assert.equal((await f.server.reassemble()).status, "applied");
  assert.deepEqual(log, ["open 1", "background 1 written", "close 1 returned", "open 2", "stale plugins_closed"]);
  assert.equal(await readFile(path.join(f.root, "bg.txt"), "utf8"), "后台结果 1");
  await assert.rejects(readFile(path.join(f.root, "stale.txt")), { code: "ENOENT" });
  const old = hosts[0];
  assert.ok(old);
  await assert.rejects(old.history.record({ kind: "plugin", pluginId: "bg" }, async () => undefined), rejectsWith("plugins_closed"));
});

test("关闭空间时插件 close 等待的后台工作可以经 Host 写入结果；关闭以后旧实例的写入被拒绝", async t => {
  const hosts: Host[] = [];
  const log: string[] = [];
  const f = await fixture(t, { plugins: () => [backgroundPlugin(hosts, log)] });
  assert.equal(await f.client.call("plugin.call", { pluginId: "bg", method: "start", input: {}, assembly: f.opened.assembly }), null);
  await f.client.call("space.close", {});
  assert.deepEqual(log, ["open 1", "background 1 written", "close 1 returned"]);
  assert.equal(await readFile(path.join(f.root, "bg.txt"), "utf8"), "后台结果 1");
  const old = hosts[0];
  assert.ok(old);
  await assert.rejects(old.files.write("stale.txt", "旧实例"), rejectsWith("plugins_closed"));
});

test("运行结束后仍在处理的作答回调使重组等待，回调写完文件后才重组", async t => {
  const f = await fixture(t);
  const session = await f.client.call("session.create", {});
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("probe_ask", {})), fauxAssistantMessage("问完了")]);
  const asked = next(f.client, "ask.request");
  const running = f.client.call("session.send", { sessionId: session.id, text: "问我一个问题" });
  const request = await asked;
  const entered = deferred();
  const gate = deferred();
  f.probe.submitEntered = () => entered.resolve();
  f.probe.submitGate = gate.promise;
  const submitting = f.client.call("ask.reply", {
    id: request.id,
    action: "submit",
    response: { item: { id: request.item.id, version: request.item.version }, answers: { answer: { type: "text", text: "七" } } },
  });
  await entered.promise;
  // 用户停止运行：询问随之结束，运行收尾，但插件的回调还在执行。
  await f.client.call("session.abort", { sessionId: session.id });
  await running.catch(() => undefined);
  const reassembling = f.server.reassemble();
  const state = watch(reassembling);
  await roundTrip(f);
  assert.equal(state.settled, false);
  assert.equal(f.probe.opens, 1);
  gate.resolve();
  await assert.rejects(submitting, rejectsWith("ask_not_found"));
  assert.equal((await reassembling).status, "applied");
  assert.equal(await readFile(path.join(f.root, "answers.txt"), "utf8"), "已作答");
});

/** 让旧实例的关闭停住，闸门在此期间一直落着。 */
async function holdGate(f: Fixture) {
  const closing = deferred();
  const gate = deferred();
  f.probe.closeEntered = () => closing.resolve();
  f.probe.closeGate = gate.promise;
  const reassembling = f.server.reassemble();
  await closing.promise;
  return {
    reassembling,
    async lift() {
      gate.resolve();
      const result = await reassembling;
      assert.equal(result.status, "applied");
      return result;
    },
  };
}

test("闸门期间同一会话先发消息再停止：停止作废等待中的发送与压缩，抬起闸门后不再运行", async t => {
  const f = await fixture(t);
  const session = await f.client.call("session.create", {});
  f.faux.setResponses([fauxAssistantMessage("第一轮")]);
  await f.client.call("session.send", { sessionId: session.id, text: "第一条" });
  const calls = f.faux.state.callCount;
  const runs = () => f.events.filter(event => event.type === "runStart" && event.sessionId === session.id).length;
  const started = runs();
  const held = await holdGate(f);
  const sending = f.client.call("session.send", { sessionId: session.id, text: "闸门期间的消息" });
  const compacting = f.client.call("session.compact", { sessionId: session.id });
  await roundTrip(f);
  const stopping = f.client.call("session.abort", { sessionId: session.id });
  await assert.rejects(sending, rejectsWith("cancelled"));
  await assert.rejects(compacting, rejectsWith("cancelled"));
  await held.lift();
  await stopping;
  assert.equal(f.faux.state.callCount, calls);
  const users = (await f.client.call("session.history", { sessionId: session.id })).filter(entry => entry.type === "user").map(entry => entry.text);
  assert.deepEqual(users, ["第一条"]);
  assert.equal(runs(), started);
});

test("闸门期间到达的插件调用在新实例上执行；新连接的初始化等到装配完成，基线带新的序号", async t => {
  const f = await fixture(t);
  const held = await holdGate(f);
  const calling = f.client.call("plugin.call", { pluginId: "probe", method: "emit", input: {}, assembly: f.opened.assembly });
  const late = RepaClient.connect(f.server.connection);
  const lateState = watch(late);
  await roundTrip(f);
  assert.equal(lateState.settled, false);
  const result = await held.lift();
  assert.equal(await calling, null);
  const reconnected = await late;
  t.after(() => reconnected.close());
  assert.ok(result.status === "applied");
  assert.deepEqual(reconnected.handshake.baseline.space, { root: f.opened.root, assembly: result.assembly });
  // 新实例打开时与方法里发的事件带新序号；旧序号的事件只有第一次打开时那一条。
  assert.deepEqual(f.pluginEvents.map(event => [event.assembly, record(event.event)?.type]), [
    [f.opened.assembly, "opened"],
    [result.assembly, "opened"],
    [result.assembly, "changed"],
  ]);
});

test("还没有第一条消息的会话经过连续两次重组仍能发送，不报错", async t => {
  const f = await fixture(t);
  const session = await f.client.call("session.create", {});
  // 第二次重组时这个会话还没有被再次用到，也要带过去。
  assert.equal((await f.server.reassemble()).status, "applied");
  assert.equal((await f.server.reassemble()).status, "applied");
  f.faux.setResponses([fauxAssistantMessage("新会话的回复")]);
  await f.client.call("session.send", { sessionId: session.id, text: "第一条消息" });
  const history = await f.client.call("session.history", { sessionId: session.id });
  assert.deepEqual(history.filter(entry => entry.type === "user" || entry.type === "assistant").map(entry => entry.text), ["第一条消息", "新会话的回复"]);
  assert.equal((await f.client.call("session.list", {})).find(info => info.id === session.id)?.model?.id, "scripted");
});

test("插件 close 抛错不挡住重组：结果写明是哪个插件；旧实例经 Host 的写入被拒绝，新实例照常运行", async t => {
  const f = await fixture(t);
  const old = f.probe.hosts[0];
  assert.ok(old);
  f.probe.closeError = new Error("定时器没有收回");
  const result = await f.server.reassemble();
  assert.ok(result.status === "applied");
  assert.deepEqual(result.closeFailures, [{ pluginId: "probe", message: "定时器没有收回" }]);
  assert.equal(f.probe.opens, 2);
  f.probe.closeError = undefined;
  await assert.rejects(old.files.write("stale.txt", "旧实例"), rejectsWith("plugins_closed"));
  await assert.rejects(old.history.record({ kind: "plugin", pluginId: "probe" }, async () => undefined), rejectsWith("plugins_closed"));
  const fresh = f.probe.hosts[1];
  assert.ok(fresh);
  await fresh.files.write("fresh.txt", "新实例");
  assert.equal(await readFile(path.join(f.root, "fresh.txt"), "utf8"), "新实例");
});

test("装配期间插件 open 调用前端服务立即以 service_unavailable 失败，不等前端", async t => {
  const failures: unknown[] = [];
  const f = await fixture(t);
  await f.connect(["probe.run"]);
  f.probe.onOpen = async host => {
    await host.services.call("probe.run", {}).catch((error: unknown) => { failures.push(error); });
  };
  assert.equal((await f.server.reassemble()).status, "applied");
  assert.equal(failures.length, 1);
  rejectsWith("service_unavailable")(failures[0]);
});

test("切换空间以后，带着旧空间序号的插件调用被拒绝；同一次打开里早于重组的序号仍然可用", async t => {
  const f = await fixture(t);
  const result = await f.server.reassemble();
  assert.ok(result.status === "applied");
  assert.equal(await f.client.call("plugin.call", { pluginId: "probe", method: "emit", input: {}, assembly: f.opened.assembly }), null);
  const other = path.join(f.directory, "other");
  await mkdir(other);
  const switched = await f.client.call("space.open", { root: other });
  assert.ok(switched.assembly > result.assembly);
  await assert.rejects(f.client.call("plugin.call", { pluginId: "probe", method: "emit", input: {}, assembly: result.assembly }), rejectsWith("space_changed"));
  assert.equal(await f.client.call("plugin.call", { pluginId: "probe", method: "emit", input: {}, assembly: switched.assembly }), null);
});

test("等待空闲时关闭空间：重组以 cancelled 结束，不再打开插件", async t => {
  const f = await fixture(t);
  const hold = deferred();
  f.probe.hold = hold.promise;
  const holding = f.client.call("plugin.call", { pluginId: "probe", method: "hold", input: {}, assembly: f.opened.assembly });
  await roundTrip(f);
  const reassembling = f.server.reassemble();
  const closing = f.client.call("space.close", {});
  // 关闭先等在途的插件调用；它一开始就放下空间，等待中的重组随即取消，不等调用结束。
  assert.deepEqual(await reassembling, { status: "cancelled" });
  hold.resolve();
  await holding;
  await closing;
  assert.equal(f.probe.opens, 1);
});

test("关闭空间时插件持有空间写锁等模型，通用 Agent 的运行在等这把锁：两者一起开始关闭，不互相等待", async t => {
  const f = await fixture(t);
  const host = f.probe.hosts[0];
  assert.ok(host);
  const modelWaiting = deferred();
  f.faux.setResponses([async (_context, options) => {
    modelWaiting.resolve();
    await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
    return fauxAssistantMessage("不应完成");
  }]);
  // 插件动作持有独占写锁，在里面等模型：模型请求只在宿主关闭时取消。
  const recording = host.history.record({ kind: "plugin", pluginId: "probe" }, async () => {
    await host.models.complete({ system: "说明", prompt: "持锁时的模型调用" });
  }).catch((error: unknown) => error);
  await modelWaiting.promise;
  // 通用 Agent 带命令行，整次运行进 record，排在同一把锁后面。
  const session = await f.client.call("session.create", {});
  const running = f.client.call("session.send", { sessionId: session.id, text: "整理文件" }).catch((error: unknown) => error);
  // 发送请求从进入后端到登记运行、再到等锁，中间只有微任务：一次协议往返之后它已经在等锁。
  // 新连接的基线列出已登记、还没开始的运行，用来确认这一点。
  await roundTrip(f);
  const observer = await f.connect();
  assert.ok((observer.handshake.baseline.sessions.find(item => item.sessionId === session.id)?.queued ?? []).some(item => item.text === "整理文件"));
  await f.client.call("space.close", {});
  rejectsWith("cancelled")(await running);
  assert.ok(await recording instanceof Error);
});

test("重组整体失败时空间随之关闭，space.assembled 带原因、root 为 null，闸门抬起，等待的请求得到明确的错误", async t => {
  const f = await fixture(t);
  const held = await (async () => {
    const closing = deferred();
    const gate = deferred();
    f.probe.closeEntered = () => closing.resolve();
    f.probe.closeGate = gate.promise;
    // 两个同 id 的插件使整个插件宿主打不开，不是单个插件停用。
    const reassembling = f.server.reassemble([probePlugin(f.probe), probePlugin(f.probe)]);
    await closing.promise;
    return { reassembling, lift: () => gate.resolve() };
  })();
  const assembled = next(f.client, "space.assembled");
  const waiting = f.client.call("session.list", {});
  await roundTrip(f);
  held.lift();
  await assert.rejects(held.reassembling, rejectsWith("invalid_plugin_id"));
  assert.deepEqual(await assembled, { root: null, error: { code: "invalid_plugin_id", message: "插件 id 必须唯一，且仅含小写字母、数字和连字符" } });
  await assert.rejects(waiting, rejectsWith("space_changed"));
  await assert.rejects(f.client.call("agent.list", {}), rejectsWith("space_not_open"));
  // 空间锁已经释放，可以重新打开。
  const reopened = await f.client.call("space.open", { root: f.root });
  assert.ok(reopened.assembly > f.opened.assembly);
});

test("两次重组同时请求：各自经过一次重组，第二次不被当作空间已经切换", async t => {
  const f = await fixture(t);
  const first = f.server.reassemble();
  const second = f.server.reassemble();
  const results = [await first, await second];
  assert.deepEqual(results.map(result => result.status), ["applied", "applied"]);
  assert.ok(results[0]?.status === "applied" && results[1]?.status === "applied" && results[1].assembly > results[0].assembly);
  assert.equal(f.probe.opens, 3);
});

test("由一次运行里发起的工作结束而触发的重组不继承那次运行：新实例 open 时不在运行里，它的写入不随撤销运行删除", async t => {
  const seen: (string | undefined)[] = [];
  const f = await fixture(t);
  f.probe.onOpen = async host => {
    seen.push(currentRun()?.runId);
    await host.files.write("opened.txt", "新实例");
  };
  const host = f.probe.hosts[0];
  assert.ok(host);
  // 插件工具在运行 R 里发起的模型调用，R 结束以后仍在进行；它结束时触发等待中的重组。
  const completing = deferred();
  const finish = deferred();
  f.faux.setResponses([async () => { completing.resolve(); await finish.promise; return fauxAssistantMessage("补判完成"); }]);
  const runId = randomUUID();
  const timer = withRun({ runId, ancestorRunIds: [], sessionId: randomUUID(), agent: "general" }, () => host.models.complete({ system: "说明", prompt: "补判" }));
  await completing.promise;
  const reassembling = f.server.reassemble();
  await roundTrip(f);
  finish.resolve();
  await timer;
  assert.equal((await reassembling).status, "applied");
  assert.deepEqual(seen, [undefined]);
  const [latest] = await f.client.call("history.list", { limit: 1 });
  assert.deepEqual(latest?.source, { kind: "plugin", pluginId: "probe" });
  await f.client.call("history.undoRun", { runId }).catch(() => undefined);
  assert.equal(await readFile(path.join(f.root, "opened.txt"), "utf8"), "新实例");
});

test("服务关闭时重组正等旧实例收尾：不再打开新实例，重组以 cancelled 结束", async t => {
  const f = await fixture(t);
  const closing = deferred();
  const gate = deferred();
  f.probe.closeEntered = () => closing.resolve();
  f.probe.closeGate = gate.promise;
  const reassembling = f.server.reassemble();
  await closing.promise;
  const stopped = f.server.close();
  gate.resolve();
  await stopped;
  assert.deepEqual(await reassembling, { status: "cancelled" });
  assert.equal(f.probe.opens, 1);
});

test("带着比当前更大的序号的插件调用以 space_changed 拒绝：它只能来自此前的后端进程", async t => {
  const f = await fixture(t);
  await assert.rejects(f.client.call("plugin.call", { pluginId: "probe", method: "emit", input: {}, assembly: f.opened.assembly + 1 }), rejectsWith("space_changed"));
});

interface RawReply { id: number; result?: unknown; error?: { code: number; message: string; data?: unknown } }

/** 不经 RepaClient 的连接：可以发批量请求，也可以再发一次 initialize。连接时先初始化一次。 */
async function rawConnect(t: TestContext, f: Fixture) {
  const socket = new WebSocket(f.server.connection.url);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  t.after(() => socket.close());
  const replies = new Map<number, (reply: RawReply) => void>();
  socket.on("message", data => {
    const value: unknown = JSON.parse(String(data));
    for (const item of Array.isArray(value) ? value : [value]) {
      const id = record(item)?.id;
      if (typeof id === "number") replies.get(id)?.(item as RawReply);
    }
  });
  let last = 0;
  const send = (requests: { method: string; params?: unknown }[]): Promise<RawReply[]> => {
    const framed = requests.map(request => ({ jsonrpc: "2.0", id: ++last, ...request }));
    const answers = framed.map(request => new Promise<RawReply>(resolve => replies.set(request.id, resolve)));
    socket.send(JSON.stringify(framed.length === 1 ? framed[0] : framed));
    return Promise.all(answers);
  };
  const initialize = { method: "initialize", params: { token: f.server.connection.token, version: PROTOCOL_VERSION } };
  const [handshake] = await send([initialize]);
  assert.equal(handshake?.error, undefined);
  return { send, initialize };
}

/** 从现在起数 ticks 个微任务以后执行 action。 */
function afterTicks<T>(ticks: number, action: () => Promise<T>): Promise<T> {
  let wait = Promise.resolve();
  for (let index = 0; index < ticks; index++) wait = wait.then(() => undefined);
  return wait.then(action);
}

// 闸门检查与登记之间若有 await，这段间隙里开始的重组会让请求落到正在关闭的实例上（plugins_closed）。
// 准确的间隙长度取决于实现，所以把重组请求依次放在后一项请求到达以后的第 0 到第 7 个微任务上，每一处都不能出错。
test("请求到达后、登记前的任一微任务里开始重组：请求要么使重组等它，要么等到新装配，不落到正在关闭的实例上", async t => {
  const f = await fixture(t);
  const raw = await rawConnect(t, f);
  const listModels = f.runtime.listModels.bind(f.runtime);
  t.after(() => { f.runtime.listModels = listModels; });
  for (let ticks = 0; ticks < 8; ticks++) {
    let reassembled: Promise<Reassembly> | undefined;
    // 同一批里先处理的 model.list 同步调用运行时，从这里数微任务；后一项 plugin.call 紧接着在同一段同步代码里到达。
    f.runtime.listModels = () => {
      reassembled = afterTicks(ticks, () => f.server.reassemble());
      return listModels();
    };
    const [, call] = await raw.send([
      { method: "model.list", params: {} },
      { method: "plugin.call", params: { pluginId: "probe", method: "emit", input: {}, assembly: f.opened.assembly } },
    ]);
    f.runtime.listModels = listModels;
    assert.equal(call?.error, undefined, `第 ${ticks} 个微任务：${JSON.stringify(call?.error)}`);
    assert.equal((await reassembled)?.status, "applied");
  }
});

test("在闸门前等过的请求，闸门抬起后、登记前的任一微任务里开始下一次重组：请求仍不落到正在关闭的实例上", async t => {
  const f = await fixture(t);
  const raw = await rawConnect(t, f);
  for (let ticks = 0; ticks < 8; ticks++) {
    const held = await holdGate(f);
    const calling = raw.send([{ method: "plugin.call", params: { pluginId: "probe", method: "emit", input: {}, assembly: f.opened.assembly } }]);
    await roundTrip(f);
    // 第一次重组的结果交回以后紧接着抬起闸门；从交回起数微任务再请求下一次重组。
    const second = held.reassembling.then(() => afterTicks(ticks, () => f.server.reassemble()));
    await held.lift();
    const [call] = await calling;
    assert.equal(call?.error, undefined, `第 ${ticks} 个微任务：${JSON.stringify(call?.error)}`);
    assert.equal((await second).status, "applied");
  }
});

test("批里的初始化已经执行、同批的插件调用结束时开始重组：初始化的基线等闸门抬起以后才生成，带新的序号", async t => {
  const f = await fixture(t);
  const raw = await rawConnect(t, f);
  const hold = deferred();
  f.probe.hold = hold.promise;
  const closing = deferred();
  const closeGate = deferred();
  f.probe.closeEntered = () => closing.resolve();
  f.probe.closeGate = closeGate.promise;
  // 已经初始化过的连接再发一次 initialize，与一项还没结束的插件调用同批。
  const replying = raw.send([raw.initialize, { method: "plugin.call", params: { pluginId: "probe", method: "hold", input: {}, assembly: f.opened.assembly } }]);
  await roundTrip(f);
  const reassembling = f.server.reassemble();
  // 插件调用结束使计数归零，重组随即落闸，旧实例的关闭停在插件代码里。
  hold.resolve();
  await closing.promise;
  closeGate.resolve();
  const result = await reassembling;
  assert.ok(result.status === "applied");
  const [initialized, held] = await replying;
  assert.equal(held?.error, undefined);
  assert.deepEqual(record(record(initialized?.result)?.baseline)?.space, { root: f.opened.root, assembly: result.assembly });
});

/** 模型请求在被取消或测试放行时结束；aborted 记下它是不是被取消的。 */
function cancellableReply(f: Fixture) {
  const waiting = deferred();
  const release = deferred();
  const state = { aborted: false };
  f.faux.setResponses([async (_context, options) => {
    waiting.resolve();
    await new Promise<void>(resolve => {
      options?.signal?.addEventListener("abort", () => { state.aborted = true; resolve(); }, { once: true });
      void release.promise.then(() => resolve());
    });
    return fauxAssistantMessage("模型回复");
  }]);
  return { waiting: waiting.promise, release: () => release.resolve(), state };
}

const codeOf = (error: unknown) => error instanceof RepaFault ? error.code : String(error);

test("关闭服务时插件持有空间写锁等模型，通用 Agent 的运行在等这把锁：一开始就通知插件宿主停止，不等运行时先收尾", async t => {
  const f = await fixture(t);
  const host = f.probe.hosts[0];
  assert.ok(host);
  const reply = cancellableReply(f);
  const recording = host.history.record({ kind: "plugin", pluginId: "probe" }, async () => {
    await host.models.complete({ system: "说明", prompt: "持锁时的模型调用" });
  }).catch((error: unknown) => error);
  await reply.waiting;
  const session = await f.client.call("session.create", {});
  const running = f.client.call("session.send", { sessionId: session.id, text: "整理文件" }).catch((error: unknown) => error);
  await roundTrip(f);
  const observer = await f.connect();
  assert.ok((observer.handshake.baseline.sessions.find(item => item.sessionId === session.id)?.queued ?? []).some(item => item.text === "整理文件"));
  const stopped = f.server.close();
  // 宿主已收到停止通知时，服务调用以 plugins_closed 立即失败；还没收到时会走到服务路由，得到 service_unavailable。
  const probe = await host.services.call("probe.run", {}).then(() => "accepted", codeOf);
  // 修正以前模型请求不会被取消，二者互相等待；放行它，测试照样结束，结论看下面的断言。
  reply.release();
  await stopped;
  assert.equal(probe, "plugins_closed");
  assert.equal(reply.state.aborted, true);
  assert.ok(await recording instanceof Error);
  assert.ok(await running instanceof Error);
});

test("关闭服务时新装配正在追赶、持锁等自己的模型请求：尚未发布的装配也收到停止通知，重组以 cancelled 结束", async t => {
  const f = await fixture(t);
  const first = f.probe.hosts[0];
  assert.ok(first);
  // 追赶从最近一次修订开始，先留下一次修订。
  await first.files.write("seed.txt", "种子");
  const reply = cancellableReply(f);
  f.probe.onChange = async host => {
    if (host === first) return;
    await host.history.record({ kind: "plugin", pluginId: "probe" }, async () => {
      await host.models.complete({ system: "说明", prompt: "追赶时的模型调用" });
    });
  };
  const reassembling = f.server.reassemble();
  await reply.waiting;
  const fresh = f.probe.hosts[1];
  assert.ok(fresh);
  const stopped = f.server.close();
  const probe = await fresh.services.call("probe.run", {}).then(() => "accepted", codeOf);
  reply.release();
  await stopped;
  assert.equal(probe, "plugins_closed");
  assert.equal(reply.state.aborted, true);
  assert.deepEqual(await reassembling, { status: "cancelled" });
});
