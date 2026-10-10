import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { WebSocket } from "ws";
import type { AgentRuntime, AgentSpace } from "../src/agent.js";
import type { Plugin } from "../src/plugin.js";
import { ConnectionError, RepaClient, RpcError } from "../src/client.js";
import { PROTOCOL_VERSION } from "../src/protocol.js";
import { record } from "../src/protocol/json-rpc.js";
import { startServer } from "../src/protocol/server.js";
import { RepaFault, type Confirm } from "../src/schema.js";
import { openSpace } from "../src/space.js";

async function fixture(
  t: TestContext,
  login?: (confirm: Confirm, signal?: AbortSignal) => Promise<void>,
  options: { runtime?: Partial<AgentRuntime>; plugins?: Plugin[] } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-protocol-"));
  const runtime: AgentRuntime = {
    async openSpace() { throw new Error("该协议边界测试不打开 Agent 空间"); },
    async listModels() { return []; },
    async login(_provider, _type, confirm, signal) { await login?.(confirm, signal); },
    async setKey() {},
    async logout() {},
    async complete() { return ""; },
    async completeStructured() { throw new Error("未使用"); },
    async close() {},
    ...options.runtime,
  };
  const server = await startServer({ home: root, runtime, plugins: options.plugins });
  const clients: RepaClient[] = [];
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await Promise.all(clients.map((client) => client.close()));
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    server,
    root,
    async client(token = server.connection.token) {
      const client = await RepaClient.connect({ ...server.connection, token });
      clients.push(client);
      return client;
    },
    async socket() {
      const socket = new WebSocket(server.connection.url);
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      return socket;
    },
  };
}

function receive(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待 RPC 响应超时")), 2000);
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as unknown);
    });
  });
}

async function exchange(socket: WebSocket, value: unknown): Promise<Record<string, unknown>> {
  const response = receive(socket);
  socket.send(JSON.stringify(value));
  const result = record(await response);
  assert.ok(result);
  return result;
}

function rpcCode(response: Record<string, unknown>): unknown {
  return record(response.error)?.code;
}

test("授权前拒绝操作，授权后逐项验证方法、参数和 JSON-RPC 请求", async (t) => {
  const f = await fixture(t);
  const socket = await f.socket();
  assert.equal(rpcCode(await exchange(socket, { jsonrpc: "2.0", id: 1, method: "settings.get" })), -32001);
  assert.equal(rpcCode(await exchange(socket, { jsonrpc: "2.0", id: 2, method: "initialize", params: { token: f.server.connection.token, version: "old" } })), -32002);
  assert.equal(record((await exchange(socket, { jsonrpc: "2.0", id: 3, method: "initialize", params: { token: f.server.connection.token, version: PROTOCOL_VERSION } })).result)?.version, PROTOCOL_VERSION);
  assert.equal(rpcCode(await exchange(socket, { jsonrpc: "2.0", id: 4, method: "settings.set", params: { unexpected: true } })), -32602);
  assert.equal(rpcCode(await exchange(socket, { jsonrpc: "2.0", id: 5, method: "unknown" })), -32601);
  assert.equal(rpcCode(await exchange(socket, { jsonrpc: "2.0", id: "null-params", method: "settings.get", params: null })), -32602);
  assert.equal(rpcCode(await exchange(socket, { jsonrpc: "1.0", id: 6, method: "settings.get" })), -32600);
  assert.equal(rpcCode(await exchange(socket, [])), -32600);
  const parsed = receive(socket);
  socket.send("{");
  assert.equal(rpcCode(record(await parsed) ?? {}), -32700);
});

test("浏览器客户端拒绝错误令牌并读取持久设置", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.client("x".repeat(64)), (error: unknown) => error instanceof RpcError && error.code === -32001);
  const client = await f.client();
  assert.equal((await client.call("settings.get", {})).commandPolicy, "ask");
  assert.equal((await client.call("settings.set", { commandPolicy: "fullAccess" })).commandPolicy, "fullAccess");
  await assert.rejects(client.call("session.list", {}), (error: unknown) => error instanceof RpcError && record(error.data)?.code === "space_not_open");
});

test("服务关闭通知断线，重新连接重新初始化且不重放请求", async (t) => {
  const f = await fixture(t);
  const client = await f.client();
  assert.equal(client.connected, true);
  const changes: boolean[] = [];
  const disconnected = new Promise<void>((resolve) => {
    client.onConnectionChange((connected) => {
      changes.push(connected);
      resolve();
    });
  });
  await client.call("settings.set", { commandPolicy: "fullAccess" });
  await f.server.close();
  await disconnected;
  assert.equal(client.connected, false);
  assert.deepEqual(changes, [false]);
  await client.close();
  assert.deepEqual(changes, [false]);
  const restarted = await fixture(t);
  const reconnected = await restarted.client();
  assert.equal(reconnected.connected, true);
  assert.equal((await reconnected.call("settings.get", {})).commandPolicy, "ask");
});

test("显式关闭只通知一次，取消监听后不再通知", async (t) => {
  const f = await fixture(t);
  const client = await f.client();
  const changes: boolean[] = [];
  client.onConnectionChange((connected) => changes.push(connected));
  const removed: boolean[] = [];
  const unsubscribe = client.onConnectionChange((connected) => removed.push(connected));
  unsubscribe();
  await Promise.all([client.close(), client.close()]);
  assert.deepEqual(changes, [false]);
  assert.deepEqual(removed, []);
});

test("登录确认只发送给发起连接，其他连接不能回答", async (t) => {
  let answer: string | boolean | null | undefined;
  const f = await fixture(t, async (confirm) => {
    answer = await confirm({ kind: "input", title: "输入验证码", secret: true });
  });
  const owner = await f.client();
  const other = await f.client();
  let otherNotified = false;
  other.on("confirm.request", () => { otherNotified = true; });
  const request = new Promise<{ id: string }>((resolve) => owner.on("confirm.request", resolve));
  const login = owner.call("auth.login", { provider: "test", type: "oauth" });
  const confirmation = await request;
  await assert.rejects(other.call("confirm.reply", { id: confirmation.id, value: "stolen" }), (error: unknown) => error instanceof RpcError && record(error.data)?.code === "confirmation_not_found");
  await owner.call("confirm.reply", { id: confirmation.id, value: "verified" });
  await login;
  assert.equal(answer, "verified");
  assert.equal(otherNotified, false);
});

test("登录连接断开取消待确认，原请求标明结果未知，关闭可以完成", async (t) => {
  let cancelled: () => void;
  const cancelledLogin = new Promise<void>((resolve) => { cancelled = resolve; });
  const f = await fixture(t, async (confirm) => {
    try { await confirm({ kind: "input", title: "输入验证码" }); }
    finally { cancelled(); }
  });
  const client = await f.client();
  const requested = new Promise<void>((resolve) => client.on("confirm.request", () => resolve()));
  const login = client.call("auth.login", { provider: "test", type: "oauth" });
  const rejected = assert.rejects(login, (error: unknown) => error instanceof ConnectionError && error.outcome === "unknown");
  await requested;
  await client.close();
  await rejected;
  await cancelledLogin;
  await f.server.close();
  await f.server.closed;
});

test("登录上游错误不把凭据或错误细节返回到协议", async (t) => {
  const f = await fixture(t, async () => { throw new Error("secret-key-from-upstream"); });
  const client = await f.client();
  await assert.rejects(client.call("auth.login", { provider: "test", type: "oauth" }), (error: unknown) => {
    assert.ok(error instanceof RpcError);
    assert.equal(record(error.data)?.code, "login_failed");
    assert.equal(error.message.includes("secret-key"), false);
    return true;
  });
});


test("批量请求保留 id，客户端 notification 不启动需要确认的操作", async (t) => {
  const f = await fixture(t);
  const socket = await f.socket();
  await exchange(socket, {
    jsonrpc: "2.0", id: 0, method: "initialize",
    params: { token: f.server.connection.token, version: PROTOCOL_VERSION },
  });
  const response = receive(socket);
  socket.send(JSON.stringify([
    { jsonrpc: "2.0", method: "settings.set", params: { commandPolicy: "fullAccess" } },
    { jsonrpc: "2.0", id: "settings", method: "settings.get", params: {} },
    { jsonrpc: "2.0", id: 42, method: "model.list", params: {} },
  ]));
  const replies = await response;
  assert.ok(Array.isArray(replies));
  assert.equal(replies.length, 2);
  const settings = record(replies[0]);
  assert.equal(settings?.id, "settings");
  assert.equal(record(settings?.result)?.commandPolicy, "ask");
  assert.deepEqual(replies[1], { jsonrpc: "2.0", id: 42, result: [] });
});


test("登录失败立即清理该次登录已经发出的 display 确认", { timeout: 5000 }, async (t) => {
  let finishCancelled: () => void;
  const cancelled = new Promise<void>((resolve) => { finishCancelled = resolve; });
  let noticeError: unknown;
  const f = await fixture(t, async (confirm, signal) => {
    const notice = confirm({ kind: "display", title: "登录说明" }, signal);
    notice.then(() => finishCancelled(), (error: unknown) => {
      noticeError = error;
      finishCancelled();
    });
    throw new Error("provider failed after notification");
  });
  const client = await f.client();
  const requested = new Promise<{ id: string }>((resolve) => client.on("confirm.request", resolve));
  await assert.rejects(client.call("auth.login", { provider: "test", type: "oauth" }), (error: unknown) => {
    return error instanceof RpcError && record(error.data)?.code === "login_failed";
  });
  const { id } = await requested;
  await cancelled;
  assert.ok(noticeError instanceof RepaFault);
  assert.equal(noticeError.code, "confirmation_cancelled");
  await assert.rejects(client.call("confirm.reply", { id, value: null }), (error: unknown) => {
    return error instanceof RpcError && record(error.data)?.code === "confirmation_not_found";
  });
});

test("关闭服务先取消初始化插件正在等待的 Agent 回合，再释放空间锁", { timeout: 10000 }, async (t) => {
  let markStarted: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let rejectWork: (error: Error) => void;
  const result = new Promise<void>((_resolve, reject) => { rejectWork = reject; });
  let markRuntimeClosed: () => void;
  const runtimeClosed = new Promise<void>((resolve) => { markRuntimeClosed = resolve; });
  let pluginClosed = false;
  const cancel = async () => rejectWork(new RepaFault("cancelled", "初始化回合已取消"));
  t.signal.addEventListener("abort", () => { cancel().catch(() => undefined); });
  const agent: AgentSpace = {
    async create() { throw new Error("未使用"); },
    async get() { throw new Error("未使用"); },
    async list() { return []; },
    async preview() { return { sections: [], views: [] }; },
    async runAgent() {
      markStarted();
      return { id: "initial-work", result, cancel };
    },
    close: cancel,
  };
  const plugin: Plugin = {
    id: "initializing",
    async open(host) {
      return {
        async onChange() {
          const task = await host.models.runAgent({ text: "初始化" });
          await task.result;
        },
        async close() { pluginClosed = true; },
      };
    },
  };
  const f = await fixture(t, undefined, {
    plugins: [plugin],
    runtime: {
      async openSpace() { return agent; },
      async close() {
        markRuntimeClosed();
        await cancel();
      },
    },
  });
  const root = path.join(f.root, "initializing-space");
  await mkdir(root);
  await writeFile(path.join(root, "seed.txt"), "初始内容");
  const client = await f.client();
  const opening = client.call("space.open", { root });
  const disconnected = assert.rejects(opening, (error: unknown) => error instanceof ConnectionError);
  await started;
  const shutdown = f.server.close();
  await runtimeClosed;
  await shutdown;
  await disconnected;
  assert.equal(pluginClosed, true);
  const reopened = await openSpace(root, { watch: false });
  await reopened.close();
});
