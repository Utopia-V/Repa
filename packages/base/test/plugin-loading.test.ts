import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import { createAgentRuntimeForTest } from "../src/agent/runtime.js";
import { RepaClient, RpcError } from "../src/client.js";
import type { Plugin } from "../src/plugin.js";
import { enablementFile, readEnablement } from "../src/plugins/enablement.js";
import { snapshotDirectory, snapshotGroup } from "../src/plugins/snapshots.js";
import type { Confirmation, PluginInfo, SessionEntry } from "../src/protocol.js";
import { startServer } from "../src/protocol/server.js";
import { createSpace } from "../src/space.js";
import { WriteGate } from "../src/space/gate.js";

// 插件代码经这个全局对象向测试报告生命周期，并等测试安排的屏障。每个测试换一个新的。
const HOOKS = Symbol.for("repa.plugin-loading-test");
interface Hooks {
  log: string[];
  /** 插件 close() 里等它返回。 */
  closing?: (id: string) => Promise<void>;
  /** 插件在模块顶层或 open 里经 stall 停住，等它返回；point 写明停在哪里。 */
  stall?: (point: string) => Promise<void>;
}
const globals = globalThis as unknown as Record<symbol, Hooks | undefined>;

const EMPTY = { type: "object", properties: {}, additionalProperties: false };

/**
 * 一个只用 JavaScript、不导入任何东西的插件文件夹：本进程在 tsx 下运行，导入 .js 不经 tsx 处理。
 * tag 写进工具结果和方法返回值，用来分辨运行的是哪一份。open 是 open(host) 函数体里在返回实例之前执行的代码，top 是模块顶层代码。
 */
function folder(id: string, tag: string, options: { open?: string; tools?: string; instance?: string; top?: string } = {}): Record<string, string> {
  const tool = `${id.replace(/-/g, "_")}_get`;
  return {
    "repa-plugin.json": JSON.stringify({ id, version: "0.1.0", baseVersion: "^0.1.0", entry: "index.js", title: `${id} 插件` }),
    "index.js": `const hooks = () => globalThis[Symbol.for("repa.plugin-loading-test")];
${options.top ?? ""}
export default {
  id: ${JSON.stringify(id)},
  async open(host) {
    hooks()?.log.push(${JSON.stringify(`open ${id} ${tag}`)});
    ${options.open ?? ""}
    return {
      instructions: () => ${JSON.stringify(`${id} 插件的说明（${tag}）`)},
      tools: () => [{ name: ${JSON.stringify(tool)}, description: "读插件版本", parameters: ${JSON.stringify(EMPTY)}, async execute() { return { text: ${JSON.stringify(`${id} ${tag}`)} }; } }${options.tools ?? ""}],
      methods: { tag: { parameters: ${JSON.stringify(EMPTY)}, async invoke() { return ${JSON.stringify(tag)}; } } },
      async close() {
        hooks()?.log.push(${JSON.stringify(`close ${id} ${tag}`)});
        await hooks()?.closing?.(${JSON.stringify(id)});
        hooks()?.log.push(${JSON.stringify(`closed ${id} ${tag}`)});
      },
      ${options.instance ?? ""}
    };
  },
};
`,
  };
}

function barrier(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function code(expected: string) {
  return (error: unknown) => {
    assert.ok(error instanceof RpcError, String(error));
    const data = error.data as { code?: string } | undefined;
    assert.equal(data?.code, expected, error.message);
    return true;
  };
}

/** 会话里的工具结果：工具名、是否出错和文字。 */
function toolResults(history: SessionEntry[]): { tool: unknown; isError: unknown; text: string }[] {
  return history.filter((entry) => entry.type === "tool").map((entry) => {
    const data = entry.data !== null && typeof entry.data === "object" ? entry.data : {};
    return { tool: "tool" in data ? data.tool : undefined, isError: "isError" in data ? data.isError : undefined, text: entry.text ?? "" };
  });
}

async function fixture(t: TestContext, options: { plugins?: Plugin[] } = {}) {
  const hooks: Hooks = { log: [] };
  globals[HOOKS] = hooks;
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-plugin-loading-")));
  const home = path.join(directory, "home");
  const root = path.join(directory, "space");
  const dataDir = path.join(root, ".repa");
  await (await createSpace(root, { watch: false })).close();
  await mkdir(path.join(home, "agent"), { recursive: true });
  const faux = fauxProvider({ api: `loading-${randomUUID()}`, provider: `loading-${randomUUID()}`, models: [{ id: "scripted", contextWindow: 16384, maxTokens: 256 }], tokensPerSecond: 0 });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(home, "agent", "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const runtime = await createAgentRuntimeForTest({
    agentDir: path.join(home, "agent"),
    modelRuntime,
    defaultModel: { provider: faux.getModel().provider, id: "scripted" },
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
  });
  const server = await startServer({ home, runtime, ...(options.plugins === undefined ? {} : { plugins: options.plugins }) });
  const client = await RepaClient.connect(server.connection);
  t.after(async () => {
    await client.close();
    await server.close();
    await chmod(dataDir, 0o755).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    if (globals[HOOKS] === hooks) globals[HOOKS] = undefined;
  });

  // 收到的批准请求；answer 决定怎样回答，默认同意。返回 undefined 时不回答，由测试自己答。
  const confirmations: Confirmation[] = [];
  const asked: { id: string; request: Confirmation }[] = [];
  let answer: (request: Confirmation) => boolean | null | undefined = () => true;
  let onAsked: (() => void) | undefined;
  client.on("confirm.request", ({ id, request }) => {
    confirmations.push(request);
    asked.push({ id, request });
    onAsked?.();
    const value = answer(request);
    if (value !== undefined) void client.call("confirm.reply", { id, value }).catch(() => undefined);
  });
  const updates: PluginInfo[][] = [];
  client.on("plugin.updated", ({ plugins }) => { updates.push(plugins); });
  const events: { pluginId: string; event: unknown }[] = [];
  const eventWaiters: { match: (event: unknown) => boolean; resolve: () => void }[] = [];
  client.on("plugin.event", (event) => {
    events.push(event);
    for (const waiter of [...eventWaiters]) {
      if (waiter.match(event.event)) {
        eventWaiters.splice(eventWaiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  });

  const opened = await client.call("space.open", { root });
  // plugin.call 带上的那一次空间打开；测试经 open 重新打开空间时随之更新。
  let opening = opened.opening;
  // 每次模型请求声明的工具。
  const requests: string[][] = [];
  const script = (...steps: (AssistantMessage | ((context: TranscriptContext) => AssistantMessage))[]) => {
    faux.setResponses(steps.map((step) => (context: TranscriptContext) => {
      requests.push(getCurrentTools(context.messages).map((tool) => tool.name));
      return typeof step === "function" ? step(context) : step;
    }));
  };
  const pluginFolder = (id: string) => path.join(root, ".agents", "plugins", id);
  /** 把插件文件夹写进空间的 .agents/plugins/<id>/，先清掉原有内容。 */
  const write = async (id: string, files: Record<string, string>) => {
    await rm(pluginFolder(id), { recursive: true, force: true });
    for (const [relative, text] of Object.entries(files)) {
      const file = path.join(pluginFolder(id), ...relative.split("/"));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
    }
  };
  const item = async (id: string) => (await client.call("plugin.list", {})).find((plugin) => plugin.id === id);
  return {
    hooks, home, root, dataDir, client, server, faux, opened, confirmations, asked, updates, events, requests, script, write, item, pluginFolder,
    set answer(value: (request: Confirmation) => boolean | null | undefined) { answer = value; },
    /** 下一次批准请求到来。 */
    nextAsk(): Promise<{ id: string; request: Confirmation }> {
      const count = asked.length;
      return new Promise((resolve) => {
        onAsked = () => { if (asked.length > count) { onAsked = undefined; resolve(asked[count]!); } };
      });
    },
    /** 下一个满足条件的插件事件。 */
    nextEvent(match: (event: unknown) => boolean): Promise<void> {
      return new Promise((resolve) => { eventWaiters.push({ match, resolve }); });
    },
    async record() {
      return readEnablement(dataDir);
    },
    /** 关闭空间再打开，以后的插件调用带上这一次打开。 */
    async reopen() {
      await client.call("space.close", {});
      const reopened = await client.call("space.open", { root });
      opening = reopened.opening;
      return reopened;
    },
    /** 调用插件方法，带上最近一次打开。 */
    call(pluginId: string, method: string, input: unknown = {}) {
      return client.call("plugin.call", { pluginId, method, input, opening });
    },
    /** 经插件列表加载，自动同意。 */
    async load(id: string, from?: "folder" | "recorded" | "previous") {
      return client.call("plugin.load", { id, ...(from === undefined ? {} : { from }) });
    },
    async session() {
      return client.call("session.create", {});
    },
    async send(sessionId: string, text: string) {
      await client.call("session.send", { sessionId, text });
      return toolResults(await client.call("session.history", { sessionId }));
    },
  };
}

/** Agent 用 write 工具写插件文件夹里的每个文件：一条回复里写完。 */
function writeCalls(root: string, id: string, files: Record<string, string>): AssistantMessage {
  return fauxAssistantMessage(Object.entries(files).map(([relative, content]) => fauxToolCall("write", { path: path.join(root, ".agents", "plugins", id, ...relative.split("/")), content })));
}

/**
 * 改已有的插件文件夹，再请求加载：在模型回复这一步直接改文件，代替 Agent 的编辑。
 * Pi 的 write 对没读过的已有文件先交回内容，不写入；这里要验证的是加载，不是编辑工具。
 */
function editThenLoad(root: string, id: string, files: Record<string, string>): () => AssistantMessage {
  return () => {
    const target = path.join(root, ".agents", "plugins", id);
    rmSync(target, { recursive: true, force: true });
    for (const [relative, text] of Object.entries(files)) {
      const file = path.join(target, ...relative.split("/"));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    return fauxAssistantMessage(fauxToolCall("plugin", { action: "load", id }));
  };
}

test("一次运行里写好插件、请求加载、使用者批准，下一次回复就能调用新工具；结果写明工具与说明，列表随之更新", async (t) => {
  const f = await fixture(t);
  const session = await f.session();
  f.script(
    writeCalls(f.root, "count", folder("count", "v1")),
    fauxAssistantMessage(fauxToolCall("plugin", { action: "load", id: "count" })),
    fauxAssistantMessage(fauxToolCall("count_get", {})),
    fauxAssistantMessage("完成"),
  );
  const results = await f.send(session.id, "做一个计数插件");

  // 批准请求发给发起运行的连接，展示的是这份内容：名字、版本、相对当前版本新增的文件。
  assert.equal(f.confirmations.length, 1);
  const approval = f.confirmations[0]?.plugin;
  assert.equal(f.confirmations[0]?.kind, "plugin");
  assert.deepEqual({ id: approval?.id, title: approval?.title, version: approval?.version, base: approval?.base, files: approval?.files }, {
    id: "count", title: "count 插件", version: "0.1.0", base: "none",
    files: [{ path: "index.js", change: "added" }, { path: "repa-plugin.json", change: "added" }],
  });
  const load = results.find((result) => result.tool === "plugin");
  assert.equal(load?.isError, false);
  assert.match(load?.text ?? "", /已生效/);
  assert.match(load?.text ?? "", /count_get/);
  assert.match(load?.text ?? "", /count 插件的说明（v1）/);
  // 加载那一步之前没有新工具，之后的下一次回复就有。
  assert.equal(f.requests[1]?.includes("count_get"), false);
  assert.equal(f.requests[2]?.includes("count_get"), true);
  assert.deepEqual(results.find((result) => result.tool === "count_get"), { tool: "count_get", isError: false, text: "count v1" });

  const record = await f.record();
  assert.equal(record.plugins.count?.enabled, true);
  assert.equal(record.plugins.count?.digest, approval?.digest);
  const item = await f.item("count");
  assert.deepEqual(item, {
    id: "count", source: "space", title: "count 插件", version: "0.1.0", state: "running", folder: "same",
    digest: approval?.digest, pages: [], methods: ["tag"], tools: ["count_get"],
  });
  assert.ok(f.updates.some((plugins) => plugins.some((plugin) => plugin.id === "count" && plugin.state === "running")));
  assert.equal(await f.call("count", "tag"), "v1");
});

test("新版本有语法错误：错误连同位置当场作为调用结果交回，不请求批准，原来的版本照常工作；改正以后同一次运行里再次加载成功", async (t) => {
  const f = await fixture(t);
  await f.write("count", folder("count", "v1"));
  const first = await f.load("count");
  const broken = folder("count", "v2");
  broken["index.js"] = `${broken["index.js"]}\nexport const = ;\n`;
  const line = broken["index.js"].split("\n").indexOf("export const = ;") + 1;
  const session = await f.session();
  f.script(
    editThenLoad(f.root, "count", broken),
    fauxAssistantMessage(fauxToolCall("count_get", {})),
    editThenLoad(f.root, "count", folder("count", "v2")),
    fauxAssistantMessage(fauxToolCall("count_get", {})),
    fauxAssistantMessage("完成"),
  );
  const results = (await f.send(session.id, "改计数插件")).filter((result) => result.tool === "plugin" || result.tool === "count_get");
  assert.equal(results.length, 4);
  assert.equal(results[0]?.isError, true);
  assert.match(results[0]?.text ?? "", /语法错误/);
  assert.ok(results[0]?.text.includes(`index.js:${line}`), results[0]?.text);
  // 只有第一次加载和改正以后的那一次请求了批准。
  assert.equal(f.confirmations.length, 2);
  assert.deepEqual(results[1], { tool: "count_get", isError: false, text: "count v1" });
  assert.equal(results[2]?.isError, false);
  assert.deepEqual(results[3], { tool: "count_get", isError: false, text: "count v2" });
  // 语法错误那一次没有改启用记录；成功的那一次把原来的版本记为上一次选定的版本。
  const record = await f.record();
  assert.equal(record.plugins.count?.previous, first.digest);
  assert.notEqual(record.plugins.count?.digest, first.digest);
  assert.deepEqual(f.hooks.log, ["open count v1", "close count v1", "closed count v1", "open count v2"]);
});

test("新版本的 open 抛错：插件转为失败并交回原因，重新打开空间仍是失败；让上一次选定的版本重新生效以后恢复工作", async (t) => {
  const f = await fixture(t);
  await f.write("count", folder("count", "v1"));
  const first = await f.load("count");
  await f.write("count", folder("count", "v2", { open: `throw new Error("v2 打不开");` }));
  await assert.rejects(f.load("count"), code("plugin_open_failed"));
  let item = await f.item("count");
  assert.equal(item?.state, "failed");
  assert.match(item?.reason?.message ?? "", /v2 打不开/);
  // 启用记录指向新版本，不自动退回。
  const record = await f.record();
  assert.notEqual(record.plugins.count?.digest, first.digest);
  assert.equal(record.plugins.count?.previous, first.digest);

  const reopened = await f.reopen();
  assert.equal(reopened.plugins.find((plugin) => plugin.id === "count")?.state, "failed");

  // 上一次选定的版本的快照还在，不必再批准。
  const asked = f.confirmations.length;
  const restored = await f.load("count", "previous");
  assert.equal(f.confirmations.length, asked);
  assert.equal(restored.state, "running");
  assert.equal(restored.digest, first.digest);
  assert.equal(await f.call("count", "tag"), "v1");
  item = await f.item("count");
  assert.equal(item?.previous, record.plugins.count?.digest);
});

test("请求批准以后再改插件文件夹：批准之前运行的仍是原来的版本，同意以后运行的是批准对话展示的那一份", async (t) => {
  const f = await fixture(t);
  await f.write("count", folder("count", "v1"));
  await f.load("count");
  await f.write("count", folder("count", "v2"));
  f.answer = () => undefined;
  const asked = f.nextAsk();
  const loading = f.load("count");
  const { id, request } = await asked;
  assert.deepEqual(request.plugin?.files, [{ path: "index.js", change: "modified" }]);
  assert.equal(await f.call("count", "tag"), "v1");
  await f.write("count", folder("count", "v3"));
  await f.client.call("confirm.reply", { id, value: true });
  const loaded = await loading;
  assert.equal(loaded.digest, request.plugin?.digest);
  assert.equal(loaded.folder, "modified");
  assert.equal(await f.call("count", "tag"), "v2");
});

test("拒绝、不作答、停止运行：调用以相应原因结束，启用记录、快照和运行的插件都没有改变", async (t) => {
  const f = await fixture(t);
  await f.write("count", folder("count", "v1"));
  const session = await f.session();
  const answers: (boolean | null)[] = [false, null];
  f.answer = () => answers.shift();
  f.script(
    fauxAssistantMessage(fauxToolCall("plugin", { action: "load", id: "count" })),
    fauxAssistantMessage(fauxToolCall("plugin", { action: "load", id: "count" })),
    fauxAssistantMessage("好的"),
  );
  const results = await f.send(session.id, "加载计数插件");
  assert.deepEqual(results.map((result) => result.isError), [true, true]);
  assert.match(results[0]?.text ?? "", /拒绝/);
  assert.match(results[1]?.text ?? "", /没有作出决定/);

  // 等批准时停止运行：等待随之结束。
  const asked = f.nextAsk();
  f.script(fauxAssistantMessage(fauxToolCall("plugin", { action: "load", id: "count" })), fauxAssistantMessage("不会到这里"));
  const sending = f.client.call("session.send", { sessionId: session.id, text: "再加载一次" }).catch(() => undefined);
  await asked;
  await f.client.call("session.abort", { sessionId: session.id });
  await sending;

  // 经插件列表的拒绝与不作答。
  const protocolAnswers: (boolean | null)[] = [false, null];
  f.answer = () => protocolAnswers.shift();
  await assert.rejects(f.load("count"), code("plugin_denied"));
  await assert.rejects(f.load("count"), code("plugin_not_decided"));

  assert.equal(f.confirmations.length, 5);
  await assert.rejects(stat(enablementFile(f.dataDir)), { code: "ENOENT" });
  await assert.rejects(stat(path.join(snapshotGroup(f.home, f.root), "count")), { code: "ENOENT" });
  // 暂存副本也已丢弃。
  assert.deepEqual(await readdir(path.join(snapshotGroup(f.home, f.root), ".staging")), []);
  assert.equal((await f.item("count"))?.state, "disabled");
  assert.deepEqual(f.hooks.log, []);
});

test("替换一个插件时，同一空间里别的插件没有关闭也没有重新打开，随包插件照常工作", async (t) => {
  let opens = 0;
  let closes = 0;
  const bundled: Plugin = {
    id: "learning",
    async open() {
      opens += 1;
      return { methods: { ping: { parameters: EMPTY, async invoke() { return "pong"; } } }, async close() { closes += 1; } };
    },
  };
  const f = await fixture(t, { plugins: [bundled] });
  await f.write("count", folder("count", "v1"));
  await f.write("other", folder("other", "v1"));
  await f.load("count");
  await f.load("other");
  await f.write("count", folder("count", "v2"));
  await f.load("count");
  assert.deepEqual([opens, closes], [1, 0]);
  assert.deepEqual(f.hooks.log, ["open count v1", "open other v1", "close count v1", "closed count v1", "open count v2"]);
  assert.equal(await f.call("learning", "ping"), "pong");
  // 随包插件不能作为自写插件加载或卸载。
  await assert.rejects(f.load("learning"), code("plugin_id_conflict"));
  await assert.rejects(f.client.call("plugin.unload", { id: "learning" }), code("plugin_id_conflict"));
});

test("替换时旧实例的 close() 返回以后新实例才打开：同一个插件不会有两个实例同时写数据目录", async (t) => {
  const f = await fixture(t);
  await f.write("count", folder("count", "v1"));
  await f.load("count");
  await f.write("count", folder("count", "v2"));
  const before = await readFile(enablementFile(f.dataDir), "utf8");
  // 旧实例 close() 返回之前，启用记录还是原来的。
  let duringClose: string | undefined;
  f.hooks.closing = async () => { duringClose = await readFile(enablementFile(f.dataDir), "utf8"); };
  assert.equal((await f.load("count")).state, "running");
  assert.equal(duringClose, before);
  assert.deepEqual(f.hooks.log, ["open count v1", "close count v1", "closed count v1", "open count v2"]);
});

test("Agent 加载的插件由定时器写空间文件，撤回加载它的那次运行：插件的写入还在，Agent 写的插件文件夹撤回了", async (t) => {
  const f = await fixture(t);
  const timer = `setTimeout(async () => { await host.files.write("from-plugin.txt", "插件写的"); host.emit({ type: "wrote" }); }, 0);`;
  const wrote = f.nextEvent((event) => event !== null && typeof event === "object" && "type" in event && event.type === "wrote");
  const session = await f.session();
  f.script(
    writeCalls(f.root, "count", folder("count", "v1", { open: timer })),
    fauxAssistantMessage(fauxToolCall("plugin", { action: "load", id: "count" })),
    fauxAssistantMessage("完成"),
  );
  await f.send(session.id, "做一个会写文件的插件");
  await wrote;
  const history = await f.client.call("session.history", { sessionId: session.id });
  const run = history.find((entry) => entry.type === "run");
  const runId = run?.data !== null && typeof run?.data === "object" && "runId" in run.data ? String(run.data.runId) : "";
  // 插件的写入记在插件自己名下，不在那次运行的名下。
  const revisions = await f.client.call("history.list", {});
  assert.ok(revisions.some((revision) => revision.source.kind === "plugin" && revision.source.pluginId === "count"), JSON.stringify(revisions.map((revision) => revision.source)));
  await f.client.call("history.undoRun", { runId });
  assert.equal(await readFile(path.join(f.root, "from-plugin.txt"), "utf8"), "插件写的");
  await assert.rejects(stat(path.join(f.pluginFolder("count"), "index.js")), { code: "ENOENT" });
  // 撤回的是编辑的地方；运行的是快照，插件照常运行。
  assert.equal((await f.item("count"))?.state, "running");
});

test("卸载：在途调用失败，工具从下一次回复起不再出现；文件夹、快照与数据目录都还在，再启用同一份内容不必批准", async (t) => {
  const f = await fixture(t);
  const waitTool = `, { name: "count_wait", description: "等", parameters: ${JSON.stringify(EMPTY)}, async execute() { host.emit({ type: "entered" }); await new Promise(() => undefined); return { text: "不会返回" }; } }`;
  await f.write("count", folder("count", "v1", { tools: waitTool }));
  const loaded = await f.load("count");
  const session = await f.session();
  f.script(
    fauxAssistantMessage(fauxToolCall("count_wait", {})),
    fauxAssistantMessage("完成"),
  );
  const entered = f.nextEvent((event) => event !== null && typeof event === "object" && "type" in event && event.type === "entered");
  const sending = f.send(session.id, "等一等");
  await entered;
  const unloaded = await f.client.call("plugin.unload", { id: "count" });
  assert.equal(unloaded.state, "disabled");
  const results = await sending;
  assert.equal(results[0]?.tool, "count_wait");
  assert.equal(results[0]?.isError, true);
  assert.equal(f.requests[1]?.includes("count_wait"), false);
  assert.equal(f.requests[1]?.includes("count_get"), false);
  assert.equal((await f.record()).plugins.count?.enabled, false);
  assert.ok((await stat(snapshotDirectory(f.home, f.root, "count", loaded.digest ?? ""))).isDirectory());
  assert.ok((await stat(f.pluginFolder("count"))).isDirectory());
  assert.ok((await stat(path.join(f.dataDir, "plugins", "count"))).isDirectory());

  // Agent 重新加载同一份内容，不再询问；再经 plugin 工具卸载。
  const asked = f.confirmations.length;
  f.script(
    fauxAssistantMessage(fauxToolCall("plugin", { action: "load", id: "count" })),
    fauxAssistantMessage(fauxToolCall("plugin", { action: "unload", id: "count" })),
    fauxAssistantMessage("完成"),
  );
  f.requests.length = 0;
  const again = (await f.send(session.id, "装上再卸载")).slice(-2);
  assert.deepEqual(again.map((result) => [result.tool, result.isError]), [["plugin", false], ["plugin", false]]);
  assert.equal(f.confirmations.length, asked);
  assert.equal(f.requests[1]?.includes("count_get"), true);
  assert.equal(f.requests[2]?.includes("count_get"), false);
  await assert.rejects(f.client.call("plugin.unload", { id: "count" }), code("plugin_not_enabled"));
});

test("重新打开空间按启用记录运行：卸载过的插件没有自己回来", async (t) => {
  const f = await fixture(t);
  await f.write("count", folder("count", "v1"));
  await f.write("other", folder("other", "v1"));
  await f.load("count");
  await f.load("other");
  await f.client.call("plugin.unload", { id: "other" });
  const reopened = await f.reopen();
  assert.deepEqual(reopened.plugins.map((plugin) => [plugin.id, plugin.state]), [["count", "running"], ["other", "disabled"]]);
  assert.deepEqual(f.hooks.log, ["open count v1", "open other v1", "close other v1", "closed other v1", "close count v1", "closed count v1", "open count v1"]);
});

test("完全访问模式下 Agent 提出的加载与使用者在插件列表里的加载都不问；改回询问以后列表里的加载照常请求批准", async (t) => {
  const f = await fixture(t);
  await f.client.call("settings.set", { commandPolicy: "fullAccess" });
  const session = await f.session();
  f.script(
    writeCalls(f.root, "count", folder("count", "v1")),
    fauxAssistantMessage(fauxToolCall("plugin", { action: "load", id: "count" })),
    fauxAssistantMessage(fauxToolCall("count_get", {})),
    fauxAssistantMessage("完成"),
  );
  const results = await f.send(session.id, "做一个计数插件");
  assert.deepEqual(results.find((result) => result.tool === "count_get"), { tool: "count_get", isError: false, text: "count v1" });
  assert.equal(f.confirmations.length, 0);
  await f.write("count", folder("count", "v2"));
  assert.equal((await f.load("count")).state, "running");
  assert.equal(f.confirmations.length, 0);
  assert.equal(await f.call("count", "tag"), "v2");
  await f.client.call("settings.set", { commandPolicy: "ask" });
  await f.write("count", folder("count", "v3"));
  await f.load("count");
  assert.equal(f.confirmations.length, 1);
});

test("子 Agent 提出加载：批准只发给发起运行的连接，子 Agent 的下一次回复就能调用新工具", async (t) => {
  const f = await fixture(t);
  await f.write("count", folder("count", "v1"));
  // 另一个连接发起运行；最初的连接也在线，它不应收到批准。
  const other = await RepaClient.connect(f.server.connection);
  t.after(() => other.close());
  const received: Confirmation[] = [];
  other.on("confirm.request", ({ id, request }) => {
    received.push(request);
    void other.call("confirm.reply", { id, value: true }).catch(() => undefined);
  });
  const session = await other.call("session.create", {});
  f.script(
    fauxAssistantMessage(fauxToolCall("subagent", { agent: "general", task: "加载计数插件并试用" })),
    fauxAssistantMessage(fauxToolCall("plugin", { action: "load", id: "count" })),
    fauxAssistantMessage(fauxToolCall("count_get", {})),
    fauxAssistantMessage("子 Agent 用上了"),
    fauxAssistantMessage("完成"),
  );
  await other.call("session.send", { sessionId: session.id, text: "让子 Agent 去做" });
  const results = toolResults(await other.call("session.history", { sessionId: session.id }));
  assert.equal(f.confirmations.length, 0);
  assert.deepEqual(received.map((request) => request.plugin?.id), ["count"]);
  assert.equal(f.requests[2]?.includes("count_get"), true);
  assert.match(results[0]?.text ?? "", /子 Agent 用上了/);
  assert.equal((await f.item("count"))?.state, "running");
});

test("写启用记录出错：调用返回错误，盘上仍是原来的记录；替换时插件显示为失败，重新打开空间按原来的记录运行", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async (t) => {
  const f = await fixture(t);
  await f.write("count", folder("count", "v1"));
  await f.load("count");
  const before = await readFile(enablementFile(f.dataDir), "utf8");
  await f.write("count", folder("count", "v2"));
  await chmod(f.dataDir, 0o555);
  await assert.rejects(f.load("count"), code("plugin_enablement_write_failed"));
  await chmod(f.dataDir, 0o755);
  assert.equal(await readFile(enablementFile(f.dataDir), "utf8"), before);
  const item = await f.item("count");
  assert.equal(item?.state, "failed");
  assert.equal(item?.reason?.code, "plugin_enablement_write_failed");
  await f.reopen();
  assert.equal(await f.call("count", "tag"), "v1");
});

test("加载前的检查不执行插件代码：文件夹不在、清单 id 与文件夹名不符时当场返回错误，什么都没有改变", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.load("count"), code("plugin_folder_missing"));
  const mismatched = folder("other", "v1");
  await f.write("count", mismatched);
  await assert.rejects(f.load("count"), code("plugin_id_mismatch"));
  assert.equal(f.confirmations.length, 0);
  assert.deepEqual(f.hooks.log, []);
  await assert.rejects(stat(enablementFile(f.dataDir)), { code: "ENOENT" });
});

test("批准之前查入口与它静态导入的模块的语法，不执行代码：语法错误连同文件与位置当场返回，不请求批准；没有语法错误时照常请求批准，同意以后才执行", async (t) => {
  const f = await fixture(t);
  // 入口的模块顶层写一个文件：检查若执行了代码，这个文件就会出现。
  const marker = path.join(f.root, "top-level-ran");
  // ext 是入口与 lib 模块的扩展名。本进程在 tsx 下运行，导入 .ts 会经 tsx 处理，所以 .ts 的一份只到批准为止。
  const files = (ext: "js" | "ts", lib: string): Record<string, string> => ({
    "repa-plugin.json": JSON.stringify({ id: "typed", version: "0.1.0", baseVersion: "^0.1.0", entry: `index.${ext}` }),
    [`index.${ext}`]: `import { writeFileSync } from "node:fs";
import { label } from "./lib.${ext}";
writeFileSync(${JSON.stringify(marker)}, "ran");
export default {
  id: "typed",
  async open() {
    return { methods: { label: { parameters: ${JSON.stringify(EMPTY)}, async invoke() { return label; } } } };
  },
};
`,
    [`lib.${ext}`]: lib,
    // 没有被导入的文件不在检查之列。
    "notes/draft.js": "this is not code (",
  });
  const staging = path.join(snapshotGroup(f.home, f.root), ".staging");

  await f.write("typed", files("ts", `const prefix: string = "typed";\nexport const label: string = prefix +;\n`));
  await assert.rejects(f.load("typed"), (error: unknown) => {
    code("plugin_import_failed")(error);
    assert.match((error as Error).message, /语法错误/);
    assert.ok((error as Error).message.includes("lib.ts:2"), (error as Error).message);
    return true;
  });
  assert.equal(f.confirmations.length, 0);
  assert.deepEqual(await readdir(staging), []);

  // 类型标注不算语法错误：照常请求批准。
  await f.write("typed", files("ts", `const prefix: string = "typed";\nexport const label: string = prefix + " ts";\n`));
  f.answer = () => false;
  await assert.rejects(f.load("typed"), code("plugin_denied"));
  assert.equal(f.confirmations.length, 1);

  await f.write("typed", files("js", `const prefix = "typed";\nexport const label = prefix + " js";\n`));
  f.answer = () => undefined;
  const asked = f.nextAsk();
  const loading = f.load("typed");
  const { id } = await asked;
  await assert.rejects(stat(marker), { code: "ENOENT" });
  await f.client.call("confirm.reply", { id, value: true });
  assert.equal((await loading).state, "running");
  assert.equal(await readFile(marker, "utf8"), "ran");
  assert.equal(await f.call("typed", "label"), "typed js");
});

test("工具声明写错时加载失败，错误说明写出是哪个工具、错在哪里、怎样改", async (t) => {
  const f = await fixture(t);
  await f.write("beta", folder("beta", "v1"));
  await f.load("beta");
  const tool = (fields: string) => `, { ${fields}, async execute() { return { text: "" }; } }`;
  const cases: [string, string, RegExp][] = [
    [tool(`name: "count-list", description: "列出", parameters: ${JSON.stringify(EMPTY)}`), "invalid_tool_name", /工具名 "count-list" 无效：要以字母开头，只含字母、数字和下划线/u],
    [tool(`name: "read", description: "读", parameters: ${JSON.stringify(EMPTY)}`), "tool_name_conflict", /工具名 read 是底座内置工具的名字/u],
    [tool(`name: "beta_get", description: "读", parameters: ${JSON.stringify(EMPTY)}`), "tool_name_conflict", /工具名 beta_get 已经是插件 beta 的工具/u],
    [tool(`name: "count_list", description: "列出"`), "invalid_tool", /工具 count_list 要有 description 文字、用 Type\.Object\(\{\.\.\.\}\) 声明的 parameters 和 execute 函数/u],
  ];
  for (const [tools, expected, message] of cases) {
    await f.write("count", folder("count", "v1", { tools }));
    await assert.rejects(f.load("count"), (error: unknown) => {
      code(expected)(error);
      assert.match(error instanceof Error ? error.message : "", message);
      return true;
    });
  }
  assert.equal((await f.item("beta"))?.state, "running");
});

test("批准以后暂存副本被改动：发布以后、导入之前的核对拦下它，插件代码不执行，启用记录不变", async (t) => {
  const f = await fixture(t);
  await f.write("count", folder("count", "v1"));
  f.answer = () => undefined;
  const asked = f.nextAsk();
  const loading = f.load("count");
  const { id } = await asked;
  // 批准对话展示的是暂存的这一份；在使用者同意之前把它换掉，模拟暂存目录被改写。
  const staging = path.join(snapshotGroup(f.home, f.root), ".staging");
  const [copy] = await readdir(staging);
  await writeFile(path.join(staging, copy ?? "", "index.js"), folder("count", "篡改")["index.js"] ?? "");
  await f.client.call("confirm.reply", { id, value: true });
  await assert.rejects(loading, code("snapshot_modified"));
  assert.deepEqual(f.hooks.log, []);
  await assert.rejects(stat(enablementFile(f.dataDir)), { code: "ENOENT" });
  assert.equal((await f.item("count"))?.state, "disabled");
  // 同一份内容再加载一次：被改动的快照换成新的副本，照常生效。
  f.answer = () => true;
  assert.equal((await f.load("count")).state, "running");
  assert.equal(await f.call("count", "tag"), "v1");
});

test("运行排队等写锁时经列表加载的插件在 open 里写空间：这次加载当场失败，不挡住那次运行里的加载", async (t) => {
  // 随包插件 holder 的写入持着共享锁，停在测试占住的同一文件写入队列里。
  const holder: Plugin = {
    id: "holder",
    async open(host) {
      return { methods: { hold: { parameters: EMPTY, async invoke() { await host.files.write("held.txt", "holder 写的"); return "ok"; } } } };
    },
  };
  const f = await fixture(t, { plugins: [holder] });
  await f.write("alpha", folder("alpha", "v1", { open: `await host.files.write("alpha.txt", "alpha 打开时写的");` }));
  await f.write("beta", folder("beta", "v1"));
  // 观察写锁：共享写入拿到锁、运行提出独占请求。
  const shared = barrier();
  const exclusive = barrier();
  const { shared: originalShared, exclusive: originalExclusive } = WriteGate.prototype;
  WriteGate.prototype.shared = function <T>(this: WriteGate, action: () => Promise<T>, wait?: Parameters<WriteGate["shared"]>[1]) {
    return originalShared.call(this, () => { shared.release(); return action(); }, wait) as Promise<T>;
  };
  WriteGate.prototype.exclusive = function <T>(this: WriteGate, action: () => Promise<T>, wait?: Parameters<WriteGate["exclusive"]>[1]) {
    exclusive.release();
    return originalExclusive.call(this, action, wait) as Promise<T>;
  };
  t.after(() => { Object.assign(WriteGate.prototype, { shared: originalShared, exclusive: originalExclusive }); });

  const held = barrier();
  t.after(() => { held.release(); });
  const queue = barrier();
  void withFileMutationQueue(path.join(f.root, "held.txt"), async () => { queue.release(); await held.promise; });
  await queue.promise;
  const holding = f.call("holder", "hold");
  await shared.promise;
  const session = await f.session();
  f.script(
    fauxAssistantMessage(fauxToolCall("plugin", { action: "load", id: "beta" })),
    fauxAssistantMessage(fauxToolCall("beta_get", {})),
    fauxAssistantMessage("完成"),
  );
  const sending = f.send(session.id, "加载 beta");
  await exclusive.promise;
  // 运行的独占请求排在 holder 的写入后面；alpha 的 open 若等写锁，就排到运行后面。
  await assert.rejects(f.load("alpha"), (error: unknown) => {
    code("space_busy")(error);
    // 写插件的模型要知道是 open() 里的写入碰上了运行，以及该挪到哪里。
    assert.match(error instanceof Error ? error.message : "", /插件 alpha 在打开期间写空间文件[^]*放进工具调用里/u);
    return true;
  });
  held.release();
  assert.equal(await holding, "ok");
  const results = await sending;
  assert.deepEqual(results.map((result) => [result.tool, result.isError]), [["plugin", false], ["beta_get", false]]);
  assert.equal((await f.item("alpha"))?.state, "failed");
  await assert.rejects(stat(path.join(f.root, "alpha.txt")), { code: "ENOENT" });
});

test("替换时旧实例的 close() 不返回：别的插件照常装卸；停止运行结束这次加载，插件显示为失败、启用记录不变，别的会话照常运行", async (t) => {
  const f = await fixture(t);
  await f.write("count", folder("count", "v1"));
  await f.write("other", folder("other", "v1"));
  await f.load("count");
  const before = (await f.record()).plugins.count;
  const entered = barrier();
  const stuck = barrier();
  f.hooks.closing = async (id) => {
    if (id !== "count") return;
    entered.release();
    await stuck.promise;
  };
  await f.write("count", folder("count", "v2"));
  const session = await f.session();
  f.script(fauxAssistantMessage(fauxToolCall("plugin", { action: "load", id: "count" })), fauxAssistantMessage("不会到这里"));
  const sending = f.client.call("session.send", { sessionId: session.id, text: "换成 v2" });
  await entered.promise;
  assert.equal((await f.load("other")).state, "running");
  await f.client.call("session.abort", { sessionId: session.id });
  await sending.catch(() => undefined);
  const item = await f.item("count");
  assert.equal(item?.state, "failed");
  assert.equal(item?.reason?.code, "plugin_load_stopped");
  assert.deepEqual((await f.record()).plugins.count, before);
  // 运行已经结束，空间写锁放开了：另一个会话照常运行。
  const second = await f.session();
  f.script(fauxAssistantMessage("好"));
  await f.send(second.id, "在吗");
  // close() 返回以后，这个插件可以再加载。
  stuck.release();
  assert.equal((await f.load("count")).state, "running");
  assert.equal(await f.call("count", "tag"), "v2");
});

test("卸载以后旧实例的 close() 不返回：Agent 再加载它时停止运行可以结束这次调用，别的会话照常运行", async (t) => {
  const f = await fixture(t);
  await f.write("count", folder("count", "v1"));
  await f.load("count");
  const stuck = barrier();
  f.hooks.closing = () => stuck.promise;
  await f.client.call("plugin.unload", { id: "count" });
  const session = await f.session();
  const called = barrier();
  f.script(() => { called.release(); return fauxAssistantMessage(fauxToolCall("plugin", { action: "load", id: "count" })); }, fauxAssistantMessage("不会到这里"));
  // 同一份内容已有快照，不再询问；这次加载停在等旧实例关闭。
  const sending = f.client.call("session.send", { sessionId: session.id, text: "再装上" });
  await called.promise;
  await f.client.call("session.abort", { sessionId: session.id });
  await sending.catch(() => undefined);
  assert.equal((await f.item("count"))?.state, "disabled");
  assert.equal((await f.record()).plugins.count?.enabled, false);
  const second = await f.session();
  f.script(fauxAssistantMessage("好"));
  await f.send(second.id, "在吗");
  // 关闭空间要等每个实例的 close() 返回。
  stuck.release();
});

/** 列表里这个插件下一次变成 state 时的那份列表。 */
function nextState(client: RepaClient, id: string, state: PluginInfo["state"]): Promise<PluginInfo> {
  return new Promise((resolve) => {
    client.on("plugin.updated", ({ plugins }) => {
      const plugin = plugins.find((item) => item.id === id);
      if (plugin?.state === state) resolve(plugin);
    });
  });
}

test("新插件的 open() 不返回：停止运行结束这次加载，别的插件照常加载，别的会话照常运行；记录、列表与返回值一致，open 返回以后列表随之更新", async (t) => {
  // 先登记放开屏障：清理时关闭空间要等这个 open 返回。
  const entered = barrier();
  const stuck = barrier();
  t.after(() => { stuck.release(); });
  const f = await fixture(t);
  f.hooks.stall = async () => {
    entered.release();
    await stuck.promise;
  };
  await f.write("count", folder("count", "v1", { open: `await hooks()?.stall?.("open count");` }));
  await f.write("other", folder("other", "v1"));
  const session = await f.session();
  f.script(fauxAssistantMessage(fauxToolCall("plugin", { action: "load", id: "count" })), fauxAssistantMessage("不会到这里"));
  const sending = f.client.call("session.send", { sessionId: session.id, text: "加载计数插件" });
  await entered.promise;
  // 停住的只是这个插件：别的插件照常加载，这个插件的另一次装卸立即失败。
  assert.equal((await f.load("other")).state, "running");
  await assert.rejects(f.load("count"), code("plugin_busy"));
  await assert.rejects(f.client.call("plugin.unload", { id: "count" }), code("plugin_busy"));
  await f.client.call("session.abort", { sessionId: session.id });
  await sending.catch(() => undefined);
  const [result] = toolResults(await f.client.call("session.history", { sessionId: session.id }));
  assert.equal(result?.tool, "plugin");
  assert.equal(result?.isError, true);
  assert.match(result?.text ?? "", /停在打开/);
  // 记录写在打开之前：指向新版本；列表显示为失败，原因是加载停在打开。
  const item = await f.item("count");
  assert.equal(item?.state, "failed");
  assert.equal(item?.reason?.code, "plugin_load_stopped");
  const record = (await f.record()).plugins.count;
  assert.equal(record?.enabled, true);
  assert.equal(record?.digest, f.confirmations[0]?.plugin?.digest);
  assert.equal(item?.digest, record?.digest);
  // 运行已经结束，空间写锁放开了：另一个会话照常运行。
  const second = await f.session();
  f.script(fauxAssistantMessage("好"));
  await f.send(second.id, "在吗");
  // open 返回以后，插件转为运行，列表随之更新，可以照常调用。
  const running = nextState(f.client, "count", "running");
  stuck.release();
  assert.equal((await running).digest, record?.digest);
  assert.equal(await f.call("count", "tag"), "v1");
});

test("新版本的模块顶层 await 不返回：停止运行结束这次加载，原来的版本照常运行，启用记录不变；别的插件与别的会话不受影响", async (t) => {
  const entered = barrier();
  const stuck = barrier();
  t.after(() => { stuck.release(); });
  const f = await fixture(t);
  await f.write("count", folder("count", "v1"));
  await f.write("other", folder("other", "v1"));
  await f.load("count");
  const before = (await f.record()).plugins.count;
  f.hooks.stall = async () => {
    entered.release();
    await stuck.promise;
  };
  await f.write("count", folder("count", "v2", { top: `await hooks()?.stall?.("import count v2");` }));
  const session = await f.session();
  f.script(fauxAssistantMessage(fauxToolCall("plugin", { action: "load", id: "count" })), fauxAssistantMessage("不会到这里"));
  const sending = f.client.call("session.send", { sessionId: session.id, text: "换成 v2" });
  await entered.promise;
  assert.equal((await f.load("other")).state, "running");
  await assert.rejects(f.load("count"), code("plugin_busy"));
  await f.client.call("session.abort", { sessionId: session.id });
  await sending.catch(() => undefined);
  const [result] = toolResults(await f.client.call("session.history", { sessionId: session.id }));
  assert.equal(result?.isError, true);
  assert.match(result?.text ?? "", /停在导入/);
  // 停在导入：旧版本没有撤下，记录与列表都还是 v1。
  assert.deepEqual((await f.record()).plugins.count, before);
  const item = await f.item("count");
  assert.equal(item?.state, "running");
  assert.equal(item?.digest, before?.digest);
  assert.equal(await f.call("count", "tag"), "v1");
  const second = await f.session();
  f.script(fauxAssistantMessage("好"));
  await f.send(second.id, "在吗");
  // 导入在后台结束以后，这个插件可以再加载；同一份内容已批准过，不再询问。
  const settled = new Promise<void>((resolve) => { f.client.on("plugin.updated", () => { resolve(); }); });
  stuck.release();
  await settled;
  assert.equal((await f.load("count")).state, "running");
  assert.equal(await f.call("count", "tag"), "v2");
  // count v1、other v1、count v2 各问过一次。
  assert.equal(f.confirmations.length, 3);
  assert.deepEqual(f.hooks.log, ["open count v1", "open other v1", "close count v1", "closed count v1", "open count v2"]);
});

test("plugin.call 核对它属于空间的哪一次打开：同一次打开里插件换了版本，调用交给新实例；空间切换或重新打开以后，此前组成的调用以 space_switched 拒绝", async (t) => {
  // 每个空间里都有的随包插件，返回它所在的空间：调用若落到切换后的空间，返回值就会是那个空间。
  const where: Plugin = {
    id: "where",
    async open(host) {
      return { methods: { root: { parameters: EMPTY, async invoke() { return host.space.root; } } } };
    },
  };
  const f = await fixture(t, { plugins: [where] });
  const first = f.opened.opening;
  assert.equal(f.client.handshake.baseline.space, null);
  await f.write("count", folder("count", "v1"));
  await f.load("count");
  const call = (pluginId: string, method: string, opening: string) => f.client.call("plugin.call", { pluginId, method, input: {}, opening });
  assert.equal(await call("count", "tag", first), "v1");
  await f.write("count", folder("count", "v2"));
  await f.load("count");
  assert.equal(await call("count", "tag", first), "v2");
  // 新连接的初始化基线带着同一次打开；同一个空间再 space.open 而没有关闭，仍是这一次打开。
  const other = await RepaClient.connect(f.server.connection);
  t.after(() => other.close());
  assert.deepEqual(other.handshake.baseline.space, { root: f.root, opening: first });
  assert.equal((await f.client.call("space.open", { root: f.root })).opening, first);

  const elsewhere = path.join(path.dirname(f.root), "elsewhere");
  const switched = await f.client.call("space.create", { root: elsewhere });
  assert.notEqual(switched.opening, first);
  await assert.rejects(call("where", "root", first), code("space_switched"));
  assert.equal(await call("where", "root", switched.opening), elsewhere);

  // 回到原来的空间是新的一次打开：切换之前组成的调用同样拒绝。
  const back = await f.client.call("space.open", { root: f.root });
  assert.notEqual(back.opening, first);
  await assert.rejects(call("count", "tag", first), code("space_switched"));
  assert.equal(await call("count", "tag", back.opening), "v2");
});
