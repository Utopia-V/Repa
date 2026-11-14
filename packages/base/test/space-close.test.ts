import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAgentRuntimeForTest } from "../src/agent/runtime.js";
import { RepaClient, RpcError } from "../src/client.js";
import type { Host, Plugin } from "../src/plugin.js";
import { record } from "../src/protocol/json-rpc.js";
import { startServer } from "../src/protocol/server.js";
import { RepaFault } from "../src/schema.js";

function deferred<T = void>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

/**
 * 插件每次 open 都留下 Host；设上 onChange 时，之后打开的实例在变化处理（含打开空间时的追赶）里调用它；
 * 设上 closeError 时，实例的 close() 抛出它。
 */
interface Probe {
  hosts: Host[];
  onChange?: (host: Host) => Promise<void>;
  closeError?: Error;
}

function probePlugin(probe: Probe): Plugin {
  return {
    id: "probe",
    async open(host) {
      probe.hosts.push(host);
      return {
        async onChange() {
          await probe.onChange?.(host);
        },
        async close() {
          if (probe.closeError) throw probe.closeError;
        },
      };
    },
  };
}

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-space-close-")));
  const root = path.join(directory, "space");
  const home = path.join(directory, "home");
  await mkdir(root);
  await mkdir(path.join(home, "agent"), { recursive: true });
  const faux = fauxProvider({ api: `space-close-${randomUUID()}`, provider: `space-close-${randomUUID()}`, models: [{ id: "scripted", contextWindow: 16384, maxTokens: 256 }], tokensPerSecond: 0 });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(home, "agent", "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const runtime = await createAgentRuntimeForTest({
    agentDir: path.join(home, "agent"),
    modelRuntime,
    defaultModel: { provider: faux.getModel().provider, id: "scripted" },
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
  });
  const probe: Probe = { hosts: [] };
  const server = await startServer({ home, plugins: [probePlugin(probe)], runtime });
  const clients: RepaClient[] = [];
  const connect = async () => {
    const client = await RepaClient.connect(server.connection);
    clients.push(client);
    return client;
  };
  const client = await connect();
  t.after(async () => {
    for (const opened of clients) await opened.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, root, faux, server, client, connect, probe };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** 下一次模型请求停住，直到被取消或测试放行；state.aborted 记下它是否被取消。 */
function cancellableReply(f: Fixture) {
  const waiting = deferred();
  const release = deferred();
  const aborted = deferred();
  const state = { aborted: false };
  f.faux.setResponses([async (_context, options) => {
    waiting.resolve();
    await new Promise<void>(resolve => {
      options?.signal?.addEventListener("abort", () => { state.aborted = true; aborted.resolve(); resolve(); }, { once: true });
      void release.promise.then(() => resolve());
    });
    return fauxAssistantMessage("模型回复");
  }]);
  return { waiting: waiting.promise, aborted: aborted.promise, release: () => release.resolve(), state };
}

const rejectsWith = (code: string) => (error: unknown): boolean => {
  assert.ok(error instanceof RpcError);
  assert.equal(record(error.data)?.code, code);
  return true;
};

const codeOf = (error: unknown) => error instanceof RepaFault ? error.code : error instanceof Error ? error.message : "unknown";

/** 从插件保存的 Host 发一次服务请求，返回结果的错误码；同步抛出的错误同样算作结果。 */
const serviceProbe = (host: Host) => Promise.resolve().then(() => host.services.call("probe.run", {})).then(() => "accepted", codeOf);

/**
 * 插件在 history.record 里持有空间写锁等模型请求，通用 Agent 带命令行的运行整次进 record，排在同一把锁后面。
 * 返回时运行已经在等锁：发送请求从进入后端到登记运行、再到等锁，中间只有微任务，新连接的基线列出了这次排队的运行。
 */
async function lockCycle(f: Fixture) {
  const host = f.probe.hosts[0];
  assert.ok(host);
  const reply = cancellableReply(f);
  const recording = host.history.record({ kind: "plugin", pluginId: "probe" }, async () => {
    await host.models.complete({ system: "说明", prompt: "持锁时的模型调用" });
  }).catch((error: unknown) => error);
  await reply.waiting;
  const session = await f.client.call("session.create", {});
  const running = f.client.call("session.send", { sessionId: session.id, text: "整理文件" }).catch((error: unknown) => error);
  await f.client.call("space.list", {});
  await new Promise(resolve => setImmediate(resolve));
  const observer = await f.connect();
  assert.ok((observer.handshake.baseline.sessions.find(item => item.sessionId === session.id)?.queued ?? []).some(item => item.text === "整理文件"));
  return { host, reply, recording, running };
}

test("关闭空间时插件持有空间写锁等模型，通用 Agent 的运行在等这把锁：两者一起开始关闭，不互相等待", async t => {
  const f = await fixture(t);
  await f.client.call("space.open", { root: f.root });
  const cycle = await lockCycle(f);
  const closing = f.client.call("space.close", {});
  // 插件的模型请求只在插件宿主开始关闭时取消；先等 Agent 关完再关插件时，它一直不取消，关闭也一直不结束。
  await cycle.reply.aborted;
  assert.equal(await closing, null);
  assert.ok(await cycle.recording instanceof Error);
  assert.ok(await cycle.running instanceof Error);
});

// 以下两个测试在关闭服务开始以后，从插件保存的 Host 发一次服务请求作为探针：插件宿主已经开始关闭时它以 plugins_closed 失败，
// 还没有时它走到服务路由，得到 service_unavailable。之后测试放行模型请求，旧的次序下也不会卡住，结论看断言。

test("关闭服务时插件持有空间写锁等模型，通用 Agent 的运行在等这把锁：一开始就通知插件宿主停止，不等运行时先收尾", async t => {
  const f = await fixture(t);
  await f.client.call("space.open", { root: f.root });
  const cycle = await lockCycle(f);
  const stopped = f.server.close();
  const probe = await serviceProbe(cycle.host);
  cycle.reply.release();
  await stopped;
  assert.equal(probe, "plugins_closed");
  assert.equal(cycle.reply.state.aborted, true);
  assert.ok(await cycle.recording instanceof Error);
  assert.ok(await cycle.running instanceof Error);
});

test("关闭服务时空间正在打开、插件在追赶里持锁等模型：尚未打开完成的插件宿主也收到停止通知", async t => {
  const f = await fixture(t);
  // 追赶从最近一次修订开始：先打开一次留下修订，关闭以后再打开。
  await f.client.call("space.open", { root: f.root });
  const first = f.probe.hosts[0];
  assert.ok(first);
  await first.files.write("seed.txt", "种子");
  await f.client.call("space.close", {});
  const reply = cancellableReply(f);
  f.probe.onChange = async host => {
    await host.history.record({ kind: "plugin", pluginId: "probe" }, async () => {
      await host.models.complete({ system: "说明", prompt: "追赶时的模型调用" });
    });
  };
  const opening = f.client.call("space.open", { root: f.root }).catch((error: unknown) => error);
  await reply.waiting;
  const fresh = f.probe.hosts[1];
  assert.ok(fresh);
  const stopped = f.server.close();
  const probe = await serviceProbe(fresh);
  reply.release();
  await stopped;
  await opening;
  assert.equal(probe, "plugins_closed");
  assert.equal(reply.state.aborted, true);
});

test("插件的 close 报错不使关闭空间、切换空间失败：空间照常关闭，同一空间能再打开，切换到新空间照常打开", async t => {
  const f = await fixture(t);
  await f.client.call("space.open", { root: f.root });
  f.probe.closeError = new Error("后台写入还没停");
  assert.equal(await f.client.call("space.close", {}), null);
  await assert.rejects(f.client.call("plugin.list", {}), rejectsWith("space_not_open"));
  // 空间锁已经释放，同一空间可以再打开；切换空间时先关旧的，旧空间的插件 close 报错不挡住打开新空间。
  await f.client.call("space.open", { root: f.root });
  const other = path.join(f.directory, "other");
  assert.equal((await f.client.call("space.create", { root: other })).root, other);
  f.probe.closeError = undefined;
});

test("关闭空间时释放锁失败：以 space_close_failed 报告，空间已经关闭", async t => {
  const f = await fixture(t);
  await f.client.call("space.open", { root: f.root });
  // 锁目录里多一个文件，释放锁时删不掉目录。
  const stray = path.join(f.root, ".repa", "lock", "stray");
  await writeFile(stray, "");
  await assert.rejects(f.client.call("space.close", {}), (error: unknown) => {
    rejectsWith("space_close_failed")(error);
    assert.ok(error instanceof RpcError);
    assert.match(error.message, /空间已经关闭/u);
    return true;
  });
  await assert.rejects(f.client.call("plugin.list", {}), rejectsWith("space_not_open"));
  await rm(stray);
});
