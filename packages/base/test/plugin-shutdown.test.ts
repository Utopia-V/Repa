import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Type } from "typebox";

import type { Host, Plugin } from "../src/plugin.js";
import { openPluginHost } from "../src/plugins.js";
import { RepaFault } from "../src/schema.js";
import { createSpace } from "../src/space.js";
import { createPluginTestHost, ModelTestDriver } from "../src/testing.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("关闭停止接纳新变化，仍等已开始的变化处理保存完成", async (t) => {
  const entered = deferred();
  const resumed = deferred();
  let deriving = false;
  let callbacks = 0;
  let instanceClosed = false;
  const testing = await createPluginTestHost({
    plugins: [{
      id: "derive",
      async open(host) {
        return {
          async onChange() {
            if (!deriving) return;
            callbacks++;
            if (callbacks === 1) {
              entered.resolve();
              await resumed.promise;
            }
            // 旧实现会继续唤醒；限制回归情境轮数，使失败能交付而不是卡住测试。
            if (callbacks < 3) await host.files.write("derived.txt", `结果 ${callbacks}`);
          },
          async close() { instanceClosed = true; },
        };
      },
    }],
  });
  t.after(async () => {
    resumed.resolve();
    await testing.close();
  });
  await testing.host.start();
  deriving = true;
  const changing = testing.writeFile("input.txt", "输入");
  await entered.promise;
  const closing = testing.host.close();
  assert.equal(instanceClosed, false);
  resumed.resolve();
  await Promise.all([changing, closing]);
  assert.equal(callbacks, 1);
  assert.equal(await testing.space.files.read("derived.txt"), "结果 1");
  assert.equal(instanceClosed, true);
});

test("经 Host 发起的文件写入在等空间写锁时，宿主算作有工作，写完才空闲；关闭完成以后新发起的写入被拒绝", async (t) => {
  let saved: Host | undefined;
  const testing = await createPluginTestHost({
    plugins: [{
      id: "timer",
      async open(host) {
        saved = host;
        return {};
      },
    }],
  });
  t.after(() => testing.close());
  await testing.host.start();
  const host = saved;
  assert.ok(host);
  assert.equal(testing.host.busy(), false);
  // 空间写锁被别的写入者独占时，插件定时器发起的写入停在锁前。
  const holding = deferred();
  const locked = deferred();
  const recording = testing.space.record({ kind: "agent", runId: "run-hold" }, async () => {
    locked.resolve();
    await holding.promise;
  });
  await locked.promise;
  const writing = host.files.write("timer.txt", "定时写入");
  assert.equal(testing.host.busy(), true);
  holding.resolve();
  await recording;
  await writing;
  assert.equal(testing.host.busy(), false);
  await testing.host.close();
  await assert.rejects(host.files.write("late.txt", "关闭以后"), (error: unknown) => error instanceof RepaFault && error.code === "plugins_closed");
  assert.equal(await testing.space.files.read("timer.txt"), "定时写入");
});

test("实例 close 抛错时以 plugin_close_failed 报告，原错误保留在 cause 里", async () => {
  const original = new Error("定时器没有收回");
  const testing = await createPluginTestHost({
    plugins: [{ id: "leaky", async open() { return { async close() { throw original; } }; } }],
  });
  await testing.host.start();
  const failure = await testing.host.close().then(() => undefined, (error: unknown) => error);
  await testing.close().catch(() => undefined);
  assert.ok(failure instanceof AggregateError);
  const [reported] = failure.errors as unknown[];
  assert.ok(reported instanceof RepaFault);
  assert.equal(reported.code, "plugin_close_failed");
  assert.deepEqual(reported.details, { pluginId: "leaky" });
  assert.equal(reported.cause, original);
});

test("插件 close 执行期间，它等待的后台工作可以经 Host 写入；close 返回以后这个插件的写入被拒绝", async (t) => {
  const outcomes: string[] = [];
  let release: () => void = () => undefined;
  let background: Promise<void> = Promise.resolve();
  let second: Host | undefined;
  const testing = await createPluginTestHost({
    plugins: [
      {
        // 先打开，后关闭：它关闭时，second 的 close 已经返回。
        id: "first",
        async open(host) {
          return {
            async close() {
              await host.files.write("first.txt", "收尾");
              await second?.files.write("after.txt", "close 返回以后").then(
                () => { outcomes.push("after:written"); },
                (error: unknown) => { outcomes.push(`after:${error instanceof RepaFault ? error.code : String(error)}`); },
              );
            },
          };
        },
      },
      {
        id: "second",
        async open(host) {
          second = host;
          return {
            methods: {
              start: {
                parameters: Type.Object({}, { additionalProperties: false }),
                async invoke() {
                  const go = new Promise<void>((resolve) => { release = resolve; });
                  // 方法返回以后仍在后台继续，不属于任何宿主登记的工作。
                  background = (async () => {
                    await go;
                    await host.files.write("bg.txt", "后台结果");
                    await host.history.record({ kind: "plugin", pluginId: "second" }, async () => undefined);
                    outcomes.push("background:written");
                  })().catch((error: unknown) => { outcomes.push(`background:${error instanceof RepaFault ? error.code : String(error)}`); });
                  return null;
                },
              },
            },
            async close() {
              release();
              await background;
            },
          };
        },
      },
    ],
  });
  t.after(() => testing.close());
  await testing.host.start();
  await testing.host.call("second", "start", {});
  await testing.host.close();
  assert.deepEqual(testing.errors, []);
  assert.deepEqual(outcomes, ["background:written", "after:plugins_closed"]);
  assert.equal(await testing.space.files.read("bg.txt"), "后台结果");
  assert.equal(await testing.space.files.read("first.txt"), "收尾");
  await assert.rejects(testing.space.files.read("after.txt"));
});

test("close 执行期间发起、close 返回时仍未写完的写入，宿主等它写完才算关闭", async (t) => {
  let saved: Host | undefined;
  const testing = await createPluginTestHost({
    plugins: [{
      id: "tail",
      async open(host) {
        saved = host;
        return {
          async close() {
            // 发起以后不等它，close 先返回。
            void host.files.write("tail.txt", "最后一笔");
          },
        };
      },
    }],
  });
  t.after(() => testing.close());
  await testing.host.start();
  assert.ok(saved);
  const holding = deferred();
  const locked = deferred();
  const recording = testing.space.record({ kind: "agent", runId: "run-hold" }, async () => {
    locked.resolve();
    await holding.promise;
  });
  await locked.promise;
  let closed = false;
  const closing = testing.host.close().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  holding.resolve();
  await recording;
  await closing;
  assert.equal(await testing.space.files.read("tail.txt"), "最后一笔");
});

const empty = Type.Object({}, { additionalProperties: false });
const closedCode = (error: unknown) => error instanceof RepaFault && error.code === "plugins_closed";

/** 记下 open 时交出的 Host；hold 方法停在 gate 上，宿主据此有一项在途工作。 */
function savingPlugin(id: string, saved: Map<string, Host>, gate?: Promise<void>): Plugin {
  return {
    id,
    async open(host) {
      saved.set(id, host);
      return { methods: { hold: { parameters: empty, async invoke() { await gate; return null; } } } };
    },
  };
}

test("宿主开始关闭、这个插件的 close 还没开始时，它经 Host 的文件与历史操作照常接纳，宿主等它们写完", async (t) => {
  const saved = new Map<string, Host>();
  const hold = deferred();
  const testing = await createPluginTestHost({ plugins: [savingPlugin("late", saved, hold.promise)] });
  t.after(() => testing.close());
  await testing.host.start();
  const host = saved.get("late");
  assert.ok(host);
  // 关闭先等在途的方法；这期间插件的后台工作算完了结果，经 Host 写下。
  const holding = testing.host.call("late", "hold", {});
  const closing = testing.host.close();
  const writing = host.files.write("late.txt", "后台结果");
  const recording = host.history.record({ kind: "plugin", pluginId: "late" }, async () => undefined);
  hold.resolve();
  await holding;
  await writing;
  await recording;
  await closing;
  assert.equal(await testing.space.files.read("late.txt"), "后台结果");
  await assert.rejects(host.files.write("after.txt", "关闭以后"), closedCode);
});

test("打开时因声明无效被停用的插件，close 返回以后它保留的 Host 不能再读写", async (t) => {
  const saved = new Map<string, Host>();
  const testing = await createPluginTestHost({
    plugins: [{
      id: "invalid",
      async open(host) {
        saved.set("invalid", host);
        return { tools: () => [{ name: "坏名字", description: "", parameters: empty, execute: async () => ({ text: "" }) }] };
      },
    }],
  });
  t.after(() => testing.close());
  assert.deepEqual(testing.host.disabled().map((plugin) => plugin.id), ["invalid"]);
  const host = saved.get("invalid");
  assert.ok(host);
  await assert.rejects(host.files.write("stale.txt", "停用以后"), closedCode);
  await assert.rejects(host.history.list(1), closedCode);
  await assert.rejects(testing.space.files.read("stale.txt"));
});

test("open 拿到 Host 以后抛错的插件，它保留的 Host 不能再读写", async (t) => {
  const saved = new Map<string, Host>();
  const testing = await createPluginTestHost({
    plugins: [{
      id: "broken",
      async open(host) {
        saved.set("broken", host);
        throw new Error("打开失败");
      },
    }],
  });
  t.after(() => testing.close());
  assert.deepEqual(testing.host.disabled().map((plugin) => plugin.id), ["broken"]);
  const host = saved.get("broken");
  assert.ok(host);
  await assert.rejects(host.files.write("stale.txt", "失败以后"), closedCode);
  await assert.rejects(testing.space.files.read("stale.txt"));
});

test("宿主整体打开失败：已打开插件的 close 可以写入收尾，清理结束以后它的 Host 不能再读写", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-plugin-open-"));
  const space = await createSpace(path.join(directory, "space"), { watch: false });
  t.after(async () => {
    await space.close();
    await rm(directory, { recursive: true, force: true });
  });
  let kept: Host | undefined;
  const driver = new ModelTestDriver();
  const failure = await openPluginHost({
    space,
    plugins: [
      {
        id: "first",
        async open(host) {
          kept = host;
          return { async close() { await host.files.write("first.txt", "收尾"); } };
        },
      },
      { id: "second", async open() { return {}; } },
    ],
    // 第二个插件的模型作用域建不起来，这不属于单个插件的打开失败，整个宿主打开失败。
    models: (pluginId) => {
      if (pluginId === "second") throw new Error("模型配置缺失");
      return driver;
    },
    emit: () => undefined,
    onError: () => undefined,
  }).then(() => undefined, (error: unknown) => error);
  assert.ok(failure instanceof Error);
  assert.equal(failure.message, "模型配置缺失");
  assert.ok(kept);
  assert.equal(await space.files.read("first.txt"), "收尾");
  await assert.rejects(kept.files.write("stale.txt", "清理以后"), closedCode);
});
