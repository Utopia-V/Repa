import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createAgentRuntimeForTest } from "../src/agent/runtime.js";
import type { AgentEvent } from "../src/schema.js";

function deferred<T = void>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

function users(context: TranscriptContext): string[] {
  return context.messages.flatMap(message => message.role === "user" && Array.isArray(message.content)
    ? message.content.flatMap(part => part.type === "text" ? [part.text] : [])
    : []);
}

// Pi 先跑输入钩子再把插话放进队列；钩子期间运行结束时，消息落进没有循环消费的队列。
// 用真实 Pi 与离线模型构造这个时序：钩子停住，放行回复让运行结束，再放行钩子。
test("插话的输入钩子期间运行结束：消息不留在 Pi 队列里，接着作为一次运行送达，会话随后空闲", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-residue-")));
  const agentDir = path.join(root, "app", "agent");
  const sessionsDir = path.join(root, ".repa", "sessions");
  await mkdir(agentDir, { recursive: true });
  const faux = fauxProvider({ api: `residue-${randomUUID()}`, provider: `residue-${randomUUID()}`, models: [{ id: "test", contextWindow: 16384, maxTokens: 512 }], tokensPerSecond: 0 });
  const models = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  models.registerNativeProvider(faux.provider);
  let hook: Promise<void> | undefined;
  const hookEntered = deferred();
  const factory: ExtensionFactory = pi => {
    pi.on("input", async () => {
      if (hook !== undefined) {
        hookEntered.resolve();
        await hook;
      }
      return { action: "continue" };
    });
  };
  const runtime = await createAgentRuntimeForTest({
    agentDir, modelRuntime: models, defaultModel: { provider: faux.getModel().provider, id: "test" },
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
    extensionFactories: [factory],
  });
  const events: AgentEvent[] = [];
  const space = await runtime.openSpace({
    root, sessionsDir, instructions: () => [], tools: () => [], views: async () => [],
    overrides: async () => ({ app: {}, space: {} }), commandPolicy: () => "fullAccess",
    record: async (_id, action) => action(), onEvent: event => events.push(event), confirm: async () => true,
  });
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  const replyEntered = deferred();
  const replyRelease = deferred();
  const requests: string[][] = [];
  faux.setResponses([
    async context => {
      requests.push(users(context));
      replyEntered.resolve();
      await replyRelease.promise;
      return fauxAssistantMessage("第一轮");
    },
    context => {
      requests.push(users(context));
      return fauxAssistantMessage("回答插话");
    },
  ]);
  const session = await space.create();
  const first = session.send("你好");
  await replyEntered.promise;
  const release = deferred();
  hook = release.promise;
  const steering = session.steer("插话");
  await hookEntered.promise;
  replyRelease.resolve();
  await first;
  hook = undefined;
  release.resolve();
  await steering;
  assert.deepEqual(requests, [["你好"], ["你好", "插话"]]);
  assert.equal(events.filter(event => event.type === "runEnd").length, 2);
  assert.equal(space.busy(), false);
});
