import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { createAgentRuntimeForTest } from "../src/agent/runtime.js";
import { RepaClient, RpcError } from "../src/client.js";
import { INTERACTION_CAPABILITIES, ItemSchema, type ClientCapabilities } from "../src/protocol.js";
import type { MethodContext, Plugin } from "../src/plugin.js";
import { record } from "../src/protocol/json-rpc.js";
import { startServer } from "../src/protocol/server.js";
import { object } from "../src/schema.js";

const rejectsWith = (code: string, details?: unknown) => (error: unknown): boolean => {
  assert.ok(error instanceof RpcError);
  assert.equal(record(error.data)?.code, code);
  if (details !== undefined) assert.deepEqual(record(error.data)?.details, details);
  return true;
};

/** 官方前端会声明第一版的全部能力；测试里的假前端按需声明一部分。 */
const FULL: ClientCapabilities = { interaction: { vocabulary: 1, supports: [...INTERACTION_CAPABILITIES] } };

const LeakSchema = object({ item: ItemSchema });

// 学习插件的最小替身：几种界面方法。
function practicePlugin(): Plugin {
  return {
    id: "practice",
    async open() {
      return {
        methods: {
          inspect: { parameters: object({}), invoke: async (_input: unknown, context: MethodContext) => context.caller ?? null },
          leak: {
            parameters: object({}),
            result: LeakSchema,
            // 示意错误：把题库记录原样交出，多带了答案字段。
            invoke: async () => ({ item: { id: "py01.k1.q1", version: `sha256:${"1".repeat(64)}`, requires: ["slot.text"], body: [], slots: [{ id: "output", type: "text", answer: "5" }] } }),
          },
          serve: {
            parameters: object({}),
            result: LeakSchema,
            invoke: async () => ({ item: { id: "py01.k1.q1", version: `sha256:${"1".repeat(64)}`, requires: ["slot.text"], body: [], slots: [{ id: "output", type: "text" }] } }),
          },
        },
      };
    },
  };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-interaction-"));
  const root = path.join(directory, "space");
  const home = path.join(directory, "home");
  await mkdir(root);
  await mkdir(path.join(home, "agent"), { recursive: true });
  const faux = fauxProvider({ api: `interaction-${randomUUID()}`, provider: `interaction-${randomUUID()}`, models: [{ id: "scripted", contextWindow: 16384, maxTokens: 256 }], tokensPerSecond: 0 });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(home, "agent", "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const runtime = await createAgentRuntimeForTest({
    agentDir: path.join(home, "agent"),
    modelRuntime,
    defaultModel: { provider: faux.getModel().provider, id: "scripted" },
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
  });
  const server = await startServer({ home, plugins: [practicePlugin()], runtime });
  const clients: RepaClient[] = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const connect = async (capabilities?: ClientCapabilities) => {
    const client = await RepaClient.connect(server.connection, capabilities === undefined ? {} : { capabilities });
    clients.push(client);
    return client;
  };
  const captures: TranscriptContext[] = [];
  const reply = (text: string) => (context: TranscriptContext) => {
    captures.push(structuredClone(context));
    return fauxAssistantMessage(text);
  };
  return { root, faux, server, connect, captures, reply };
}

test("插件方法收到调用方的能力声明，声明的结果 schema 拦下多带的答案字段", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const declared: ClientCapabilities = { ...FULL, services: ["python.run"] };
  const client = await f.connect(declared);
  await client.call("space.open", { root: f.root });
  assert.deepEqual(await client.call("plugin.call", { pluginId: "practice", method: "inspect", input: {} }), { capabilities: declared });
  const bare = await f.connect();
  assert.deepEqual(await bare.call("plugin.call", { pluginId: "practice", method: "inspect", input: {} }), { capabilities: {} });
  await assert.rejects(client.call("plugin.call", { pluginId: "practice", method: "leak", input: {} }), rejectsWith("invalid_plugin_result", { pluginId: "practice", methodName: "leak" }));
  const served = await client.call("plugin.call", { pluginId: "practice", method: "serve", input: {} });
  assert.equal(Value.Check(object({ item: ItemSchema }), served), true);
});

test("initialize 严格校验能力声明，旧版本客户端不能连接", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const invalid = { interaction: { vocabulary: 1, supports: ["slot.choice"], extra: true } } as unknown as ClientCapabilities;
  await assert.rejects(RepaClient.connect(f.server.connection, { capabilities: invalid }), (error: unknown) => error instanceof RpcError && error.code === -32602);
  const socket = new WebSocket(f.server.connection.url);
  t.after(() => socket.close());
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("无法连接")), { once: true });
  });
  const response = new Promise<unknown>(resolve => socket.addEventListener("message", event => resolve(JSON.parse(String(event.data))), { once: true }));
  socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { token: f.server.connection.token, version: "1" } }));
  assert.equal(record(record(await response)?.error)?.code, -32002);
});
