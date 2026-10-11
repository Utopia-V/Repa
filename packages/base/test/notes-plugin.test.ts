import assert from "node:assert/strict";
import { symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { Type } from "typebox";

import type { Plugin } from "@repa/base/plugin";
import { createPluginTestHost } from "@repa/base/testing";

import { createNotesPlugin, notesPlugin } from "../examples/notes-plugin.js";

const fault = (code: string) => (error: unknown): boolean => error instanceof Error && "code" in error && error.code === code;

async function fixture(t: TestContext) {
  const testing = await createPluginTestHost({ plugins: [notesPlugin] });
  t.after(() => testing.close());
  await testing.host.start();
  return testing;
}

function hasEvent(events: { event: unknown }[], type: string): boolean {
  return events.some(({ event }) => typeof event === "object" && event !== null && "type" in event && event.type === type);
}

test("示例工具保留原文并归入 Agent 活动，宿主拒绝非法参数", async (t) => {
  const { host, space } = await fixture(t);
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

test("离线宿主传递真实文件变化，示例子插件仅观察笔记目录", async (t) => {
  const testing = await fixture(t);
  testing.events.length = 0;
  await testing.writeFile("outside.txt", "目录之外");
  assert.equal(testing.events.length, 0);
  await testing.writeFile("notes/external.md", "从外部改动的中文\r\n");
  assert.equal(await testing.space.files.read("notes/external.md"), "从外部改动的中文\r\n");
  assert.ok(testing.events.some(({ pluginId, event }) => pluginId === "notes"
    && typeof event === "object" && event !== null && "child" in event && event.child === "notebook"));
  assert.deepEqual(testing.errors, []);
});

test("示例父插件保存状态并实际调用离线模型的三种接口", async (t) => {
  const { host, space, models, events } = await fixture(t);
  assert.deepEqual(host.list().map((item) => item.id), ["notes"]);
  await host.call("notes", "save", { name: "first", text: "第一篇" });
  assert.equal(await space.files.read("notes/first.md"), "第一篇");
  await host.call("notes", "setStyle", { style: "自然" });
  const rewriting = models.expectComplete();
  rewriting.succeed("改写结果");
  assert.equal(await host.call("notes", "rewrite", { text: "原文", style: "" }), "改写结果");
  assert.equal((await rewriting.requested).prompt, "用自然风格改写下面的文字：\n原文");
  const summary = models.expectStructured();
  summary.succeed({ title: "标题", summary: "摘要" });
  assert.deepEqual(await host.call("notes", "summarize", { text: "原文" }), { title: "标题", summary: "摘要" });
  const work = models.expectAgent();
  assert.deepEqual(await host.call("notes", "organize", {}), { id: work.id });
  assert.match((await work.requested).text, /notes\//);
  assert.equal((await work.requested).agent, "notes-organizer");
  assert.deepEqual(host.agents().map((agent) => [agent.id, agent.tools]), [["notes-organizer", ["read", "ls", "find", "grep"]]]);
  assert.deepEqual(models.calls.map((call) => call.kind), ["complete", "structured", "agent"]);
  work.finish();
  await host.close();
  assert.ok(hasEvent(events, "organizeFinished"));
});

test("离线模型失败与结构化结果校验给示例插件明确反馈", async (t) => {
  const { host, models, events } = await fixture(t);
  const failure = new Error("模拟模型失败");
  models.expectComplete().fail(failure);
  await assert.rejects(host.call("notes", "rewrite", { text: "原文", style: "自然" }), (error) => error === failure);
  models.expectStructured().succeed({ title: "缺少 summary" });
  await assert.rejects(host.call("notes", "summarize", { text: "原文" }), fault("invalid_input"));
  const work = models.expectAgent();
  await host.call("notes", "organize", {});
  work.fail(failure);
  await host.close();
  assert.ok(hasEvent(events, "organizeFailed"));
});

test("示例关闭先取消后台工作，再等工作终态与事件处理完成", async (t) => {
  const { host, models, events } = await fixture(t);
  const work = models.expectAgent({ cancel: "manual" });
  await host.call("notes", "organize", {});
  let closed = false;
  const closing = host.close().then(() => { closed = true; });
  try {
    await work.cancelRequested;
    assert.equal(closed, false);
    await assert.rejects(async () => host.call("notes", "organize", {}), fault("plugins_closed"));
  } finally {
    work.finish();
  }
  await closing;
  assert.ok(hasEvent(events, "organizeFinished"));
});

test("子插件拒绝通过空间内部链接写到自己的目录之外", async (t) => {
  const { host, space } = await fixture(t);
  await space.files.write("outside.txt", "保留");
  await symlink(path.join(space.root, "outside.txt"), path.join(space.root, "notes", "linked.md"));
  await assert.rejects(host.call("notes", "save", { name: "linked", text: "不应写入" }), fault("file_outside_space"));
  assert.equal(await space.files.read("outside.txt"), "保留");
});

test("示例父插件拒绝已有 notes 目录是外部符号链接，离线宿主清理失败初始化", async () => {
  await assert.rejects(createPluginTestHost({
    plugins: [{
      id: "notes",
      async open(host) {
        await symlink(host.space.dataDir, path.join(host.space.root, "notes"));
        return notesPlugin.open(host);
      },
    }],
  }), fault("file_outside_space"));
});


test("父插件初始化失败清理已打开子插件，同时保留清理失败", async () => {
  for (const closeFails of [false, true]) {
    let closed = false;
    const cleanupFailure = new Error("子插件清理失败");
    const plugin = createNotesPlugin({
      id: "notebook",
      async open() {
        return {
          async close() {
            closed = true;
            if (closeFails) throw cleanupFailure;
          },
        };
      },
    });
    await assert.rejects(createPluginTestHost({
      plugins: [{
        ...plugin,
        async open(host) {
          await writeFile(path.join(host.space.dataDir, "preferences.json"), "{损坏的 JSON");
          return plugin.open(host);
        },
      }],
    }), (error) => {
      if (!closeFails) return error instanceof SyntaxError;
      return error instanceof AggregateError
        && error.errors[0] instanceof SyntaxError
        && error.errors[1] === cleanupFailure;
    });
    assert.equal(closed, true);
  }
});


test("笔记插件作为子插件提前关闭，主动取消整理工作并等通知结束，父宿主继续可用", async (t) => {
  const empty = Type.Object({}, { additionalProperties: false });
  const parent: Plugin = {
    id: "container",
    async open(host) {
      const child = await notesPlugin.open(host);
      return {
        methods: {
          organize: { parameters: empty, async invoke() {
            const method = child.methods?.organize;
            assert.ok(method);
            return method.invoke({});
          } },
          closeChild: { parameters: empty, invoke: async () => child.close?.() },
          inspect: { parameters: empty, invoke: async () => "父插件仍然可用" },
        },
        close: async () => child.close?.(),
      };
    },
  };
  const testing = await createPluginTestHost({ plugins: [parent] });
  t.after(() => testing.close());
  const work = testing.models.expectAgent({ cancel: "manual" });
  await testing.host.call("container", "organize", {});
  let childClosed = false;
  const closingChild = testing.host.call("container", "closeChild", {}).then(() => { childClosed = true; });
  await work.cancelRequested;
  assert.equal(childClosed, false);
  assert.equal(hasEvent(testing.events, "organizeFinished"), false);
  assert.deepEqual(testing.host.list().map((plugin) => plugin.id), ["container"]);
  work.finish();
  await closingChild;
  assert.ok(hasEvent(testing.events, "organizeFinished"));
  assert.equal(await testing.host.call("container", "inspect", {}), "父插件仍然可用");
});
