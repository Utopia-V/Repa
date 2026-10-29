import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAgentRuntimeForTest } from "../src/agent/runtime.js";
import { RepaClient } from "../src/client.js";
import type { Plugin } from "../src/plugin.js";
import { startServer } from "../src/protocol/server.js";
import { readParent } from "../src/agent/parent.js";
import { withRun, withToolCall } from "../src/run-context.js";
import { RepaFault } from "../src/schema.js";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-model-call-")));
  const agentDir = path.join(root, "app", "agent");
  const sessionsDir = path.join(root, ".repa", "sessions");
  await mkdir(agentDir, { recursive: true });
  const faux = fauxProvider({ api: `repa-api-${randomUUID()}`, provider: `repa-provider-${randomUUID()}`, models: [{ id: "test" }], tokensPerSecond: 0 });
  const models = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  models.registerNativeProvider(faux.provider);
  const runtime = await createAgentRuntimeForTest({ agentDir, modelRuntime: models, defaultModel: { provider: faux.getModel().provider, id: "test" }, settingsManager: SettingsManager.inMemory() });
  const space = await runtime.openSpace({ root, sessionsDir, instructions: () => [], tools: () => [], views: async () => [], overrides: async () => ({ app: {}, space: {} }), commandPolicy: () => "fullAccess", record: async (_id, action) => action(), onEvent: () => undefined, confirm: async () => true });
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, sessionsDir, runtime, space, faux, scope: { root, sessionsDir, pluginId: "test-plugin" } };
}

const fault = (code: string) => (error: unknown) => error instanceof RepaFault && error.code === code;

test("空间插件完成请求以 Pi 会话保存提示、回答和用量，列表隐藏但编号可打开", async t => {
  const f = await fixture(t);
  let calls = 0;
  f.faux.setResponses([context => {
    calls++;
    assert.equal(getCurrentSystemPrompt(context.messages), "插件系统说明");
    assert.deepEqual(getCurrentTools(context.messages), []);
    assert.equal(context.messages.filter(message => message.role === "user").length, 1);
    return fauxAssistantMessage("回答正文");
  }]);
  assert.equal(await f.runtime.complete({ system: "插件系统说明", prompt: "用户任务" }, f.scope), "回答正文");
  assert.equal(calls, 1);
  const files = (await readdir(f.sessionsDir)).filter(file => file.endsWith(".jsonl"));
  assert.equal(files.length, 1);
  const file = files[0];
  assert.ok(file);
  const manager = SessionManager.open(path.join(f.sessionsDir, file));
  const id = manager.getSessionId();
  assert.match(file, new RegExp(`_${id}\\.jsonl$`, "u"));
  const entries = manager.getEntries();
  const origin = entries.find(entry => entry.type === "custom" && entry.customType === "repa-model-call");
  assert.ok(origin?.type === "custom");
  assert.deepEqual(origin.data, { pluginId: "test-plugin" });
  const messages = entries.flatMap(entry => entry.type === "message" ? [entry.message] : []);
  assert.deepEqual(messages.map(message => message.role), ["system", "user", "assistant"]);
  assert.equal(getCurrentSystemPrompt(messages), "插件系统说明");
  assert.match(await readFile(path.join(f.sessionsDir, file), "utf8"), /用户任务/u);
  const assistant = messages.find(message => message.role === "assistant");
  assert.ok(assistant);
  assert.ok(assistant.usage.input > 0);
  assert.ok(assistant.usage.output > 0);
  assert.deepEqual(await f.space.list(), []);
  const opened = await f.space.get(id);
  assert.equal(opened.history().find(entry => entry.type === "assistant")?.text, "回答正文");
  assert.deepEqual(await f.space.list(), []);
  await assert.rejects(opened.send("继续"), fault("agent_not_found"));
  assert.equal(await readParent(f.sessionsDir, id), undefined);
});

test("运行中插件模型调用保留父运行和工具关联，空间外完成请求只使用内存", async t => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("子结果"), fauxAssistantMessage("内存结果")]);
  await withRun({ sessionId: "parent-session", runId: "parent-run", ancestorRunIds: [], agent: "general" }, () => withToolCall("parent-call", () => f.runtime.complete({ prompt: "子任务" }, f.scope)));
  const [file] = (await readdir(f.sessionsDir)).filter(name => name.endsWith(".jsonl"));
  assert.ok(file);
  const manager = SessionManager.open(path.join(f.sessionsDir, file));
  assert.deepEqual(await readParent(f.sessionsDir, manager.getSessionId()), { sessionId: "parent-session", runId: "parent-run", callId: "parent-call" });
  const before = await readdir(f.sessionsDir);
  assert.equal(await f.runtime.complete({ system: "检查课程", prompt: "离线课程核对" }), "内存结果");
  assert.deepEqual(await readdir(f.sessionsDir), before);
});

test("结构化完成仅声明原 schema 的约束工具，成功提交后不再请求模型", async t => {
  const f = await fixture(t);
  const schema = Type.Object({ answer: Type.String() }, { additionalProperties: false });
  let calls = 0;
  f.faux.setResponses([context => {
    calls++;
    assert.equal(getCurrentSystemPrompt(context.messages), "结构化说明\n\n用 submit_result 工具提交结果，只调用一次。");
    const [tool] = getCurrentTools(context.messages);
    assert.ok(tool);
    assert.equal(tool.name, "submit_result");
    assert.deepEqual(tool.parameters, JSON.parse(JSON.stringify(schema)));
    assert.deepEqual(tool.constrainedSampling, { type: "json_schema", strict: "prefer" });
    return fauxAssistantMessage(fauxToolCall("submit_result", { answer: "结果" }));
  }]);
  assert.deepEqual(await f.runtime.completeStructured({ system: "结构化说明", prompt: "提交结果" }, schema, f.scope), { answer: "结果" });
  assert.equal(calls, 1);
  const [file] = (await readdir(f.sessionsDir)).filter(name => name.endsWith(".jsonl"));
  assert.ok(file);
  const manager = SessionManager.open(path.join(f.sessionsDir, file));
  const messages = manager.getEntries().flatMap(entry => entry.type === "message" ? [entry.message] : []);
  assert.equal(getCurrentSystemPrompt(messages), "结构化说明\n\n用 submit_result 工具提交结果，只调用一次。");
  assert.equal(getCurrentTools(messages).length, 1);
  assert.equal(manager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "toolResult").length, 1);
});

test("结构化完成没有调用工具时返回 invalid_model_output，不重试", async t => {
  const f = await fixture(t);
  let calls = 0;
  f.faux.setResponses([() => { calls++; return fauxAssistantMessage("直接回答"); }]);
  await assert.rejects(f.runtime.completeStructured({ prompt: "提交结果" }, Type.Object({ answer: Type.String() })), (error: unknown) => fault("invalid_model_output")(error) && error instanceof Error && error.message === "模型没有调用 submit_result");
  assert.equal(calls, 1);
});

test("短会话模型错误和取消保留约定错误码", async t => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "服务故障" })]);
  await assert.rejects(f.runtime.complete({ prompt: "错误请求" }, f.scope), fault("model_error"));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.runtime.complete({ prompt: "取消请求", signal: controller.signal }, f.scope), fault("cancelled"));
});


test("协议宿主给插件调用补上空间和插件归属，工具调用关联真实父运行", async t => {
  const f = await fixture(t);
  const root = path.join(f.root, "product-space");
  await mkdir(root);
  const plugin: Plugin = {
    id: "integration-plugin",
    async open(host) {
      return {
        tools: () => [{
          name: "call_model",
          description: "调用插件模型",
          parameters: Type.Object({}),
          async execute() {
            return { text: await host.models.complete({ system: "内部说明", prompt: "工具内子任务" }) };
          },
        }],
        methods: {
          complete: {
            parameters: Type.Object({}),
            async invoke() {
              return host.models.complete({ system: "外部说明", prompt: "方法子任务" });
            },
          },
        },
      };
    },
  };
  const server = await startServer({ home: path.join(f.root, "protocol-home"), runtime: f.runtime, plugins: [plugin] });
  const client = await RepaClient.connect(server.connection);
  try {
    await client.call("space.open", { root });
    f.faux.setResponses([fauxAssistantMessage("方法模型结果")]);
    assert.equal(await client.call("plugin.call", { pluginId: plugin.id, method: "complete", input: {} }), "方法模型结果");
    assert.deepEqual(await client.call("session.list", {}), []);
    const parent = await client.call("session.create", {});
    const callId = "integration-call";
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("call_model", {}, { id: callId })),
      fauxAssistantMessage("工具模型结果"),
      fauxAssistantMessage("父运行完成"),
    ]);
    await client.call("session.send", { sessionId: parent.id, text: "发起模型调用" });
    const sessionsDir = path.join(root, ".repa", "sessions");
    const managers = (await SessionManager.listAll(sessionsDir)).map(info => SessionManager.open(info.path));
    const modelCalls = managers.filter(manager => manager.getEntries().some(entry => entry.type === "custom" && entry.customType === "repa-model-call"));
    assert.equal(modelCalls.length, 2);
    for (const manager of modelCalls) {
      const origin = manager.getEntries().find(entry => entry.type === "custom" && entry.customType === "repa-model-call");
      assert.ok(origin?.type === "custom");
      assert.deepEqual(origin.data, { pluginId: plugin.id });
    }
    const internal = modelCalls.find(manager => manager.getEntries().some(entry => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("工具内子任务")));
    const external = modelCalls.find(manager => manager !== internal);
    assert.ok(internal);
    assert.ok(external);
    const parentRun = (await client.call("session.history", { sessionId: parent.id })).find(entry => entry.type === "run")?.data;
    assert.ok(parentRun !== null && typeof parentRun === "object" && "runId" in parentRun);
    assert.deepEqual(await readParent(sessionsDir, internal.getSessionId()), { sessionId: parent.id, runId: parentRun.runId, callId });
    assert.equal(await readParent(sessionsDir, external.getSessionId()), undefined);
    assert.deepEqual((await client.call("session.list", {})).map(info => info.id), [parent.id]);
    assert.equal((await client.call("session.history", { sessionId: internal.getSessionId() })).find(entry => entry.type === "assistant")?.text, "工具模型结果");
    assert.deepEqual((await client.call("session.list", {})).map(info => info.id), [parent.id]);
  } finally {
    await client.close();
    await server.close();
  }
});


test("空系统提示原样进入实际请求和持久会话，不回退到 Pi 的默认提示", async t => {
  const f = await fixture(t);
  for (const system of [undefined, ""]) {
    f.faux.setResponses([context => {
      assert.equal(getCurrentSystemPrompt(context.messages), "");
      return fauxAssistantMessage("完成");
    }]);
    assert.equal(await f.runtime.complete({ prompt: "仅用户任务", ...(system === undefined ? {} : { system }) }, f.scope), "完成");
  }
  const sessions = await SessionManager.listAll(f.sessionsDir);
  assert.equal(sessions.length, 2);
  for (const info of sessions) {
    const manager = SessionManager.open(info.path);
    const messages = manager.getEntries().flatMap(entry => entry.type === "message" ? [entry.message] : []);
    assert.equal(getCurrentSystemPrompt(messages), "");
  }
});


test("结构化完成的参数不合格时只请求一次，并以 invalid_model_output 说明首个字段", async t => {
  const f = await fixture(t);
  const schema = Type.Object({ answer: Type.String() }, { additionalProperties: false });
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("submit_result", {})),
    fauxAssistantMessage("没有提交有效参数"),
  ]);
  let failure: unknown;
  try {
    await f.runtime.completeStructured({ prompt: "提交结果" }, schema, f.scope);
  } catch (error) {
    failure = error;
  }
  assert.equal(f.faux.state.callCount, 1);
  assert.ok(failure instanceof RepaFault);
  assert.equal(failure.code, "invalid_model_output");
  assert.match(failure.message, /\/answer[：:]\s*.+/u);
});
