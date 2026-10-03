import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { CapabilityHost } from "../src/capabilities/host.js";
import { CapabilityDescriptorSchema, type CapabilitySelection } from "../src/capabilities/schema.js";
import type { BackendPlugin, CapabilityDefinition, InvocationContext } from "../src/capabilities/types.js";
import { ContentStore } from "../src/content/store.js";
import { RepaFault } from "../src/errors.js";
import { object } from "../src/schema.js";
import { SpaceOperations } from "../src/spaces/store.js";
import { sqlitePlugin } from "./fixtures/capability-sqlite-plugin.js";

const TextSchema = object({ text: Type.String() });
const EchoContract = { id: "example.echo", version: "1" };
const EntrySelection: CapabilitySelection = { contract: { id: "example.entries.append", version: "1" }, implementationId: "sqlite" };
const source = { kind: "client" as const, hostId: "frontend" };
const fault = (code: string) => (error: unknown) => error instanceof RepaFault && error.code === code;

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-capabilities-"));
  const host = new CapabilityHost();
  const stores: ContentStore[] = [];
  t.after(async () => {
    await host.close();
    await Promise.all(stores.map((store) => store.settled()));
    await rm(root, { recursive: true, force: true });
  });
  const space = async (spaceId: string) => {
    const directory = path.join(root, spaceId);
    await mkdir(directory);
    const content = await ContentStore.open({ root: directory, spaceId, assertOwned() {} });
    stores.push(content);
    return content;
  };
  const context = (content?: ContentStore): Omit<InvocationContext, "spaceRuntime"> => ({
    scope: content ? { kind: "space", spaceId: content.options.spaceId } : { kind: "application" },
    source,
    signal: new AbortController().signal,
    ...(content ? { content } : {}),
  });
  return { root, host, space, context };
}

function echo(implementationId = "plain"): CapabilityDefinition<typeof TextSchema, typeof TextSchema> {
  return {
    contract: EchoContract,
    implementationId,
    inputSchema: TextSchema,
    outputSchema: TextSchema,
    scopes: ["application", "space"],
    execution: "inline",
    invoke: (input) => ({ text: input.text }),
  };
}

test("未启用的插件不运行工厂，无状态能力共享一份处理函数且不建立存储目录", async (t) => {
  const f = await fixture(t);
  const content = await f.space("one");
  let loaded = 0;
  await f.host.register({ id: "disabled", enabled: false, factory: () => { loaded++; return { capabilities: [] }; } });
  assert.equal(loaded, 0);
  assert.deepEqual(f.host.list(), []);
  assert.deepEqual(f.host.snapshotParticipants(), []);
  const calls: InvocationContext[] = [];
  const definition = echo();
  definition.tool = { name: "echo_text", description: "返回本次文字。" };
  definition.invoke = (input, context) => { calls.push(context); return { text: input.text }; };
  await f.host.register({ id: "stateless", enabled: true, factory: () => ({ capabilities: [definition] }) });
  const selection = { contract: EchoContract };
  assert.deepEqual(await f.host.invoke(selection, { text: "前端输入" }, f.context()), { text: "前端输入" });
  const controller = new AbortController();
  const services = { annotate: (value: string) => `来源：${value}` };
  const agent = { kind: "agent" as const, spaceId: "one", sessionId: "session", runId: "run", requestId: "request" };
  assert.deepEqual(await f.host.invoke(selection, { text: "Agent 输入" }, { ...f.context(content), source: agent, signal: controller.signal, services }), { text: "Agent 输入" });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.content, content);
  assert.equal(calls[1]?.services, services);
  assert.deepEqual(calls[1]?.source, agent);
  assert.equal(calls[1]?.spaceRuntime, undefined);
  assert(!existsSync(path.join(content.options.root, ".repa/plugins")));
  const descriptor = f.host.list()[0];
  assert(Check(CapabilityDescriptorSchema, descriptor));
  assert.deepEqual(descriptor.tool, definition.tool);
  assert.equal(Object.hasOwn(descriptor, "invoke"), false);
  assert.equal(JSON.stringify(descriptor).includes("annotate"), false);
});

test("模型工具输入在所选作用域适配，公共调用保持完整契约且声明不泄漏处理函数", async (t) => {
  const f = await fixture(t);
  const content = await f.space("one");
  const PublicInputSchema = object({
    text: Type.String(), operationId: Type.String({ minLength: 1 }), spaceId: Type.String(),
  });
  let prepared = 0;
  const received: unknown[] = [];
  const declared: unknown[] = [];
  const definition: CapabilityDefinition<typeof PublicInputSchema, typeof TextSchema, object, unknown, typeof TextSchema> = {
    contract: EchoContract, implementationId: "mapped", inputSchema: PublicInputSchema,
    outputSchema: TextSchema, scopes: ["space"], execution: "inline",
    tool: {
      name: "mapped_echo", description: "返回文字，程序补足操作身份与空间。",
      input: {
        schema: TextSchema,
        prepare(input, scope) {
          prepared++;
          assert.equal(scope.kind, "space");
          return { ...input, operationId: input.text === "无效映射" ? "" : randomUUID(), spaceId: scope.kind === "space" ? scope.spaceId : "" };
        },
      },
    },
    inputResources(input) { declared.push(input); return []; },
    invoke(input) { received.push(input); return { text: input.text }; },
  };
  await f.host.register({ id: "mapped", enabled: true, factory: () => ({ capabilities: [definition] }) });
  const selection = { contract: EchoContract, implementationId: "mapped" };
  const scope = { kind: "space" as const, spaceId: "one" };
  const descriptor = f.host.resolve(selection, scope);
  assert(Check(CapabilityDescriptorSchema, descriptor));
  assert.deepEqual(descriptor.tool, { name: "mapped_echo", description: definition.tool?.description, inputSchema: TextSchema });
  assert.equal(JSON.stringify(descriptor).includes("prepare"), false);
  const declarations = f.host.resourceDeclarations(selection, scope);
  const mapped = f.host.prepareToolInput(selection, { text: "模型输入" }, scope);
  assert(Check(PublicInputSchema, mapped));
  assert.equal(mapped.spaceId, "one");
  assert.deepEqual(declarations.inputResources(mapped), []);
  assert.deepEqual(declared, [mapped]);
  assert.throws(() => declarations.inputResources({ text: "未适配参数" }), fault("invalid_capability_input"));
  assert.deepEqual(await f.host.invoke(selection, mapped, f.context(content)), { text: "模型输入" });
  const publicInput = { text: "公共调用", operationId: "retry-original", spaceId: "one" };
  assert.deepEqual(await f.host.invoke(selection, publicInput, f.context(content)), { text: "公共调用" });
  assert.deepEqual(received, [mapped, publicInput]);
  assert.equal(prepared, 1);
  await assert.rejects(f.host.invoke(selection, { text: "缺少程序参数" }, f.context(content)), fault("invalid_capability_input"));
  assert.throws(() => f.host.prepareToolInput(selection, publicInput, scope), fault("invalid_capability_input"));
  assert.throws(() => f.host.prepareToolInput(selection, { text: 1 }, scope), fault("invalid_capability_input"));
  assert.throws(() => f.host.prepareToolInput(selection, { text: "错误作用域" }, { kind: "application" }), fault("capability_scope"));
  assert.throws(() => f.host.prepareToolInput({ ...selection, implementationId: "missing" }, { text: "错误实现" }, scope), fault("capability_not_found"));
  assert.equal(prepared, 1);
  const invalid = f.host.prepareToolInput(selection, { text: "无效映射" }, scope);
  await assert.rejects(f.host.invoke(selection, invalid, f.context(content)), fault("invalid_capability_input"));
  assert.equal(received.length, 2);
});

test("未声明模型输入适配的能力沿用公共参数", async (t) => {
  const f = await fixture(t);
  const definition = echo();
  definition.tool = { name: "echo_text", description: "返回文字。" };
  await f.host.register({ id: "plain", enabled: true, factory: () => ({ capabilities: [definition] }) });
  const input = { text: "原参数" };
  assert.equal(f.host.prepareToolInput({ contract: EchoContract }, input, { kind: "application" }), input);
  assert.deepEqual(await f.host.invoke({ contract: EchoContract }, input, f.context()), input);
});

test("同契约的多个实现必须明确选择，登记冲突不会部分发布插件", async (t) => {
  const f = await fixture(t);
  await f.host.register({ id: "first", enabled: true, factory: () => ({ capabilities: [echo("first")] }) });
  await f.host.register({ id: "second", enabled: true, factory: () => ({ capabilities: [echo("second")] }) });
  await assert.rejects(f.host.invoke({ contract: EchoContract }, { text: "不猜测实现" }, f.context()), fault("capability_selection_required"));
  const chosen = { contract: EchoContract, implementationId: "second" };
  assert.equal(f.host.resolve(chosen, { kind: "application" }).pluginId, "second");
  assert.deepEqual(await f.host.invoke(chosen, { text: "已明确" }, f.context()), { text: "已明确" });
  await assert.rejects(f.host.register({ id: "duplicate", enabled: true, factory: () => ({ capabilities: [echo("first")] }) }), fault("capability_conflict"));
  const conflicting = { ...echo("different"), outputSchema: Type.String(), invoke: () => "另一契约" };
  await assert.rejects(f.host.register({ id: "conflicting", enabled: true, factory: () => ({ capabilities: [conflicting] }) }), fault("capability_contract_conflict"));
  assert.deepEqual(f.host.list().map((item) => item.pluginId), ["first", "second"]);
  await f.host.remove("first");
  assert.equal(f.host.resolve({ contract: EchoContract }, { kind: "application" }).implementationId, "second");
});

test("调用在插件执行前检查作用域和输入，执行后检查结果 schema", async (t) => {
  const f = await fixture(t);
  const left = await f.space("left");
  const right = await f.space("right");
  let invoked = 0;
  const definition = echo();
  definition.scopes = ["space"];
  definition.invoke = () => { invoked++; return { text: "完成" }; };
  await f.host.register({ id: "space-only", enabled: true, factory: () => ({ capabilities: [definition] }) });
  const selection = { contract: EchoContract };
  await assert.rejects(f.host.invoke(selection, { text: "应用调用" }, f.context()), fault("capability_scope"));
  await assert.rejects(f.host.invoke(selection, { text: 1 }, f.context(left)), fault("invalid_capability_input"));
  await assert.rejects(f.host.invoke(selection, { text: "跨空间" }, { ...f.context(left), content: right }), fault("capability_scope"));
  await assert.rejects(f.host.invoke(selection, { text: "跨空间来源" }, {
    ...f.context(left), source: { kind: "agent", spaceId: "right", sessionId: "session", runId: "run", requestId: "request" },
  }), fault("capability_scope"));
  assert.equal(invoked, 0);
  assert.deepEqual(await f.host.invoke(selection, { text: "有效调用" }, f.context(left)), { text: "完成" });
  assert.equal(invoked, 1);
  await f.host.register({ id: "invalid-output", enabled: true, factory: () => ({ capabilities: [{
    contract: { id: "example.invalid", version: "1" }, implementationId: "invalid",
    inputSchema: TextSchema, outputSchema: TextSchema, scopes: ["application"], execution: "inline",
    invoke: () => ({ wrong: true }),
  }] }) });
  await assert.rejects(f.host.invoke({ contract: { id: "example.invalid", version: "1" } }, { text: "检查实际结果" }, f.context()), fault("invalid_capability_output"));
});

test("SQLite 插件仅在真实空间调用时打开，每个空间独立迁移并共享一次打开", async (t) => {
  const f = await fixture(t);
  const left = await f.space("left");
  const right = await f.space("right");
  const entered = deferred();
  const gate = deferred();
  const opened: string[] = [];
  const closed: string[] = [];
  await f.host.register({ id: "entries", enabled: true, factory: () => sqlitePlugin({
    id: "entries",
    async beforeOpen(context) {
      if (context.spaceId === "left" && !opened.length) { entered.resolve(); await gate.promise; }
    },
    opened: (context) => { opened.push(context.spaceId); },
    closed: (context) => { closed.push(context.spaceId); },
  }) });
  assert.deepEqual(f.host.settingsDefinitions().map((definition) => definition.namespace), ["example.entries"]);
  assert.deepEqual(f.host.snapshotParticipants().map((participant) => participant.directory), [".repa/plugins/entries"]);
  assert(!existsSync(path.join(left.options.root, ".repa/plugins")));
  const first = f.host.invoke(EntrySelection, { value: "first" }, f.context(left));
  const second = f.host.invoke(EntrySelection, { value: "second" }, f.context(left));
  try {
    await entered.promise;
    assert.deepEqual(opened, []);
  } finally { gate.resolve(); }
  assert.deepEqual(await Promise.all([first, second]), [{ count: 1, spaceId: "left" }, { count: 2, spaceId: "left" }]);
  assert.deepEqual(await f.host.invoke(EntrySelection, { value: "other space" }, f.context(right)), { count: 1, spaceId: "right" });
  assert.deepEqual(opened, ["left", "right"]);
  await f.host.closeSpace("left");
  assert.deepEqual(closed, ["left"]);
  assert.deepEqual(await f.host.invoke(EntrySelection, { value: "reopened" }, f.context(left)), { count: 3, spaceId: "left" });
  assert.deepEqual(opened, ["left", "right", "left"]);
  await f.host.remove("entries");
  assert.deepEqual(closed, ["left", "right", "left"]);
  assert.deepEqual(f.host.settingsDefinitions(), []);
  assert(existsSync(path.join(left.options.root, ".repa/plugins/entries/entries.sqlite")));
});

test("取消等待处理函数真正结束，禁用插件停止接收新调用但保留已完成结果", async (t) => {
  const f = await fixture(t);
  const started = deferred();
  const finishing = deferred();
  let observedSignal: AbortSignal | undefined;
  const definition = echo();
  definition.invoke = async (input, context) => {
    observedSignal = context.signal;
    started.resolve();
    await finishing.promise;
    return { text: input.text };
  };
  await f.host.register({ id: "waiting", enabled: true, factory: () => ({ capabilities: [definition] }) });
  const active = f.host.invoke({ contract: EchoContract }, { text: "已经完成的结果" }, f.context());
  await started.promise;
  let settled = false;
  f.host.cancel();
  const waiting = f.host.settled().then(() => { settled = true; });
  const removing = f.host.remove("waiting");
  try {
    await Promise.resolve();
    assert.equal(observedSignal?.aborted, true);
    assert.equal(settled, false);
    await assert.rejects(f.host.invoke({ contract: EchoContract }, { text: "后续调用" }, f.context()), fault("capability_not_found"));
  } finally { finishing.resolve(); }
  assert.deepEqual(await active, { text: "已经完成的结果" });
  await Promise.all([waiting, removing]);
  assert.equal(settled, true);
  assert.deepEqual(f.host.list(), []);
});

test("关闭空间会取消打开过程并等待收尾，失败打开后可以明确重试", async (t) => {
  const f = await fixture(t);
  const content = await f.space("one");
  const started = deferred();
  let attempts = 0;
  let closed = 0;
  const definition = echo();
  const plugin: BackendPlugin = {
    capabilities: [definition],
    async openSpace(context) {
      attempts++;
      if (attempts === 1) {
        started.resolve();
        await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
        context.signal.throwIfAborted();
      }
      return {};
    },
    closeSpace() { closed++; },
  };
  await f.host.register({ id: "opening", enabled: true, factory: () => plugin });
  const active = f.host.invoke({ contract: EchoContract }, { text: "打开期间取消" }, f.context(content));
  const rejected = assert.rejects(active, (error: unknown) => error instanceof Error && error.name === "AbortError");
  await started.promise;
  await f.host.closeSpace("one");
  await rejected;
  assert.equal(closed, 0);
  assert.deepEqual(await f.host.invoke({ contract: EchoContract }, { text: "重试" }, f.context(content)), { text: "重试" });
  assert.equal(attempts, 2);
  await f.host.close();
  assert.equal(closed, 1);
  await assert.rejects(f.host.invoke({ contract: EchoContract }, { text: "已关闭" }, f.context(content)), fault("closed"));
});

test("宿主取消先中止正在初始化的空间资源，正常重试后关闭仍立即传递资源取消", async (t) => {
  const f = await fixture(t);
  const first = await f.space("first");
  const second = await f.space("second");
  const enteredFirst = deferred();
  const enteredSecond = deferred();
  const signals = new Map<string, AbortSignal>();
  let attempts = 0;
  await f.host.register({ id: "initializing", enabled: true, factory: () => ({
    capabilities: [echo()],
    async openSpace(context) {
      signals.set(context.spaceId, context.signal);
      attempts++;
      if (context.spaceId === "first" && attempts === 2) return {};
      (context.spaceId === "first" ? enteredFirst : enteredSecond).resolve();
      await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      context.signal.throwIfAborted();
      return {};
    },
  }) });
  const firstCall = f.host.invoke({ contract: EchoContract }, { text: "取消初始化" }, f.context(first));
  const firstRejected = assert.rejects(firstCall, (error: unknown) => error instanceof Error && error.name === "AbortError");
  await enteredFirst.promise;
  f.host.cancel({ kind: "space", spaceId: "first" });
  assert.equal(signals.get("first")?.aborted, true);
  await f.host.settled();
  await firstRejected;
  assert.deepEqual(await f.host.invoke({ contract: EchoContract }, { text: "重新打开" }, f.context(first)), { text: "重新打开" });
  assert.equal(signals.get("first")?.aborted, false);
  const secondCall = f.host.invoke({ contract: EchoContract }, { text: "退出期间初始化" }, f.context(second));
  const secondRejected = assert.rejects(secondCall, (error: unknown) => error instanceof Error && error.name === "AbortError");
  await enteredSecond.promise;
  const closing = f.host.close();
  assert.equal(signals.get("first")?.aborted, true);
  assert.equal(signals.get("second")?.aborted, true);
  await Promise.all([closing, secondRejected]);
});

test("单个调用取消不终止同空间其他调用共用的资源初始化", async (t) => {
  const f = await fixture(t);
  const content = await f.space("shared");
  const entered = deferred();
  const ready = deferred();
  let openingSignal: AbortSignal | undefined;
  let opened = 0;
  await f.host.register({ id: "shared-opening", enabled: true, factory: () => ({
    capabilities: [echo()],
    async openSpace(context) {
      opened++;
      openingSignal = context.signal;
      entered.resolve();
      await ready.promise;
      context.signal.throwIfAborted();
      return {};
    },
  }) });
  const controller = new AbortController();
  const first = f.host.invoke({ contract: EchoContract }, { text: "取消自己" }, { ...f.context(content), signal: controller.signal });
  const rejected = assert.rejects(first, fault("cancelled"));
  const second = f.host.invoke({ contract: EchoContract }, { text: "仍需资源" }, f.context(content));
  try {
    await entered.promise;
    controller.abort();
    assert.equal(openingSignal?.aborted, false);
  } finally { ready.resolve(); }
  await rejected;
  assert.deepEqual(await second, { text: "仍需资源" });
  assert.equal(opened, 1);
});

test("插件快照参与既有空间复制，未启用 owner 时不擅自复制 SQLite 文件", async (t) => {
  const f = await fixture(t);
  const content = await f.space("one");
  await f.host.register({ id: "entries", enabled: true, factory: () => sqlitePlugin({ id: "entries" }) });
  await f.host.invoke(EntrySelection, { value: "需要保留" }, f.context(content));
  await f.host.settled();
  const spaces = new SpaceOperations(path.join(f.root, "operations"));
  const copied = await spaces.capture({
    kind: "copy", operationId: randomUUID(), spaceId: "one", source: content.options.root, destination: path.join(f.root, "copy"),
  }, content, f.host.snapshotParticipants());
  assert.equal(copied.status, "completed", copied.error?.message);
  const database = new DatabaseSync(path.join(copied.destination, ".repa/plugins/entries/entries.sqlite"));
  try {
    assert.deepEqual({ ...database.prepare("SELECT * FROM entries").get() }, { space: copied.spaceId, value: "需要保留" });
    assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 1);
  } finally { database.close(); }
  await f.host.remove("entries");
  await f.host.register({ id: "entries", enabled: false, factory: () => { throw new Error("禁用插件不能为快照加载工厂"); } });
  const unavailable = await spaces.capture({
    kind: "backup", operationId: randomUUID(), spaceId: "one", source: content.options.root, destination: path.join(f.root, "backup"),
  }, content, f.host.snapshotParticipants());
  assert.equal(unavailable.status, "failed");
  assert.equal(unavailable.error?.code, "snapshot_owner_unavailable");
  assert(existsSync(path.join(content.options.root, ".repa/plugins/entries/entries.sqlite")));
});

test("空间附带的插件目录符号链接不能把运行资源写到空间外", async (t) => {
  const f = await fixture(t);
  const content = await f.space("one");
  const external = path.join(f.root, "external");
  await mkdir(external);
  await symlink(external, path.join(content.options.root, ".repa/plugins"));
  await f.host.register({ id: "entries", enabled: true, factory: () => sqlitePlugin({ id: "entries" }) });
  await assert.rejects(f.host.invoke(EntrySelection, { value: "不能越界" }, f.context(content)), fault("invalid_storage"));
  assert(!existsSync(path.join(external, "entries")));
});

test("资源关闭失败时仍等待其他空间收尾，明确重试只重试尚未关闭的资源", async (t) => {
  const f = await fixture(t);
  const left = await f.space("left");
  const right = await f.space("right");
  const closingRight = deferred();
  const rightFinished = deferred();
  const attempts: string[] = [];
  await f.host.register({ id: "close-failure", enabled: true, factory: () => ({
    capabilities: [echo()],
    openSpace: () => ({}),
    async closeSpace(_runtime, context) {
      attempts.push(context.spaceId);
      if (context.spaceId === "left" && attempts.filter((id) => id === "left").length === 1) throw new Error("暂未关闭");
      if (context.spaceId === "right") {
        closingRight.resolve();
        await rightFinished.promise;
      }
    },
  }) });
  await f.host.invoke({ contract: EchoContract }, { text: "left" }, f.context(left));
  await f.host.invoke({ contract: EchoContract }, { text: "right" }, f.context(right));
  let finished = false;
  const closing = f.host.close().finally(() => { finished = true; });
  const rejected = assert.rejects(closing, AggregateError);
  try {
    await closingRight.promise;
    assert.equal(finished, false);
  } finally { rightFinished.resolve(); }
  await rejected;
  await f.host.close();
  assert.deepEqual(attempts, ["left", "right", "left"]);
});
