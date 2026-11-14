import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
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

/**
 * 真实 Pi 与离线模型。输入钩子在 hook 设上时停住；record 在 recordGate 设上时，运行动作结束以后停在保存上，
 * 模拟不透明运行在 Pi 循环结束以后还要提交历史快照。
 */
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-residue-")));
  const agentDir = path.join(root, "app", "agent");
  const sessionsDir = path.join(root, ".repa", "sessions");
  await mkdir(agentDir, { recursive: true });
  const faux = fauxProvider({ api: `residue-${randomUUID()}`, provider: `residue-${randomUUID()}`, models: [{ id: "test", contextWindow: 16384, maxTokens: 512 }], tokensPerSecond: 0 });
  const models = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  models.registerNativeProvider(faux.provider);
  const control: { hook?: Promise<void>; hookEntered?: () => void; recordGate?: Promise<void>; actionDone?: () => void } = {};
  const factory: ExtensionFactory = pi => {
    pi.on("input", async () => {
      const hook = control.hook;
      if (hook !== undefined) {
        control.hookEntered?.();
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
  const watchers = new Set<() => void>();
  /** 等到第 count 次运行结束事件。 */
  const runEnds = (count: number) => new Promise<void>(resolve => {
    const check = () => {
      if (events.filter(event => event.type === "runEnd").length < count) return;
      watchers.delete(check);
      resolve();
    };
    watchers.add(check);
    check();
  });
  const space = await runtime.openSpace({
    root, sessionsDir, instructions: () => [], tools: () => [], views: async () => [],
    overrides: async () => ({ app: {}, space: {} }), commandPolicy: () => "fullAccess",
    record: async (_id, action) => {
      const value = await action();
      const gate = control.recordGate;
      if (gate !== undefined) {
        control.actionDone?.();
        await gate;
      }
      return value;
    },
    onEvent: event => {
      events.push(event);
      for (const check of [...watchers]) check();
    },
    confirm: async () => true,
  });
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  const requests: string[][] = [];
  return { faux, space, events, runEnds, control, requests };
}

// Pi 先跑输入钩子再把插话放进队列；钩子期间运行结束时，消息落进没有循环消费的队列。
// 用真实 Pi 与离线模型构造这个时序：钩子停住，放行回复让运行结束，再放行钩子。
test("插话的输入钩子期间运行结束：消息不留在 Pi 队列里，接着作为一次运行送达，会话随后空闲", async t => {
  const { faux, space, events, control, requests } = await fixture(t);
  const replyEntered = deferred();
  const replyRelease = deferred();
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
  const hookEntered = deferred();
  control.hookEntered = () => hookEntered.resolve();
  control.hook = release.promise;
  const steering = session.steer("插话");
  await hookEntered.promise;
  replyRelease.resolve();
  await first;
  control.hook = undefined;
  release.resolve();
  await steering;
  assert.deepEqual(requests, [["你好"], ["你好", "插话"]]);
  assert.equal(events.filter(event => event.type === "runEnd").length, 2);
  // 会话没有在运行的工作，Repa 与 Pi 的队列里都没有消息。
  assert.deepEqual(space.baseline(), []);
});

/** 第一轮的回复停住；插话进入输入钩子以后放行回复，Pi 循环结束，但这次运行停在保存上。 */
async function strandWhileSaving(f: Awaited<ReturnType<typeof fixture>>, replies: string[]) {
  const { faux, space, control, requests } = f;
  const replyEntered = deferred();
  const replyRelease = deferred();
  faux.setResponses([
    async context => {
      requests.push(users(context));
      replyEntered.resolve();
      await replyRelease.promise;
      return fauxAssistantMessage("第一轮");
    },
    ...replies.map(text => (context: TranscriptContext) => {
      requests.push(users(context));
      return fauxAssistantMessage(text);
    }),
  ]);
  const session = await space.create();
  const saving = deferred();
  const actionDone = deferred();
  control.recordGate = saving.promise;
  control.actionDone = () => actionDone.resolve();
  const first = session.send("你好");
  await replyEntered.promise;
  const hookRelease = deferred();
  const hookEntered = deferred();
  control.hookEntered = () => hookEntered.resolve();
  control.hook = hookRelease.promise;
  const steering = session.steer("插话");
  await hookEntered.promise;
  control.hook = undefined;
  replyRelease.resolve();
  // Pi 的循环已经结束，这次 Repa 运行还在保存。
  await actionDone.promise;
  control.recordGate = undefined;
  return { session, first, steering, releaseHook: () => hookRelease.resolve(), releaseSave: () => saving.resolve() };
}

test("插话在运行保存期间才进入 Pi 队列：运行收尾时取回，作为一次运行送达，会话随后空闲", async t => {
  const f = await fixture(t);
  const stranded = await strandWhileSaving(f, ["回答插话"]);
  // 输入钩子先结束：消息落进 Pi 队列时，这次运行还没结束。
  stranded.releaseHook();
  await stranded.steering;
  stranded.releaseSave();
  await stranded.first;
  // 取回的消息在运行收尾时登记，不另有可等的请求；等它的运行结束事件。修正以前它一直留在 Pi 队列里，这里等不到。
  await f.runEnds(2);
  assert.deepEqual(f.requests, [["你好"], ["你好", "插话"]]);
  assert.deepEqual(f.space.baseline(), []);
});

test("插话在运行保存期间进入 Pi 队列，其后又有一条消息排在 Repa 队列里：插话先送达，后发的消息排在它后面", async t => {
  const f = await fixture(t);
  const stranded = await strandWhileSaving(f, ["回答插话", "回答下一条"]);
  const later = stranded.session.send("下一条");
  stranded.releaseHook();
  await stranded.steering;
  stranded.releaseSave();
  await stranded.first;
  await later;
  assert.deepEqual(f.requests, [["你好"], ["你好", "插话"], ["你好", "插话", "下一条"]]);
  assert.deepEqual(f.space.baseline(), []);
});
