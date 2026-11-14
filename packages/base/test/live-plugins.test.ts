import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAgentRuntimeForTest } from "../src/agent/runtime.js";
import { withFileMutationQueue, type AgentSession, type AgentSpace } from "../src/agent.js";
import type { AgentDefinition, Host, Plugin, PluginInstance } from "../src/plugin.js";
import { openPluginHost, type PluginHost } from "../src/plugins.js";
import type { AgentEvent } from "../src/schema.js";
import { createSpace } from "../src/space.js";
import { ModelTestDriver } from "../src/testing.js";

const empty = Type.Object({}, { additionalProperties: false });

/** 每个插件 open 与 close 的调用次数，用来断言装卸只动了一个插件。 */
class Lifecycle {
  readonly opens = new Map<string, number>();
  readonly closes = new Map<string, number>();
  opened(id: string): void { this.opens.set(id, (this.opens.get(id) ?? 0) + 1); }
  closed(id: string): void { this.closes.set(id, (this.closes.get(id) ?? 0) + 1); }
  counts(id: string): [number, number] { return [this.opens.get(id) ?? 0, this.closes.get(id) ?? 0]; }
}

function barrier(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

/** 一个只有一个工具的插件；工具返回自己的版本号。 */
function toolPlugin(id: string, tool: string, version: string, life: Lifecycle, extra: (host: Host) => Partial<PluginInstance> = () => ({})): Plugin {
  return {
    id,
    async open(host) {
      life.opened(id);
      return {
        tools: () => [{ name: tool, description: `${tool} ${version}`, parameters: empty, execute: async () => ({ text: `${tool} ${version}` }) }],
        close: async () => { life.closed(id); },
        ...extra(host),
      };
    },
  };
}

async function fixture(t: TestContext, plugins: Plugin[], options: { extensionFactories?: ExtensionFactory[] } = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-live-plugins-")));
  const space = await createSpace(path.join(directory, "space"), { watch: false, fileQueue: withFileMutationQueue });
  const faux = fauxProvider({ api: `live-api-${randomUUID()}`, provider: `live-${randomUUID()}`, models: [{ id: "test", contextWindow: 16384, maxTokens: 512 }], tokensPerSecond: 0 });
  const models = await ModelRuntime.create({ authPath: path.join(directory, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  models.registerNativeProvider(faux.provider);
  const runtime = await createAgentRuntimeForTest({
    agentDir: path.join(directory, "agent"),
    modelRuntime: models,
    defaultModel: { provider: faux.getModel().provider, id: "test" },
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
    ...(options.extensionFactories === undefined ? {} : { extensionFactories: options.extensionFactories }),
  });
  // 测试控制插件：通用 Agent 调用 ctl，在它的工具调用里执行测试安排的动作，例如加上或撤下插件。
  const actions = new Map<string, () => Promise<string>>();
  const ctl: Plugin = {
    id: "ctl",
    open: async () => ({
      tools: () => [{
        name: "ctl",
        description: "测试控制",
        parameters: Type.Object({ action: Type.String() }, { additionalProperties: false }),
        async execute(input) {
          const action = actions.get((input as { action: string }).action);
          if (action === undefined) throw new Error("没有安排这个动作");
          return { text: await action() };
        },
      }],
    }),
  };
  const errors: unknown[] = [];
  const events: AgentEvent[] = [];
  const emitted: { pluginId: string; event: unknown }[] = [];
  const host: PluginHost = await openPluginHost({ space, plugins: [ctl, ...plugins], models: new ModelTestDriver(), emit: (pluginId, event) => { emitted.push({ pluginId, event }); }, onError: (error) => { errors.push(error); } });
  const agentOptions = {
    root: space.root,
    sessionsDir: space.sessionsDir,
    instructions: () => host.instructions(),
    tools: () => host.tools(),
    views: () => host.views(),
    agents: () => host.agents(),
    overrides: async () => ({ app: {}, space: {} }),
    commandPolicy: () => "fullAccess" as const,
    // 与装配相同：带命令行的运行整次持空间写锁独占。
    record: async <T>(runId: string, action: () => Promise<T>) => (await space.record({ kind: "agent", runId }, action)).value,
    writes: space.writes,
    onEvent: (event: AgentEvent) => { events.push(event); },
    confirm: async () => true,
  };
  let agents: AgentSpace = await runtime.openSpace(agentOptions);
  await host.start();
  t.after(async () => {
    await Promise.allSettled([agents.close(), host.close()]);
    await runtime.close();
    await space.close();
    await rm(directory, { recursive: true, force: true });
  });
  // 每次模型请求声明的工具。
  const requests: string[][] = [];
  // 每次模型请求的系统提示。
  const prompts: string[] = [];
  const script = (...steps: (AssistantMessage | ((context: TranscriptContext) => AssistantMessage))[]) => {
    faux.setResponses(steps.map((step) => (context: TranscriptContext) => {
      requests.push(getCurrentTools(context.messages).map((tool) => tool.name));
      prompts.push(getCurrentSystemPrompt(context.messages));
      return typeof step === "function" ? step(context) : step;
    }));
  };
  return {
    space, host, actions, errors, events, emitted, requests, prompts, script,
    get agents() { return agents; },
    /** 关掉 Agent 空间再打开一个新的：会话从文件重新打开。 */
    async reopenAgents() {
      await agents.close();
      agents = await runtime.openSpace(agentOptions);
      return agents;
    },
  };
}

function toolResults(session: AgentSession): { tool: unknown; isError: unknown; text: string }[] {
  return session.history().filter((entry) => entry.type === "tool").map((entry) => {
    const data = entry.data !== null && typeof entry.data === "object" ? entry.data : {};
    return { tool: "tool" in data ? data.tool : undefined, isError: "isError" in data ? data.isError : undefined, text: entry.text ?? "" };
  });
}

function fault(code: string) {
  return (error: unknown) => error !== null && typeof error === "object" && "code" in error && error.code === code;
}

test("运行中途加上插件：同一条回复里的调用仍按原来的集合，下一次回复就能调用新工具", async (t) => {
  const life = new Lifecycle();
  const f = await fixture(t, [toolPlugin("other", "other_get", "v1", life)]);
  f.actions.set("add", async () => {
    await f.host.add(toolPlugin("count", "count_get", "v1", life));
    return "已加上";
  });
  const session = await f.agents.create();
  f.script(
    fauxAssistantMessage([fauxToolCall("ctl", { action: "add" }), fauxToolCall("count_get", {})]),
    fauxAssistantMessage(fauxToolCall("count_get", {})),
    fauxAssistantMessage("完成"),
  );
  await session.send("加上计数插件");
  assert.equal(f.requests[0]?.includes("count_get"), false);
  assert.equal(f.requests[1]?.includes("count_get"), true);
  // 系统提示在运行中途不变，新插件的说明下一次运行才进入。
  assert.equal(f.prompts[1], f.prompts[0]);
  assert.deepEqual(toolResults(session).map(({ tool, isError, text }) => [tool, isError, text]), [
    ["ctl", false, "已加上"],
    ["count_get", true, "Tool count_get not found"],
    ["count_get", false, "count_get v1"],
  ]);
  // 只打开了新插件，已有的插件没有关闭也没有重新打开。
  assert.deepEqual(life.counts("other"), [1, 0]);
  assert.deepEqual(life.counts("count"), [1, 0]);
});

test("运行中途撤下插件：下一次回复不再声明，已经发出的调用失败，别的会话的下一步也看不到，别的插件不受影响", async (t) => {
  const life = new Lifecycle();
  const entered = barrier();
  const removed = barrier();
  const f = await fixture(t, [
    toolPlugin("other", "other_get", "v1", life),
    toolPlugin("count", "count_get", "v1", life, () => ({
      tools: () => [{
        name: "count_get",
        description: "计数",
        parameters: empty,
        // 调用进到插件里以后，等测试撤下插件才返回。
        async execute() {
          entered.release();
          await removed.promise;
          return { text: "撤下以后才返回" };
        },
      }],
    })),
  ]);
  const other = await f.agents.create();
  f.script(fauxAssistantMessage("看到了"));
  await other.send("第一次");
  assert.equal(f.requests[0]?.includes("count_get"), true);

  f.actions.set("remove", async () => {
    await entered.promise;
    const closing = f.host.remove("count");
    removed.release();
    await closing;
    return "已撤下";
  });
  const session = await f.agents.create();
  f.script(
    fauxAssistantMessage([fauxToolCall("count_get", {}), fauxToolCall("ctl", { action: "remove" })]),
    fauxAssistantMessage("完成"),
  );
  await session.send("撤下计数插件");
  assert.equal(f.requests[1]?.includes("count_get"), true);
  assert.equal(f.requests[2]?.includes("count_get"), false);
  const results = toolResults(session);
  assert.deepEqual(results.map(({ tool, isError }) => [tool, isError]), [["count_get", true], ["ctl", false]]);
  assert.match(results[0]?.text ?? "", /插件已经关闭/u);

  f.script(fauxAssistantMessage("再看一次"));
  await other.send("第二次");
  assert.equal(f.requests[3]?.includes("count_get"), false);
  assert.equal(f.requests[3]?.includes("other_get"), true);
  assert.deepEqual(life.counts("count"), [1, 1]);
  assert.deepEqual(life.counts("other"), [1, 0]);
});

test("替换插件以后执行的是新实现；旧实例交出去的工具、Host 与事件都不随同名插件复活", async (t) => {
  const life = new Lifecycle();
  let oldHost: Host | undefined;
  const f = await fixture(t, [toolPlugin("count", "count_get", "v1", life, (host) => {
    oldHost = host;
    return {};
  })]);
  const oldTool = f.host.tools().find((tool) => tool.name === "count_get");
  assert.ok(oldTool && oldHost);
  await f.host.remove("count");
  await f.host.add(toolPlugin("count", "count_get", "v2", life));

  const session = await f.agents.create();
  f.script(fauxAssistantMessage(fauxToolCall("count_get", {})), fauxAssistantMessage("完成"));
  await session.send("计数");
  assert.deepEqual(toolResults(session).map(({ text }) => text), ["count_get v2"]);

  await assert.rejects(async () => oldTool.execute({}, { signal: new AbortController().signal, callId: "old" }), fault("plugins_closed"));
  await assert.rejects(oldHost.files.write("old.txt", "旧实例"), fault("plugins_closed"));
  const staleHost = oldHost;
  staleHost.emit({ type: "旧实例的事件" });
  assert.deepEqual(f.emitted, []);
  await assert.rejects(async () => staleHost.services.call("anything", {}), fault("plugins_closed"));
  assert.deepEqual(life.counts("count"), [2, 1]);
});

test("运行中途加上的插件由定时器写空间文件，撤回那次运行：插件的写入还在，历史里记在插件名下", async (t) => {
  const life = new Lifecycle();
  const runEnded = barrier();
  const fired = barrier();
  let written: Promise<void> | undefined;
  const f = await fixture(t, []);
  f.actions.set("add", async () => {
    await f.space.files.write("run.txt", "运行写的");
    await f.host.add(toolPlugin("timer", "timer_get", "v1", life, (host) => {
      // open 里安排的定时器；它在运行结束以后才写。
      setTimeout(() => {
        written = runEnded.promise.then(() => host.files.write("timer.txt", "插件写的"));
        fired.release();
      }, 0);
      return {};
    }));
    return "已加上";
  });
  const session = await f.agents.create();
  f.script(fauxAssistantMessage(fauxToolCall("ctl", { action: "add" })), fauxAssistantMessage("完成"));
  await session.send("加上定时插件");
  const runId = f.events.find((event) => event.type === "runStart")?.runId;
  assert.ok(runId);
  runEnded.release();
  await fired.promise;
  await written;
  await f.host.flush();

  await f.space.history.undoRun(runId);
  await assert.rejects(readFile(path.join(f.space.root, "run.txt"), "utf8"), { code: "ENOENT" });
  assert.equal(await readFile(path.join(f.space.root, "timer.txt"), "utf8"), "插件写的");
  const feed = await f.space.history.changes();
  const timerRevision = feed.revisions.find((revision) => revision.changes.some((change) => change.path === "timer.txt"));
  assert.deepEqual(timerRevision?.source, { kind: "plugin", pluginId: "timer" });
});

test("运行中途加上的插件在 open 里写空间或读历史：立即失败，调用方不挂住，宿主里不留下半个实例", async (t) => {
  const life = new Lifecycle();
  const eager = (action: (host: Host) => Promise<unknown>): Plugin => ({
    id: "eager",
    async open(host) {
      life.opened("eager");
      await action(host);
      return { tools: () => [{ name: "eager_get", description: "急", parameters: empty, execute: async () => ({ text: "急" }) }], close: async () => { life.closed("eager"); } };
    },
  });
  const f = await fixture(t, []);
  const outcomes: string[] = [];
  const attempt = (plugin: Plugin) => async () => {
    try {
      await f.host.add(plugin);
      return "加上了";
    } catch (error) {
      outcomes.push(error !== null && typeof error === "object" && "code" in error ? String(error.code) : "unknown");
      return "失败";
    }
  };
  f.actions.set("write", attempt(eager((host) => host.files.write("eager.txt", "打开时写"))));
  f.actions.set("history", attempt(eager((host) => host.history.list(1))));
  const session = await f.agents.create();
  f.script(
    fauxAssistantMessage(fauxToolCall("ctl", { action: "write" })),
    fauxAssistantMessage(fauxToolCall("ctl", { action: "history" })),
    fauxAssistantMessage("完成"),
  );
  await session.send("加上会写文件的插件");
  assert.deepEqual(outcomes, ["space_busy", "space_busy"]);
  assert.equal(f.host.list().some((plugin) => plugin.id === "eager"), false);
  assert.equal(f.host.tools().some((tool) => tool.name === "eager_get"), false);
  // open() 已经调用过：open 报错的实例没有 close 可调。open 里抛错时插件负责自己的清理。
  assert.deepEqual(life.counts("eager"), [2, 0]);

  // 运行之外加上同一个插件照常成功：失败没有留下占着 id 的实例。
  await f.host.add(eager((host) => host.files.write("eager.txt", "打开时写")));
  assert.equal(await readFile(path.join(f.space.root, "eager.txt"), "utf8"), "打开时写");
});

test("旧实例的 close() 还没结束时再加上同一个插件，立即失败；结束以后才能加上", async (t) => {
  const life = new Lifecycle();
  const closing = barrier();
  const f = await fixture(t, [toolPlugin("count", "count_get", "v1", life, () => ({
    close: async () => {
      await closing.promise;
      life.closed("count");
    },
  }))]);
  const removal = f.host.remove("count");
  await assert.rejects(f.host.add(toolPlugin("count", "count_get", "v2", life)), fault("plugin_closing"));
  assert.deepEqual(life.counts("count"), [1, 0]);
  closing.release();
  await removal;
  await f.host.add(toolPlugin("count", "count_get", "v2", life));
  assert.deepEqual(life.counts("count"), [2, 1]);
  await assert.rejects(f.host.add(toolPlugin("count", "count_get", "v3", life)), fault("plugin_open"));
});

test("插件 Agent 的会话拿不到档案之外的工具：即使有扩展把 bash 写进激活列表，调用也找不到", async (t) => {
  const life = new Lifecycle();
  const helper: AgentDefinition = { id: "helper", instructions: () => "帮手", tools: ["read", "count_get"] };
  const f = await fixture(t, [
    toolPlugin("count", "count_get", "v1", life),
    { id: "helpers", open: async () => ({ agents: () => [helper] }) },
  ], {
    // 模拟一处写错的激活列表：每次运行开始时把 bash 和 ctl 也激活。
    extensionFactories: [(pi) => {
      pi.on("before_agent_start", () => { pi.setActiveTools([...pi.getActiveTools(), "bash", "ctl"]); });
    }],
  });
  const session = await f.agents.create({ agent: "helper" });
  f.script(
    fauxAssistantMessage([fauxToolCall("bash", { command: "echo 越权 > bash.txt" }), fauxToolCall("ctl", { action: "none" }), fauxToolCall("count_get", {})]),
    fauxAssistantMessage("完成"),
  );
  await session.send("试试");
  assert.deepEqual(f.requests[0], ["read", "count_get"]);
  assert.deepEqual(toolResults(session).map(({ tool, isError, text }) => [tool, isError, text]), [
    ["bash", true, "Tool bash not found"],
    ["ctl", true, "Tool ctl not found"],
    ["count_get", false, "count_get v1"],
  ]);
  await assert.rejects(readFile(path.join(f.space.root, "bash.txt"), "utf8"), { code: "ENOENT" });
});

test("插件 Agent 引用的别的插件的工具，按名字在当时的集合里取；引用方不因此关闭或重新打开", async (t) => {
  const life = new Lifecycle();
  const helper: AgentDefinition = { id: "helper", instructions: () => "帮手", tools: ["read", "count_get"] };
  const f = await fixture(t, [
    toolPlugin("count", "count_get", "v1", life),
    { id: "helpers", open: async () => { life.opened("helpers"); return { agents: () => [helper], close: async () => { life.closed("helpers"); } }; } },
  ]);
  const session = await f.agents.create({ agent: "helper" });
  await f.host.remove("count");
  f.script(fauxAssistantMessage("没有计数"));
  await session.send("第一次");
  await f.host.add(toolPlugin("count", "count_get", "v2", life));
  f.script(fauxAssistantMessage(fauxToolCall("count_get", {})), fauxAssistantMessage("完成"));
  await session.send("第二次");
  assert.deepEqual(f.requests, [["read"], ["read", "count_get"], ["read", "count_get"]]);
  assert.deepEqual(toolResults(session).map(({ text }) => text), ["count_get v2"]);
  assert.deepEqual(life.counts("helpers"), [1, 0]);
});

test("插件 Agent 的会话在插件撤下后只读，插件回来以后同一个会话恢复可用", async (t) => {
  const life = new Lifecycle();
  const helpers = (version: string): Plugin => ({
    id: "helpers",
    async open() {
      life.opened("helpers");
      return { agents: () => [{ id: "helper", instructions: () => `帮手 ${version}`, tools: ["read"] }] };
    },
  });
  const f = await fixture(t, [helpers("v1")]);
  const session = await f.agents.create({ agent: "helper" });
  await f.host.remove("helpers");
  await assert.rejects(session.send("插件不在"), fault("agent_not_found"));
  assert.deepEqual(f.agents.agents().map((agent) => agent.id), ["general"]);
  await f.host.add(helpers("v2"));
  f.script(fauxAssistantMessage("回来了"));
  await session.send("插件回来了");
  assert.equal(session.history().at(-1)?.text, "回来了");
  assert.equal(f.requests.length, 1);
});

test("重新打开一个会话后，激活的工具是这一刻的集合，不是会话里记下的那一套", async (t) => {
  const life = new Lifecycle();
  const f = await fixture(t, [toolPlugin("count", "count_get", "v1", life)]);
  const session = await f.agents.create();
  f.script(fauxAssistantMessage("第一次"));
  await session.send("第一次");
  assert.equal(f.requests[0]?.includes("count_get"), true);
  const id = session.info().id;

  await f.host.remove("count");
  await f.host.add(toolPlugin("other", "other_get", "v1", life));
  const agents = await f.reopenAgents();
  const reopened = await agents.get(id);
  f.script(fauxAssistantMessage("第二次"));
  await reopened.send("第二次");
  const tools = f.requests[1] ?? [];
  assert.equal(tools.includes("count_get"), false);
  assert.equal(tools.includes("other_get"), true);
  assert.deepEqual(tools.filter((name) => ["read", "bash", "edit", "write", "grep", "find", "ls", "ask_user"].includes(name)), ["read", "bash", "edit", "write", "grep", "find", "ls", "ask_user"]);
});

test("空间写锁的查询只在独占期间为真", async (t) => {
  const f = await fixture(t, []);
  assert.equal(f.space.writeLocked(), false);
  const inside = await f.space.record({ kind: "plugin", pluginId: "ctl" }, async () => f.space.writeLocked());
  assert.equal(inside.value, true);
  assert.equal(f.space.writeLocked(), false);
});

