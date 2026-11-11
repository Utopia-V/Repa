import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAgentRuntimeForTest } from "../src/agent/runtime.js";
import { RepaClient, RpcError } from "../src/client.js";
import type { Plugin } from "../src/plugin.js";
import { record } from "../src/protocol/json-rpc.js";
import { startServer } from "../src/protocol/server.js";
import { RepaFault, type AgentEvent } from "../src/schema.js";

// 学习版的装配：通用 Agent 关掉，只开放插件的辅导 Agent。插件另有方法经 host.models 调用模型，
// 学习插件判开放题、在后台准备任务走的就是这条路。
const learning: Plugin = {
  id: "learning",
  async open(host) {
    const failure = (error: unknown) => ({ failure: error instanceof RepaFault ? error.code : String(error) });
    return {
      agents: () => [{ id: "tutor", direct: true, tools: [], instructions: () => "你陪学习者练习 Python。" }],
      methods: {
        probe: {
          parameters: Type.Object({}, { additionalProperties: false }),
          async invoke() {
            const model = host.models.defaultModel();
            if (model !== undefined) return { model };
            const complete = await host.models.complete({ prompt: "判这道开放题" }).then(() => ({ failure: "none" }), failure);
            const runAgent = await host.models.runAgent({ agent: "tutor", text: "准备下一题" }).then(() => ({ failure: "none" }), failure);
            return { complete, runAgent };
          },
        },
      },
    };
  },
};

// 一个要先存密钥才可用的提供方，和学习者在设置页填密钥、登出的过程一样。
async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-learner-model-")));
  const root = path.join(directory, "space");
  const home = path.join(directory, "home");
  await mkdir(root);
  await mkdir(path.join(home, "agent"), { recursive: true });
  const faux = fauxProvider({ api: `learner-${randomUUID()}`, provider: `learner-${randomUUID()}`, models: [{ id: "scripted", contextWindow: 16384, maxTokens: 256 }], tokensPerSecond: 0 });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(home, "agent", "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider({
    ...faux.provider,
    auth: {
      apiKey: {
        name: "测试密钥",
        login: async interaction => ({ type: "api_key", key: await interaction.prompt({ type: "secret", message: "密钥" }) }),
        resolve: async ({ credential }) => credential?.key === undefined ? undefined : { auth: { apiKey: credential.key } },
      },
    },
  });
  const runtime = await createAgentRuntimeForTest({
    agentDir: path.join(home, "agent"),
    modelRuntime,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
  });
  const server = await startServer({ home, runtime, plugins: [learning], generalAgent: false, directAgents: ["tutor"] });
  const client = await RepaClient.connect(server.connection);
  const events: AgentEvent[] = [];
  client.on("session.event", event => { events.push(event); });
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  await client.call("space.open", { root });
  const model = { provider: faux.getModel().provider, id: "scripted" };
  const probe = () => client.call("plugin.call", { pluginId: "learning", method: "probe", input: {} });
  const sessionFiles = async () => (await readdir(path.join(root, ".repa", "sessions"), { recursive: true })).filter(name => name.endsWith(".jsonl"));
  return { client, faux, model, events, probe, sessionFiles };
}

const rejectsWith = (code: string) => (error: unknown): boolean => {
  assert.ok(error instanceof RpcError);
  assert.equal(record(error.data)?.code, code);
  return true;
};

test("学习版还没配模型时，建会话以 model_required 拒绝，不留下会话；插件调用模型同样如此", async t => {
  const f = await fixture(t);
  assert.equal(await f.client.call("model.getDefault", {}), null);
  await assert.rejects(f.client.call("session.create", { agent: "tutor" }), rejectsWith("model_required"));
  await assert.rejects(f.client.call("session.create", { agent: "tutor", model: f.model }), rejectsWith("model_required"));
  assert.deepEqual(await f.client.call("session.list", {}), []);
  assert.deepEqual(await f.probe(), { complete: { failure: "model_required" }, runAgent: { failure: "model_required" } });
  assert.deepEqual(await f.client.call("session.list", {}), []);
  assert.deepEqual(await f.sessionFiles(), []);
  assert.deepEqual(f.events, []);
});

test("学习版的模型登出后，默认模型为空，已有会话发送以 model_required 拒绝，消息不进入会话", async t => {
  const f = await fixture(t);
  await f.client.call("auth.setKey", { provider: f.model.provider, key: "learner-key" });
  await f.client.call("model.setDefault", { model: f.model });
  assert.deepEqual(await f.client.call("model.getDefault", {}), f.model);
  assert.deepEqual(await f.probe(), { model: f.model });
  const session = await f.client.call("session.create", { agent: "tutor" });
  f.faux.setResponses([fauxAssistantMessage("我们从循环开始。")]);
  await f.client.call("session.send", { sessionId: session.id, text: "你好" });

  await f.client.call("auth.logout", { provider: f.model.provider });
  // 保存的默认模型还指向这个提供方；它已经没有凭据，插件据此不再出要由模型判分的题。
  assert.equal(await f.client.call("model.getDefault", {}), null);
  assert.deepEqual(await f.probe(), { complete: { failure: "model_required" }, runAgent: { failure: "model_required" } });
  const runs = f.events.filter(event => event.type === "runStart").length;
  await assert.rejects(f.client.call("session.send", { sessionId: session.id, text: "再来一题" }), rejectsWith("model_required"));
  await assert.rejects(f.client.call("session.steer", { sessionId: session.id, text: "再来一题" }), rejectsWith("model_required"));
  assert.equal(f.events.filter(event => event.type === "runStart").length, runs);
  const users = (await f.client.call("session.history", { sessionId: session.id })).filter(entry => entry.type === "user").map(entry => entry.text);
  assert.deepEqual(users, ["你好"]);
  assert.deepEqual((await f.client.call("session.list", {})).map(info => info.id), [session.id]);
});
