import assert from "node:assert/strict";
import test from "node:test";

import { Type } from "typebox";

import { createPluginTestHost, ModelTestDriver } from "@repa/base/testing";

import { notesPlugin } from "../examples/notes-plugin.js";
import type { AgentTask, PluginInstance } from "../src/plugin.js";

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => { throw new Error("尚未创建屏障"); };
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const empty = Type.Object({}, { additionalProperties: false });
const fault = (code: string) => (error: unknown): boolean => error instanceof Error && "code" in error && error.code === code;

test("子笔记插件关闭等待迟到的整理句柄，取消后等待终态并拒绝新方法，父仍可请求模型", async (t) => {
  const entered = deferred<void>();
  const created = deferred<void>();
  class DelayedModels extends ModelTestDriver {
    override async runAgent(task: AgentTask) {
      entered.resolve();
      await created.promise;
      return super.runAgent(task);
    }
  }
  const models = new DelayedModels();
  let child: PluginInstance | undefined;
  const testing = await createPluginTestHost({
    models,
    plugins: [{
      id: "container",
      async open(host) {
        child = await notesPlugin.open(host);
        return {
          methods: { probe: { parameters: empty, invoke: () => host.models.complete({ prompt: "父插件请求" }) } },
          close: async () => child?.close?.(),
        };
      },
    }],
  });
  t.after(() => testing.close());
  assert.ok(child);
  const organize = child.methods?.organize;
  const setStyle = child.methods?.setStyle;
  assert.ok(organize);
  assert.ok(setStyle);
  const work = models.expectAgent({ cancel: "manual" });
  const launching = organize.invoke({}, {});
  await entered.promise;
  let stopped = false;
  const closing = child.close?.().then(() => { stopped = true; });
  await assert.rejects(async () => organize.invoke({}, {}), fault("plugin_closed"));
  await assert.rejects(async () => setStyle.invoke({ style: "不应写入" }, {}), fault("plugin_closed"));
  created.resolve();
  await work.cancelRequested;
  assert.equal(stopped, false);
  work.finish();
  assert.deepEqual(await launching, { id: work.id });
  await closing;
  assert.equal(stopped, true);
  models.expectComplete().succeed("父插件仍可用");
  assert.equal(await testing.host.call("container", "probe", {}), "父插件仍可用");
});

test("子笔记插件提前关闭取消未完成的改写和概括，停止自己的模型作用域", async (t) => {
  let child: PluginInstance | undefined;
  const testing = await createPluginTestHost({
    plugins: [{ id: "container", async open(host) {
      child = await notesPlugin.open(host);
      return { close: async () => child?.close?.() };
    } }],
  });
  t.after(() => testing.close());
  assert.ok(child);
  const rewrite = child.methods?.rewrite;
  const summarize = child.methods?.summarize;
  assert.ok(rewrite);
  assert.ok(summarize);
  const rewritePlan = testing.models.expectComplete();
  const summaryPlan = testing.models.expectStructured();
  const rewriting = assert.rejects(rewrite.invoke({ text: "原文", style: "简短" }, {}), { name: "AbortError" });
  const summarizing = assert.rejects(summarize.invoke({ text: "原文" }, {}), { name: "AbortError" });
  const [rewriteRequest, summaryRequest] = await Promise.all([rewritePlan.requested, summaryPlan.requested]);
  await child.close?.();
  assert.equal(rewriteRequest.signal?.aborted, true);
  assert.equal(summaryRequest.signal?.aborted, true);
  await Promise.all([rewriting, summarizing]);
});
