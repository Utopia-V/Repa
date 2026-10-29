import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { WebSocket } from "ws";
import { createAgentRuntimeForTest } from "../src/agent/runtime.js";
import { RepaClient } from "../src/client.js";
import { methods, PROTOCOL_VERSION, type SessionBaseline } from "../src/protocol.js";
import { startServer } from "../src/protocol/server.js";
import { object, parse } from "../src/schema.js";

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const gated of [false, true]) {
  test(`重连基线包含运行编号、${gated ? "有关卡的 Repa" : "Pi 与 Repa"} 队列，消息按消费顺序排列`, { timeout: 30000 }, async (t) => {
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-reconnect-")));
    const root = path.join(directory, "space");
    const home = path.join(directory, "home");
    await mkdir(root);
    await mkdir(home);
    const entered = deferred();
    const release = deferred();
    const faux = fauxProvider({
      api: `reconnect-${randomUUID()}`, provider: `reconnect-${randomUUID()}`, tokensPerSecond: 0,
      models: [{ id: "scripted", contextWindow: 16384, maxTokens: 256 }],
    });
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(home, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const runtime = await createAgentRuntimeForTest({
      agentDir: home, modelRuntime,
      defaultModel: { provider: faux.getModel().provider, id: "scripted" },
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
    });
    const server = await startServer({ home, runtime, plugins: [{
      id: "probe",
      async open() {
        return {
          tools: () => [{
            name: "hold", description: "等待测试放行", parameters: object({}),
            async execute() {
              entered.resolve();
              await release.promise;
              return { text: "已放行" };
            },
          }],
          agents: () => [{ id: "probe-agent", direct: true, instructions: () => "测试", tools: ["hold"], ...(gated ? { beforeRun: async () => undefined } : {}) }],
        };
      },
    }] });
    const client = await RepaClient.connect(server.connection);
    const socket = new WebSocket(server.connection.url);
    const opened = new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    t.after(async () => {
      release.resolve();
      socket.terminate();
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    });
    await client.call("space.open", { root });
    const session = await client.call("session.create", { agent: "probe-agent" });
    let runId: string | undefined;
    client.on("session.event", (event) => {
      if (event.type === "runStart") runId = event.runId;
    });
    faux.setResponses([fauxAssistantMessage(fauxToolCall("hold", {})), ...Array.from({ length: 8 }, () => fauxAssistantMessage("完成"))]);
    const running = client.call("session.send", { sessionId: session.id, text: "正在处理" }).catch(() => undefined);
    await entered.promise;
    assert.ok(runId);
    const sending = client.call("session.send", { sessionId: session.id, text: "下一次发送" }).catch(() => undefined);
    await client.call("session.steer", { sessionId: session.id, text: "引导消息" });
    await client.call("session.followUp", { sessionId: session.id, text: "追问消息" });
    await client.close();
    await opened;
    const response = new Promise<unknown>((resolve) => socket.once("message", (data) => resolve(JSON.parse(String(data)))));
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: "reconnect", method: "initialize", params: { token: server.connection.token, version: PROTOCOL_VERSION } }));
    const reply = await response;
    assert.ok(reply !== null && typeof reply === "object" && "result" in reply);
    const baseline = parse(methods.initialize.result, reply.result).baseline;
    const queued: SessionBaseline["queued"] = gated ? [
      { text: "下一次发送", mode: "send" },
      { text: "引导消息", mode: "steer" },
      { text: "追问消息", mode: "followUp" },
    ] : [
      { text: "引导消息", mode: "steer" },
      { text: "追问消息", mode: "followUp" },
      { text: "下一次发送", mode: "send" },
    ];
    assert.deepEqual(baseline.space, { root });
    assert.deepEqual(baseline.sessions, [{ sessionId: session.id, agent: "probe-agent", runId, queued }]);
    assert.deepEqual(baseline.disabledPlugins, []);
    release.resolve();
    await Promise.all([running, sending]);
  });
}
