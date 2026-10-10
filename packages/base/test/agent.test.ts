import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, getInitialSystemMessage, resolveTranscriptTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { cacheStatusForTest, createAgentRuntimeForTest } from "../src/agent/runtime.js";
import type { AgentSpaceOptions } from "../src/agent.js";

async function fixture(t: TestContext, extra: Partial<AgentSpaceOptions> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-agent-"));
  const agentDir = path.join(root, "app", "agent");
  const sessionsDir = path.join(root, ".repa", "sessions");
  await mkdir(agentDir, { recursive: true });
  const faux = fauxProvider({ api: `repa-api-${randomUUID()}`, provider: `repa-provider-${randomUUID()}`, models: [{ id: "test", contextWindow: 16384, maxTokens: 512 }], tokensPerSecond: 0 });
  const models = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  models.registerNativeProvider(faux.provider);
  const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 16, reserveTokens: 400 }, cacheWarming: "off" });
  const runtime = await createAgentRuntimeForTest({ agentDir, modelRuntime: models, defaultModel: { provider: faux.getModel().provider, id: "test" }, settingsManager: settings });
  const events: unknown[] = [];
  const space = await runtime.openSpace({
    root, sessionsDir, instructions: () => [], tools: () => [], views: async () => [{ id: "plugin:test", text: "当前状态" }],
    overrides: async () => ({ app: {}, space: {} }), commandPolicy: () => "fullAccess",
    record: async (_id, action) => action(), onEvent: event => events.push(event), confirm: async () => true,
    ...extra,
  });
  const session = await space.create();
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, agentDir, sessionsDir, faux, models, runtime, settings, space, session, events };
}

test("多份 view 首轮在 system 之后进入请求，默认批清后保留原始提示和初始工具声明", async t => {
  let version = 1;
  const f = await fixture(t, {
    instructions: () => [{ id: "plugin:test", text: "稳定的插件说明" }],
    views: async () => [
      { id: "plugin:changing", text: `状态版本 ${version}` },
      { id: "plugin:stable", text: "不变的状态" },
    ],
    tools: () => [{ name: "test_state", description: "读取测试状态", parameters: Type.Object({}), execute: async () => ({ text: "状态" }) }],
  });
  const captures: TranscriptContext[] = [];
  for (let request = 1; request <= 5; request++) {
    version = Math.min(request, 4);
    f.faux.setResponses([context => {
      captures.push(structuredClone(context));
      return fauxAssistantMessage("回答");
    }]);
    await f.session.send("继续");
  }
  const first = captures[0];
  assert(first);
  const initial = getInitialSystemMessage(first.messages);
  assert(initial);
  assert.equal(first.messages[0]?.role, "system");
  assert.equal(first.messages[1]?.role, "user");
  assert.match(getCurrentSystemPrompt(first.messages), /稳定的插件说明/u);
  assert(initial.toolsAdded?.some(tool => tool.name === "test_state"));
  assert.deepEqual(initial.toolsAdded, getCurrentTools(first.messages));
  const views = (context: TranscriptContext) => context.messages.filter(message => JSON.stringify(message.content).includes("<repa-view"));
  assert.equal(views(first).length, 2);
  const beforeCleanup = captures[3];
  const afterCleanup = captures[4];
  assert(beforeCleanup);
  assert(afterCleanup);
  assert.equal(views(beforeCleanup).length, 5);
  assert.equal(views(afterCleanup).length, 2);
  assert.equal(f.session.history().filter(entry => entry.type === "contextEdit").length, 3);
  assert(!JSON.stringify(views(afterCleanup)).includes("状态版本 1"));
  assert.match(JSON.stringify(views(afterCleanup)), /状态版本 4/u);
  for (const capture of captures) {
    assert.equal(capture.messages[0]?.role, "system");
    assert.deepEqual(getInitialSystemMessage(capture.messages), initial);
    assert.equal(getCurrentSystemPrompt(capture.messages), getCurrentSystemPrompt(first.messages));
    assert.deepEqual(resolveTranscriptTools(capture.messages, true), { requestTools: initial.toolsAdded, anchorsAdditions: true });
  }
});

test("真实 SDK 压缩保留会话摘要并补回一份当前视图", async t => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("原始回答".repeat(300)), fauxAssistantMessage("后续回答".repeat(300))]);
  await f.session.send("问题一");
  await f.session.send("问题二");
  f.faux.setResponses([fauxAssistantMessage("摘要：已完成两轮工作"), fauxAssistantMessage("回合前缀摘要")]);
  await f.session.compact();
  let capture: TranscriptContext | undefined;
  f.faux.setResponses([context => { capture = structuredClone(context); return fauxAssistantMessage("新回答"); }]);
  await f.session.send("继续");
  assert(capture);
  const texts = JSON.stringify(capture.messages);
  assert.equal(texts.split("<repa-view source=").length - 1, 1);
  assert(f.session.history().some(entry => entry.type === "compaction"));
});

test("精确 edit 同名覆盖保留中文全角标点与混合换行，拒绝规范化匹配", async t => {
  const f = await fixture(t);
  const file = path.join(f.root, "note.txt");
  const before = "第一行，（：\r\n第二行\n第三行\r\n";
  await writeFile(file, before);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("edit", { path: "note.txt", edits: [{ oldText: "第二行", newText: "改变" }] })),
    fauxAssistantMessage("已完成"),
  ]);
  await f.session.send("编辑");
  assert.equal(await readFile(file, "utf8"), "第一行，（：\r\n改变\n第三行\r\n");
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("edit", { path: "note.txt", edits: [{ oldText: "第一行,(:", newText: "变坏" }] })),
    fauxAssistantMessage("原文不匹配"),
  ]);
  await f.session.send("再次编辑");
  assert.equal(await readFile(file, "utf8"), "第一行，（：\r\n改变\n第三行\r\n");
  assert(f.session.history().some(entry => entry.type === "tool" && entry.data !== null && typeof entry.data === "object" && "isError" in entry.data && entry.data.isError === true));
});

test("模型完成与结构化输出使用共享 SDK 并对错误 JSON 重试", async t => {
  const f = await fixture(t);
  f.faux.setResponses([context => {
    assert.equal(getCurrentSystemPrompt(context.messages), "系统说明");
    return fauxAssistantMessage("文本结果");
  }, fauxAssistantMessage("不是 JSON"), fauxAssistantMessage('{"result": 4}')]);
  assert.equal(await f.runtime.complete({ prompt: "请求", system: "系统说明" }), "文本结果");
  assert.deepEqual(await f.runtime.completeStructured({ prompt: "计算" }, Type.Object({ result: Type.Number() })), { result: 4 });
  assert.equal(f.faux.state.callCount, 3);
});

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>(complete => {
    resolve = complete;
  });
  return { promise, resolve };
}

test("首个 assistant 前用户消息已经持久化，重开空间沿用真实 SDK 会话", async t => {
  const f = await fixture(t);
  const started = deferred<void>();
  const release = deferred<void>();
  f.faux.setResponses([async () => {
    started.resolve();
    await release.promise;
    return fauxAssistantMessage("第一份回答");
  }]);
  const run = f.session.send("需要保存的原始用户消息");
  await started.promise;
  const managerFile = (await import("@earendil-works/pi-coding-agent")).SessionManager.findById(f.root, f.session.info().id, f.sessionsDir);
  assert(managerFile);
  const raw = await readFile(managerFile, "utf8");
  assert.match(raw, /需要保存的原始用户消息/u);
  assert(!raw.includes('"role":"assistant"'));
  release.resolve();
  await run;
  await f.space.close();
  const reopened = await f.runtime.openSpace({ root: f.root, sessionsDir: f.sessionsDir, instructions: () => [], tools: () => [], views: async () => [], overrides: async () => ({ app: {}, space: {} }), commandPolicy: () => "fullAccess", record: async (_id, action) => action(), onEvent: () => undefined, confirm: async () => true });
  const session = await reopened.get(f.session.info().id);
  assert.deepEqual(session.history().filter(entry => entry.type === "user").map(entry => entry.text), ["需要保存的原始用户消息"]);
});

test("运行中插话和追加沿用 SDK 队列，空闲追加直接启动下一轮", async t => {
  const f = await fixture(t);
  const started = deferred<void>();
  const release = deferred<void>();
  const inputs: string[][] = [];
  f.faux.setResponses([
    async context => {
      inputs.push(context.messages.filter(message => message.role === "user").map(message => JSON.stringify(message.content)));
      started.resolve();
      await release.promise;
      return fauxAssistantMessage("第一轮结束");
    },
    context => {
      inputs.push(context.messages.filter(message => message.role === "user").map(message => JSON.stringify(message.content)));
      return fauxAssistantMessage("插话已处理");
    },
    context => {
      inputs.push(context.messages.filter(message => message.role === "user").map(message => JSON.stringify(message.content)));
      return fauxAssistantMessage("追加已处理");
    },
  ]);
  const run = f.session.send("开始");
  await started.promise;
  await f.session.steer("运行中插话");
  await f.session.followUp("运行结束追加");
  release.resolve();
  await run;
  assert.equal(f.faux.state.callCount, 3);
  assert.match(JSON.stringify(inputs[1]), /运行中插话/u);
  assert(!JSON.stringify(inputs[1]).includes("运行结束追加"));
  assert.match(JSON.stringify(inputs[2]), /运行结束追加/u);
  f.faux.setResponses([fauxAssistantMessage("空闲追加回答")]);
  await f.session.followUp("空闲追加");
  assert.equal(f.faux.state.callCount, 4);
  assert.equal(f.session.history().findLast(entry => entry.type === "assistant")?.text, "空闲追加回答");
});

test("fork 保存独立分支并在重开后保持选择的位置，父会话不变", async t => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("回答一"), fauxAssistantMessage("回答二")]);
  await f.session.send("问题一");
  await f.session.send("问题二");
  const first = f.session.history().find(entry => entry.type === "user");
  assert(first);
  const fork = await f.session.fork(first.id);
  assert.notEqual(fork.info().id, f.session.info().id);
  assert.deepEqual(fork.history().filter(entry => entry.type === "user").map(entry => entry.text), ["问题一"]);
  assert.deepEqual(f.session.history().filter(entry => entry.type === "user").map(entry => entry.text), ["问题一", "问题二"]);
  f.faux.setResponses([fauxAssistantMessage("分支回答")]);
  await fork.send("分支问题");
  assert.deepEqual(fork.history().filter(entry => entry.type === "user").map(entry => entry.text), ["问题一", "分支问题"]);
});

test("取消运行等待真实 SDK 终态，后台任务 id 指向可查会话", async t => {
  const f = await fixture(t);
  const started = deferred<void>();
  const release = deferred<void>();
  f.faux.setResponses([async () => {
    started.resolve();
    await release.promise;
    return fauxAssistantMessage("取消前返回");
  }]);
  const work = await f.space.runAgent({ text: "后台工作" });
  assert((await f.space.list()).some(session => session.id === work.id));
  await started.promise;
  const cancelled = work.cancel();
  release.resolve();
  await cancelled;
  await work.result;
  assert(f.events.some(event => event !== null && typeof event === "object" && "type" in event && event.type === "runEnd"));
});

test("插件工具不能覆盖内置工具或命令确认入口", async t => {
  const f = await fixture(t);
  const space = await f.runtime.openSpace({ root: f.root, sessionsDir: f.sessionsDir, instructions: () => [], tools: () => [{ name: "bash", description: "覆盖", parameters: Type.Object({}), execute: async () => ({ text: "坏工具" }) }], views: async () => [], overrides: async () => ({ app: {}, space: {} }), commandPolicy: () => "ask", record: async (_id, action) => action(), onEvent: () => undefined, confirm: async () => false });
  await assert.rejects(space.create(), error => error !== null && typeof error === "object" && "code" in error && error.code === "tool_name_conflict");
});

test("单 key 登录通过 SDK 持久化，重建运行时仍可用且登出删除凭据", async t => {
  const f = await fixture(t);
  const provider = {
    ...f.faux.provider,
    auth: {
      apiKey: {
        name: "本地测试 key",
        async login(interaction: import("@earendil-works/pi-ai").ProviderAuthInteraction) {
          const key = await interaction.prompt({ type: "secret", message: "API key" });
          return { type: "api_key" as const, key };
        },
        async resolve({ credential }: { credential?: import("@earendil-works/pi-ai").ApiKeyCredential }) {
          return credential?.key ? { auth: { apiKey: credential.key } } : undefined;
        },
      },
    },
  };
  f.models.registerNativeProvider(provider);
  await f.runtime.setKey(provider.id, "test-only-secret");
  const auth = JSON.parse(await readFile(path.join(f.agentDir, "auth.json"), "utf8")) as unknown;
  assert(auth !== null && typeof auth === "object" && provider.id in auth);
  const models = await ModelRuntime.create({ authPath: path.join(f.agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  models.registerNativeProvider(provider);
  assert.equal((await models.getAuth(provider.id))?.auth.apiKey, "test-only-secret");
  const runtime = await createAgentRuntimeForTest({ agentDir: f.agentDir, modelRuntime: models, settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }) });
  t.after(() => runtime.close());
  await runtime.logout(provider.id);
  assert.equal((await models.listCredentials()).some(entry => entry.providerId === provider.id), false);
  assert.equal(await models.getAuth(provider.id), undefined);
  assert(!JSON.stringify(f.events).includes("test-only-secret"));
});

test("需要第二项信息的 key 登录要求交互登录，不保存半成品凭据", async t => {
  const f = await fixture(t);
  const provider = {
    ...f.faux.provider,
    auth: {
      apiKey: {
        name: "需要额外信息",
        async login(interaction: import("@earendil-works/pi-ai").ProviderAuthInteraction) {
          const key = await interaction.prompt({ type: "secret", message: "API key" });
          await interaction.prompt({ type: "text", message: "账户 id" });
          return { type: "api_key" as const, key };
        },
        async resolve() { return undefined; },
      },
    },
  };
  f.models.registerNativeProvider(provider);
  await assert.rejects(f.runtime.setKey(provider.id, "partial-key"), error => error !== null && typeof error === "object" && "code" in error && error.code === "requires_interactive_login");
  assert.equal((await f.models.listCredentials()).some(entry => entry.providerId === provider.id), false);
});

test("运行结束事件等待空间记录收尾，排队续轮不重复报告运行起止", async t => {
  const recorded = deferred<void>();
  const release = deferred<void>();
  let committed = false;
  const observed: { type: string; committed: boolean }[] = [];
  const f = await fixture(t, {
    async record(_id, action) {
      const value = await action();
      recorded.resolve();
      await release.promise;
      committed = true;
      return value;
    },
    onEvent(event) { observed.push({ type: event.type, committed }); },
  });
  f.faux.setResponses([fauxAssistantMessage("完成")]);
  const run = f.session.send("开始");
  await recorded.promise;
  assert(!observed.some(event => event.type === "runEnd"));
  release.resolve();
  await run;
  assert.deepEqual(observed.filter(event => event.type === "runStart" || event.type === "runEnd"), [{ type: "runStart", committed: false }, { type: "runEnd", committed: true }]);
});

test("SDK 在经济收益成立时自动保温，并在真实会话记录缓存用量", { timeout: 10000 }, async t => {
  const warmed = deferred<void>();
  const f = await fixture(t, { views: async () => [], onEvent(event) {
    if (event.type === "usage" && event.data !== null && typeof event.data === "object" && "kind" in event.data && event.data.kind === "cache_warm") warmed.resolve();
  } });
  const model = f.faux.getModel();
  model.promptCache = { short: 12 };
  model.cost = { input: 100000, output: 1, cacheRead: 1, cacheWrite: 100000 };
  f.models.registerNativeProvider(f.faux.provider);
  const session = await f.space.create();
  f.settings.setCacheWarmingMode("idle");
  f.faux.setResponses([fauxAssistantMessage("正常请求"), fauxAssistantMessage("保温")]);
  await session.send("开始");
  const timeout = setTimeout(() => warmed.resolve(), 5000);
  try {
    await warmed.promise;
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(f.faux.state.callCount, 2, JSON.stringify(cacheStatusForTest(session)));
  const usage = session.history().find(entry => entry.type === "usage");
  assert(usage?.usage);
  assert(usage.usage.cacheRead > 0);
});

test("空间写入队列中的后台工作取消后不写用户消息也不调用模型", async t => {
  let tail: Promise<unknown> = Promise.resolve();
  const f = await fixture(t, { record(_id, action) {
    const result = tail.then(action);
    tail = result.catch(() => undefined);
    return result;
  } });
  const started = deferred<void>();
  const release = deferred<void>();
  f.faux.setResponses([async () => {
    started.resolve();
    await release.promise;
    return fauxAssistantMessage("前一项完成");
  }]);
  const active = f.session.send("占用空间队列");
  await started.promise;
  const work = await f.space.runAgent({ text: "排队工作" });
  const failed = assert.rejects(work.result, error => error !== null && typeof error === "object" && "code" in error && error.code === "cancelled");
  const cancelled = work.cancel();
  release.resolve();
  await active;
  await cancelled;
  await failed;
  const session = await f.space.get(work.id);
  assert.equal(session.history().filter(entry => entry.type === "user").length, 0);
  assert.equal(f.faux.state.callCount, 1);
});

test("并发打开同一持久会话只有一个 SDK owner，后续问题沿用完整历史", async t => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("初始回答")]);
  await f.session.send("初始问题");
  await f.space.close();
  let tail: Promise<unknown> = Promise.resolve();
  const space = await f.runtime.openSpace({ root: f.root, sessionsDir: f.sessionsDir, instructions: () => [], tools: () => [], views: async () => [], overrides: async () => ({ app: {}, space: {} }), commandPolicy: () => "fullAccess", record(_id, action) {
    const result = tail.then(action);
    tail = result.catch(() => undefined);
    return result;
  }, onEvent: () => undefined, confirm: async () => true });
  const [a, b] = await Promise.all([space.get(f.session.info().id), space.get(f.session.info().id)]);
  assert.equal(a, b);
  let secondInput = "";
  f.faux.setResponses([fauxAssistantMessage("回答 A"), context => { secondInput = JSON.stringify(context.messages); return fauxAssistantMessage("回答 B"); }]);
  await Promise.all([a.send("问题 A"), b.send("问题 B")]);
  assert.match(secondInput, /问题 A/u);
  assert.match(secondInput, /回答 A/u);
  assert.deepEqual(b.history().filter(entry => entry.type === "user").map(entry => entry.text), ["初始问题", "问题 A", "问题 B"]);
});

// 依赖 patches/ 中对 Pi 0.87.1 的补丁：视图投影会重建消息对象，补丁让保温按内容而不是对象身份判断上下文是否变化。
test("含视图的会话在补丁后仍能原生缓存保温", { timeout: 10000 }, async t => {
  const warmed = deferred<void>();
  const f = await fixture(t, { onEvent(event) {
    if (event.type === "usage" && event.data !== null && typeof event.data === "object" && "kind" in event.data && event.data.kind === "cache_warm") warmed.resolve();
  } });
  const model = f.faux.getModel();
  model.promptCache = { short: 12 };
  model.cost = { input: 100000, output: 1, cacheRead: 1, cacheWrite: 100000 };
  f.models.registerNativeProvider(f.faux.provider);
  const session = await f.space.create();
  f.settings.setCacheWarmingMode("idle");
  f.faux.setResponses([fauxAssistantMessage("回答"), fauxAssistantMessage("保温")]);
  await session.send("含当前视图的请求");
  const timeout = setTimeout(() => warmed.resolve(), 5000);
  try {
    await warmed.promise;
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(f.faux.state.callCount, 2, JSON.stringify(cacheStatusForTest(session)));
});

test("默认自动 overflow 压缩在重试第一份请求前补回最新视图", async t => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("第一轮".repeat(300)), fauxAssistantMessage("第二轮".repeat(300))]);
  await f.session.send("问题一");
  await f.session.send("问题二");
  f.settings.setCompactionEnabled(true);
  let capture: TranscriptContext | undefined;
  f.faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "maximum context length exceeded" }),
    fauxAssistantMessage("主摘要"),
    fauxAssistantMessage("前缀摘要"),
    context => { capture = structuredClone(context); return fauxAssistantMessage("重试成功"); },
  ]);
  await f.session.send("触发上下文溢出");
  assert(capture);
  assert.equal(JSON.stringify(capture.messages).split("<repa-view source=").length - 1, 1);
  assert(f.events.some(event => event !== null && typeof event === "object" && "type" in event && event.type === "compaction"));
  assert.equal(f.session.history().findLast(entry => entry.type === "assistant")?.text, "重试成功");
});
