import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { Type } from "typebox";

import { notesPlugin } from "../examples/notes-plugin.js";
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

test("插件工具在 Agent 活动内写入不会形成嵌套历史，参数由宿主校验", async (t) => {
  const { host, space } = await fixture(t, [notesPlugin]);
  await host.start();
  const tool = host.tools()[0];
  assert.ok(tool);
  const context = { signal: new AbortController().signal, callId: "call-1" };
  await assert.rejects(async () => tool.execute({ name: "../escape", text: "bad" }, context), fault("invalid_input"));
  await space.record({ kind: "agent", runId: "run-note" }, async () => {
    await tool.execute({ name: "first", text: "保存中文，（：\r\n" }, context);
  });
  await host.flush();
  assert.equal(await space.files.read("notes/first.md"), "保存中文，（：\r\n");
  const [revision] = await space.history.list(1);
  assert.deepEqual(revision?.source, { kind: "agent", runId: "run-note" });
});

test("示例父插件提供子插件并实际调用三种模型接口", async (t) => {
  const calls: string[] = [];
  let finish!: () => void;
  const result = new Promise<void>((resolve) => { finish = resolve; });
  const models: Models = {
    async complete(request) {
      calls.push(`complete:${request.prompt}`);
      return "改写结果";
    },
    async completeStructured(request, schema) {
      calls.push(`structured:${request.prompt}`);
      return parse(schema, { title: "标题", summary: "摘要" });
    },
    async runAgent(task) {
      calls.push(`agent:${task.text}`);
      return { id: "work-1", result, cancel: async () => { finish(); } };
    },
  };
  const { host, space, events } = await fixture(t, [notesPlugin], models);
  await host.start();
  assert.deepEqual(host.list().map((item) => item.id), ["notes"]);
  await host.call("notes", "save", { name: "first", text: "第一篇" });
  assert.equal(await space.files.read("notes/first.md"), "第一篇");
  await host.call("notes", "setStyle", { style: "自然" });
  assert.equal(await host.call("notes", "rewrite", { text: "原文", style: "简短" }), "改写结果");
  assert.deepEqual(await host.call("notes", "summarize", { text: "原文" }), { title: "标题", summary: "摘要" });
  assert.deepEqual(await host.call("notes", "organize", {}), { id: "work-1" });
  assert.equal(calls.length, 3);
  finish();
  await host.close();
  assert.ok(events.some(({ event }) => typeof event === "object" && event !== null && "child" in event));
  assert.ok(events.some(({ event }) => typeof event === "object" && event !== null && "type" in event && event.type === "organizeFinished"));
});

test("子插件拒绝通过空间内部链接写到它自己的目录之外", async (t) => {
  const { host, space } = await fixture(t, [notesPlugin]);
  await host.start();
  await space.files.write("outside.txt", "保留");
  await symlink(path.join(space.root, "outside.txt"), path.join(space.root, "notes", "linked.md"));
  await assert.rejects(host.call("notes", "save", { name: "linked", text: "不应写入" }), fault("file_outside_space"));
  assert.equal(await space.files.read("outside.txt"), "保留");
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

test("示例父插件拒绝已有 notes 目录是外部符号链接", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-plugin-symlink-"));
  const space = await createSpace(path.join(directory, "space"), { watch: false });
  t.after(async () => {
    await space.close();
    await rm(directory, { recursive: true, force: true });
  });
  await symlink(directory, path.join(space.root, "notes"));
  await assert.rejects(openPluginHost({ space, plugins: [notesPlugin], models: noModels, emit() {}, onError() {} }), fault("file_outside_space"));
});
