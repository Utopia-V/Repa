import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { Type } from "typebox";
import type { RepaCapabilityServices } from "../src/capabilities/services.js";
import type { BackendPluginRegistration, CapabilityDefinition } from "../src/capabilities/types.js";
import { RepaClient, RpcError } from "../src/client.js";
import type { CapabilityScope, SessionKey, SettingScope } from "../src/protocol.js";
import { ContextViewSchema } from "../src/learning/schema.js";
import { DEFAULT_LEARNING_PROMPT } from "../src/learning/default-prompt.js";
import { object } from "../src/schema.js";
import { startRepaServer } from "../src/server.js";
import { sqlitePlugin, sqliteSnapshot } from "./fixtures/capability-sqlite-plugin.js";

const entryContract = { id: "example.entries.append", version: "1" };
const application: CapabilityScope = { kind: "application" };
const fault = (code: string) => (error: unknown) => error instanceof RpcError &&
  error.data !== null && typeof error.data === "object" && "code" in error.data && error.data.code === code;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: unknown) => part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "").join("\n");
}

function requestText(context: TranscriptContext): string {
  return context.messages.map((message) => textOf(message.content)).join("\n");
}

async function until<T>(read: () => T | Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= deadline) assert.fail(`等待状态超时：${JSON.stringify(value)}`);
    await delay(10);
  }
}

async function fixture(t: TestContext, plugins: readonly BackendPluginRegistration[] = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-capability-api-"));
  const agentDir = path.join(root, "agent");
  const appDirectory = path.join(root, "app");
  const directory = path.join(root, "space");
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: [], extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"],
    retry: { enabled: false }, compaction: { enabled: false },
  }));
  const faux = fauxProvider({
    api: `repa-capability-api-${randomUUID()}`, provider: `repa-capability-provider-${randomUUID()}`,
    models: [{ id: "test", reasoning: false, input: ["text"], contextWindow: 16384, maxTokens: 512 }],
    tokensPerSecond: 0,
  });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const options = { agentDir, appDirectory, plugins, modelOverride: { modelRuntime, model: faux.getModel() }, trustExtensions: false };
  let server = await startRepaServer(options);
  let client = await RepaClient.connect(server.connection);
  t.after(async () => {
    await server.close("cancel");
    await client.close();
    await rm(root, { recursive: true, force: true });
  });
  const space = await client.call("space.open", { path: directory });
  const session = await client.call("session.create", { spaceId: space.id });
  const scope: CapabilityScope = { kind: "space", spaceId: space.id };
  const key = { spaceId: space.id, sessionId: session.sessionId };
  const reopen = async () => {
    await server.close("cancel");
    await client.close();
    server = await startRepaServer(options);
    client = await RepaClient.connect(server.connection);
    assert.equal((await client.call("space.open", { path: directory })).id, space.id);
  };
  const send = async (text: string) => {
    const request = await client.call("session.submit", {
      target: key, requestId: randomUUID(), input: { parts: [{ kind: "text", text }] }, dispatch: { kind: "start" },
    });
    assert(request.runId);
    const runId = request.runId;
    const run = await until(() => client.call("run.get", { spaceId: space.id, runId }),
      (value) => ["completed", "failed", "cancelled", "interrupted"].includes(value.status));
    assert.equal(run.status, "completed", JSON.stringify(run));
    return run;
  };
  return { root, appDirectory, directory, space, scope, key, faux, reopen, send, shutdown: () => server.close("cancel"), get application() { return server.application; }, get client() { return client; } };
}

async function disable(client: RepaClient, scope: SettingScope, plugins: string[]) {
  const view = await client.call("settings.get", { scope, namespace: "plugins" });
  const disabled = view.entries.find((entry) => entry.key === "disabled");
  assert(disabled);
  await client.call("settings.set", { scope, namespace: "plugins", key: "disabled", value: plugins, base: disabled.revision });
}

async function append(client: RepaClient, scope: CapabilityScope, value: string) {
  const accepted = await client.call("capability.invoke", { scope, requestId: randomUUID(), contract: entryContract, input: { value } });
  assert.equal(accepted.kind, "background");
  if (accepted.kind !== "background") assert.fail("条目能力应返回后台受理记录");
  const requestId = accepted.request.requestId;
  const finished = await until(() => client.call("request.get", { requestId, ...(scope.kind === "space" ? { spaceId: scope.spaceId } : {}) }),
    (request) => ["completed", "failed", "cancelled", "interrupted"].includes(request.status));
  assert.equal(finished.status, "completed", JSON.stringify(finished));
  assert("operation" in finished && finished.result?.value.kind === "inline");
  return { requestId, result: finished.result.value.data };
}

function databaseRows(file: string) {
  const database = new DatabaseSync(file, { readOnly: true });
  try { return database.prepare("SELECT space, value FROM entries ORDER BY rowid").all().map((row) => ({ ...row })); }
  finally { database.close(); }
}

test("即时查询读取当前值，不为刷新保存处理记录", async (t) => {
  const ValueSchema = object({ value: Type.Number() });
  let value = 1;
  const query: CapabilityDefinition = {
    contract: { id: "example.current", version: "1" }, implementationId: "current",
    inputSchema: object({}), outputSchema: ValueSchema, scopes: ["application", "space"], execution: "query",
    invoke(_input, context) {
      assert.equal(context.source.kind, "client");
      return { value };
    },
  };
  const f = await fixture(t, [{ id: "current", enabled: true, factory: () => ({ capabilities: [query] }) }]);
  for (const scope of [application, f.scope]) {
    const params = { scope, requestId: randomUUID(), contract: query.contract, input: {} };
    const first = await f.client.call("capability.invoke", params);
    assert.deepEqual(first, { kind: "inline", requestId: params.requestId, result: { value } });
    value += 1;
    assert.deepEqual(await f.client.call("capability.invoke", params), {
      kind: "inline", requestId: params.requestId, result: { value },
    });
    assert.deepEqual(await f.client.call("request.get", {
      requestId: params.requestId, ...(scope.kind === "space" ? { spaceId: scope.spaceId } : {}),
    }), { requestId: params.requestId, status: "unknown" });
  }
  assert.deepEqual(await readdir(path.join(f.directory, ".repa/runtime/processing")), []);
  assert.deepEqual(await readdir(path.join(f.appDirectory, "runtime/processing")), []);
});

test("持久 inline 调用可查询和重传，重启不重新执行已完成请求", async (t) => {
  const TextSchema = object({ text: Type.String() });
  let calls = 0;
  const echo: CapabilityDefinition<typeof TextSchema, typeof TextSchema> = {
    contract: { id: "example.echo", version: "1" }, implementationId: "plain", inputSchema: TextSchema, outputSchema: TextSchema,
    scopes: ["application"], execution: "inline",
    invoke(input, context) {
      assert.equal(context.scope.kind, "application");
      assert.equal(context.source.kind, "client");
      assert.equal(context.content, undefined);
      calls += 1;
      return { text: input.text };
    },
  };
  const f = await fixture(t, [{ id: "echo", enabled: true, factory: () => ({ capabilities: [echo] }) }]);
  const described = await f.client.call("capability.describe", { scope: application });
  assert.deepEqual(described.capabilities.filter(item => item.pluginId === "echo").map(item => item.contract), [echo.contract]);
  assert(described.capabilities.every(item => item.scopes.includes("application")));
  assert.deepEqual(described.issues, []);
  assert(!existsSync(path.join(f.appDirectory, ".repa/plugins")));
  const params = { scope: application, requestId: randomUUID(), contract: echo.contract, input: { text: "无状态结果" } };
  const result = await f.client.call("capability.invoke", params);
  assert.deepEqual(result, { kind: "inline", requestId: params.requestId, result: { text: "无状态结果" } });
  assert.deepEqual(await f.client.call("capability.invoke", params), result);
  const stored = await f.client.call("request.get", { requestId: params.requestId });
  assert.equal(stored.status, "completed");
  assert(!Object.hasOwn(stored, "spaceId"));
  await f.reopen();
  assert.deepEqual(await f.client.call("request.get", { requestId: params.requestId }), stored);
  assert.deepEqual(await f.client.call("capability.invoke", params), result);
  assert.equal(calls, 1);
  assert(!existsSync(path.join(f.appDirectory, ".repa/plugins")));
});

test("空间 SQLite 能力的公共后台调用与真实 Pi 工具共享处理和数据库，不另建工具后台请求", async (t) => {
  const opened: string[] = [];
  const f = await fixture(t, [{ id: "entries", enabled: true, factory: () => sqlitePlugin({ id: "entries", opened: (context) => { opened.push(context.spaceId); } }) }]);
  const described = await f.client.call("capability.describe", { scope: f.scope });
  assert(described.capabilities.some((item) => item.contract.id === entryContract.id && item.tool?.name === "append_entry"));
  assert.deepEqual(opened, []);
  assert(!existsSync(path.join(f.directory, ".repa/plugins/entries")));
  const first = await append(f.client, f.scope, "公共调用");
  assert.deepEqual(first.result, { count: 1, spaceId: f.space.id });
  const before = await readdir(path.join(f.directory, ".repa/runtime/processing"));
  f.faux.setResponses([
    (context) => {
      assert(getCurrentTools(context.messages).some((tool) => tool.name === "append_entry"));
      return fauxAssistantMessage(fauxToolCall("append_entry", { value: "Agent 工具" }), { stopReason: "toolUse" });
    },
    (context) => {
      const result = context.messages.find((message) => message.role === "toolResult");
      assert(result);
      assert.match(textOf(result.content), /"count":2/u);
      return fauxAssistantMessage("保存完成");
    },
  ]);
  await f.send("保存一条测试记录");
  assert.deepEqual(databaseRows(path.join(f.directory, ".repa/plugins/entries/entries.sqlite")), [
    { space: f.space.id, value: "公共调用" }, { space: f.space.id, value: "Agent 工具" },
  ]);
  assert.deepEqual(opened, [f.space.id]);
  assert.deepEqual(await readdir(path.join(f.directory, ".repa/runtime/processing")), before);
});

test("关闭整个学习能力后普通内容和 Agent 继续，复制撤回与重启学习接续原数据", async (t) => {
  const f = await fixture(t);
  const target = { kind: "file" as const, spaceId: f.space.id, location: { kind: "relative" as const, path: "goal.md" } };
  await f.client.call("content.write", { target, base: { kind: "absent" }, operationId: randomUUID(), value: { kind: "text", text: "旧目标" } });
  const associated = await f.client.call("content.associate", { spaceId: f.space.id, location: target.location, role: "document", operationId: randomUUID() });
  const ref = associated.contents[0]?.ref;
  assert(ref);
  const state = await f.client.call("context.get", { spaceId: f.space.id });
  await f.client.call("context.set", { spaceId: f.space.id, binding: { kind: "document", ref }, base: state.revision, operationId: randomUUID() });
  f.faux.setResponses([
    (context) => { assert.match(requestText(context), /旧目标/u); return fauxAssistantMessage("学习开始"); },
    (context) => {
      assert.doesNotMatch(requestText(context), /repa_learning_context|旧目标/u);
      assert.equal(getCurrentSystemPrompt(context.messages).includes(DEFAULT_LEARNING_PROMPT), false);
      assert(!getCurrentTools(context.messages).some((tool) => tool.name === "learning_context"));
      return fauxAssistantMessage("普通 Agent 正常工作");
    },
    (context) => { assert.match(requestText(context), /新目标/u); return fauxAssistantMessage("学习已接续"); },
  ]);
  await f.send("开始学习");
  await disable(f.client, f.scope, ["repa-learning"]);
  await assert.rejects(f.client.call("context.get", { spaceId: f.space.id }), fault("capability_not_found"));
  const editOperation = randomUUID();
  await f.client.call("content.edit", { target: { kind: "content", ref }, edits: [{ oldText: "旧目标", newText: "新目标" }], operationId: editOperation });
  await f.send("普通任务");
  const history = await f.client.call("session.history", f.key);
  assert(history.messages.some((message) => message.role === "context" && message.content.some((part) => part.type === "text" && part.text.includes("旧目标"))));
  const copied = await f.client.call("space.copy", { spaceId: f.space.id, destination: path.join(f.root, "copy"), operationId: randomUUID() });
  assert.equal(copied.status, "completed", copied.error?.message);
  const copy = await f.client.call("space.open", { path: copied.destination });
  await f.client.call("operation.undo", { spaceId: copy.id, operationId: editOperation, undoOperationId: randomUUID() });
  await disable(f.client, { kind: "space", spaceId: copy.id }, []);
  assert.equal((await f.client.call("context.preview", { spaceId: copy.id })).text, "旧目标");
  await disable(f.client, f.scope, []);
  await f.reopen();
  assert.equal((await f.client.call("context.preview", { spaceId: f.space.id })).text, "新目标");
  await f.send("恢复学习");
  assert.equal(f.faux.state.callCount, 3);
});

test("scope 禁用数据库插件关闭运行资源，快照与重新启用仍保留独立数据", async (t) => {
  const opened: string[] = [];
  const closed: string[] = [];
  let factories = 0;
  const f = await fixture(t, [{
    id: "entries", enabled: true, snapshot: sqliteSnapshot("entries"),
    factory: () => {
      factories += 1;
      return sqlitePlugin({
        id: "entries", opened: (context) => { opened.push(context.spaceId); }, closed: (context) => { closed.push(context.spaceId); },
      });
    },
  }]);
  await append(f.client, f.scope, "保留记录");
  await disable(f.client, f.scope, ["entries"]);
  assert.deepEqual(closed, [f.space.id]);
  const described = await f.client.call("capability.describe", { scope: f.scope });
  assert(!described.capabilities.some((item) => item.pluginId === "entries"));
  await assert.rejects(append(f.client, f.scope, "不能执行"), fault("capability_not_found"));
  await f.reopen();
  const copied = await f.client.call("space.copy", { spaceId: f.space.id, destination: path.join(f.root, "copy"), operationId: randomUUID() });
  assert.equal(copied.status, "completed", copied.error?.message);
  const copy = await f.client.call("space.open", { path: copied.destination });
  assert.deepEqual(opened, [f.space.id]);
  assert.equal(factories, 1, "禁用后重开和快照不得执行后台工厂");
  assert.deepEqual(databaseRows(path.join(copy.path, ".repa/plugins/entries/entries.sqlite")), [{ space: copy.id, value: "保留记录" }]);
  await disable(f.client, { kind: "space", spaceId: copy.id }, []);
  assert.deepEqual((await append(f.client, { kind: "space", spaceId: copy.id }, "副本记录")).result, { count: 2, spaceId: copy.id });
  await f.reopen();
  assert.deepEqual(opened, [f.space.id, copy.id]);
  await disable(f.client, f.scope, []);
  assert.deepEqual((await append(f.client, f.scope, "恢复记录")).result, { count: 2, spaceId: f.space.id });
  assert.deepEqual(databaseRows(path.join(f.directory, ".repa/plugins/entries/entries.sqlite")), [
    { space: f.space.id, value: "保留记录" }, { space: f.space.id, value: "恢复记录" },
  ]);
});


test("应用取消退出会中止等待空间初始化信号的插件，持久请求取消且重开不建立数据库", async (t) => {
  let entered: (() => void) | undefined;
  let releaseInitialization = () => {};
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let initializationCancelled = false;
  let databasesOpened = 0;
  const f = await fixture(t, [{
    id: "entries", enabled: true, snapshot: sqliteSnapshot("entries"),
    factory: () => sqlitePlugin({
      id: "entries",
      beforeOpen: async (context) => {
        await new Promise<void>((resolve) => {
          const cancelled = () => {
            initializationCancelled = context.signal.aborted;
            context.signal.removeEventListener("abort", cancelled);
            resolve();
          };
          releaseInitialization = () => {
            context.signal.removeEventListener("abort", cancelled);
            resolve();
          };
          if (context.signal.aborted) cancelled();
          else context.signal.addEventListener("abort", cancelled, { once: true });
          entered?.();
        });
      },
      opened: () => { databasesOpened += 1; },
    }),
  }]);
  const accepted = await f.client.call("capability.invoke", {
    scope: f.scope, requestId: randomUUID(), contract: entryContract, input: { value: "初始化中取消" },
  });
  assert.equal(accepted.kind, "background");
  if (accepted.kind !== "background") assert.fail("条目能力应在初始化前持久受理");
  await started;
  const shutdown = f.shutdown();
  const deadline = new AbortController();
  try {
    await Promise.race([
      shutdown,
      delay(5000, undefined, { signal: deadline.signal }).then(() => assert.fail("应用取消退出未解除插件初始化等待")),
    ]);
  } finally {
    deadline.abort();
    releaseInitialization();
    await shutdown;
  }
  assert.equal(initializationCancelled, true);
  assert.equal(databasesOpened, 0);
  await f.reopen();
  const stored = await f.client.call("request.get", { spaceId: f.space.id, requestId: accepted.request.requestId });
  assert.equal(stored.status, "cancelled");
  assert.equal(databasesOpened, 0);
  assert(!existsSync(path.join(f.directory, ".repa/plugins/entries/entries.sqlite")));
});


test("禁用插件取消等待 admission 的能力会话提交，关闭不死锁也不留下幽灵输入", async (t) => {
  const EmptySchema = object({});
  const ResultSchema = object({ submitted: Type.Boolean() });
  let target: SessionKey | undefined;
  let entered = () => {};
  let proceed = () => {};
  let enqueued = () => {};
  let escape = () => {};
  const started = new Promise<void>(resolve => { entered = resolve; });
  const allowed = new Promise<void>(resolve => { proceed = resolve; });
  const queued = new Promise<void>(resolve => { enqueued = resolve; });
  const cleanupEscape = new Promise<never>((_resolve, reject) => { escape = () => reject(new Error("解除失败测试的能力等待")); });
  let cancelled = false;
  let finished = false;
  const childRequestId = randomUUID();
  const handoff: CapabilityDefinition<typeof EmptySchema, typeof ResultSchema, RepaCapabilityServices> = {
    contract: { id: "fixture.sessions.handoff", version: "1" }, implementationId: "plain",
    inputSchema: EmptySchema, outputSchema: ResultSchema, scopes: ["space"], execution: "background",
    async invoke(_input, context) {
      assert(context.services?.sessions);
      entered();
      await allowed;
      assert(target);
      const submitted = context.services.sessions.submit({
        target, requestId: childRequestId, input: { parts: [{ kind: "text", text: "取消后不得进入会话" }] }, dispatch: { kind: "queue" },
      });
      enqueued();
      try {
        // 仅失败收尾时使用逃生屏障，正常路径始终等待真实 submit。
        await Promise.race([submitted, cleanupEscape]);
        return { submitted: true };
      } finally {
        cancelled = context.signal.aborted;
        finished = true;
      }
    },
  };
  const f = await fixture(t, [{ id: "handoff", enabled: true, factory: () => ({ capabilities: [handoff] }) }]);
  target = f.key;
  const view = await f.client.call("settings.get", { scope: f.scope, namespace: "plugins" });
  const disabled = view.entries.find(entry => entry.key === "disabled");
  assert(disabled);
  const accepted = await f.client.call("capability.invoke", { scope: f.scope, requestId: randomUUID(), contract: handoff.contract, input: {} });
  assert.equal(accepted.kind, "background");
  if (accepted.kind !== "background") assert.fail("会话提交能力应持久后台受理");
  await started;
  const release = await lockfile.lock(path.join(f.directory, ".repa", "settings.json"), { realpath: false });
  let released = false;
  const deadline = new AbortController();
  let saving: Promise<unknown> | undefined;
  try {
    // 公共应用入口同步占据 admission；真实文件锁延后设置保存及插件关闭。
    saving = f.application.settingsCall("settings.set", {
      scope: f.scope, namespace: "plugins", key: "disabled", value: ["handoff"], base: disabled.revision,
    });
    proceed();
    await queued;
    await release();
    released = true;
    await Promise.race([
      saving,
      delay(5000, undefined, { signal: deadline.signal }).then(() => assert.fail("插件关闭与排队会话提交形成循环等待")),
    ]);
  } finally {
    deadline.abort();
    proceed();
    if (!released) await release();
    escape();
    await saving;
  }
  const parent = await until(() => f.client.call("request.get", { spaceId: f.space.id, requestId: accepted.request.requestId }),
    request => ["completed", "failed", "cancelled", "interrupted"].includes(request.status));
  assert.equal(parent.status, "cancelled");
  assert.equal(cancelled, true);
  assert.equal(finished, true);
  assert.deepEqual(await f.client.call("request.get", { spaceId: f.space.id, requestId: childRequestId }), { requestId: childRequestId, status: "unknown" });
  assert.deepEqual((await f.client.call("queue.list", f.key)).requests, []);
  assert.deepEqual((await f.client.call("session.get", f.key)).runs, []);
  assert.equal(f.faux.state.callCount, 0);
  await f.reopen();
  assert.equal((await f.client.call("request.get", { spaceId: f.space.id, requestId: accepted.request.requestId })).status, "cancelled");
  assert.equal((await f.client.call("request.get", { spaceId: f.space.id, requestId: childRequestId })).status, "unknown");
});


test("替换学习语境实现沿用公共空间配置与 Agent 会话覆盖，静态预览不执行能力", async (t) => {
  const namespace = "fixture.learning-context";
  const values = { application: "应用配置语境", space: "空间配置语境", session: "会话配置语境" };
  let factories = 0;
  const calls: { kind: string; scope: SettingScope; text: string; requestId?: string }[] = [];
  const EmptySchema = object({});
  const replacement: CapabilityDefinition<typeof EmptySchema, typeof ContextViewSchema, Pick<RepaCapabilityServices, "settings">> = {
    contract: { id: "repa.context.preview", version: "1" }, implementationId: "configured",
    inputSchema: EmptySchema, outputSchema: ContextViewSchema, scopes: ["space"], execution: "inline",
    tool: { name: "learning_context", description: "读取替换实现的完整学习语境" },
    async invoke(_input, context) {
      assert(context.services, "公共学习接口与 Agent 路径都应提供所选能力的 settings 服务");
      const settings = await context.services.settings(namespace);
      const text = settings.entries.find(entry => entry.key === "text")?.effective;
      assert.equal(typeof text, "string");
      assert(typeof text === "string");
      calls.push({ kind: context.source.kind, scope: settings.scope, text,
        ...(context.source.kind === "agent" ? { requestId: context.source.requestId } : {}) });
      return { text, revision: "configured-view", sources: [] };
    },
  };
  const f = await fixture(t, [{ id: "configured-learning", enabled: true, factory: () => {
    factories++;
    return { capabilities: [replacement], settings: [{ namespace, settings: {
      text: { schema: Type.String(), default: "默认替换语境", scopes: ["application", "space", "session"] },
    } }] };
  } }]);
  const save = async (scope: SettingScope, selectedNamespace: string, key: string, value: unknown) => {
    const view = await f.client.call("settings.get", { scope, namespace: selectedNamespace });
    const current = view.entries.find(entry => entry.key === key);
    assert(current);
    return f.client.call("settings.set", { scope, namespace: selectedNamespace, key, value, base: current.revision });
  };
  await save(application, "plugins", "implementations", { "repa.context.preview": "configured" });
  const firstPreview = await f.client.call("prompts.preview", f.key);
  assert(firstPreview.prompt.sources.some(source => source.id === "learningContext" && source.dynamic && source.enabled && source.reference === "repa.context.preview:configured"));
  assert(firstPreview.prompt.sources.some(source => source.id === "capabilityPlugin:configured-learning" && source.dynamic));
  const staticToolDefinitions = firstPreview.prompt.sources.find(source => source.id === "toolDefinitions");
  assert(staticToolDefinitions?.content);
  assert.doesNotMatch(staticToolDefinitions.content, /"name":"learning_context"/u, "替换实现的工具只标动态，不冒用官方静态声明");
  assert.equal(factories, 0);
  assert.deepEqual(calls, []);
  await save(application, namespace, "text", values.application);
  await save(f.scope, namespace, "text", values.space);
  const sessionScope: SettingScope = { kind: "session", ...f.key };
  await save(sessionScope, namespace, "text", values.session);
  const beforePreview = factories;
  const configuredPreview = await f.client.call("prompts.preview", f.key);
  assert.equal(factories, beforePreview);
  assert.deepEqual(calls, []);
  assert(configuredPreview.prompt.sources.some(source => source.id === "learningContext" && source.dynamic && source.content === undefined));
  assert.doesNotMatch(JSON.stringify(configuredPreview.prompt), /应用配置语境|空间配置语境|会话配置语境/u);
  assert.deepEqual(await f.client.call("context.preview", { spaceId: f.space.id }), { text: values.space, revision: "configured-view", sources: [] });
  assert.deepEqual(calls, [{ kind: "client", scope: f.scope, text: values.space }]);
  f.faux.setResponses([
    context => {
      assert.match(requestText(context), /会话配置语境/u);
      assert.doesNotMatch(requestText(context), /空间配置语境|应用配置语境/u);
      assert(getCurrentTools(context.messages).some(tool => tool.name === "learning_context" && tool.description === replacement.tool?.description));
      return fauxAssistantMessage(fauxToolCall("learning_context", {}), { stopReason: "toolUse" });
    },
    context => {
      const result = context.messages.find(message => message.role === "toolResult" && message.toolName === "learning_context");
      assert(result);
      assert.match(textOf(result.content), /会话配置语境/u);
      return fauxAssistantMessage("替换语境已用于当前会话");
    },
  ]);
  const run = await f.send("检查替换语境及其工具读取");
  assert.equal(calls.length, 3);
  assert("requestIds" in run && run.requestIds);
  const requestId = run.requestIds[0];
  assert(requestId);
  assert.deepEqual(calls.slice(1), [1, 2].map(() => ({ kind: "agent", scope: sessionScope, text: values.session, requestId })));
  assert.equal(f.faux.state.callCount, 2);
});

test("应用后台交互答复在重开后可确认，不为确认历史结果重新装配能力", async (t) => {
  const contract = { id: "example.answer", version: "1" };
  const inputSchema = object({});
  const outputSchema = object({ answer: Type.String() });
  let factories = 0;
  let actions = 0;
  const capability: CapabilityDefinition<typeof inputSchema, typeof outputSchema, RepaCapabilityServices> = {
    contract, implementationId: "local", inputSchema, outputSchema, scopes: ["application"], execution: "background",
    async invoke(_input, context) {
      assert(context.services?.ask);
      const answer = await context.services.ask({ kind: "input", title: "后台处理需要说明" });
      context.signal.throwIfAborted();
      assert.equal(typeof answer, "string");
      actions++;
      return { answer: String(answer) };
    },
  };
  const f = await fixture(t, [{ id: "answer", enabled: true, factory: () => {
    factories++;
    return { capabilities: [capability] };
  } }]);
  const accepted = await f.client.call("capability.invoke", { scope: application, requestId: randomUUID(), contract, input: {} });
  assert.equal(accepted.kind, "background");
  assert(accepted.kind === "background");
  const requestId = accepted.request.requestId;
  const waiting = await until(() => f.client.call("request.get", { requestId }), value => "interactions" in value && value.interactions.length === 1);
  assert("interactions" in waiting && waiting.interactions[0]);
  const reply = { id: waiting.interactions[0].id, responseId: randomUUID(), value: "应用处理的实际回答" };
  const confirmation = await f.client.call("interaction.reply", reply);
  assert.equal(confirmation.status, "accepted");
  const completed = await until(() => f.client.call("request.get", { requestId }), value => value.status === "completed");
  assert("interactions" in completed);
  assert.equal(completed.interactionReplies?.[0]?.value, reply.value);
  assert.equal(actions, 1);
  const before = factories;
  await f.reopen();
  assert.deepEqual(await f.client.call("interaction.reply", reply), confirmation);
  assert.equal(factories, before);
  assert.equal(actions, 1);
  assert.deepEqual(await f.client.call("request.get", { requestId }), completed);
  assert.equal((await f.client.call("session.get", f.key)).runtime, "unloaded");
});
