import assert from "node:assert/strict";
import test from "node:test";

import { Type } from "typebox";

import type { Host } from "../src/plugin.js";
import { RepaFault } from "../src/schema.js";
import { createPluginTestHost } from "../src/testing.js";

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

/** 插件经 Host 的各类操作的结果：成功为 ok，失败为错误码；同步抛出的错误同样算作结果。 */
async function outcome(action: () => Promise<unknown>): Promise<string> {
  try {
    await Promise.resolve().then(action);
    return "ok";
  } catch (error) {
    return error instanceof RepaFault ? error.code : String(error);
  }
}

async function hostOutcomes(host: Host, pluginId: string) {
  return {
    write: await outcome(() => host.files.write(`${pluginId}.txt`, "旧 Host 的写入")),
    read: await outcome(() => host.files.list(".")),
    history: await outcome(() => host.history.list(1)),
    record: await outcome(() => host.history.record({ kind: "plugin", pluginId }, async () => undefined)),
    model: await outcome(() => host.models.complete({ system: "说明", prompt: "旧 Host 的模型调用" })),
    service: await outcome(() => host.services.call("echo", {})),
  };
}

const rejected = { write: "plugins_closed", read: "plugins_closed", history: "plugins_closed", record: "plugins_closed", model: "models_closed", service: "plugins_closed" };

test("打开时停用的插件和 open 拿到 Host 以后抛错的插件：它们保留的 Host 不能再读写文件、记历史、调模型和服务", async (t) => {
  const hosts = new Map<string, Host>();
  const empty = Type.Object({}, { additionalProperties: false });
  const testing = await createPluginTestHost({
    services: { call: async () => "服务结果" },
    plugins: [
      {
        id: "invalid",
        async open(host) {
          hosts.set("invalid", host);
          return { tools: () => [{ name: "不是有效的工具名", description: "", parameters: empty, execute: async () => ({ text: "" }) }] };
        },
      },
      { id: "throws", async open(host) { hosts.set("throws", host); throw new Error("打开失败"); } },
      { id: "good", async open(host) { hosts.set("good", host); return {}; } },
    ],
  });
  t.after(() => testing.close());
  await testing.host.start();
  assert.deepEqual(testing.host.disabled().map(({ id }) => id), ["invalid", "throws"]);
  const invalid = hosts.get("invalid");
  const throws = hosts.get("throws");
  const good = hosts.get("good");
  assert.ok(invalid && throws && good);
  assert.deepEqual(await hostOutcomes(invalid, "invalid"), rejected);
  assert.deepEqual(await hostOutcomes(throws, "throws"), rejected);
  assert.deepEqual(await testing.space.files.list("."), []);
  // 同一宿主里照常运行的插件不受影响。
  assert.equal(await outcome(() => good.files.write("good.txt", "照常写入")), "ok");
  assert.equal(await outcome(() => good.services.call("echo", {})), "ok");
});

test("关闭时插件 close 等待的后台工作可以经 Host 写入结果；close 返回以后这个 Host 不能再读写文件和记历史", async (t) => {
  let kept: Host | undefined;
  const testing = await createPluginTestHost({
    plugins: [{
      id: "background",
      async open(host) {
        kept = host;
        const release = deferred();
        // 插件自己在后台做的事：放行以后经 Host 写入结果并记一笔历史。
        const background = release.promise.then(async () => {
          await host.files.write("result.txt", "后台结果");
          await host.history.record({ kind: "plugin", pluginId: "background" }, async () => undefined);
        });
        return {
          async close() {
            release.resolve();
            await background;
          },
        };
      },
    }],
  });
  t.after(() => testing.close());
  await testing.host.start();
  await testing.host.close();
  assert.equal(await testing.space.files.read("result.txt"), "后台结果");
  assert.ok(kept);
  const host = kept;
  assert.deepEqual(
    { write: await outcome(() => host.files.write("stale.txt", "关闭以后")), record: await outcome(() => host.history.record({ kind: "plugin", pluginId: "background" }, async () => undefined)) },
    { write: "plugins_closed", record: "plugins_closed" },
  );
  assert.deepEqual(await testing.space.files.list("."), ["result.txt"]);
});
