import assert from "node:assert/strict";
import test from "node:test";

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
