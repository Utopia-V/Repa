import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, type FauxResponseStep, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { createAgentRuntimeForTest } from "../src/agent/runtime.js";
import { RepaClient, RpcError } from "../src/client.js";
import { INTERACTION_CAPABILITIES } from "../src/interaction.js";
import type { Plugin } from "../src/plugin.js";
import { readEnablement } from "../src/plugins/enablement.js";
import { checkSnapshot, snapshotDirectory, snapshotGroup } from "../src/plugins/snapshots.js";
import type { NotificationParams, PluginInfo } from "../src/protocol.js";
import { record } from "../src/protocol/json-rpc.js";
import { startServer } from "../src/protocol/server.js";
import type { AgentEvent, Confirmation } from "../src/schema.js";

function deferred<T = void>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

const rejectsWith = (code: string) => (error: unknown): boolean => {
  assert.ok(error instanceof RpcError, String(error));
  assert.equal(record(error.data)?.code, code);
  return true;
};

const empty = Type.Object({}, { additionalProperties: false });

// 自写插件经 globalThis 上的计数报告模块顶层的执行、open 与 close，测试在同一进程里读它。插件文件不导入任何东西，参数直接写成 JSON Schema。
interface Counts { evaluated: Record<string, number>; opens: Record<string, number>; closes: Record<string, number> }
const COUNTS = "__repaRequestCounts";
function counts(): Counts {
  const store = globalThis as unknown as Record<string, Counts | undefined>;
  store[COUNTS] ??= { evaluated: {}, opens: {}, closes: {} };
  return store[COUNTS];
}

type FsPromises = Record<string, (...args: unknown[]) => Promise<unknown>>;
const fsPromises = createRequire(import.meta.url)("node:fs/promises") as FsPromises;

/**
 * 在文件系统的边界上替换 node:fs/promises 的一个函数，测试结束时还原。后端在同一进程里，源码以具名导入使用这些函数，
 * syncBuiltinESMExports 让那些导入也换成替身；替身拿到第一个参数（路径）和原函数，决定放行、等待还是失败。
 */
function intercept(t: TestContext, name: string, wrap: (target: string, original: (...args: unknown[]) => Promise<unknown>, args: unknown[]) => Promise<unknown>) {
  const original = fsPromises[name];
  assert.ok(original !== undefined);
  fsPromises[name] = (...args: unknown[]) => wrap(String(args[0]), original, args);
  syncBuiltinESMExports();
  t.after(() => {
    fsPromises[name] = original;
    syncBuiltinESMExports();
  });
}

/**
 * 带一个工具的自写插件文件夹。label 区分同一 id 的不同版本，open 与 close 按 label 计数；工具回复 reply。
 * open 设为 "throw" 时 open 抛错，"opaque" 时抛出不能转成文字的值；close 设为 "throw" 时 close 抛错；broken 时入口有语法错误。
 */
function toolFolder(id: string, label: string, options: { tool?: string; reply?: string; open?: "throw" | "opaque"; close?: "throw"; broken?: boolean } = {}): Record<string, string> {
  const tool = options.tool ?? `${id.replaceAll("-", "_")}_greet`;
  const failOpen = options.open === "throw" ? `throw new Error("数据目录里缺少配置文件 settings.json");` : options.open === "opaque" ? "throw Object.create(null);" : "";
  const failClose = options.close === "throw" ? `throw new Error("定时器还没收回");` : "";
  return {
    "repa-plugin.json": JSON.stringify({ id, version: "0.1.0", baseVersion: "^0.1.0", entry: "index.js", title: `${id} 插件`, pages: [{ id: "main", title: "主页", entry: "page/index.html" }] }),
    "page/index.html": "<!doctype html><title>页面</title>\n",
    "index.js": `${options.broken === true ? "export default {;\n" : ""}const counts = (globalThis[${JSON.stringify(COUNTS)}] ??= { evaluated: {}, opens: {}, closes: {} });
counts.evaluated[${JSON.stringify(label)}] = (counts.evaluated[${JSON.stringify(label)}] ?? 0) + 1;
export default {
  id: ${JSON.stringify(id)},
  async open() {
    counts.opens[${JSON.stringify(label)}] = (counts.opens[${JSON.stringify(label)}] ?? 0) + 1;
    ${failOpen}
    const tool = { name: ${JSON.stringify(tool)}, description: "问候", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => ({ text: ${JSON.stringify(options.reply ?? label)} }) };
    return {
      tools: () => [tool],
      async close() {
        counts.closes[${JSON.stringify(label)}] = (counts.closes[${JSON.stringify(label)}] ?? 0) + 1;
        ${failClose}
      },
    };
  },
};
`,
  };
}

/** 随包的控制插件：测试经它让重组停在旧实例关闭时、让运行停在读 view 时，或让一个插件调用一直在途。 */
interface Control {
  closeEntered?: () => void;
  closeGate?: Promise<void>;
  viewEntered?: () => void;
  viewGate?: Promise<void>;
  hold?: Promise<void>;
}

function controlPlugin(control: Control): Plugin {
  return {
    id: "control",
    async open(host) {
      return {
        async view() {
          control.viewEntered?.();
          await control.viewGate;
          return undefined;
        },
        methods: {
          hold: { parameters: empty, async invoke() { await control.hold; return null; } },
          // 插件交给通用 Agent 的后台任务，等它结束，返回会话编号。
          background: {
            parameters: empty,
            async invoke() {
              const work = await host.models.runAgent({ text: "加载 hello 插件" });
              await work.result;
              return work.id;
            },
          },
        },
        async close() {
          control.closeEntered?.();
          await control.closeGate;
        },
      };
    },
  };
}

/** 在已有记录与未来通知里等第一个满足条件的值：先到的事件不会因为等待登记得晚而错过。 */
function stream<T>() {
  const seen: T[] = [];
  const waiting = new Set<{ test: (value: T) => boolean; resolve: (value: T) => void }>();
  return {
    seen,
    push(value: T) {
      seen.push(value);
      for (const waiter of [...waiting]) {
        if (!waiter.test(value)) continue;
        waiting.delete(waiter);
        waiter.resolve(value);
      }
    },
    when(test: (value: T) => boolean, from = 0): Promise<T> {
      const found = seen.slice(from).find(test);
      if (found !== undefined) return Promise.resolve(found);
      return new Promise(resolve => waiting.add({ test, resolve }));
    },
  };
}

async function fixture(t: TestContext, options: { control?: Control; extensions?: ExtensionFactory[] } = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-plugin-requests-")));
  const root = path.join(directory, "space");
  const home = path.join(directory, "home");
  await mkdir(path.join(home, "agent"), { recursive: true });
  const faux = fauxProvider({ api: `requests-${randomUUID()}`, provider: `requests-${randomUUID()}`, models: [{ id: "scripted", contextWindow: 16384, maxTokens: 256 }], tokensPerSecond: 0 });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(home, "agent", "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const runtime = await createAgentRuntimeForTest({
    agentDir: path.join(home, "agent"),
    modelRuntime,
    defaultModel: { provider: faux.getModel().provider, id: "scripted" },
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
    ...(options.extensions === undefined ? {} : { extensionFactories: options.extensions }),
  });
  const control = options.control ?? {};
  const server = await startServer({ home, runtime, plugins: [controlPlugin(control)] });
  const clients: RepaClient[] = [];
  const events = stream<AgentEvent>();
  const lists = stream<PluginInfo[]>();
  const confirmations = stream<{ id: string; request: Confirmation; client: RepaClient }>();
  const connect = async () => {
    const client = await RepaClient.connect(server.connection, { capabilities: { interaction: { supports: [...INTERACTION_CAPABILITIES] } } });
    clients.push(client);
    client.on("session.event", event => events.push(event));
    client.on("plugin.updated", ({ plugins }) => lists.push(plugins));
    client.on("space.assembled", notice => { if (notice.root !== null) lists.push(notice.plugins); });
    client.on("confirm.request", ({ id, request }) => confirmations.push({ id, request, client }));
    return client;
  };
  const client = await connect();
  t.after(async () => {
    for (const opened of clients) await opened.close().catch(() => undefined);
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const opened = await client.call("space.create", { root });
  /** 在空间的 .agents/plugins/<id>/ 写插件文件夹；files 的键是以 / 分隔的相对路径。 */
  const folder = async (id: string, files: Record<string, string>) => {
    const target = path.join(root, ".agents", "plugins", id);
    await rm(target, { recursive: true, force: true });
    for (const [relative, text] of Object.entries(files)) {
      const file = path.join(target, ...relative.split("/"));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
    }
    return target;
  };
  /** 等某个插件的请求有了结局：requestId 省略时取 from 以后收到的列表里的任何请求。 */
  const outcome = async (id: string, requestId?: string, from = 0) => {
    const list = await lists.when(plugins => plugins.some(plugin => plugin.id === id && plugin.request !== undefined && "outcome" in plugin.request && (requestId === undefined || plugin.request.id === requestId)), from);
    const request = list.find(plugin => plugin.id === id)?.request;
    assert.ok(request !== undefined && "outcome" in request);
    return { requestId: request.id, ...request.outcome };
  };
  /** 回答最早一个还没回答的插件批准，返回请求内容。 */
  const answered = new Set<string>();
  const answer = async (value: boolean | null) => {
    const confirmation = await confirmations.when(item => item.request.kind === "plugin" && !answered.has(item.id));
    answered.add(confirmation.id);
    await confirmation.client.call("confirm.reply", { id: confirmation.id, value });
    return confirmation.request;
  };
  /** 模型每次回复时记下请求里的工具名。 */
  const tools: string[][] = [];
  const reply = (step: FauxResponseStep): FauxResponseStep => (context: TranscriptContext, ...rest) => {
    tools.push(getCurrentTools(context.messages).map(tool => tool.name).sort());
    return typeof step === "function" ? step(context, ...rest) : step;
  };
  const script = (steps: FauxResponseStep[]) => faux.setResponses(steps.map(reply));
  return { directory, root, home, dataDir: path.join(root, ".repa"), faux, server, client, connect, opened, folder, events, lists, confirmations, outcome, answer, tools, script, control };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Agent 在一次运行里请求加载 ids，然后结束这次运行；返回会话编号。 */
async function agentLoads(f: Fixture, ids: string[], more: FauxResponseStep[] = []) {
  f.script([
    fauxAssistantMessage(fauxToolCall("plugin", { action: "load", ids })),
    fauxAssistantMessage("插件写好了，等批准。"),
    ...more,
  ]);
  const session = await f.client.call("session.create", {});
  await f.client.call("session.send", { sessionId: session.id, text: "写一个问候插件并加载" });
  return session.id;
}

/** 会话里的装卸结果条目。 */
async function results(f: Fixture, sessionId: string) {
  return (await f.client.call("session.history", { sessionId })).filter(entry => entry.type === "pluginResult");
}

test("Agent 请求加载：运行结束后请求批准，批准以后重组，续跑用上新工具；结果在会话里只有一份，实时事件与历史同一身份", async t => {
  const f = await fixture(t);
  await f.folder("hello", toolFolder("hello", "hello-1", { reply: "你好，世界" }));
  const sessionId = await agentLoads(f, ["hello"], [
    fauxAssistantMessage(fauxToolCall("hello_greet", {})),
    fauxAssistantMessage("新插件回答了：你好，世界"),
  ]);
  // 请求只是记下：这次运行里工具清单里还没有新工具，工具结果告诉模型稍后处理。
  const first = (await f.client.call("session.history", { sessionId })).find(entry => entry.type === "tool");
  assert.match(first?.text ?? "", /本次运行结束后处理/);
  assert.ok(!(f.tools[0] ?? []).includes("hello_greet"));
  assert.ok((f.tools[0] ?? []).includes("plugin"));

  const request = await f.answer(true);
  assert.equal(request.kind, "plugin");
  assert.equal(request.title, "");
  const shown = request.plugins?.[0];
  assert.equal(shown?.id, "hello");
  assert.equal(shown?.title, "hello 插件");
  assert.equal(shown?.version, "0.1.0");
  assert.deepEqual(shown?.pages, [{ id: "main", title: "主页" }]);
  assert.equal(shown?.base, "none");
  assert.deepEqual(shown?.files.map(file => [file.path, file.change]), [["index.js", "added"], ["page/index.html", "added"], ["repa-plugin.json", "added"]]);

  const done = await f.outcome("hello");
  assert.deepEqual({ recorded: done.recorded, application: done.application }, { recorded: true, application: "applied" });
  const shownEvent = await f.events.when(event => event.sessionId === sessionId && event.type === "pluginResult");
  assert.ok(shownEvent.runId !== undefined, "续跑的输入就是结果");
  await f.events.when(event => event.type === "runEnd" && event.runId === shownEvent.runId);
  // 结构化的结果：每项的 id、动作与结局，以及旧实例 close() 报错的插件。
  const expected = { requestId: done.requestId, items: [{ id: "hello", action: "load", outcome: { recorded: true, application: "applied" } }], closeFailures: [] };
  assert.deepEqual(shownEvent.data, expected);
  assert.ok((f.tools[2] ?? []).includes("hello_greet"));
  const history = await f.client.call("session.history", { sessionId });
  const entries = history.filter(entry => entry.type === "pluginResult");
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0]?.data, expected);
  assert.equal(entries[0]?.text, shownEvent.text);
  assert.match(entries[0]?.text ?? "", /加载 hello：已生效，启用记录已改/);
  assert.equal(history.findLast(entry => entry.type === "tool")?.text, "你好，世界");
  assert.equal(history.findLast(entry => entry.type === "assistant")?.text, "新插件回答了：你好，世界");
  // 列表：运行中，版本与页面取自快照的清单，源文件夹与记下的版本相同。
  const listed = (await f.client.call("plugin.list", {})).find(plugin => plugin.id === "hello");
  assert.equal(listed?.state, "running");
  assert.equal(listed?.folder, "same");
  assert.equal(listed?.digest, shown?.digest);
  assert.deepEqual(listed?.tools, ["hello_greet"]);
  assert.deepEqual(listed?.pages, [{ id: "main", title: "主页" }]);
});

test("替换时入口有语法错误：导入失败到此为止，旧版照常运行，记录不变，没有重组", async t => {
  const f = await fixture(t);
  await f.folder("hello", toolFolder("hello", "hello-1"));
  const first = await f.client.call("plugin.load", { ids: ["hello"] });
  await f.answer(true);
  assert.equal((await f.outcome("hello", first.requestId)).application, "applied");
  const before = await readFile(path.join(f.dataDir, "plugins.json"), "utf8");
  const assemblies = f.lists.seen.length;

  await f.folder("hello", toolFolder("hello", "hello-2", { broken: true }));
  const second = await f.client.call("plugin.load", { ids: ["hello"] });
  await f.answer(true);
  const failed = await f.outcome("hello", second.requestId);
  assert.deepEqual({ recorded: failed.recorded, application: failed.application, code: failed.reason?.code }, { recorded: false, application: "failed", code: "plugin_import_failed" });
  assert.match(failed.reason?.message ?? "", /语法错误/);
  assert.equal(await readFile(path.join(f.dataDir, "plugins.json"), "utf8"), before);
  const listed = (await f.client.call("plugin.list", {})).find(plugin => plugin.id === "hello");
  assert.equal(listed?.state, "running");
  assert.equal(listed?.folder, "modified");
  assert.deepEqual(counts().opens["hello-2"], undefined);
  assert.ok(f.lists.seen.slice(assemblies).every(list => list.find(plugin => plugin.id === "hello")?.state === "running"));
});

test("新版本 open 抛错：转为失败并附原因，记录指向它，重开空间仍失败；from previous 让上一版重新生效，之后 previous 是失败的那一版", async t => {
  const f = await fixture(t);
  await f.folder("hello", toolFolder("hello", "open-a"));
  await f.client.call("plugin.load", { ids: ["hello"] });
  await f.answer(true);
  await f.outcome("hello");
  const a = (await readEnablement(f.dataDir)).plugins.hello?.digest;

  await f.folder("hello", toolFolder("hello", "open-b", { open: "throw" }));
  const second = await f.client.call("plugin.load", { ids: ["hello"] });
  await f.answer(true);
  const failed = await f.outcome("hello", second.requestId);
  assert.deepEqual({ recorded: failed.recorded, application: failed.application }, { recorded: true, application: "failed" });
  assert.match(failed.reason?.message ?? "", /缺少配置文件/);
  const recordB = (await readEnablement(f.dataDir)).plugins.hello;
  assert.equal(recordB?.previous, a);
  const b = recordB?.digest;
  await f.client.call("space.close", {});
  const reopened = await f.client.call("space.open", { root: f.root });
  const listed = reopened.plugins.find(plugin => plugin.id === "hello");
  assert.deepEqual([listed?.state, listed?.digest, listed?.previous], ["failed", b, a]);
  assert.match(listed?.reason?.message ?? "", /缺少配置文件/);

  // 上一次选定的版本已有快照，不再询问。
  const asked = f.confirmations.seen.length;
  const back = await f.client.call("plugin.load", { ids: ["hello"], from: "previous" });
  const restored = await f.outcome("hello", back.requestId);
  assert.deepEqual({ recorded: restored.recorded, application: restored.application }, { recorded: true, application: "applied" });
  assert.equal(f.confirmations.seen.length, asked);
  const recordA = (await readEnablement(f.dataDir)).plugins.hello;
  assert.deepEqual([recordA?.digest, recordA?.previous], [a, b]);
  assert.equal((await f.client.call("plugin.list", {})).find(plugin => plugin.id === "hello")?.state, "running");
});

test("同一内容再加载一次：不再询问，记录不变，插件照样重开一次", async t => {
  const f = await fixture(t);
  await f.folder("hello", toolFolder("hello", "same-1"));
  await f.client.call("plugin.load", { ids: ["hello"] });
  await f.answer(true);
  await f.outcome("hello");
  const before = await readFile(path.join(f.dataDir, "plugins.json"), "utf8");
  const asked = f.confirmations.seen.length;
  const { requestId } = await f.client.call("plugin.load", { ids: ["hello"] });
  const again = await f.outcome("hello", requestId);
  assert.deepEqual({ recorded: again.recorded, application: again.application }, { recorded: false, application: "applied" });
  assert.equal(f.confirmations.seen.length, asked);
  assert.equal(await readFile(path.join(f.dataDir, "plugins.json"), "utf8"), before);
  assert.equal(counts().opens["same-1"], 2);
});

test("previous 是上一次选定的版本：A 生效、B 生效以后回到 A，previous 变成 B；A、B 失败以后再选 C，A 的快照已清理", async t => {
  const f = await fixture(t);
  const load = async (label: string, extra: Parameters<typeof toolFolder>[2] = {}) => {
    await f.folder("hello", toolFolder("hello", label, extra));
    const { requestId } = await f.client.call("plugin.load", { ids: ["hello"] });
    await f.answer(true);
    await f.outcome("hello", requestId);
    return (await readEnablement(f.dataDir)).plugins.hello?.digest ?? "";
  };
  const a = await load("prev-a");
  const b = await load("prev-b");
  const { requestId } = await f.client.call("plugin.load", { ids: ["hello"], from: "previous" });
  assert.equal((await f.outcome("hello", requestId)).application, "applied");
  assert.deepEqual([(await readEnablement(f.dataDir)).plugins.hello?.digest, (await readEnablement(f.dataDir)).plugins.hello?.previous], [a, b]);

  const c = await load("prev-c", { open: "throw" });
  const d = await load("prev-d", { open: "throw" });
  const entry = (await readEnablement(f.dataDir)).plugins.hello;
  assert.deepEqual([entry?.digest, entry?.previous], [d, c]);
  assert.equal(await checkSnapshot(f.home, f.root, "hello", a), "missing");
  const again = await f.client.call("plugin.load", { ids: ["hello"], from: "previous" });
  const outcome = await f.outcome("hello", again.requestId);
  assert.equal(outcome.application, "failed");
  assert.match(outcome.reason?.message ?? "", /缺少配置文件/);
});

test("卸载：工具从下一条消息起不在，重开空间不回来；文件夹、快照与数据目录都在；随包插件不能卸载", async t => {
  const f = await fixture(t);
  await f.folder("hello", toolFolder("hello", "unload-1"));
  await f.client.call("plugin.load", { ids: ["hello"] });
  await f.answer(true);
  await f.outcome("hello");
  const digest = (await readEnablement(f.dataDir)).plugins.hello?.digest ?? "";
  const dataDir = path.join(f.dataDir, "plugins", "hello");
  await writeFile(path.join(dataDir, "notes.txt"), "插件的数据");
  f.script([fauxAssistantMessage("好"), fauxAssistantMessage(fauxToolCall("plugin", { action: "unload", ids: ["hello"] })), fauxAssistantMessage("已请求卸载"), fauxAssistantMessage("好")]);
  const session = await f.client.call("session.create", {});
  await f.client.call("session.send", { sessionId: session.id, text: "第一条" });
  assert.ok(f.tools.at(-1)?.includes("hello_greet"));
  const mark = f.lists.seen.length;
  await f.client.call("session.send", { sessionId: session.id, text: "卸载它" });
  const unloaded = await f.outcome("hello", undefined, mark);
  assert.equal(unloaded.application, "applied");
  // 续跑之后再发一条：新工具清单里已经没有它。
  const resumed = await f.events.when(event => event.sessionId === session.id && event.type === "pluginResult");
  await f.events.when(event => event.type === "runEnd" && event.runId === resumed.runId);
  assert.ok(!(f.tools.at(-1) ?? []).includes("hello_greet"));
  await f.client.call("space.close", {});
  const reopened = await f.client.call("space.open", { root: f.root });
  assert.equal(reopened.plugins.find(plugin => plugin.id === "hello")?.state, "disabled");
  assert.equal(await checkSnapshot(f.home, f.root, "hello", digest), "ok");
  assert.equal(await readFile(path.join(dataDir, "notes.txt"), "utf8"), "插件的数据");
  assert.ok((await stat(path.join(f.root, ".agents", "plugins", "hello", "index.js"))).isFile());
  await assert.rejects(f.client.call("plugin.unload", { ids: ["control"] }), rejectsWith("plugin_bundled"));
  await assert.rejects(f.client.call("plugin.load", { ids: ["control"] }), rejectsWith("plugin_id_conflict"));
});

test("换一个配置目录打开同一空间：本机没有快照，插件列为待批准；重新批准以后运行", async t => {
  const f = await fixture(t);
  await f.folder("hello", toolFolder("hello", "home-1"));
  await f.client.call("plugin.load", { ids: ["hello"] });
  await f.answer(true);
  await f.outcome("hello");
  await f.client.call("space.close", {});
  const other = await startServer({ home: path.join(f.directory, "other-home") });
  const client = await RepaClient.connect(other.connection, { capabilities: {} });
  try {
    const opened = await client.call("space.open", { root: f.root });
    const listed = opened.plugins.find(plugin => plugin.id === "hello");
    assert.deepEqual([listed?.state, listed?.reason?.code, listed?.folder], ["pending", "snapshot_missing", "same"]);
    const asked = new Promise<{ id: string; request: Confirmation }>(resolve => {
      const stop = client.on("confirm.request", params => { stop(); resolve(params); });
    });
    const { requestId } = await client.call("plugin.load", { ids: ["hello"], from: "recorded" });
    const confirmation = await asked;
    assert.equal(confirmation.request.plugins?.[0]?.digest, listed?.digest);
    const assembled = new Promise<NotificationParams<"space.assembled">>(resolve => {
      const stop = client.on("space.assembled", params => { stop(); resolve(params); });
    });
    await client.call("confirm.reply", { id: confirmation.id, value: true });
    const notice = await assembled;
    assert.ok(notice.root !== null);
    const after = notice.plugins.find(plugin => plugin.id === "hello");
    assert.equal(after?.state, "running");
    assert.ok(after?.request !== undefined && "outcome" in after.request && after.request.id === requestId && after.request.outcome.application === "applied");
  } finally {
    // 先于夹具删除目录关闭另一个后端。
    await client.close();
    await other.close();
  }
});

test("批准前改动插件文件夹：运行的是请求批准时展示的那一份", async t => {
  const f = await fixture(t);
  await f.folder("hello", toolFolder("hello", "shown", { reply: "展示的版本" }));
  const { requestId } = await f.client.call("plugin.load", { ids: ["hello"] });
  const confirmation = await f.confirmations.when(item => item.request.kind === "plugin");
  await f.folder("hello", toolFolder("hello", "edited", { reply: "批准时改过的版本" }));
  await f.client.call("confirm.reply", { id: confirmation.id, value: true });
  assert.equal((await f.outcome("hello", requestId)).application, "applied");
  const listed = (await f.client.call("plugin.list", {})).find(plugin => plugin.id === "hello");
  assert.equal(listed?.digest, confirmation.request.plugins?.[0]?.digest);
  assert.equal(listed?.folder, "modified");
  f.script([fauxAssistantMessage(fauxToolCall("hello_greet", {})), fauxAssistantMessage("好")]);
  const session = await f.client.call("session.create", {});
  await f.client.call("session.send", { sessionId: session.id, text: "问候" });
  assert.equal((await f.client.call("session.history", { sessionId: session.id })).find(entry => entry.type === "tool")?.text, "展示的版本");
  assert.equal(counts().opens.edited, undefined);
});

test("拒绝批准、等待批准时撤回、发起连接断开：都不执行，记录不变；Agent 的请求被拒绝时结果追加进会话，不续跑", async t => {
  const f = await fixture(t);
  await f.folder("hello", toolFolder("hello", "deny-1"));
  const sessionId = await agentLoads(f, ["hello"], [fauxAssistantMessage("不该续跑")]);
  await f.answer(false);
  const denied = await f.outcome("hello");
  assert.deepEqual({ recorded: denied.recorded, application: denied.application }, { recorded: false, application: "denied" });
  const shown = await f.events.when(event => event.sessionId === sessionId && event.type === "pluginResult");
  assert.equal(shown.runId, undefined);
  assert.deepEqual(shown.data, { requestId: denied.requestId, items: [{ id: "hello", action: "load", outcome: { recorded: false, application: "denied", reason: denied.reason } }], closeFailures: [] });
  assert.equal((await results(f, sessionId)).length, 1);
  assert.equal(f.faux.getPendingResponseCount(), 1);
  await assert.rejects(readFile(path.join(f.dataDir, "plugins.json")), { code: "ENOENT" });
  assert.equal((await f.client.call("plugin.list", {})).find(plugin => plugin.id === "hello")?.state, "disabled");
  // plugin 工具的 list 也看得到这个结局。
  f.script([fauxAssistantMessage(fauxToolCall("plugin", { action: "list" })), fauxAssistantMessage("看过了")]);
  await f.client.call("session.send", { sessionId, text: "看看插件" });
  const listed = (await f.client.call("session.history", { sessionId })).findLast(entry => entry.type === "tool")?.text ?? "";
  assert.match(listed, /hello（自写）；未启用/);
  assert.match(listed, /使用者拒绝批准/);

  const from = f.confirmations.seen.length;
  const cancelled = await f.client.call("plugin.load", { ids: ["hello"] });
  await f.confirmations.when(item => item.request.kind === "plugin", from);
  await f.client.call("plugin.cancel", { requestId: cancelled.requestId });
  const withdrawn = await f.outcome("hello", cancelled.requestId);
  assert.deepEqual({ application: withdrawn.application, code: withdrawn.reason?.code }, { application: "cancelled", code: "plugin_request_cancelled" });
  await assert.rejects(f.client.call("plugin.cancel", { requestId: cancelled.requestId }), rejectsWith("plugin_request_not_found"));

  const other = await f.connect();
  const later = f.confirmations.seen.length;
  const lost = await other.call("plugin.load", { ids: ["hello"] });
  const asked = await f.confirmations.when(item => item.request.kind === "plugin", later);
  assert.equal(asked.client, other, "批准发给发起请求的连接");
  await other.close();
  const gone = await f.outcome("hello", lost.requestId);
  assert.equal(gone.application, "cancelled");
  await assert.rejects(readFile(path.join(f.dataDir, "plugins.json")), { code: "ENOENT" });
  assert.equal(counts().opens["deny-1"], undefined);
  assert.equal(counts().evaluated["deny-1"], undefined);
});

test("等待空闲时撤回：不重组，插件集合不变；等待期间别的请求照常进行", async t => {
  const f = await fixture(t, { control: {} });
  await f.folder("hello", toolFolder("hello", "idle-1"));
  const release = deferred();
  f.control.hold = release.promise;
  const opened = f.opened.assembly;
  const holding = f.client.call("plugin.call", { pluginId: "control", method: "hold", input: {}, assembly: opened });
  const { requestId } = await f.client.call("plugin.load", { ids: ["hello"] });
  await f.answer(true);
  await f.lists.when(list => list.some(plugin => plugin.id === "hello" && plugin.request !== undefined && "stage" in plugin.request && plugin.request.stage === "waiting"));
  // 等待空闲不挡住别的工作。
  assert.ok((await f.client.call("session.list", {})).length >= 0);
  await f.client.call("plugin.cancel", { requestId });
  const outcome = await f.outcome("hello", requestId);
  assert.equal(outcome.application, "cancelled");
  release.resolve();
  await holding;
  await f.client.call("space.list", {});
  assert.ok(f.lists.seen.every(list => list.find(plugin => plugin.id === "hello")?.state !== "running"));
  assert.equal(counts().opens["idle-1"], undefined);
  await assert.rejects(readFile(path.join(f.dataDir, "plugins.json")), { code: "ENOENT" });
});

test("两批请求先进先出，各自经过一次重组；第二批等第一批结束才准备", async t => {
  const f = await fixture(t);
  await f.folder("alpha", toolFolder("alpha", "fifo-a"));
  await f.folder("beta", toolFolder("beta", "fifo-b"));
  const first = await f.client.call("plugin.load", { ids: ["alpha"] });
  const second = await f.client.call("plugin.load", { ids: ["beta"] });
  const confirmation = await f.confirmations.when(item => item.request.kind === "plugin");
  assert.deepEqual(confirmation.request.plugins?.map(item => item.id), ["alpha"]);
  // 第二批还在排队，没有开始准备。
  const beta = f.lists.seen.at(-1)?.find(plugin => plugin.id === "beta")?.request;
  assert.ok(beta !== undefined && "stage" in beta && beta.stage === "queued");
  await f.answer(true);
  await f.answer(true);
  assert.equal((await f.outcome("alpha", first.requestId)).application, "applied");
  assert.equal((await f.outcome("beta", second.requestId)).application, "applied");
  assert.deepEqual([counts().opens["fifo-a"], counts().opens["fifo-b"]], [2, 1]);
});

test("完全访问模式下 Agent 明确提出的加载不再询问；插件列表发起的加载仍然询问", async t => {
  const f = await fixture(t);
  await f.client.call("settings.set", { commandPolicy: "fullAccess" });
  await f.folder("hello", toolFolder("hello", "full-1"));
  await agentLoads(f, ["hello"], [fauxAssistantMessage("好")]);
  assert.equal((await f.outcome("hello")).application, "applied");
  assert.equal(f.confirmations.seen.length, 0);
  await f.folder("hello", toolFolder("hello", "full-2"));
  const { requestId } = await f.client.call("plugin.load", { ids: ["hello"] });
  await f.answer(true);
  assert.equal((await f.outcome("hello", requestId)).application, "applied");
  assert.equal(f.confirmations.seen.length, 1);
});

test("子 Agent 提出装卸被拒绝，工具结果说明原因，不登记请求", async t => {
  const f = await fixture(t);
  await f.folder("hello", toolFolder("hello", "child-1"));
  f.script([
    fauxAssistantMessage(fauxToolCall("subagent", { agent: "general", task: "加载 hello 插件" })),
    fauxAssistantMessage(fauxToolCall("plugin", { action: "load", ids: ["hello"] })),
    fauxAssistantMessage("子任务没能加载"),
    fauxAssistantMessage("好"),
  ]);
  const session = await f.client.call("session.create", {});
  await f.client.call("session.send", { sessionId: session.id, text: "让子 Agent 加载插件" });
  const child = (await f.client.call("session.list", {})).find(info => info.parent?.sessionId === session.id);
  assert.ok(child);
  const tool = (await f.client.call("session.history", { sessionId: child.id })).find(entry => entry.type === "tool");
  assert.match(tool?.text ?? "", /只有使用者直接对话的会话能提出装卸/);
  await f.client.call("space.list", {});
  assert.equal((await f.client.call("plugin.list", {})).find(plugin => plugin.id === "hello")?.request, undefined);
});

test("后台任务里的通用 Agent 提出装卸被拒绝", async t => {
  const f = await fixture(t);
  await f.folder("hello", toolFolder("hello", "task-1"));
  f.script([fauxAssistantMessage(fauxToolCall("plugin", { action: "load", ids: ["hello"] })), fauxAssistantMessage("没能加载")]);
  const sessionId = await f.client.call("plugin.call", { pluginId: "control", method: "background", input: {}, assembly: f.opened.assembly });
  assert.equal(typeof sessionId, "string");
  const tool = (await f.client.call("session.history", { sessionId: String(sessionId) })).find(entry => entry.type === "tool");
  assert.match(tool?.text ?? "", /只有使用者直接对话的会话能提出装卸/);
  assert.equal((await f.client.call("plugin.list", {})).find(plugin => plugin.id === "hello")?.request, undefined);
});

test("续跑：提出请求的运行被停止，结果只追加为条目，不开始运行", async t => {
  const f = await fixture(t);
  await f.folder("hello", toolFolder("hello", "stop-1"));
  const answered = deferred();
  f.script([
    fauxAssistantMessage(fauxToolCall("plugin", { action: "load", ids: ["hello"] })),
    async () => { await answered.promise; return fauxAssistantMessage("被停止了"); },
  ]);
  const session = await f.client.call("session.create", {});
  const sending = f.client.call("session.send", { sessionId: session.id, text: "加载" });
  await f.events.when(event => event.type === "toolEnd" && event.tool === "plugin");
  // 停止要等模型这一步结束；先发出停止，再让模型这一步返回。
  const aborting = f.client.call("session.abort", { sessionId: session.id });
  await f.client.call("space.list", {});
  answered.resolve();
  await aborting;
  await sending.catch(() => undefined);
  await f.answer(true);
  assert.equal((await f.outcome("hello")).application, "applied");
  const shown = await f.events.when(event => event.sessionId === session.id && event.type === "pluginResult");
  assert.equal(shown.runId, undefined);
  await f.client.call("space.list", {});
  assert.equal(f.faux.getPendingResponseCount(), 0);
  assert.equal((await results(f, session.id)).length, 1);
});

test("续跑：等待批准期间使用者在会话里又发了消息，结果只追加为条目", async t => {
  const f = await fixture(t);
  await f.folder("hello", toolFolder("hello", "send-1"));
  const sessionId = await agentLoads(f, ["hello"], [fauxAssistantMessage("另一件事办好了")]);
  await f.confirmations.when(item => item.request.kind === "plugin");
  await f.client.call("session.send", { sessionId, text: "顺便办另一件事" });
  await f.answer(true);
  await f.outcome("hello");
  const shown = await f.events.when(event => event.sessionId === sessionId && event.type === "pluginResult");
  assert.equal(shown.runId, undefined);
  assert.equal((await results(f, sessionId)).length, 1);
});

test("续跑：闸门落下期间到达的停止，以及排在重组后面的关闭空间，都使结果只追加为条目", async t => {
  for (const intervention of ["abort", "close"] as const) {
    await t.test(intervention, async t => {
      const f = await fixture(t, { control: {} });
      await f.folder("hello", toolFolder("hello", `gate-${intervention}`));
      const sessionId = await agentLoads(f, ["hello"]);
      const entered = deferred();
      const release = deferred();
      f.control.closeEntered = () => entered.resolve();
      f.control.closeGate = release.promise;
      await f.answer(true);
      await entered.promise;
      // 闸门已经落下：停止在闸门前等待，关闭空间排在生命周期队列里；两者都在到达时登记为介入。
      const pending = intervention === "abort"
        ? f.client.call("session.abort", { sessionId })
        : f.client.call("space.close", {});
      await f.client.call("space.list", {});
      f.control.closeEntered = undefined;
      f.control.closeGate = undefined;
      release.resolve();
      await pending;
      const outcome = await f.outcome("hello");
      assert.equal(outcome.application, "applied");
      const shown = await f.events.when(event => event.sessionId === sessionId && event.type === "pluginResult");
      assert.equal(shown.runId, undefined, "没有开始续跑");
      assert.equal(f.events.seen.filter(event => event.sessionId === sessionId && event.type === "runStart").length, 1);
      // 续跑没有登记过：登记以后再被停止或关闭会留下一次取消的错误事件。
      assert.deepEqual(f.events.seen.filter(event => event.sessionId === sessionId && event.type === "error"), []);
      if (intervention === "close") await f.client.call("space.open", { root: f.root });
      assert.equal((await results(f, sessionId)).length, 1);
    });
  }
});

test("续跑：发起请求的连接在执行前断开，结果只追加为条目", async t => {
  const f = await fixture(t, { control: {} });
  await f.client.call("settings.set", { commandPolicy: "fullAccess" });
  await f.folder("hello", toolFolder("hello", "peer-1"));
  const other = await f.connect();
  f.script([fauxAssistantMessage(fauxToolCall("plugin", { action: "load", ids: ["hello"] })), fauxAssistantMessage("等它生效")]);
  const entered = deferred();
  const release = deferred();
  f.control.closeEntered = () => entered.resolve();
  f.control.closeGate = release.promise;
  const session = await other.call("session.create", {});
  await other.call("session.send", { sessionId: session.id, text: "加载" });
  await entered.promise;
  await other.close();
  f.control.closeGate = undefined;
  release.resolve();
  assert.equal((await f.outcome("hello")).application, "applied");
  const shown = await f.events.when(event => event.sessionId === session.id && event.type === "pluginResult");
  assert.equal(shown.runId, undefined);
  assert.equal((await results(f, session.id)).length, 1);
});

test("续跑在写下输入之前被停止：结果仍在会话里，只有一份", async t => {
  const f = await fixture(t, { control: {} });
  await f.folder("hello", toolFolder("hello", "late-1"));
  const sessionId = await agentLoads(f, ["hello"]);
  // 续跑读 view 时停住：这时运行已登记、输入还没写下。
  const entered = deferred();
  const release = deferred();
  f.control.viewEntered = () => entered.resolve();
  f.control.viewGate = release.promise;
  await f.answer(true);
  await f.outcome("hello");
  await entered.promise;
  // 停止要等读 view 这一步结束：先发出停止，再放行。
  const aborting = f.client.call("session.abort", { sessionId });
  await f.client.call("space.list", {});
  f.control.viewEntered = undefined;
  f.control.viewGate = undefined;
  release.resolve();
  await aborting;
  const shown = await f.events.when(event => event.sessionId === sessionId && event.type === "pluginResult");
  assert.equal(shown.runId, undefined);
  const entries = await results(f, sessionId);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0]?.data, shown.data);
});

const permissions = process.platform === "win32" || process.getuid?.() === 0 ? "目录权限位在这个环境里不限制访问" : false;

test("记录在改名之前写入失败：这一项没有生效、记录未改，原来的集合照常运行", { skip: permissions }, async t => {
  const f = await fixture(t, { control: {} });
  await f.folder("hello", toolFolder("hello", "write-before"));
  const entered = deferred();
  const release = deferred();
  f.control.closeEntered = () => entered.resolve();
  f.control.closeGate = release.promise;
  const { requestId } = await f.client.call("plugin.load", { ids: ["hello"] });
  await f.answer(true);
  await entered.promise;
  // 旧实例正在关闭：此时让 .repa 不能新建文件，写记录的临时文件建不出来。
  await chmod(f.dataDir, 0o500);
  f.control.closeGate = undefined;
  f.control.closeEntered = undefined;
  release.resolve();
  let outcome;
  try {
    outcome = await f.outcome("hello", requestId);
  } finally {
    await chmod(f.dataDir, 0o700);
  }
  assert.deepEqual({ recorded: outcome.recorded, application: outcome.application, code: outcome.reason?.code }, { recorded: false, application: "failed", code: "record_write_failed" });
  await assert.rejects(readFile(path.join(f.dataDir, "plugins.json")), { code: "ENOENT" });
  assert.equal(counts().opens["write-before"], undefined);
  assert.equal((await f.client.call("plugin.list", {})).find(plugin => plugin.id === "control")?.state, "running");
});

test("记录在改名之后写入失败：照装配读到的新记录运行、结局为生效，这一次不清理快照", { skip: permissions }, async t => {
  const f = await fixture(t, { control: {} });
  await f.folder("hello", toolFolder("hello", "write-after"));
  // 记录之外的一个版本：清理时应当删掉它，持久化未确认时留着。
  const stale = path.join(snapshotGroup(f.home, f.root), "hello", "e".repeat(64));
  await mkdir(stale, { recursive: true });
  const entered = deferred();
  const release = deferred();
  f.control.closeEntered = () => entered.resolve();
  f.control.closeGate = release.promise;
  const { requestId } = await f.client.call("plugin.load", { ids: ["hello"] });
  await f.answer(true);
  await entered.promise;
  // 能建文件、能改名，但不能打开目录同步：失败发生在改名之后。
  await chmod(f.dataDir, 0o300);
  f.control.closeGate = undefined;
  f.control.closeEntered = undefined;
  release.resolve();
  let outcome;
  try {
    outcome = await f.outcome("hello", requestId);
  } finally {
    await chmod(f.dataDir, 0o700);
  }
  assert.deepEqual({ recorded: outcome.recorded, application: outcome.application, code: outcome.reason?.code }, { recorded: true, application: "applied", code: undefined });
  assert.ok((await stat(stale)).isDirectory());
  assert.equal(counts().opens["write-after"], 1);
  // 下一次正常的重组照常清理。
  await f.server.reassemble();
  await assert.rejects(stat(stale), { code: "ENOENT" });
  assert.equal(await checkSnapshot(f.home, f.root, "hello", (await readEnablement(f.dataDir)).plugins.hello?.digest ?? ""), "ok");
});

test("插件的 open 抛出不能转成文字的值、close 抛错：只停这个插件，重组照常完成，原因写进结果交回会话", async t => {
  const f = await fixture(t);
  await f.folder("hello", toolFolder("hello", "odd-1", { close: "throw" }));
  await f.client.call("plugin.load", { ids: ["hello"] });
  await f.answer(true);
  await f.outcome("hello");
  await f.folder("hello", toolFolder("hello", "odd-2", { open: "opaque" }));
  const mark = f.lists.seen.length;
  const sessionId = await agentLoads(f, ["hello"]);
  await f.answer(true);
  const outcome = await f.outcome("hello", undefined, mark);
  assert.equal(outcome.application, "failed");
  assert.equal(outcome.reason?.message, "插件抛出了无法转成文字的值");
  const shown = await f.events.when(event => event.sessionId === sessionId && event.type === "pluginResult");
  assert.match(shown.text ?? "", /旧实例 close\(\) 报错：定时器还没收回/);
  assert.match(shown.text ?? "", /加载 hello：没有生效/);
  const data = record(shown.data);
  assert.deepEqual(data?.closeFailures, [{ pluginId: "hello", message: "定时器还没收回" }]);
  assert.deepEqual(data?.items, [{ id: "hello", action: "load", outcome: { recorded: true, application: "failed", reason: outcome.reason } }]);
  assert.equal((await f.client.call("plugin.list", {})).find(plugin => plugin.id === "control")?.state, "running");
  assert.equal(snapshotDirectory(f.home, f.root, "hello", (await readEnablement(f.dataDir)).plugins.hello?.digest ?? "").length > 0, true);
});

/** 先到的是批准还是结局：只等其中一个时，另一个先到就会一直等下去，所以两者一起等。 */
async function askedFirst(f: Fixture, id: string, from = 0): Promise<"asked" | "settled"> {
  return Promise.race([
    f.confirmations.when(item => item.request.kind === "plugin", from).then(() => "asked" as const),
    f.outcome(id, undefined, f.lists.seen.length).then(() => "settled" as const),
  ]);
}

test("完全访问模式下，提出加载的运行被使用者停止：照常询问，不经批准不运行", async t => {
  const f = await fixture(t);
  await f.client.call("settings.set", { commandPolicy: "fullAccess" });
  await f.folder("hello", toolFolder("hello", "full-abort"));
  const answered = deferred();
  f.script([
    fauxAssistantMessage(fauxToolCall("plugin", { action: "load", ids: ["hello"] })),
    async () => { await answered.promise; return fauxAssistantMessage("被停止了"); },
  ]);
  const session = await f.client.call("session.create", {});
  const sending = f.client.call("session.send", { sessionId: session.id, text: "加载" });
  await f.events.when(event => event.type === "toolEnd" && event.tool === "plugin");
  const aborting = f.client.call("session.abort", { sessionId: session.id });
  await f.client.call("space.list", {});
  answered.resolve();
  await aborting;
  await sending.catch(() => undefined);
  assert.equal(await askedFirst(f, "hello"), "asked");
  await f.answer(false);
  assert.equal((await f.outcome("hello")).application, "denied");
  assert.equal(counts().opens["full-abort"], undefined);
});

test("请求提出时不是完全访问模式、处理时才是：照常询问", async t => {
  const f = await fixture(t);
  await f.folder("first", toolFolder("first", "late-full-a"));
  await f.folder("second", toolFolder("second", "late-full-b"));
  const first = await f.client.call("plugin.load", { ids: ["first"] });
  await f.confirmations.when(item => item.request.kind === "plugin");
  // 第一批停在批准上；Agent 在询问模式下提出的第二批排在后面。
  await agentLoads(f, ["second"], [fauxAssistantMessage("好")]);
  await f.client.call("settings.set", { commandPolicy: "fullAccess" });
  const from = f.confirmations.seen.length;
  await f.answer(true);
  assert.equal((await f.outcome("first", first.requestId)).application, "applied");
  assert.equal(await askedFirst(f, "second", from), "asked");
  await f.answer(true);
  assert.equal((await f.outcome("second")).application, "applied");
});

test("插件文件夹或它的上级是符号链接：以 invalid_plugin_folder 失败，不询问，不运行；列表里文件夹状态为读不了", async t => {
  const f = await fixture(t);
  const outside = path.join(f.directory, "outside");
  for (const [relative, text] of Object.entries(toolFolder("evil", "link-evil"))) {
    await mkdir(path.dirname(path.join(outside, "evil", relative)), { recursive: true });
    await writeFile(path.join(outside, "evil", relative), text);
  }
  const plugins = path.join(f.root, ".agents", "plugins");
  await mkdir(plugins, { recursive: true });
  await symlink(path.join(outside, "evil"), path.join(plugins, "evil"), "junction");
  const direct = await f.client.call("plugin.load", { ids: ["evil"] });
  assert.equal(await askedFirst(f, "evil"), "settled");
  const failed = await f.outcome("evil", direct.requestId);
  assert.deepEqual({ application: failed.application, code: failed.reason?.code }, { application: "failed", code: "invalid_plugin_folder" });

  // 上一层 .agents/plugins 是链接时同样拒绝。
  await rm(plugins, { recursive: true });
  await symlink(outside, plugins, "junction");
  const above = await f.client.call("plugin.load", { ids: ["evil"] });
  assert.equal(await askedFirst(f, "evil"), "settled");
  assert.equal((await f.outcome("evil", above.requestId)).reason?.code, "invalid_plugin_folder");
  assert.equal(f.confirmations.seen.length, 0);
  assert.equal(counts().opens["link-evil"], undefined);
  await assert.rejects(readFile(path.join(f.dataDir, "plugins.json")), { code: "ENOENT" });
});

test("记录里的插件的文件夹换成符号链接：列表里文件夹状态为读不了", async t => {
  const f = await fixture(t);
  await f.folder("hello", toolFolder("hello", "link-listed"));
  await f.client.call("plugin.load", { ids: ["hello"] });
  await f.answer(true);
  await f.outcome("hello");
  const folder = path.join(f.root, ".agents", "plugins", "hello");
  const moved = path.join(f.directory, "moved-hello");
  await rename(folder, moved);
  await symlink(moved, folder, "junction");
  assert.equal((await f.client.call("plugin.list", {})).find(plugin => plugin.id === "hello")?.folder, "unreadable");
});

test("拒绝批准时，同批里没有展示给使用者的卸载以取消结束，不算被拒绝；插件照常运行", async t => {
  const f = await fixture(t);
  await f.folder("hello", toolFolder("hello", "batch-hello"));
  await f.client.call("plugin.load", { ids: ["hello"] });
  await f.answer(true);
  await f.outcome("hello");
  await f.folder("world", toolFolder("world", "batch-world"));
  f.script([
    fauxAssistantMessage(fauxToolCall("plugin", { action: "load", ids: ["world"] })),
    fauxAssistantMessage(fauxToolCall("plugin", { action: "unload", ids: ["hello"] })),
    fauxAssistantMessage("等批准"),
  ]);
  const mark = f.lists.seen.length;
  const session = await f.client.call("session.create", {});
  await f.client.call("session.send", { sessionId: session.id, text: "换插件" });
  const shown = await f.answer(false);
  assert.deepEqual(shown.plugins?.map(item => item.id), ["world"]);
  const world = await f.outcome("world", undefined, mark);
  assert.equal(world.application, "denied");
  const hello = await f.outcome("hello", world.requestId);
  assert.deepEqual({ application: hello.application, code: hello.reason?.code }, { application: "cancelled", code: "plugin_batch_denied" });
  assert.equal((await f.client.call("plugin.list", {})).find(plugin => plugin.id === "hello")?.state, "running");
});

test("续跑：请求提出之前排进来的使用者消息在提出请求的运行之后运行，结果只追加为条目", async t => {
  const f = await fixture(t);
  await f.folder("hello", toolFolder("hello", "queued-1"));
  const gate = deferred();
  const entered = deferred();
  f.script([
    async () => { entered.resolve(); await gate.promise; return fauxAssistantMessage(fauxToolCall("plugin", { action: "load", ids: ["hello"] })); },
    fauxAssistantMessage("等它生效"),
    fauxAssistantMessage("天气不错"),
    fauxAssistantMessage("不该续跑"),
  ]);
  const session = await f.client.call("session.create", {});
  const first = f.client.call("session.send", { sessionId: session.id, text: "写插件并加载" });
  await entered.promise;
  // 这次运行还没提出请求，使用者又发了一条消息，排在这次运行之后。
  const second = f.client.call("session.send", { sessionId: session.id, text: "顺便说说天气" });
  await f.client.call("space.list", {});
  gate.resolve();
  await first;
  await second;
  await f.answer(true);
  assert.equal((await f.outcome("hello")).application, "applied");
  const shown = await f.events.when(event => event.sessionId === session.id && event.type === "pluginResult");
  assert.equal(shown.runId, undefined);
  assert.equal(f.faux.getPendingResponseCount(), 1);
});

test("续跑：提出请求的运行以错误结束，期间没有介入，也不续跑", async t => {
  const f = await fixture(t);
  await f.folder("hello", toolFolder("hello", "failed-run-1"));
  f.script([
    fauxAssistantMessage(fauxToolCall("plugin", { action: "load", ids: ["hello"] })),
    fauxAssistantMessage("坏了", { stopReason: "error", errorMessage: "模型出错" }),
    fauxAssistantMessage("不该续跑"),
  ]);
  const session = await f.client.call("session.create", {});
  await f.client.call("session.send", { sessionId: session.id, text: "加载" }).catch(() => undefined);
  await f.answer(true);
  assert.equal((await f.outcome("hello")).application, "applied");
  const shown = await f.events.when(event => event.sessionId === session.id && event.type === "pluginResult");
  assert.equal(shown.runId, undefined);
  assert.equal(f.faux.getPendingResponseCount(), 1);
});

test("续跑：等待批准期间分支或压缩会话，结果只追加为条目", async t => {
  for (const intervention of ["fork", "compact"] as const) {
    await t.test(intervention, async t => {
      const f = await fixture(t);
      await f.folder("hello", toolFolder("hello", `${intervention}-1`));
      const sessionId = await agentLoads(f, ["hello"], [fauxAssistantMessage("摘要"), fauxAssistantMessage("不该续跑")]);
      await f.confirmations.when(item => item.request.kind === "plugin");
      if (intervention === "fork") {
        const entry = (await f.client.call("session.history", { sessionId })).find(item => item.type === "user");
        assert.ok(entry);
        await f.client.call("session.fork", { sessionId, entryId: entry.id });
      } else {
        // 这套替身模型下压缩本身可能失败；介入在请求到达时就已登记。
        await f.client.call("session.compact", { sessionId }).catch(() => undefined);
      }
      await f.answer(true);
      assert.equal((await f.outcome("hello")).application, "applied");
      const shown = await f.events.when(event => event.sessionId === sessionId && event.type === "pluginResult");
      assert.equal(shown.runId, undefined);
    });
  }
});

test("等待批准时关闭空间：正在处理的与排队的批次都以 space_changed 结束，不说成撤回；重新打开以后新请求照常生效", async t => {
  const f = await fixture(t);
  await f.folder("hello", toolFolder("hello", "close-approve"));
  await f.folder("beta", toolFolder("beta", "close-approve-b"));
  const first = await f.client.call("plugin.load", { ids: ["hello"] });
  const queued = await f.client.call("plugin.load", { ids: ["beta"] });
  await f.confirmations.when(item => item.request.kind === "plugin");
  await f.client.call("space.close", {});
  const reopened = await f.client.call("space.open", { root: f.root });
  const requestOf = (id: string) => reopened.plugins.find(plugin => plugin.id === id)?.request;
  const hello = requestOf("hello");
  const beta = requestOf("beta");
  assert.ok(hello !== undefined && "outcome" in hello && hello.id === first.requestId);
  assert.ok(beta !== undefined && "outcome" in beta && beta.id === queued.requestId);
  assert.deepEqual([hello.outcome.application, hello.outcome.reason?.code], ["cancelled", "space_changed"]);
  assert.deepEqual([beta.outcome.application, beta.outcome.reason?.code], ["cancelled", "space_changed"]);
  const from = f.confirmations.seen.length;
  const again = await f.client.call("plugin.load", { ids: ["hello"] });
  const asked = await f.confirmations.when(item => item.request.kind === "plugin", from);
  await asked.client.call("confirm.reply", { id: asked.id, value: true });
  assert.equal((await f.outcome("hello", again.requestId)).application, "applied");
});

test("Agent 加载的插件有语法错误：错误交回给 Agent 并续跑，没有重组，原来的版本照常运行；改正后再次加载成功", async t => {
  const f = await fixture(t);
  await f.folder("hello", toolFolder("hello", "loop-1"));
  const first = await f.client.call("plugin.load", { ids: ["hello"] });
  await f.answer(true);
  assert.equal((await f.outcome("hello", first.requestId)).application, "applied");
  await f.folder("hello", toolFolder("hello", "loop-2", { broken: true }));
  const mark = f.lists.seen.length;
  const sessionId = await agentLoads(f, ["hello"], [
    // 续跑：模型读到错误，改好文件夹，再次提出加载。
    async () => {
      await f.folder("hello", toolFolder("hello", "loop-3", { reply: "改好了" }));
      return fauxAssistantMessage(fauxToolCall("plugin", { action: "load", ids: ["hello"] }));
    },
    fauxAssistantMessage("改好了，再加载一次"),
    fauxAssistantMessage(fauxToolCall("hello_greet", {})),
    fauxAssistantMessage("新版本回答了"),
  ]);
  await f.answer(true);
  const failed = await f.outcome("hello", undefined, mark);
  assert.deepEqual([failed.recorded, failed.application, failed.reason?.code], [false, "failed", "plugin_import_failed"]);
  const shown = await f.events.when(event => event.sessionId === sessionId && event.type === "pluginResult");
  assert.ok(shown.runId !== undefined, "错误交回以后续跑");
  assert.match(shown.text ?? "", /语法错误/);
  assert.deepEqual(shown.data, { requestId: failed.requestId, items: [{ id: "hello", action: "load", outcome: { recorded: false, application: "failed", reason: failed.reason } }], closeFailures: [] });
  // 交回不经过重组：旧实例没有关闭过。
  assert.equal(counts().closes["loop-1"], undefined);
  const again = f.lists.seen.length;
  await f.answer(true);
  const fixed = await f.outcome("hello", undefined, again);
  assert.equal(fixed.application, "applied");
  const second = await f.events.when(event => event.sessionId === sessionId && event.type === "pluginResult" && record(event.data)?.requestId === fixed.requestId);
  await f.events.when(event => event.type === "runEnd" && event.runId === second.runId);
  const history = await f.client.call("session.history", { sessionId });
  assert.equal(history.filter(entry => entry.type === "pluginResult").length, 2);
  assert.equal(history.findLast(entry => entry.type === "tool")?.text, "改好了");
  assert.equal(counts().evaluated["loop-2"], undefined);
});

test("Agent 的请求等待批准时撤回：结果追加进会话，不续跑；等待批准时关闭空间：不交回", async t => {
  const f = await fixture(t);
  await f.folder("hello", toolFolder("hello", "withdraw-agent"));
  const sessionId = await agentLoads(f, ["hello"], [fauxAssistantMessage("不该续跑")]);
  await f.confirmations.when(item => item.request.kind === "plugin");
  const pending = (await f.client.call("plugin.list", {})).find(plugin => plugin.id === "hello")?.request;
  assert.ok(pending !== undefined);
  await f.client.call("plugin.cancel", { requestId: pending.id });
  const withdrawn = await f.outcome("hello", pending.id);
  assert.equal(withdrawn.reason?.code, "plugin_request_cancelled");
  const shown = await f.events.when(event => event.sessionId === sessionId && event.type === "pluginResult");
  assert.equal(shown.runId, undefined);
  assert.deepEqual(record(shown.data)?.items, [{ id: "hello", action: "load", outcome: { recorded: false, application: "cancelled", reason: withdrawn.reason } }]);
  assert.equal(f.faux.getPendingResponseCount(), 1);

  const from = f.confirmations.seen.length;
  const closed = await agentLoads(f, ["hello"]);
  await f.confirmations.when(item => item.request.kind === "plugin", from);
  await f.client.call("space.close", {});
  await f.client.call("space.open", { root: f.root });
  assert.deepEqual(await results(f, closed), []);
  assert.ok(!f.events.seen.some(event => event.sessionId === closed && event.type === "pluginResult"));
});

test("同一批里一项准备失败、一项经过重组：结果合成一条，在重组里交回一次", async t => {
  const f = await fixture(t);
  await f.folder("hello", toolFolder("hello", "mixed-1"));
  const sessionId = await agentLoads(f, ["hello", "absent"], [fauxAssistantMessage("好")]);
  const shownRequest = await f.answer(true);
  assert.deepEqual(shownRequest.plugins?.map(item => item.id), ["hello"]);
  const shown = await f.events.when(event => event.sessionId === sessionId && event.type === "pluginResult");
  assert.ok(shown.runId !== undefined);
  await f.events.when(event => event.type === "runEnd" && event.runId === shown.runId);
  const items = record(shown.data)?.items;
  assert.ok(Array.isArray(items));
  assert.deepEqual(items.map(item => [record(item)?.id, record(record(item)?.outcome)?.application, record(record(record(item)?.outcome)?.reason)?.code]), [["hello", "applied", undefined], ["absent", "failed", "plugin_folder_missing"]]);
  assert.equal((await results(f, sessionId)).length, 1);
});

test("发布快照或读取入口期间撤回、关闭空间：获批的模块不再导入，顶层代码一次也没有执行", async t => {
  for (const [where, how] of [["publish", "cancel"], ["publish", "close"], ["entry", "cancel"]] as const) {
    await t.test(`${where}：${how}`, async t => {
      const f = await fixture(t);
      const label = `edge-${where}-${how}`;
      await f.folder("hello", toolFolder("hello", label));
      await f.folder("other", toolFolder("other", `${label}-other`));
      const group = path.join(snapshotGroup(f.home, f.root), "hello");
      const entered = deferred();
      const release = deferred();
      let armed = true;
      // 屏障：发布时的改名，或导入之前读快照里的清单。
      intercept(t, where === "publish" ? "rename" : "readFile", async (target, original, args) => {
        const hit = where === "publish" ? path.dirname(String(args[1])) === group : target.startsWith(`${group}${path.sep}`) && target.endsWith("repa-plugin.json");
        if (armed && hit) {
          armed = false;
          entered.resolve();
          await release.promise;
        }
        return original(...args);
      });
      const { requestId } = await f.client.call("plugin.load", { ids: ["hello"] });
      await f.answer(true);
      await entered.promise;
      if (how === "cancel") await f.client.call("plugin.cancel", { requestId });
      else await f.client.call("space.close", {});
      release.resolve();
      if (how === "cancel") {
        assert.equal((await f.outcome("hello", requestId)).reason?.code, "plugin_request_cancelled");
      } else {
        // 队列先进先出：重新打开以后的下一批开始询问时，前一批已经结束。
        await f.client.call("space.open", { root: f.root });
        const from = f.confirmations.seen.length;
        await f.client.call("plugin.load", { ids: ["other"] });
        await f.confirmations.when(item => item.request.kind === "plugin", from);
        const request = (await f.client.call("plugin.list", {})).find(plugin => plugin.id === "hello")?.request;
        assert.ok(request !== undefined && "outcome" in request && request.id === requestId);
        assert.equal(request.outcome.reason?.code, "space_changed");
      }
      assert.equal(counts().evaluated[label], undefined);
      assert.equal(counts().opens[label], undefined);
    });
  }
});

/** 把以装卸结果为输入的提示拦下（Pi 的输入钩子返回 handled）：运行写下了运行记录，却不写下这条用户消息就结束。 */
function swallowResults(before?: () => Promise<void>): ExtensionFactory {
  return pi => {
    pi.on("input", async event => {
      if (!event.text.startsWith("插件装卸请求")) return undefined;
      await before?.();
      return { action: "handled" as const };
    });
  };
}

test("续跑写下了运行记录、还没写下结果消息就结束：结果追加为条目，只有一份", async t => {
  const f = await fixture(t, { extensions: [swallowResults()] });
  await f.folder("hello", toolFolder("hello", "window-1"));
  const sessionId = await agentLoads(f, ["hello"]);
  await f.answer(true);
  const done = await f.outcome("hello");
  assert.equal(done.application, "applied");
  const shown = await f.events.when(event => event.sessionId === sessionId && event.type === "pluginResult");
  assert.equal(shown.runId, undefined, "追加的条目，不是运行的输入");
  const history = await f.client.call("session.history", { sessionId });
  assert.ok(history.some(entry => entry.type === "run" && record(record(entry.data)?.pluginResult)?.requestId === done.requestId), "续跑写下了运行记录");
  const entries = history.filter(entry => entry.type === "pluginResult");
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0]?.data, shown.data);
});

test("续跑没写下输入、追加结果又写不进会话文件：报告交回失败，运行照常收尾，此后的消息、停止、装卸与关闭空间都能结束", { skip: permissions }, async t => {
  let sessionFile = "";
  const f = await fixture(t, { extensions: [swallowResults(() => chmod(sessionFile, 0o400))] });
  await f.folder("hello", toolFolder("hello", "unsaved-1"));
  const sessionId = await agentLoads(f, ["hello"], [fauxAssistantMessage("下一条的回复")]);
  const sessions = path.join(f.dataDir, "sessions");
  const name = (await readdir(sessions)).find(file => file.includes(sessionId));
  assert.ok(name !== undefined);
  sessionFile = path.join(sessions, name);
  t.after(() => chmod(sessionFile, 0o600).catch(() => undefined));
  await f.answer(true);
  assert.equal((await f.outcome("hello")).application, "applied");
  const reported = await f.events.when(event => event.sessionId === sessionId && event.type === "error");
  assert.equal(record(reported.data)?.code, "plugin_result_undelivered");
  await chmod(sessionFile, 0o600);
  await f.client.call("session.send", { sessionId, text: "下一条" });
  await f.client.call("session.abort", { sessionId });
  const next = await f.client.call("plugin.unload", { ids: ["hello"] });
  assert.equal((await f.outcome("hello", next.requestId)).application, "applied");
  await f.client.call("space.close", {});
});

test("续跑：模型生成时追问排进 Pi 的队列，请求之后才在同一次运行里取出，结果只追加为条目", async t => {
  const f = await fixture(t);
  await f.folder("hello", toolFolder("hello", "pi-queue-1"));
  const gate = deferred();
  const entered = deferred();
  f.script([
    async () => { entered.resolve(); await gate.promise; return fauxAssistantMessage(fauxToolCall("plugin", { action: "load", ids: ["hello"] })); },
    fauxAssistantMessage("等它生效"),
    fauxAssistantMessage("另一件事是这样"),
    fauxAssistantMessage("不该续跑"),
  ]);
  const session = await f.client.call("session.create", {});
  const first = f.client.call("session.send", { sessionId: session.id, text: "写插件并加载" });
  await entered.promise;
  await f.client.call("session.followUp", { sessionId: session.id, text: "先说说另一件事" });
  gate.resolve();
  await first;
  // 追问在同一次运行里被取出，没有开始新的运行。
  assert.equal(f.events.seen.filter(event => event.sessionId === session.id && event.type === "runStart").length, 1);
  await f.answer(true);
  assert.equal((await f.outcome("hello")).application, "applied");
  const shown = await f.events.when(event => event.sessionId === session.id && event.type === "pluginResult");
  assert.equal(shown.runId, undefined);
  assert.equal(f.faux.getPendingResponseCount(), 1);
});

test("续跑：等待批准期间或闸门落下期间换了模型，结果只追加为条目", async t => {
  for (const when of ["approving", "gate"] as const) {
    await t.test(when, async t => {
      const f = await fixture(t, { control: {} });
      await f.folder("hello", toolFolder("hello", `model-${when}`));
      const sessionId = await agentLoads(f, ["hello"], [fauxAssistantMessage("不该续跑")]);
      const model = { provider: f.faux.getModel().provider, id: "scripted" };
      if (when === "approving") {
        await f.confirmations.when(item => item.request.kind === "plugin");
        await f.client.call("session.setModel", { sessionId, model });
        await f.answer(true);
      } else {
        const entered = deferred();
        const release = deferred();
        f.control.closeEntered = () => entered.resolve();
        f.control.closeGate = release.promise;
        await f.answer(true);
        await entered.promise;
        const changing = f.client.call("session.setModel", { sessionId, model });
        await f.client.call("space.list", {});
        f.control.closeEntered = undefined;
        f.control.closeGate = undefined;
        release.resolve();
        await changing;
      }
      assert.equal((await f.outcome("hello")).application, "applied");
      const shown = await f.events.when(event => event.sessionId === sessionId && event.type === "pluginResult");
      assert.equal(shown.runId, undefined);
      assert.equal(f.faux.getPendingResponseCount(), 1);
    });
  }
});

test("启用记录读不了、源文件夹也不在了：列表里仍有正在运行的自写插件，只缺取自记录的字段", async t => {
  const f = await fixture(t);
  await f.folder("hello", toolFolder("hello", "list-unreadable"));
  await f.client.call("plugin.load", { ids: ["hello"] });
  await f.answer(true);
  await f.outcome("hello");
  await rm(path.join(f.root, ".agents", "plugins", "hello"), { recursive: true });
  await writeFile(path.join(f.dataDir, "plugins.json"), "{坏了");
  const listed = (await f.client.call("plugin.list", {})).find(plugin => plugin.id === "hello");
  assert.deepEqual([listed?.state, listed?.tools, listed?.digest, listed?.folder], ["running", ["hello_greet"], undefined, undefined]);
});

test("准备在暂存以后失败：这一项没有生效，不询问，暂存副本在批次结束时删掉", async t => {
  const f = await fixture(t);
  await f.folder("hello", toolFolder("hello", "staged-1"));
  const staging = path.join(snapshotGroup(f.home, f.root), ".staging");
  // 读过暂存副本的清单以后，下一次打开暂存里的文件（列出改动时算各文件的摘要）读取出错。
  let armed = false;
  intercept(t, "readFile", async (target, original, args) => {
    if (target.startsWith(`${staging}${path.sep}`) && target.endsWith("repa-plugin.json")) armed = true;
    return original(...args);
  });
  intercept(t, "open", async (target, original, args) => {
    if (armed && target.startsWith(`${staging}${path.sep}`)) {
      armed = false;
      throw Object.assign(new Error("磁盘读取出错"), { code: "EIO" });
    }
    return original(...args);
  });
  const { requestId } = await f.client.call("plugin.load", { ids: ["hello"] });
  const failed = await f.outcome("hello", requestId);
  assert.equal(failed.application, "failed");
  assert.match(failed.reason?.message ?? "", /磁盘读取出错/);
  // 队列先进先出：下一批有了结局时，前一批已经收尾。
  const next = await f.client.call("plugin.unload", { ids: ["absent"] });
  await f.outcome("absent", next.requestId);
  assert.equal(f.confirmations.seen.length, 0);
  assert.deepEqual(await readdir(staging), []);
});

test("装配时启用记录读不了：自写插件都不运行，这一项没有生效，recorded 为 false，原因写明读不了", async t => {
  const f = await fixture(t);
  await f.folder("hello", toolFolder("hello", "assembly-unreadable"));
  const file = path.join(f.dataDir, "plugins.json");
  // 记录写好以后，再读它都出错：装配读不了。
  let written = false;
  intercept(t, "rename", async (_target, original, args) => {
    const result = await original(...args);
    if (String(args[1]) === file) written = true;
    return result;
  });
  intercept(t, "readFile", async (target, original, args) => {
    if (written && target === file) throw Object.assign(new Error("读取出错"), { code: "EIO" });
    return original(...args);
  });
  const { requestId } = await f.client.call("plugin.load", { ids: ["hello"] });
  await f.answer(true);
  const outcome = await f.outcome("hello", requestId);
  assert.deepEqual({ recorded: outcome.recorded, application: outcome.application, code: outcome.reason?.code }, { recorded: false, application: "failed", code: "plugin_enablement_unreadable" });
  assert.equal(counts().opens["assembly-unreadable"], undefined);
});
