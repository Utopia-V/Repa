import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

import { Type } from "typebox";

import { createModelScope, type Models } from "../src/plugin.js";

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => { throw new Error("尚未创建屏障"); };
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const empty = Type.Object({}, { additionalProperties: false });

const unusedModels: Models = {
  async complete() { throw new Error("不应请求模型"); },
  async completeStructured() { throw new Error("不应请求模型"); },
  async runAgent() { throw new Error("不应请求模型"); },
};
const closed = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "models_closed";

test("模型作用域开始关闭就拒绝新请求，close 重复调用等待同一条完成链", async () => {
  const scope = createModelScope(unusedModels);
  const closing = scope.close();
  assert.equal(scope.close(), closing);
  await assert.rejects(async () => scope.models.complete({ prompt: "新请求" }), closed);
  await assert.rejects(async () => scope.models.completeStructured({ prompt: "新请求" }, empty), closed);
  await assert.rejects(async () => scope.models.runAgent({ text: "新工作" }), closed);
  await closing;
});

test("嵌套模型作用域等待迟到句柄，局部取消等终态，外层仍可以继续工作", async () => {
  const entered = deferred<void>();
  const created = deferred<void>();
  const cancelled = deferred<void>();
  const finish = deferred<void>();
  let cancellations = 0;
  const root = createModelScope({
    ...unusedModels,
    async complete() { return "继续使用外层"; },
    async runAgent() {
      entered.resolve();
      await created.promise;
      return { id: "nested", result: finish.promise, async cancel() { cancellations++; cancelled.resolve(); } };
    },
  });
  const child = createModelScope(root.models);
  const launching = child.models.runAgent({ text: "工作" });
  await entered.promise;
  let stopped = false;
  const closing = child.close().then(() => { stopped = true; });
  await assert.rejects(async () => child.models.runAgent({ text: "关闭后的工作" }), closed);
  created.resolve();
  await cancelled.promise;
  assert.equal(stopped, false);
  finish.resolve();
  await launching;
  await closing;
  assert.equal(cancellations, 1);
  assert.equal(await root.models.complete({ prompt: "新请求" }), "继续使用外层");
  await root.close();
});

test("局部作用域关闭取消完整与结构化请求，保留调用方的取消信号", async () => {
  const completeEntered = deferred<AbortSignal>();
  const structuredEntered = deferred<AbortSignal>();
  const scope = createModelScope({
    ...unusedModels,
    async complete(request) {
      assert.ok(request.signal);
      completeEntered.resolve(request.signal);
      await new Promise<void>((resolve) => { request.signal?.addEventListener("abort", () => { resolve(); }, { once: true }); });
      throw request.signal.reason;
    },
    async completeStructured(request) {
      assert.ok(request.signal);
      structuredEntered.resolve(request.signal);
      await new Promise<void>((resolve) => { request.signal?.addEventListener("abort", () => { resolve(); }, { once: true }); });
      throw request.signal.reason;
    },
  });
  const caller = new AbortController();
  const originalReason = new Error("调用方取消");
  const complete = assert.rejects(scope.models.complete({ prompt: "普通请求", signal: caller.signal }), (error) => error === originalReason);
  const structured = assert.rejects(scope.models.completeStructured({ prompt: "结构化请求" }, empty), { name: "AbortError" });
  const [completeSignal, structuredSignal] = await Promise.all([completeEntered.promise, structuredEntered.promise]);
  caller.abort(originalReason);
  assert.equal(completeSignal.aborted, true);
  assert.equal(structuredSignal.aborted, false);
  await scope.close();
  assert.equal(structuredSignal.aborted, true);
  await Promise.all([complete, structured]);
});

test("Agent 结果先结束而主动取消仍在收尾，作用域关闭等待取消完成链", async () => {
  const cancelling = deferred<void>();
  const cancelled = deferred<void>();
  const result = deferred<void>();
  const scope = createModelScope({
    ...unusedModels,
    async runAgent() {
      return {
        id: "late-cancel-cleanup",
        result: result.promise,
        async cancel() {
          cancelling.resolve();
          await cancelled.promise;
        },
      };
    },
  });
  const task = await scope.models.runAgent({ text: "工作" });
  const cancellation = task.cancel();
  await cancelling.promise;
  result.resolve();
  await task.result;
  let closed = false;
  const closing = scope.close().then(() => { closed = true; });
  // 跨过当前微任务队列，观察 result 移出活动集合后的关闭状态。
  await setImmediate();
  assert.equal(closed, false);
  cancelled.resolve();
  await Promise.all([cancellation, closing]);
  assert.equal(closed, true);
});


test("关闭立即取消已有与迟到的 Agent，慢请求的终态不会阻塞其他取消", { timeout: 10_000 }, async () => {
  const completionEntered = deferred<AbortSignal>();
  const completionFinished = deferred<void>();
  const lateEntered = deferred<void>();
  const lateCreated = deferred<void>();
  const existingCancelled = deferred<void>();
  const lateCancelled = deferred<void>();
  const existingFinished = deferred<void>();
  const lateFinished = deferred<void>();
  const scope = createModelScope({
    ...unusedModels,
    async complete(request) {
      assert.ok(request.signal);
      completionEntered.resolve(request.signal);
      // 用手工屏障模拟取消已收到但请求尚未退出。
      await completionFinished.promise;
      return "慢请求已结束";
    },
    async runAgent(task) {
      if (task.text === "已有工作") {
        return { id: "existing", result: existingFinished.promise, async cancel() { existingCancelled.resolve(); } };
      }
      lateEntered.resolve();
      await lateCreated.promise;
      return { id: "late", result: lateFinished.promise, async cancel() { lateCancelled.resolve(); } };
    },
  });
  await scope.models.runAgent({ text: "已有工作" });
  const completion = scope.models.complete({ prompt: "慢请求" });
  const late = scope.models.runAgent({ text: "迟到工作" });
  const signal = await completionEntered.promise;
  await lateEntered.promise;
  let closed = false;
  const closing = scope.close().then(() => { closed = true; });
  await existingCancelled.promise;
  assert.equal(signal.aborted, true);
  assert.equal(closed, false);
  lateCreated.resolve();
  await lateCancelled.promise;
  assert.equal(closed, false);
  completionFinished.resolve();
  existingFinished.resolve();
  lateFinished.resolve();
  await Promise.all([completion, late, closing]);
  assert.equal(closed, true);
});
