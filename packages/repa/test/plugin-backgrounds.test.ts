import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxProvider, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { projectSessionBackgrounds } from "../src/agent/background.js";
import { learningContextCodec, makeContextMessage } from "../src/learning/background.js";
import type { BackendPluginRegistration } from "../src/capabilities/types.js";
import { InstalledContributions } from "../src/agent/contributions.js";
import { RepaClient } from "../src/client.js";
import { RepaFault } from "../src/errors.js";
import type { ContentRef, Run, SessionKey } from "../src/protocol.js";
import { startRepaServer } from "../src/server.js";
import { InputSchema, ViewSchema, novelCodec, novelFormat, novelPlugin } from "./fixtures/novel-plugin.js";

async function until<T>(read: () => T | Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= deadline) assert.fail(`等待状态超时：${JSON.stringify(value)}`);
    await delay(10);
  }
}
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: unknown) => part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "").join("\n");
}
const backgrounds = (context: TranscriptContext, marker: string) => context.messages.map(message => textOf(message.content)).filter(text => text.includes(marker));

async function fixture(t: TestContext, plugin = novelPlugin(), extraPlugins: readonly BackendPluginRegistration[] = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-plugin-backgrounds-"));
  const agentDir = path.join(root, "agent");
  const directory = path.join(root, "space");
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: [], extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"],
    retry: { enabled: false }, compaction: { enabled: false },
  }));
  const faux = fauxProvider({ api: `backgrounds-${randomUUID()}`, provider: `backgrounds-${randomUUID()}`,
    models: [{ id: "test", reasoning: false, input: ["text"], contextWindow: 16384, maxTokens: 512 }], tokensPerSecond: 0 });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const options = { agentDir, appDirectory: path.join(root, "app"), plugins: [plugin.registration, ...extraPlugins], modelOverride: { modelRuntime, model: faux.getModel() } };
  let server = await startRepaServer(options);
  let client = await RepaClient.connect(server.connection);
  t.after(async () => {
    await server.close("cancel");
    await client.close();
    await rm(root, { recursive: true, force: true });
  });
  const space = await client.call("space.open", { path: directory });
  const session = await client.call("session.create", { spaceId: space.id });
  const key = { spaceId: space.id, sessionId: session.sessionId };
  const scope = { kind: "space" as const, spaceId: space.id };
  async function terminal(runId: string): Promise<Run> {
    const run = await until(() => client.call("run.get", { spaceId: space.id, runId }),
      value => ["completed", "failed", "cancelled", "interrupted"].includes(value.status));
    assert.notEqual(run.status, "unknown");
    return run as Run;
  }
  async function submit(text: string, target: SessionKey = key) {
    return client.call("session.submit", { target, requestId: randomUUID(), input: { parts: [{ kind: "text", text }] }, dispatch: { kind: "start" } });
  }
  return {
    root, directory, space, key, scope, faux, plugin, terminal, submit,
    get client() { return client; },
    async send(text: string, target: SessionKey = key) {
      const request = await submit(text, target);
      assert(request.runId);
      assert.equal((await terminal(request.runId)).status, "completed");
      return request;
    },
    async disable(ids: string[]) {
      const settings = await client.call("settings.get", { scope, namespace: "plugins" });
      const entry = settings.entries.find(value => value.key === "disabled");
      assert(entry);
      await client.call("settings.set", { scope, namespace: "plugins", key: "disabled", value: ids, base: entry.revision });
    },
    async document(file: string, text: string): Promise<ContentRef> {
      const location = { kind: "relative" as const, path: file };
      await client.call("content.write", { target: { kind: "file", spaceId: space.id, location }, base: { kind: "absent" }, operationId: randomUUID(), value: { kind: "text", text } });
      const associated = await client.call("content.associate", { spaceId: space.id, location, role: "document", operationId: randomUUID() });
      const ref = associated.contents[0]?.ref;
      assert(ref);
      return ref;
    },
    async bind(ref: ContentRef) {
      const result = await client.call("capability.invoke", { scope, requestId: randomUUID(), contract: { id: "example.novel.bind", version: "1" }, input: { ref, operationId: randomUUID() } });
      assert.equal(result.kind, "inline");
    },
    async reopen() {
      await server.close("cancel");
      await client.close();
      server = await startRepaServer(options);
      client = await RepaClient.connect(server.connection);
      assert.equal((await client.call("space.open", { path: directory })).id, space.id);
    },
  };
}

test("小说与学习从现有能力并行提供真实 Pi 背景，独立关闭与重启接续当前空间", async t => {
  const f = await fixture(t);
  const novel = await f.document("novel.md", "主角住在海底城。🪸");
  await f.bind(novel);
  const learning = await f.document("study.md", "本周学习群论。");
  const state = await f.client.call("context.get", { spaceId: f.space.id });
  await f.client.call("context.set", { spaceId: f.space.id, binding: { kind: "document", ref: learning }, base: state.revision, operationId: randomUUID() });
  f.faux.setResponses([
    context => {
      assert.equal(backgrounds(context, "<novel_background>").length, 1);
      assert.match(backgrounds(context, "<novel_background>")[0]!, /主角住在海底城。🪸/u);
      assert.equal(backgrounds(context, "<repa_learning_context>").length, 1);
      assert.match(backgrounds(context, "<repa_learning_context>")[0]!, /本周学习群论。/u);
      return fauxAssistantMessage("已读取两个背景");
    },
    context => {
      assert.deepEqual(backgrounds(context, "<novel_background>"), []);
      assert.equal(backgrounds(context, "<repa_learning_context>").length, 1);
      return fauxAssistantMessage("学习背景仍可用");
    },
    context => {
      assert.deepEqual(backgrounds(context, "<repa_learning_context>"), []);
      assert.match(backgrounds(context, "<novel_background>").at(-1)!, /主角搬到云端城。/u);
      return fauxAssistantMessage("小说背景已接续");
    },
    context => {
      assert.deepEqual(backgrounds(context, "<repa_learning_context>"), []);
      assert.deepEqual(backgrounds(context, "<novel_background>"), ["<novel_background>\n主角搬到云端城。\n</novel_background>"]);
      return fauxAssistantMessage("新会话使用当前小说状态");
    },
  ]);
  const first = await f.send("开始工作");
  assert.equal(f.plugin.state.toolAdapters, 0, "背景应使用公共 query 输入，不经过模型工具参数适配");
  assert.deepEqual(f.plugin.state.sources, [{ kind: "agent", ...f.key, requestId: first.requestId, runId: first.runId }]);
  await f.disable(["novel"]);
  await f.reopen();
  await f.client.call("content.edit", { target: { kind: "content", ref: novel }, edits: [{ oldText: "主角住在海底城。🪸", newText: "主角搬到云端城。" }], operationId: randomUUID() });
  await f.send("继续学习");
  assert.equal(f.plugin.state.queries, 1, "关闭与重启后不执行小说背景 query");
  const history = await f.client.call("session.history", f.key);
  assert(history.messages.some(message => textOf(message.content).includes("主角住在海底城。🪸")));
  await f.disable(["repa-learning"]);
  await f.reopen();
  await f.send("继续小说");
  const session = await f.client.call("session.create", { spaceId: f.space.id });
  await f.send("在新会话延续小说", { spaceId: f.space.id, sessionId: session.sessionId });
  assert.equal(f.faux.state.callCount, 4);
});

test("动态与声明的静态预览均不执行后台工厂，禁用保留持久格式用于空间复制重映射", async t => {
  const f = await fixture(t, novelPlugin({ staticPreview: true }));
  const empty = await f.client.call("prompts.preview", f.key);
  assert.equal(empty.prompt.sources.find(source => source.id === novelCodec.id)?.content, "");
  assert.equal(f.plugin.state.factories, 0);
  assert.equal(f.plugin.state.queries, 0);
  const ref = await f.document("novel.md", "只在静态预览中读取的设定。");
  await f.bind(ref);
  const factories = f.plugin.state.factories;
  const preview = await f.client.call("prompts.preview", f.key);
  assert.equal(preview.prompt.sources.find(source => source.id === novelCodec.id)?.content, "只在静态预览中读取的设定。");
  assert.equal(f.plugin.state.factories, factories);
  assert.equal(f.plugin.state.queries, 0);
  await f.disable(["novel", "repa-learning"]);
  await f.reopen();
  const copied = await f.client.call("space.copy", { spaceId: f.space.id, destination: path.join(f.root, "copy"), operationId: randomUUID() });
  assert.equal(copied.status, "completed", copied.error?.message);
  const copy = await f.client.call("space.open", { path: copied.destination });
  const catalog: unknown = JSON.parse(await readFile(path.join(copy.path, ".repa/content/catalog.json"), "utf8"));
  assert(catalog && typeof catalog === "object" && "novelSetting" in catalog);
  assert.deepEqual(catalog.novelSetting, { spaceId: copy.id, id: ref.id });
  assert.equal(f.plugin.state.factories, factories);
  const disabled = await f.client.call("prompts.preview", f.key);
  assert.equal(disabled.prompt.sources.find(source => source.id === novelCodec.id)?.enabled, false);
  assert.equal(disabled.prompt.sources.find(source => source.id === novelCodec.id)?.content, undefined);
});

test("未声明静态预览的小说来源只显示动态标记，不读取数据或打开后台", async t => {
  const f = await fixture(t);
  const preview = await f.client.call("prompts.preview", f.key);
  const source = preview.prompt.sources.find(item => item.id === novelCodec.id);
  assert(source?.enabled && source.dynamic);
  assert.equal(source.content, undefined);
  assert.equal(f.plugin.state.factories, 0);
  assert.equal(f.plugin.state.queries, 0);
});

test("背景准备失败与父运行取消均保持请求未进入 Pi 历史，取消信号到达同一 query", async t => {
  let mode: "failure" | "wait" = "failure";
  let entered = () => {};
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  let cancelled = false;
  const f = await fixture(t, novelPlugin({ beforeRead: async context => {
    if (mode === "failure") throw new RepaFault("novel_unavailable", "设定暂时不可读。");
    entered();
    await new Promise<void>(resolve => context.signal.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }));
  } }));
  const failed = await f.submit("失败输入不进入历史");
  assert(failed.runId);
  const failedRun = await f.terminal(failed.runId);
  assert.equal(failedRun.status, "failed");
  assert.equal(failedRun.error?.code, "novel_unavailable");
  assert.equal((await f.client.call("request.get", { spaceId: f.space.id, requestId: failed.requestId })).status, "failed");
  assert.deepEqual((await f.client.call("session.history", f.key)).messages, []);
  mode = "wait";
  await f.client.call("queue.resume", f.key);
  const request = await f.submit("取消输入不进入历史");
  assert(request.runId);
  await waiting;
  await f.client.call("run.cancel", { spaceId: f.space.id, runId: request.runId });
  assert.equal((await f.terminal(request.runId)).status, "cancelled");
  assert.equal(cancelled, true);
  assert.equal(f.faux.state.callCount, 0);
  assert.deepEqual((await f.client.call("session.history", f.key)).messages, []);
});

test("重复背景来源或持久格式 ID 在启动副作用之前被拒绝", () => {
  const registration = novelPlugin().registration;
  assert.throws(() => new InstalledContributions([registration, { ...registration, id: "other" }]),
    error => error instanceof RepaFault && error.code === "background_conflict");
  assert.throws(() => new InstalledContributions([registration, { ...registration, id: "other", backgrounds: [], formats: [{ ...novelFormat, field: "other" }] }]),
    error => error instanceof RepaFault && error.code === "content_format_conflict");
});


test("两个 codec 在真实 Pi 压缩投影中各自回填来源，关闭与分支仍保留各自边界", async () => {
  const manager = SessionManager.inMemory();
  const root = manager.appendMessage({ role: "user", content: "共享起点", timestamp: 1 });
  const learning = makeContextMessage({ text: "群论学习", revision: "learning-1", sources: [] }, 2);
  const contribution = novelPlugin().registration.backgrounds?.[0];
  assert(contribution);
  const novel = (await contribution.prepare({ text: "海底城", revision: "novel-1", ref: null })).message;
  assert.equal(learning.role, "custom");
  assert.equal(novel.role, "custom");
  const learningId = manager.appendMessage(learning);
  const novelId = manager.appendMessage(novel);
  const kept = manager.appendMessage({ role: "user", content: "共同请求", timestamp: 3 });
  manager.appendCompaction("共同摘要", kept, 1000);
  const leaf = manager.getLeafId();
  assert(leaf);
  const original = structuredClone(manager.getEntries());
  const project = (novelEnabled: boolean) => projectSessionBackgrounds(manager.buildSessionProjection(), manager, {
    backgrounds: [{ codec: learningContextCodec, enabled: true }, { codec: novelCodec, enabled: novelEnabled }],
    fileChanges: "on-demand",
  });
  const projection = project(true);
  assert.deepEqual(projection.entries.flatMap(entry => entry.messages), projection.messages);
  assert.deepEqual(new Set(projection.entries.filter(entry => entry.messages.some(message => message.role === "custom")).map(entry => entry.sourceEntry.id)), new Set([learningId, novelId]));
  assert.equal(projection.messages.filter(message => novelCodec.snapshot(message)).length, 1);
  assert.equal(project(false).messages.filter(message => novelCodec.snapshot(message)).length, 0);
  manager.branch(root);
  const branchKept = manager.appendMessage({ role: "user", content: "无背景分支", timestamp: 4 });
  manager.appendCompaction("分支摘要", branchKept, 1000);
  assert.equal(project(true).messages.filter(message => message.role === "custom").length, 0);
  manager.branch(leaf);
  assert.deepEqual(project(true), projection);
  assert.deepEqual(manager.getBranch().filter(entry => original.some(item => item.id === entry.id)), original);
});


function alternateNovelPlugin(): BackendPluginRegistration {
  return {
    id: "alternate-novel", enabled: true,
    factory: () => ({ capabilities: [{
      contract: { id: "example.novel.preview", version: "1" }, implementationId: "alternate",
      inputSchema: InputSchema, outputSchema: ViewSchema, scopes: ["space"], execution: "query",
      invoke: () => ({ text: "替代小说设定", revision: "alternate", ref: null }),
    }] }),
  };
}

test("多个实现使用声明的同一个默认选择，配置覆盖后静态预览与实际 query 同步改变", async t => {
  const f = await fixture(t, novelPlugin({ staticPreview: true }), [alternateNovelPlugin()]);
  const defaults = await f.client.call("prompts.preview", f.key);
  assert.equal(defaults.prompt.sources.find(source => source.id === novelCodec.id)?.content, "");
  assert.equal(f.plugin.state.factories, 0);
  f.faux.setResponses([context => {
    assert.deepEqual(backgrounds(context, "<novel_background>"), ["<novel_background>\n\n</novel_background>"]);
    return fauxAssistantMessage("使用声明的默认实现");
  }]);
  await f.send("默认选择");
  assert.equal(f.plugin.state.queries, 1);
  const settings = await f.client.call("settings.get", { scope: f.scope, namespace: "plugins" });
  const selection = settings.entries.find(entry => entry.key === "implementations");
  assert(selection);
  await f.client.call("settings.set", { scope: f.scope, namespace: "plugins", key: "implementations",
    value: { "example.novel.preview": "alternate" }, base: selection.revision });
  const overridden = await f.client.call("prompts.preview", f.key);
  const source = overridden.prompt.sources.find(item => item.id === novelCodec.id);
  assert(source?.dynamic && source.enabled);
  assert.equal(source.content, undefined);
  assert.equal(source.reference, "example.novel.preview:alternate");
  f.faux.setResponses([context => {
    assert.match(backgrounds(context, "<novel_background>").at(-1)!, /替代小说设定/u);
    return fauxAssistantMessage("已使用替代实现");
  }]);
  await f.send("选择替代实现");
  assert.equal(f.plugin.state.queries, 1);
});

test("声明未选择默认实现时预览不推断官方内容，多实现运行明确要求选择", async t => {
  const plugin = novelPlugin({ staticPreview: true });
  plugin.registration = { ...plugin.registration, backgrounds: plugin.registration.backgrounds?.map(background => ({
    ...background, selection: { contract: background.selection.contract },
  })) };
  const f = await fixture(t, plugin, [alternateNovelPlugin()]);
  const preview = await f.client.call("prompts.preview", f.key);
  const source = preview.prompt.sources.find(item => item.id === novelCodec.id);
  assert(source?.enabled && source.dynamic);
  assert.equal(source.content, undefined);
  assert.equal(plugin.state.factories, 0);
  const request = await f.submit("尚未选择默认实现");
  assert(request.runId);
  const run = await f.terminal(request.runId);
  assert.equal(run.status, "failed");
  assert.equal(run.error?.code, "capability_selection_required");
  assert.equal(f.faux.state.callCount, 0);
});
