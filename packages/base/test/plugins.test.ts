import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { Type } from "typebox";

import type { Models, Plugin } from "../src/plugin.js";
import { openPluginHost } from "../src/plugins.js";
import { createSpace } from "../src/space.js";
import { object, parse } from "../src/schema.js";

const empty = object({});
const noModels: Models = {
  async complete() { throw new Error("此测试不应调用模型"); },
  async completeStructured() { throw new Error("此测试不应调用模型"); },
  async runAgent() { throw new Error("此测试不应运行 Agent"); },
};

async function fixture(t: TestContext, plugins: Plugin[], models = noModels) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-plugins-"));
  const space = await createSpace(path.join(directory, "space"), { watch: false });
  const errors: unknown[] = [];
  const events: { pluginId: string; event: unknown }[] = [];
  const host = await openPluginHost({
    space, plugins, models,
    emit: (pluginId, event) => { events.push({ pluginId, event }); },
    onError: (error) => { errors.push(error); },
  });
  t.after(async () => {
    await host.close();
    await space.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, space, host, errors, events };
}

const fault = (code: string) => (error: unknown): boolean => error instanceof Error && "code" in error && error.code === code;

test("插件初始化等运行时 start 后才唤醒，并提供说明、工具和视图", async (t) => {
  let changes = 0;
  const plugin: Plugin = {
    id: "demo",
    async open() {
      return {
        instructions: () => "独立插件说明",
        view: async () => "当前视图",
        onChange: async () => { changes++; },
        tools: () => [{
          name: "demo_tool", description: "示例工具", parameters: empty,
          execute: async () => ({ text: "完成" }),
        }],
        methods: { inspect: { parameters: empty, invoke: async () => ({ ready: true }) } },
      };
    },
  };
  const { host } = await fixture(t, [plugin]);
  assert.equal(changes, 0);
  await host.start();
  assert.equal(changes, 1);
  await host.start();
  assert.equal(changes, 1);
  assert.deepEqual(host.list(), [{ id: "demo", methods: ["inspect"], tools: ["demo_tool"] }]);
  assert.deepEqual(host.instructions(), [{ id: "plugin:demo", text: "独立插件说明" }]);
  assert.deepEqual(await host.views(), [{ id: "plugin:demo", text: "当前视图" }]);
  assert.deepEqual(await host.call("demo", "inspect", {}), { ready: true });
  await assert.rejects(host.call("demo", "inspect", { extra: true }), fault("invalid_input"));
  await assert.rejects(host.call("demo", "constructor", {}), fault("plugin_method_not_found"));
});

test("界面方法保存私有状态并发出插件事件，不读取历史或唤醒变化处理", async (t) => {
  let changes = 0;
  let stateFile = "";
  const plugin: Plugin = {
    id: "state",
    async open(host) {
      stateFile = path.join(host.space.dataDir, "state.txt");
      return {
        async onChange() { changes++; },
        methods: {
          save: {
            parameters: object({ value: Type.String() }),
            async invoke(input) {
              const { value } = parse(object({ value: Type.String() }), input);
              await writeFile(stateFile, value);
              host.emit({ value });
              return value;
            },
          },
        },
      };
    },
  };
  const { host, space, events } = await fixture(t, [plugin]);
  await host.start();
  const before = await space.history.list();
  const list = space.history.list;
  let historyReads = 0;
  space.history.list = async limit => {
    historyReads++;
    return list(limit);
  };
  assert.equal(await host.call("state", "save", { value: "新状态" }), "新状态");
  await host.flush();
  assert.equal(historyReads, 0);
  assert.equal(await readFile(stateFile, "utf8"), "新状态");
  assert.deepEqual(events, [{ pluginId: "state", event: { value: "新状态" } }]);
  assert.equal(changes, 1);
  assert.deepEqual(await space.history.list(), before);
});

test("变化处理读取自己的游标并写回内容，flush 等待后续变化处理", async (t) => {
  let cursor: string | undefined;
  let processed = false;
  const plugin: Plugin = {
    id: "derive",
    async open(host) {
      return {
        async onChange() {
          const feed = await host.history.changes(cursor);
          cursor = feed.revision;
          if (feed.revisions.some((revision) => revision.changes.some((change) => change.path === "input.txt"))) {
            await host.files.write("derived.txt", (await host.files.read("input.txt")).toUpperCase());
            processed = true;
          }
        },
      };
    },
  };
  const { host, space } = await fixture(t, [plugin]);
  await host.start();
  await space.record({ kind: "agent", runId: "run-input" }, () => space.files.write("input.txt", "hello"));
  await host.flush();
  assert.equal(processed, true);
  assert.equal(await space.files.read("derived.txt"), "HELLO");
  const [revision] = await space.history.list(1);
  assert.deepEqual(revision?.source, { kind: "plugin", pluginId: "derive" });
  assert.equal(cursor, revision?.id);
});




test("一个插件变化处理失败仍唤醒其他插件，并由 flush 交付失败", async (t) => {
  let bad = false;
  let woke = 0;
  const { host, errors } = await fixture(t, [
    { id: "bad", open: async () => ({ onChange: async () => { if (bad) throw new Error("处理失败"); } }) },
    { id: "good", open: async pluginHost => ({
      onChange: async () => { woke++; },
      methods: { trigger: { parameters: empty, invoke: async () => pluginHost.files.write("trigger.txt", "文件变化") } },
    }) },
  ]);
  await host.start();
  bad = true;
  await host.call("good", "trigger", {});
  await assert.rejects(host.flush(), AggregateError);
  bad = false;
  assert.equal(woke, 2);
  assert.equal(errors.length, 1);
});

test("关闭宿主等在途方法保存完成，拒绝新的方法调用", async (t) => {
  let enter!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const resumed = new Promise<void>((resolve) => { resume = resolve; });
  let instanceClosed = false;
  const { host, space } = await fixture(t, [{
    id: "slow",
    async open(pluginHost) {
      return {
        methods: { save: {
          parameters: empty,
          async invoke() {
            enter();
            await resumed;
            await pluginHost.files.write("saved.txt", "等待保存结束");
            return "saved";
          },
        } },
        async close() { instanceClosed = true; },
      };
    },
  }]);
  await host.start();
  const saving = host.call("slow", "save", {});
  await entered;
  const closing = host.close();
  await assert.rejects(async () => host.call("slow", "save", {}), fault("plugins_closed"));
  assert.equal(instanceClosed, false);
  resume();
  assert.equal(await saving, "saved");
  await closing;
  assert.equal(instanceClosed, true);
  assert.equal(await space.files.read("saved.txt"), "等待保存结束");
});

test("插件关闭失败仍关闭其他实例", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-plugin-close-"));
  const space = await createSpace(path.join(directory, "space"), { watch: false });
  t.after(async () => {
    await space.close();
    await rm(directory, { recursive: true, force: true });
  });
  const closed: string[] = [];
  const host = await openPluginHost({
    space, models: noModels, emit() {}, onError() {},
    plugins: [
      { id: "first", open: async () => ({ close: async () => { closed.push("first"); } }) },
      {
        id: "second",
        open: async () => ({
          async close() {
            closed.push("second");
            throw new Error("关闭失败");
          },
        }),
      },
    ],
  });
  await host.start();
  await assert.rejects(host.close(), AggregateError);
  assert.deepEqual(closed, ["second", "first"]);
});


function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => { throw new Error("尚未创建屏障"); };
  let reject: (error: unknown) => void = () => { throw new Error("尚未创建屏障"); };
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

async function failureSpace(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-plugin-failure-"));
  const space = await createSpace(path.join(directory, "space"), { watch: false });
  t.after(async () => {
    await space.close();
    await rm(directory, { recursive: true, force: true });
  });
  return space;
}

test("同组插件以不同登记顺序打开，提示、视图与工具声明保持相同顺序", async (t) => {
  const makePlugin = (id: string, names: string[]): Plugin => ({
    id,
    async open() {
      return {
        instructions: () => `${id} 说明`,
        view: async () => `${id} 视图`,
        tools: () => names.map((name) => ({ name, description: name, parameters: empty, execute: async () => ({ text: name }) })),
      };
    },
  });
  const alpha = makePlugin("alpha", ["z_tool", "a_tool"]);
  const beta = makePlugin("beta", ["m_tool"]);
  const left = await fixture(t, [beta, alpha]);
  const right = await fixture(t, [alpha, beta]);
  assert.deepEqual(left.host.instructions(), right.host.instructions());
  assert.deepEqual(left.host.instructions().map((section) => section.id), ["plugin:alpha", "plugin:beta"]);
  assert.deepEqual(await left.host.views(), await right.host.views());
  assert.deepEqual(left.host.tools().map((tool) => tool.name), ["a_tool", "m_tool", "z_tool"]);
  assert.deepEqual(left.host.tools().map((tool) => tool.name), right.host.tools().map((tool) => tool.name));
  assert.deepEqual(left.host.list().map((plugin) => plugin.id), ["alpha", "beta"]);
});

test("插件 id 重复在任何 open 之前拒绝", async (t) => {
  const space = await failureSpace(t);
  let opened = 0;
  const plugin: Plugin = { id: "duplicate", open: async () => { opened++; return {}; } };
  await assert.rejects(openPluginHost({ space, plugins: [plugin, plugin], models: noModels, emit() {}, onError() {} }), fault("invalid_plugin_id"));
  assert.equal(opened, 0);
});

test("插件工具同名或覆盖内置工具只停失败方，并清理它已打开的实例", async (t) => {
  const space = await failureSpace(t);
  const closed: string[] = [];
  const plugin = (id: string, name: string): Plugin => ({
    id,
    async open() {
      return {
        tools: () => [{ name, description: name, parameters: empty, execute: async () => ({ text: "完成" }) }],
        close: async () => { closed.push(id); },
      };
    },
  });
  const host = await openPluginHost({ space, plugins: [plugin("first", "same"), plugin("second", "same"), plugin("builtin", "read")], models: noModels, emit() {}, onError() {} });
  assert.deepEqual(host.list().map((plugin) => plugin.id), ["first"]);
  assert.deepEqual(host.disabled().map(({ id, reason }) => [id, reason.code]), [["builtin", "tool_name_conflict"], ["second", "tool_name_conflict"]]);
  assert.deepEqual(closed, ["builtin", "second"]);
  await host.close();
  assert.deepEqual(closed, ["builtin", "second", "first"]);
});

test("插件 open 中途失败只取消自己的后台工作，其余插件继续可用", async (t) => {
  const space = await failureSpace(t);
  const order: string[] = [];
  const finished = deferred<void>();
  const models: Models = {
    ...noModels,
    async runAgent() {
      return { id: "opening-work", result: finished.promise, async cancel() { order.push("cancel"); finished.resolve(); } };
    },
  };
  const host = await openPluginHost({
    space, models, emit() {}, onError() {},
    plugins: [
      { id: "first", open: async () => ({ close: async () => { order.push("first"); } }) },
      { id: "second", open: async () => ({ close: async () => { order.push("second"); } }) },
      { id: "failing", async open(host) { await host.models.runAgent({ text: "工作" }); throw new Error("打开失败"); } },
    ],
  });
  assert.deepEqual(order, ["cancel"]);
  assert.deepEqual(host.list().map((plugin) => plugin.id), ["first", "second"]);
  assert.equal(host.disabled()[0]?.reason.code, "plugin_open_failed");
  await host.close();
  assert.deepEqual(order, ["cancel", "second", "first"]);
});

test("关闭时仍在创建 Agent 句柄，取得后取消并等待实际结果才关闭插件", async (t) => {
  const entered = deferred<void>();
  const create = deferred<void>();
  const cancelled = deferred<void>();
  const finish = deferred<void>();
  let instanceClosed = false;
  let closed = false;
  const models: Models = {
    ...noModels,
    async runAgent() {
      entered.resolve();
      await create.promise;
      return { id: "late-work", result: finish.promise, async cancel() { cancelled.resolve(); } };
    },
  };
  const { host } = await fixture(t, [{
    id: "background",
    async open(pluginHost) {
      return {
        methods: { launch: { parameters: empty, invoke: async () => ({ id: (await pluginHost.models.runAgent({ text: "工作" })).id }) } },
        close: async () => { instanceClosed = true; },
      };
    },
  }], models);
  const launching = host.call("background", "launch", {});
  await entered.promise;
  const closing = host.close().then(() => { closed = true; });
  create.resolve();
  await cancelled.promise;
  assert.equal(instanceClosed, false);
  assert.equal(closed, false);
  finish.resolve();
  assert.deepEqual(await launching, { id: "late-work" });
  await closing;
  assert.equal(instanceClosed, true);
  assert.equal(closed, true);
});

test("关闭先取消 complete 与 structured，再等在途方法结束，不会在等待模型时死锁", async (t) => {
  const completeEntered = deferred<void>();
  const structuredEntered = deferred<void>();
  const stopped: string[] = [];
  const invoke = async (request: { signal?: AbortSignal }, kind: string, entered: ReturnType<typeof deferred<void>>) => {
    entered.resolve();
    await new Promise<void>((resolve) => {
      assert.ok(request.signal);
      if (request.signal.aborted) resolve();
      else request.signal.addEventListener("abort", () => { resolve(); }, { once: true });
    });
    stopped.push(kind);
    throw new Error("取消完成");
  };
  const models: Models = {
    ...noModels,
    complete: (request) => invoke(request, "complete", completeEntered),
    completeStructured: (request) => invoke(request, "structured", structuredEntered),
  };
  const { host } = await fixture(t, [{
    id: "models",
    async open(pluginHost) {
      return {
        methods: {
          complete: { parameters: empty, invoke: () => pluginHost.models.complete({ prompt: "普通" }) },
          structured: { parameters: empty, invoke: () => pluginHost.models.completeStructured({ prompt: "结构化" }, empty) },
        },
        async close() { assert.deepEqual(stopped.sort(), ["complete", "structured"]); },
      };
    },
  }], models);
  const complete = assert.rejects(host.call("models", "complete", {}), /取消完成/u);
  const structured = assert.rejects(host.call("models", "structured", {}), /取消完成/u);
  await Promise.all([completeEntered.promise, structuredEntered.promise]);
  await host.close();
  await Promise.all([complete, structured]);
});

test("关闭等在途工具与视图完成，并拒绝再次调用工具或读取视图", async (t) => {
  const toolEntered = deferred<void>();
  const viewEntered = deferred<void>();
  const resume = deferred<void>();
  let instanceClosed = false;
  const { host } = await fixture(t, [{
    id: "slow-reads",
    async open() {
      return {
        tools: () => [{
          name: "slow_tool", description: "等待工具", parameters: empty,
          async execute() { toolEntered.resolve(); await resume.promise; return { text: "结束" }; },
        }],
        async view() { viewEntered.resolve(); await resume.promise; return "视图"; },
        async close() { instanceClosed = true; },
      };
    },
  }]);
  const tool = host.tools()[0];
  assert.ok(tool);
  const context = { signal: new AbortController().signal, callId: "slow" };
  const executing = tool.execute({}, context);
  const viewing = host.views();
  await Promise.all([toolEntered.promise, viewEntered.promise]);
  const closing = host.close();
  assert.equal(instanceClosed, false);
  await assert.rejects(async () => tool.execute({}, context), fault("plugins_closed"));
  await assert.rejects(async () => host.views(), fault("plugins_closed"));
  resume.resolve();
  assert.deepEqual(await executing, { text: "结束" });
  assert.deepEqual(await viewing, [{ id: "plugin:slow-reads", text: "视图" }]);
  await closing;
  assert.equal(instanceClosed, true);
});

test("后台 Agent 主动取消与宿主关闭共享取消句柄，关闭仍等待结果终态", async (t) => {
  const cancelled = deferred<void>();
  const finish = deferred<void>();
  let cancellations = 0;
  let instanceClosed = false;
  const models: Models = {
    ...noModels,
    async runAgent() {
      return {
        id: "manual-cancel",
        result: finish.promise,
        async cancel() { cancellations++; cancelled.resolve(); },
      };
    },
  };
  const { host } = await fixture(t, [{
    id: "manual",
    async open(pluginHost) {
      return {
        methods: {
          launch: { parameters: empty, async invoke() {
            const task = await pluginHost.models.runAgent({ text: "工作" });
            await Promise.all([task.cancel(), task.cancel()]);
          } },
        },
        close: async () => { instanceClosed = true; },
      };
    },
  }], models);
  const launching = host.call("manual", "launch", {});
  await cancelled.promise;
  const closing = host.close();
  assert.equal(instanceClosed, false);
  finish.resolve();
  await Promise.all([launching, closing]);
  assert.equal(cancellations, 1);
  assert.equal(instanceClosed, true);
});

test("模型取消失败仍等待工作终态，并关闭其他插件后交付失败", async (t) => {
  const space = await failureSpace(t);
  const finished = deferred<void>();
  const cancelled = deferred<void>();
  const cancellationError = new Error("取消失败");
  const closed: string[] = [];
  const host = await openPluginHost({
    space, emit() {}, onError() {},
    models: {
      ...noModels,
      async runAgent() {
        return {
          id: "failed-cancel", result: finished.promise,
          async cancel() { cancelled.resolve(); throw cancellationError; },
        };
      },
    },
    plugins: [
      { id: "first", async open(pluginHost) { await pluginHost.models.runAgent({ text: "工作" }); return { close: async () => { closed.push("first"); } }; } },
      { id: "second", open: async () => ({ close: async () => { closed.push("second"); } }) },
    ],
  });
  const closing = assert.rejects(host.close(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    const [modelError] = error.errors;
    assert.ok(modelError instanceof AggregateError);
    assert.deepEqual(modelError.errors, [cancellationError]);
    return true;
  });
  await cancelled.promise;
  assert.deepEqual(closed, []);
  finished.resolve();
  await closing;
  assert.deepEqual(closed, ["second", "first"]);
});

test("关闭等待已接纳但还在读取历史的 start，停止追加初始变化处理", async (t) => {
  let instanceClosed = false;
  let changes = 0;
  const { host, space } = await fixture(t, [{
    id: "starting",
    open: async () => ({
      onChange: async () => { changes++; },
      close: async () => { instanceClosed = true; },
    }),
  }]);
  const entered = deferred<void>();
  const resume = deferred<void>();
  const list = space.history.list;
  space.history.list = async (limit) => {
    entered.resolve();
    await resume.promise;
    return list(limit);
  };
  const starting = host.start();
  await entered.promise;
  const closing = host.close();
  assert.equal(instanceClosed, false);
  resume.resolve();
  await Promise.all([starting, closing]);
  assert.equal(instanceClosed, true);
  assert.equal(changes, 0);
});

test("插件声明的 Agent 按 id 排序交给宿主，view 在宿主关闭后不再接纳", async (t) => {
  const tool = { name: "lookup", description: "查询", parameters: empty, execute: async () => ({ text: "结果" }) };
  const { host } = await fixture(t, [
    { id: "zeta", open: async () => ({ agents: () => [{ id: "writer", instructions: () => "写课", tools: ["read", "lookup"], subagents: ["checker"] }] }) },
    {
      id: "alpha",
      open: async () => ({
        tools: () => [tool],
        agents: () => [{ id: "checker", instructions: () => "检查", tools: ["lookup"], direct: true, view: async () => "检查进度" }],
      }),
    },
  ]);
  assert.deepEqual(host.agents().map((agent) => [agent.id, agent.tools, agent.subagents, agent.direct]), [
    ["checker", ["lookup"], undefined, true],
    ["writer", ["read", "lookup"], ["checker"], undefined],
  ]);
  const checker = host.agents()[0];
  assert.equal(checker?.instructions(), "检查");
  assert.equal(await checker?.view?.(), "检查进度");
  await host.close();
  await assert.rejects(async () => checker?.view?.(), fault("plugins_closed"));
});

test("Agent 定义无效只停声明它的插件，并清理实例而不暴露其工具和 Agent", async (t) => {
  const space = await failureSpace(t);
  const cases: [string, Plugin["open"]][] = [
    ["unknown_agent_tool", async () => ({ agents: () => [{ id: "tutor", instructions: () => "", tools: ["read", "missing_tool"] }] })],
    ["agent_tool_unavailable", async () => ({ agents: () => [{ id: "tutor", instructions: () => "", tools: ["read", "grep"] }] })],
    ["unknown_subagent", async () => ({ agents: () => [{ id: "tutor", instructions: () => "", tools: [], subagents: ["missing"] }] })],
    ["subagent_exceeds_parent", async () => ({ agents: () => [
      { id: "tutor", instructions: () => "", tools: ["read"], subagents: ["writer"] },
      { id: "writer", instructions: () => "", tools: ["read", "write"] },
    ] })],
    ["invalid_agent_id", async () => ({ agents: () => [{ id: "general", instructions: () => "", tools: [] }] })],
    ["invalid_agent", async () => ({ agents: () => [{ id: "Tutor", instructions: () => "", tools: [] }] })],
  ];
  for (const [code, open] of cases) {
    const closed: string[] = [];
    const host = await openPluginHost({
      space, models: noModels, emit() {}, onError() {},
      plugins: [
        { id: "first", open: async () => ({ close: async () => { closed.push("first"); } }) },
        { id: "declaring", async open(context) {
          const instance = await open(context);
          return { ...instance, tools: () => [{ name: "failed_tool", description: "失败插件的工具", parameters: empty, execute: async () => ({ text: "不可用" }) }], close: async () => { closed.push("declaring"); } };
        } },
      ],
    });
    assert.deepEqual(host.disabled().map(({ id, reason }) => [id, reason.code]), [["declaring", code]]);
    assert.deepEqual(host.list().map((plugin) => plugin.id), ["first"]);
    assert.deepEqual(host.tools(), []);
    assert.deepEqual(host.agents(), []);
    assert.deepEqual(closed, ["declaring"]);
    await host.close();
    assert.deepEqual(closed, ["declaring", "first"]);
  }
  const duplicate: Plugin = { id: "copy", open: async () => ({ agents: () => [{ id: "tutor", instructions: () => "", tools: [] }] }) };
  const host = await openPluginHost({
    space, models: noModels, emit() {}, onError() {},
    plugins: [{ ...duplicate, id: "one" }, { ...duplicate, id: "two" }],
  });
  assert.deepEqual(host.list().map((plugin) => plugin.id), ["one"]);
  assert.equal(host.disabled()[0]?.reason.code, "invalid_agent_id");
  await host.close();
});

test("Agent 定义可以互相列为子 Agent，也可以列自己，打开时不拒绝", async (t) => {
  const { host } = await fixture(t, [{
    id: "cycle",
    open: async () => ({
      agents: () => [
        { id: "planner", instructions: () => "规划", tools: ["read"], subagents: ["planner", "worker"] },
        { id: "worker", instructions: () => "执行", tools: ["read"], subagents: ["planner"] },
      ],
    }),
  }]);
  assert.deepEqual(host.agents().map((agent) => [agent.id, agent.subagents]), [["planner", ["planner", "worker"]], ["worker", ["planner"]]]);
});

test("失败声明不占用工具名，依赖失败插件的 Agent 也只停在所属插件", async (t) => {
  const { host } = await fixture(t, [
    {
      id: "broken",
      async open() {
        return {
          tools: () => ["reused", "read"].map((name) => ({ name, description: name, parameters: empty, execute: async () => ({ text: name }) })),
        };
      },
    },
    {
      id: "dependent",
      async open() {
        return { agents: () => [{ id: "dependent", instructions: () => "", tools: ["missing"] }] };
      },
    },
    {
      id: "good",
      async open() {
        return { tools: () => [{ name: "reused", description: "继续使用", parameters: empty, execute: async () => ({ text: "可用" }) }] };
      },
    },
  ]);
  assert.deepEqual(host.list().map((plugin) => plugin.id), ["good"]);
  assert.deepEqual(host.tools().map((tool) => tool.name), ["reused"]);
  assert.deepEqual(host.disabled().map(({ id, reason }) => [id, reason.code]), [["broken", "tool_name_conflict"], ["dependent", "unknown_agent_tool"]]);
});

test("插件打开后的声明读取失败时清理实例，清理再失败也不阻止其他插件", async (t) => {
  let closed = false;
  const { host, errors } = await fixture(t, [
    {
      id: "broken",
      async open() {
        return {
          agents() { throw new Error("声明损坏"); },
          async close() { closed = true; throw new Error("清理失败"); },
        };
      },
    },
    { id: "good", open: async () => ({}) },
  ]);
  assert.equal(closed, true);
  assert.equal(host.disabled()[0]?.reason.message, "声明损坏");
  assert.deepEqual(host.list().map((plugin) => plugin.id), ["good"]);
  assert.deepEqual(errors.map((error) => error instanceof Error ? error.message : ""), ["声明损坏", "清理失败"]);
});


test("Agent 定义后置校验失败的插件不占工具名，后登记的正常插件继续可用", async (t) => {
  const closed: string[] = [];
  const tool = { name: "shared", description: "同名工具", parameters: empty, execute: async () => ({ text: "继续工作" }) };
  const { host } = await fixture(t, [
    {
      id: "broken",
      async open() {
        return {
          tools: () => [tool, { ...tool, name: "broken_only" }],
          agents: () => [{ id: "broken", instructions: () => "", tools: ["missing"] }],
          close: async () => { closed.push("broken"); },
        };
      },
    },
    { id: "dependent", open: async () => ({ agents: () => [{ id: "dependent", instructions: () => "", tools: ["broken_only"] }] }) },
    { id: "good", open: async () => ({ tools: () => [tool] }) },
  ]);
  assert.deepEqual(host.list().map((plugin) => plugin.id), ["good"]);
  assert.deepEqual(host.disabled().map(({ id, reason }) => [id, reason.code]), [["broken", "unknown_agent_tool"], ["dependent", "unknown_agent_tool"]]);
  assert.deepEqual(closed, ["broken"]);
  const [available] = host.tools();
  assert.ok(available);
  assert.deepEqual(await available.execute({}, { callId: "shared-test", signal: new AbortController().signal }), { text: "继续工作" });
});
