import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import test from "node:test";

import { Type } from "typebox";
import { checkResponse, contentVersion, type AskOutcome, type ItemDraft, type Plugin } from "@repa/base/plugin";
import { createPluginTestHost, ModelTestDriver, type AskInput } from "@repa/base/testing";

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

test("离线宿主把插件的询问交给测试提供的路由：题目已补上版本和能力，多带答案字段的题在交出前被拒绝", async (t) => {
  const asked: AskInput[] = [];
  const outcomes: AskOutcome[] = [];
  const draft: ItemDraft = { id: "py01.k1.q1", body: [{ type: "markdown", text: "输出是什么？" }], slots: [{ id: "output", type: "text" }] };
  const plugin: Plugin = {
    id: "practice",
    async open(host) {
      return {
        tools: () => [{
          name: "practice_once",
          description: "出一道练习",
          parameters: Type.Object({ leak: Type.Boolean() }, { additionalProperties: false }),
          async execute(input, context) {
            const leak = (input as { leak: boolean }).leak;
            const item = leak ? { ...draft, answer: "5" } : draft;
            outcomes.push(await context.ask({
              item,
              purpose: "practice",
              evaluate: async (response) => ({ status: "recorded", feedback: { item: response.item, verdict: "correct" } }),
            }));
            const result = await host.services.call("python.run", { code: "print(5)" }, { signal: context.signal });
            return { text: JSON.stringify(result) };
          },
        }],
      };
    },
  };
  const testing = await createPluginTestHost({
    plugins: [plugin],
    async ask(request, options) {
      asked.push(request);
      const response = { item: { id: request.item.id, version: request.item.version }, answers: { output: { type: "text" as const, text: "5" } } };
      const checked = checkResponse(request.item, response);
      assert.equal(checked.ok, true);
      return { action: "submit", response, ...(options.evaluate === undefined ? {} : { result: await options.evaluate(response) }) };
    },
    services: { call: async (service, input) => ({ service, input }) },
  });
  t.after(() => testing.close());
  const [tool] = testing.host.tools();
  assert.ok(tool);
  const context = { signal: new AbortController().signal, callId: "call-1" };
  assert.equal((await tool.execute({ leak: false }, context)).text, JSON.stringify({ service: "python.run", input: { code: "print(5)" } }));
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0]?.origin, { kind: "plugin", pluginId: "practice", callId: "call-1" });
  assert.deepEqual(asked[0]?.item.requires, ["block.markdown", "slot.text"]);
  assert.equal(asked[0]?.item.version, await contentVersion(draft));
  assert.equal(outcomes[0]?.action === "submit" ? outcomes[0].result?.status : undefined, "recorded");
  await assert.rejects(tool.execute({ leak: true }, context), fault("invalid_item"));
  assert.equal(asked.length, 1);
});

test("离线宿主没有提供询问和服务时，插件得到明确的错误码", async (t) => {
  const plugin: Plugin = {
    id: "lonely",
    async open(host) {
      return {
        tools: () => [{
          name: "lonely_ask",
          description: "提问",
          parameters: Type.Object({}, { additionalProperties: false }),
          execute: async (_input, context) => ({ text: (await context.ask({ item: { id: "q", body: [], slots: [{ id: "a", type: "text" }] }, purpose: "question" })).action }),
        }],
        methods: { run: { parameters: Type.Object({}, { additionalProperties: false }), invoke: async () => host.services.call("python.run", {}) } },
      };
    },
  };
  const testing = await createPluginTestHost({ plugins: [plugin] });
  t.after(() => testing.close());
  const [tool] = testing.host.tools();
  assert.ok(tool);
  await assert.rejects(tool.execute({}, { signal: new AbortController().signal, callId: "call-1" }), fault("ask_unavailable"));
  await assert.rejects(testing.host.call("lonely", "run", {}), fault("service_unavailable"));
});
