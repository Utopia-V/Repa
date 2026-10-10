import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import test from "node:test";

import { Type } from "typebox";
import { createPluginTestHost, ModelTestDriver } from "@repa/base/testing";

const fault = (code: string) => (error: unknown): boolean => error instanceof Error && "code" in error && error.code === code;

test("离线模型未安排的调用立即失败，结构化响应通过调用方 schema 校验", async () => {
  const models = new ModelTestDriver();
  await assert.rejects(models.complete({ prompt: "未安排" }), /expect/);
  models.expectStructured().succeed({ value: "不是数字" });
  await assert.rejects(models.completeStructured({ prompt: "结构化" }, Type.Object({ value: Type.Number() })), fault("invalid_input"));
  models.expectStructured().succeed({ value: 42 });
  assert.deepEqual(await models.completeStructured({ prompt: "结构化" }, Type.Object({ value: Type.Number() })), { value: 42 });
});

test("离线模型接收 AbortSignal 并结束被取消的在途完成请求", async () => {
  const models = new ModelTestDriver();
  const response = models.expectComplete();
  const controller = new AbortController();
  const reason = new Error("取消请求");
  const completing = models.complete({ prompt: "等待", signal: controller.signal });
  assert.equal((await response.requested).signal, controller.signal);
  controller.abort(reason);
  await assert.rejects(completing, (error) => error === reason);
});

test("离线宿主关闭失败仍释放空间并移除临时目录，重复关闭交付同一失败", async () => {
  const testing = await createPluginTestHost({
    plugins: [{ id: "bad", open: async () => ({ close: async () => { throw new Error("关闭失败"); } }) }],
  });
  const closing = testing.close();
  assert.equal(testing.close(), closing);
  await assert.rejects(closing, AggregateError);
  await assert.rejects(stat(testing.directory), fault("ENOENT"));
});

test("离线宿主初始化失败关闭已打开实例并释放临时目录", async () => {
  let directory = "";
  let closed = false;
  await assert.rejects(createPluginTestHost({
    plugins: [
      { id: "first", open: async (host) => {
        directory = host.space.root;
        return { close: async () => { closed = true; } };
      } },
      { id: "second", open: async () => { throw new Error("打开失败"); } },
    ],
  }), /打开失败/);
  assert.equal(closed, true);
  await assert.rejects(stat(directory), fault("ENOENT"));
});
