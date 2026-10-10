import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { fauxAssistantMessage, fauxProvider, getCurrentSystemPrompt, getInitialSystemMessage, getCurrentTools } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { Type } from "typebox";

import type { Models, Plugin } from "../src/plugin.js";
import { openPluginHost } from "../src/plugins.js";
import { createSpace } from "../src/space.js";
import { createAgentRuntimeForTest } from "../src/agent/runtime.js";

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext, extensionFactories: ExtensionFactory[] = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-prompt-preflight-"));
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir);
  const faux = fauxProvider({ api: `repa-api-${randomUUID()}`, provider: `repa-provider-${randomUUID()}`, models: [{ id: "test", contextWindow: 16384, maxTokens: 512 }], tokensPerSecond: 0 });
  const models = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  models.registerNativeProvider(faux.provider);
  const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 16, reserveTokens: 400 }, cacheWarming: "off" });
  const runtime = await createAgentRuntimeForTest({ agentDir, modelRuntime: models, defaultModel: { provider: faux.getModel().provider, id: "test" }, settingsManager: settings, extensionFactories });
  let text = "规则 A";
  const space = await runtime.openSpace({
    root, sessionsDir: path.join(root, "sessions"), instructions: () => [{ id: "plugin:test", text }], tools: () => [], views: async () => [],
    overrides: async () => ({ app: {}, space: {} }), commandPolicy: () => "fullAccess", record: async (_id, action) => action(), onEvent: () => {}, confirm: async () => true,
  });
  const session = await space.create();
  const resources: Array<() => Promise<void>> = [];
  t.after(async () => {
    await runtime.close();
    for (const close of resources.reverse()) await close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, runtime, faux, session, ownClose(close: () => Promise<void>) { resources.push(close); }, text(value: string) { text = value; } };
}

test("提示更新 preflight 期间取消不调用模型，下一轮沿用一次说明", { timeout: 10000 }, async t => {
  const entered = deferred();
  const release = deferred();
  let blocked = false;
  const f = await fixture(t, [pi => {
    pi.on("before_agent_start", async () => {
      if (!blocked) return;
      entered.resolve();
      await release.promise;
    });
  }]);
  f.faux.setResponses([fauxAssistantMessage("初始回答")]);
  await f.session.send("开始");
  assert.equal(f.session.history().filter(entry => entry.type === "promptChange").length, 0, "首轮不应附变更说明");
  f.text("规则 B");
  blocked = true;
  const rejected = assert.rejects(f.session.send("将取消的问题"), error => error !== null && typeof error === "object" && "code" in error && error.code === "cancelled");
  await entered.promise;
  const cancelling = f.session.abort();
  release.resolve();
  await cancelling;
  await rejected;
  assert.equal(f.faux.state.callCount, 1);
  assert.equal(f.session.history().filter(entry => entry.type === "promptChange").length, 1);
  blocked = false;
  f.faux.setResponses([context => {
    assert.match(getCurrentSystemPrompt(context.messages), /规则 B/u);
    assert.equal(context.messages.filter(message => JSON.stringify(message.content).includes("提示变更说明")).length, 1);
    return fauxAssistantMessage("取消后的回答");
  }]);
  await f.session.send("继续");
  assert.equal(f.session.history().filter(entry => entry.type === "promptChange").length, 1);
});

test("提示更新后的压缩保留当前规则且下一轮不重复说明", async t => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("回答 A".repeat(100))]);
  await f.session.send("问题 A");
  f.text("规则 B");
  f.faux.setResponses([fauxAssistantMessage("回答 B".repeat(100))]);
  await f.session.send("问题 B");
  f.faux.setResponses([fauxAssistantMessage("摘要"), fauxAssistantMessage("前缀摘要")]);
  await f.session.compact();
  f.faux.setResponses([context => {
    assert.match(getCurrentSystemPrompt(context.messages), /规则 B/u);
    return fauxAssistantMessage("压缩后回答");
  }]);
  await f.session.send("继续");
  assert.equal(f.session.history().filter(entry => entry.type === "promptChange").length, 1);
  f.text("规则 C");
  f.faux.setResponses([fauxAssistantMessage("回答 C")]);
  await f.session.send("再次更新");
  assert.equal(f.session.history().filter(entry => entry.type === "promptChange").length, 2);
});

test("从旧规则和已更新规则分支都按分支投影发送一次说明", async t => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("回答 A")]);
  await f.session.send("问题 A");
  const old = f.session.history().findLast(entry => entry.type === "assistant");
  assert(old);
  f.text("规则 B");
  f.faux.setResponses([fauxAssistantMessage("回答 B")]);
  await f.session.send("问题 B");
  const updated = f.session.history().findLast(entry => entry.type === "assistant");
  assert(updated);
  const oldFork = await f.session.fork(old.id);
  f.faux.setResponses([fauxAssistantMessage("旧分支回答")]);
  await oldFork.send("继续");
  assert.equal(oldFork.history().filter(entry => entry.type === "promptChange").length, 1);
  const newFork = await f.session.fork(updated.id);
  f.faux.setResponses([fauxAssistantMessage("新分支回答")]);
  await newFork.send("继续");
  assert.equal(newFork.history().filter(entry => entry.type === "promptChange").length, 1);
});

test("同组插件反转登记次序时实际 provider 的初始提示与工具前缀一致", async t => {
  const f = await fixture(t);
  const content = await createSpace(f.root, { watch: false });
  f.ownClose(() => content.close());
  const noModels: Models = {
    async complete() { throw new Error("插件不应调用模型"); },
    async completeStructured() { throw new Error("插件不应调用模型"); },
    async runAgent() { throw new Error("插件不应运行后台 Agent"); },
  };
  const plugin = (id: string, names: string[]): Plugin => ({
    id,
    async open() {
      return {
        instructions: () => `${id} 的稳定规则`,
        tools: () => names.map(name => ({ name, description: `${name} 的说明`, parameters: Type.Object({}), execute: async () => ({ text: "结果" }) })),
      };
    },
  });
  const alpha = plugin("alpha", ["z_tool", "a_tool"]);
  const beta = plugin("beta", ["m_tool"]);
  const prefixes: unknown[] = [];
  const toolOrders: string[][] = [];
  for (const [index, plugins] of [[beta, alpha], [alpha, beta]].entries()) {
    const host = await openPluginHost({ space: content, plugins, models: noModels, emit: () => {}, onError(error) { throw error; } });
    try {
      const agentSpace = await f.runtime.openSpace({
        root: f.root, sessionsDir: path.join(f.root, `prefix-sessions-${index}`),
        instructions: () => host.instructions(), tools: () => host.tools(), views: () => host.views(),
        overrides: async () => ({ app: {}, space: {} }), commandPolicy: () => "fullAccess",
        record: async (_id, action) => action(), onEvent: () => {}, confirm: async () => true,
      });
      try {
        const session = await agentSpace.create();
        f.faux.setResponses([context => {
          const initial = getInitialSystemMessage(context.messages);
          assert(initial);
          prefixes.push(Object.fromEntries(Object.entries(initial).filter(([key]) => key !== "timestamp")));
          toolOrders.push(getCurrentTools(context.messages).map(tool => tool.name));
          return fauxAssistantMessage("回答");
        }]);
        await session.send("开始");
      } finally {
        await agentSpace.close();
      }
    } finally {
      await host.close();
    }
  }
  assert.equal(prefixes.length, 2);
  assert.deepEqual(prefixes[0], prefixes[1]);
  assert.deepEqual(toolOrders[0], toolOrders[1]);
  assert.deepEqual(toolOrders[0]?.filter(name => name.endsWith("_tool")), ["a_tool", "m_tool", "z_tool"]);
});
