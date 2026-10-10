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

test("界面方法保存插件私有状态仍触发可等待的变化处理", async (t) => {
  let cursor: string | undefined;
  let observed = "";
  let changes = 0;
  const plugin: Plugin = {
    id: "state",
    async open(host) {
      const stateFile = path.join(host.space.dataDir, "state.txt");
      return {
        async onChange() {
          await host.history.changes(cursor).then((feed) => { cursor = feed.revision; });
          try {
            observed = await readFile(stateFile, "utf8");
          } catch (error) {
            if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
          }
          changes++;
        },
        methods: {
          save: {
            parameters: object({ value: Type.String() }),
            async invoke(input) {
              const { value } = parse(object({ value: Type.String() }), input);
              await writeFile(stateFile, value);
              return value;
            },
          },
        },
      };
    },
  };
  const { host, space } = await fixture(t, [plugin]);
  await host.start();
  const before = await space.history.list();
  assert.equal(await host.call("state", "save", { value: "新状态" }), "新状态");
  assert.equal(observed, "新状态");
  assert.equal(changes, 2);
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
    { id: "good", open: async () => ({
      onChange: async () => { woke++; },
      methods: { trigger: { parameters: empty, invoke: async () => {} } },
    }) },
  ]);
  await host.start();
  bad = true;
  await assert.rejects(host.call("good", "trigger", {}), AggregateError);
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

test("插件工具同名或覆盖内置工具会拒绝，并逆序清理已打开实例", async (t) => {
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
  await assert.rejects(openPluginHost({ space, plugins: [plugin("first", "same"), plugin("second", "same")], models: noModels, emit() {}, onError() {} }), fault("tool_name_conflict"));
  assert.deepEqual(closed, ["second", "first"]);
  await assert.rejects(openPluginHost({ space, plugins: [plugin("builtin", "read")], models: noModels, emit() {}, onError() {} }), fault("tool_name_conflict"));
  assert.deepEqual(closed, ["second", "first", "builtin"]);
});

test("插件 open 中途失败，宿主先取消后台工作再逆序关闭已打开实例", async (t) => {
  const space = await failureSpace(t);
  const order: string[] = [];
  const finished = deferred<void>();
  const failure = new Error("打开失败");
  const models: Models = {
    ...noModels,
    async runAgent() {
      return { id: "opening-work", result: finished.promise, async cancel() { order.push("cancel"); finished.resolve(); } };
    },
  };
  await assert.rejects(openPluginHost({
    space, models, emit() {}, onError() {},
    plugins: [
      { id: "first", open: async () => ({ close: async () => { order.push("first"); } }) },
      { id: "second", open: async () => ({ close: async () => { order.push("second"); } }) },
      { id: "failing", async open(host) { await host.models.runAgent({ text: "工作" }); throw failure; } },
    ],
  }), (error) => error === failure);
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
