import { expect, it, vi } from "vitest";
import { RpcError } from "@repa/base/client";
import type { AgentEvent, SessionEntry, SessionInfo } from "@repa/base/protocol";

import { createAppStore } from "../src/lib/store";
import { fakeClient } from "./fake-client";

const at = "2026-10-12T00:00:00.000Z";

/** 模拟后端的会话部分：发送和停止由测试决定何时完成。 */
function sessionBackend(sessions: SessionInfo[] = [], history: Record<string, SessionEntry[]> = {}) {
  const runs: { sessionId: string; text: string; finish(error?: unknown): void }[] = [];
  const aborts: { finish(): void }[] = [];
  const steers: { text: string; finish(error?: unknown): void }[] = [];
  let failOpen: unknown;
  const call = vi.fn((method: string, params: Record<string, unknown>) => {
    switch (method) {
      case "space.open":
        return failOpen ? Promise.reject(failOpen) : Promise.resolve({ root: params.root });
      case "space.list":
        return Promise.resolve([]);
      case "session.list":
        return Promise.resolve([...sessions]);
      case "session.create": {
        const info: SessionInfo = { id: `s${sessions.length + 1}`, createdAt: at, updatedAt: at, model: (params.model as NonNullable<SessionInfo["model"]> | undefined) ?? { provider: "test", id: "default" } };
        sessions.push(info);
        return Promise.resolve(info);
      }
      case "session.history":
        return Promise.resolve(history[String(params.sessionId)] ?? []);
      case "session.send":
        return new Promise((resolve, reject) => {
          runs.push({
            sessionId: String(params.sessionId),
            text: String(params.text),
            finish: (error) => error ? reject(error) : resolve(null),
          });
        });
      case "session.abort":
        return new Promise((resolve) => { aborts.push({ finish: () => resolve(null) }); });
      case "session.steer":
        return new Promise((resolve, reject) => {
          steers.push({ text: String(params.text), finish: (error) => error ? reject(error) : resolve(null) });
        });
      case "session.setModel": {
        const found = sessions.find((session) => session.id === params.sessionId);
        if (found) found.model = params.model as NonNullable<SessionInfo["model"]>;
        return Promise.resolve(null);
      }
      case "session.fork": {
        // 和后端一样复制到分叉点为止，原会话不变；新会话沿用原会话的模型。
        const source = sessions.find((session) => session.id === params.sessionId);
        const entries = history[String(params.sessionId)] ?? [];
        const info: SessionInfo = { id: `s${sessions.length + 1}`, createdAt: at, updatedAt: at, ...(source?.model ? { model: source.model } : {}) };
        history[info.id] = entries.slice(0, entries.findIndex((entry) => entry.id === params.entryId) + 1);
        sessions.push(info);
        return Promise.resolve(info);
      }
      case "confirm.reply":
      case "space.close":
        return Promise.resolve(null);
      default:
        return Promise.reject(new Error(`未模拟的方法 ${method}`));
    }
  });
  return { call, runs, aborts, steers, history, failOpen: (error: unknown) => { failOpen = error; }, ...fakeClient(call) };
}

async function openedStore(backend: ReturnType<typeof sessionBackend>) {
  const store = createAppStore();
  store.getState().setClient(backend.client);
  await store.getState().openSpace("/notes/calculus");
  await store.getState().loadConversation();
  return store;
}

function event(sessionId: string, value: Omit<AgentEvent, "sessionId" | "runId">): AgentEvent {
  return { sessionId, runId: "r1", ...value };
}

it("进入空间时打开最近有消息的会话，而不是最近建立的", async () => {
  const backend = sessionBackend(
    [
      { id: "old", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-12T00:00:00.000Z", model: { provider: "anthropic", id: "claude" } },
      { id: "new", createdAt: "2026-10-11T00:00:00.000Z", updatedAt: "2026-10-11T00:00:00.000Z" },
    ],
    { old: [{ id: "u1", type: "user", timestamp: at, text: "昨天学到哪了" }] },
  );
  const store = await openedStore(backend);

  expect(store.getState().conversation).toMatchObject({
    status: "ready",
    sessionId: "old",
    model: { provider: "anthropic", id: "claude" },
    items: [{ kind: "user", id: "u1", text: "昨天学到哪了" }],
  });
  expect(store.getState().resources.sessions.data?.map((session) => session.id)).toEqual(["old", "new"]);
});

it("空间里没有会话时第一次发送才建立；运行中按事件显示，结束后换成会话记录", async () => {
  const backend = sessionBackend();
  const store = await openedStore(backend);
  expect(store.getState().conversation).toMatchObject({ status: "ready", sessionId: undefined, items: [] });
  expect(backend.call).not.toHaveBeenCalledWith("session.create", {});

  const sending = store.getState().sendMessage("解释一下导数");
  await vi.waitFor(() => expect(backend.runs).toHaveLength(1));
  expect(backend.call).toHaveBeenCalledWith("session.create", {});
  expect(backend.runs[0]).toMatchObject({ sessionId: "s1", text: "解释一下导数" });
  expect(store.getState().conversation.run).toBe("sending");

  backend.emit("session.event", event("s1", { type: "runStart" }));
  backend.emit("session.event", event("s1", { type: "message", text: "解释一下导数", data: { role: "user" } }));
  backend.emit("session.event", event("s1", { type: "textDelta", text: "导数描述" }));
  backend.emit("session.event", event("other", { type: "textDelta", text: "别的会话" }));
  expect(store.getState().conversation.run).toBe("running");
  expect(store.getState().conversation.items.map((item) => "text" in item ? item.text : item.kind)).toEqual(["解释一下导数", "导数描述"]);

  backend.history.s1 = [
    { id: "u1", type: "user", timestamp: at, text: "解释一下导数" },
    { id: "a1", type: "assistant", timestamp: at, text: "导数描述变化率。", data: { stopReason: "stop" } },
  ];
  backend.emit("session.event", event("s1", { type: "runEnd", data: { status: "completed" } }));
  backend.runs[0]?.finish();

  expect(await sending).toBe(true);
  await vi.waitFor(() => expect(store.getState().conversation.items).toEqual([
    { kind: "user", id: "u1", text: "解释一下导数" },
    { kind: "assistant", id: "a1", text: "导数描述变化率。", forkable: true },
  ]));
  expect(store.getState().conversation.run).toBe("idle");
});

it("没写进会话记录的失败返回 false 并保留原因；模型出错由记录显示，不另外提示", async () => {
  const backend = sessionBackend([{ id: "s1", createdAt: at, updatedAt: at }]);
  const store = await openedStore(backend);

  const missingModel = store.getState().sendMessage("你好");
  await vi.waitFor(() => expect(backend.runs).toHaveLength(1));
  backend.runs[0]?.finish(new RpcError(-32000, "请选择可用模型", { code: "model_required" }));
  expect(await missingModel).toBe(false);
  expect(store.getState().conversation.sendError).toBeInstanceOf(RpcError);
  expect(store.getState().conversation.run).toBe("idle");

  const modelError = store.getState().sendMessage("你好");
  await vi.waitFor(() => expect(backend.runs).toHaveLength(2));
  backend.runs[1]?.finish(new RpcError(-32000, "模型请求失败", { code: "model_error" }));
  expect(await modelError).toBe(true);
  expect(store.getState().conversation.sendError).toBeUndefined();
});

it("停止运行时调用取消，取消完成前保持停止中，期间不能再发送", async () => {
  const backend = sessionBackend([{ id: "s1", createdAt: at, updatedAt: at }]);
  const store = await openedStore(backend);
  const sending = store.getState().sendMessage("出一道题");
  await vi.waitFor(() => expect(backend.runs).toHaveLength(1));
  backend.emit("session.event", event("s1", { type: "runStart" }));

  const stopping = store.getState().stopRun();
  expect(backend.call).toHaveBeenCalledWith("session.abort", { sessionId: "s1" });
  expect(store.getState().conversation.run).toBe("stopping");
  expect(await store.getState().sendMessage("再来一道")).toBe(false);
  expect(backend.runs).toHaveLength(1);

  backend.runs[0]?.finish(new RpcError(-32000, "会话运行已取消", { code: "cancelled" }));
  backend.aborts[0]?.finish();
  await Promise.all([sending, stopping]);
  expect(store.getState().conversation.run).toBe("idle");
  expect(store.getState().conversation.sendError).toBeUndefined();
});

it("命令授权按到达顺序排队，回答后发给后端；登录类请求直接取消；发送结束后清空", async () => {
  const backend = sessionBackend([{ id: "s1", createdAt: at, updatedAt: at }]);
  const store = await openedStore(backend);
  const sending = store.getState().sendMessage("跑一下测试");
  await vi.waitFor(() => expect(backend.runs).toHaveLength(1));

  backend.emit("confirm.request", { id: "c1", request: { kind: "command", title: "允许执行命令？", message: "npm test" } });
  backend.emit("confirm.request", { id: "c2", request: { kind: "command", title: "允许执行命令？", message: "ls" } });
  backend.emit("confirm.request", { id: "c3", request: { kind: "input", title: "输入授权码" } });
  expect(store.getState().confirmations.map((item) => item.id)).toEqual(["c1", "c2"]);
  expect(backend.call).toHaveBeenCalledWith("confirm.reply", { id: "c3", value: null });

  await store.getState().replyConfirmation("c1", true);
  expect(backend.call).toHaveBeenCalledWith("confirm.reply", { id: "c1", value: true });
  expect(store.getState().confirmations.map((item) => item.id)).toEqual(["c2"]);

  // 后端取消运行时不会撤回已发出的请求，运行结束后由前端清掉。
  backend.runs[0]?.finish(new RpcError(-32000, "会话运行已取消", { code: "cancelled" }));
  await sending;
  expect(store.getState().confirmations).toEqual([]);
});

it("换连接后重新打开原来的空间并重读会话记录；空间打不开时回到未打开", async () => {
  const backend = sessionBackend([{ id: "s1", createdAt: at, updatedAt: at }], { s1: [] });
  const store = await openedStore(backend);
  backend.history.s1 = [{ id: "u1", type: "user", timestamp: at, text: "断线前发的" }];

  const next = sessionBackend([{ id: "s1", createdAt: at, updatedAt: at }], backend.history);
  store.getState().setClient(next.client);
  await vi.waitFor(() => expect(store.getState().conversation.items).toEqual([{ kind: "user", id: "u1", text: "断线前发的" }]));
  expect(next.call).toHaveBeenCalledWith("space.open", { root: "/notes/calculus" });
  expect(store.getState().space).toBe("/notes/calculus");

  const broken = sessionBackend();
  broken.failOpen(new RpcError(-32000, "目录不存在", { code: "not_found" }));
  store.getState().setClient(broken.client);
  await vi.waitFor(() => expect(store.getState().space).toBeUndefined());
  expect(store.getState().conversation.status).toBe("idle");
});

it("切换到列表里的另一个会话；运行中不切换", async () => {
  const backend = sessionBackend(
    [
      { id: "a", createdAt: at, updatedAt: "2026-10-12T02:00:00.000Z", model: { provider: "fake", id: "tutor" } },
      { id: "b", createdAt: at, updatedAt: "2026-10-12T01:00:00.000Z", model: { provider: "anthropic", id: "claude" } },
    ],
    { b: [{ id: "u1", type: "user", timestamp: at, text: "另一个会话" }] },
  );
  const store = await openedStore(backend);
  const b = store.getState().resources.sessions.data![1]!;

  await store.getState().openSession(b);
  expect(store.getState().conversation).toMatchObject({
    status: "ready", sessionId: "b", model: { provider: "anthropic", id: "claude" },
    items: [{ kind: "user", text: "另一个会话" }],
  });

  const sending = store.getState().sendMessage("继续");
  await vi.waitFor(() => expect(backend.runs).toHaveLength(1));
  await store.getState().openSession(store.getState().resources.sessions.data![0]!);
  expect(store.getState().conversation.sessionId).toBe("b");
  backend.runs[0]?.finish();
  await sending;
});

it("还没建立的会话记下选的模型，建立时使用；已建立的会话调用 session.setModel", async () => {
  const backend = sessionBackend();
  const store = await openedStore(backend);

  await store.getState().setConversationModel({ provider: "anthropic", id: "claude" });
  expect(backend.call).not.toHaveBeenCalledWith("session.setModel", expect.anything());
  expect(store.getState().conversation.model).toEqual({ provider: "anthropic", id: "claude" });

  const sending = store.getState().sendMessage("你好");
  await vi.waitFor(() => expect(backend.runs).toHaveLength(1));
  expect(backend.call).toHaveBeenCalledWith("session.create", { model: { provider: "anthropic", id: "claude" } });
  backend.runs[0]?.finish();
  await sending;
  expect(store.getState().resources.sessions.data?.map((session) => session.id)).toEqual(["s1"]);

  await store.getState().setConversationModel({ provider: "openai", id: "gpt" });
  expect(backend.call).toHaveBeenCalledWith("session.setModel", { sessionId: "s1", model: { provider: "openai", id: "gpt" } });
  expect(store.getState().conversation.model).toEqual({ provider: "openai", id: "gpt" });
  expect(store.getState().resources.sessions.data?.[0]?.model).toEqual({ provider: "openai", id: "gpt" });

  // 新会话回到默认模型。
  store.getState().newConversation();
  expect(store.getState().conversation.model).toBeUndefined();
});

it("换空间时清空上一个空间的会话列表", async () => {
  const backend = sessionBackend([{ id: "s1", createdAt: at, updatedAt: at }]);
  const store = await openedStore(backend);
  expect(store.getState().resources.sessions.data).toHaveLength(1);
  await store.getState().openSpace("/notes/algebra");
  expect(store.getState().resources.sessions).toEqual({ status: "idle" });
});

it("从一条回答分叉：打开新会话，记录到这条回答为止，侧栏列表重新读取；运行中不分叉", async () => {
  const backend = sessionBackend(
    [{ id: "s1", createdAt: at, updatedAt: at, model: { provider: "anthropic", id: "claude" } }],
    {
      s1: [
        { id: "u1", type: "user", timestamp: at, text: "什么是极限" },
        { id: "a1", type: "assistant", timestamp: at, text: "极限描述趋近。", data: { stopReason: "stop" } },
        { id: "u2", type: "user", timestamp: at, text: "举个例子" },
        { id: "a2", type: "assistant", timestamp: at, text: "1/n 趋近 0。", data: { stopReason: "stop" } },
      ],
    },
  );
  const store = await openedStore(backend);

  await store.getState().forkSession("a1");
  expect(backend.call).toHaveBeenCalledWith("session.fork", { sessionId: "s1", entryId: "a1" });
  expect(store.getState().conversation).toMatchObject({
    status: "ready", sessionId: "s2", model: { provider: "anthropic", id: "claude" },
    items: [{ kind: "user", text: "什么是极限" }, { kind: "assistant", text: "极限描述趋近。" }],
  });
  expect(store.getState().resources.sessions.data?.map((session) => session.id)).toEqual(["s1", "s2"]);

  const sending = store.getState().sendMessage("换个角度讲");
  await vi.waitFor(() => expect(backend.runs).toHaveLength(1));
  await store.getState().forkSession("a1");
  expect(backend.call.mock.calls.filter(([method]) => method === "session.fork")).toHaveLength(1);
  expect(store.getState().conversation.sessionId).toBe("s2");
  backend.runs[0]?.finish();
  await sending;
});

it("运行中发出的消息用 session.steer 排队，送达事件到来后成为用户消息；停止时交还没送到的", async () => {
  const backend = sessionBackend([{ id: "s1", createdAt: at, updatedAt: at }]);
  const store = await openedStore(backend);
  const sending = store.getState().sendMessage("讲讲链式法则");
  await vi.waitFor(() => expect(backend.runs).toHaveLength(1));
  // 运行开始前没有可以排队的运行。
  expect(await store.getState().sendMessage("太快了")).toBe(false);
  backend.emit("session.event", event("s1", { type: "runStart" }));
  backend.emit("session.event", event("s1", { type: "message", text: "讲讲链式法则", data: { role: "user" } }));

  const first = store.getState().sendMessage("能举个例子吗");
  const second = store.getState().sendMessage("再慢一点");
  expect(backend.call).toHaveBeenCalledWith("session.steer", { sessionId: "s1", text: "能举个例子吗" });
  expect(store.getState().conversation.queued.map((message) => message.text)).toEqual(["能举个例子吗", "再慢一点"]);
  backend.steers[0]?.finish();
  backend.steers[1]?.finish();
  expect(await first).toBe(true);
  expect(await second).toBe(true);
  // 入队返回不等于送达，仍然显示为排队。
  expect(store.getState().conversation.queued).toHaveLength(2);

  backend.emit("session.event", event("s1", { type: "message", text: "能举个例子吗", data: { role: "user" } }));
  expect(store.getState().conversation.queued.map((message) => message.text)).toEqual(["再慢一点"]);
  expect(store.getState().conversation.items.map((item) => "text" in item ? item.text : item.kind)).toEqual(["讲讲链式法则", "能举个例子吗"]);

  const stopping = store.getState().stopRun();
  backend.runs[0]?.finish(new RpcError(-32000, "会话运行已取消", { code: "cancelled" }));
  backend.aborts[0]?.finish();
  expect(await stopping).toEqual(["再慢一点"]);
  await sending;
  expect(store.getState().conversation.queued).toEqual([]);
  expect(store.getState().conversation.run).toBe("idle");
});

it("排队失败时移出队列并返回 false，保留原因", async () => {
  const backend = sessionBackend([{ id: "s1", createdAt: at, updatedAt: at }]);
  const store = await openedStore(backend);
  const sending = store.getState().sendMessage("出一道题");
  await vi.waitFor(() => expect(backend.runs).toHaveLength(1));
  backend.emit("session.event", event("s1", { type: "runStart" }));

  const steering = store.getState().sendMessage("换一道");
  expect(store.getState().conversation.queued).toHaveLength(1);
  backend.steers[0]?.finish(new RpcError(-32000, "会话运行正在取消", { code: "cancelled" }));
  expect(await steering).toBe(false);
  expect(store.getState().conversation.queued).toEqual([]);
  expect(store.getState().conversation.sendError).toBeInstanceOf(RpcError);
  expect(store.getState().conversation.run).toBe("running");

  backend.runs[0]?.finish();
  await sending;
});

it("关闭空间后清空会话、会话列表和授权；运行中不关闭", async () => {
  const backend = sessionBackend([{ id: "s1", createdAt: at, updatedAt: at }], { s1: [{ id: "u1", type: "user", timestamp: at, text: "极限" }] });
  const store = await openedStore(backend);

  const sending = store.getState().sendMessage("出一道题");
  await vi.waitFor(() => expect(backend.runs).toHaveLength(1));
  backend.emit("confirm.request", { id: "c1", request: { kind: "command", title: "允许执行命令？", message: "ls" } });
  await store.getState().closeSpace();
  expect(backend.call).not.toHaveBeenCalledWith("space.close", {});
  expect(store.getState().space).toBe("/notes/calculus");
  backend.runs[0]?.finish();
  await sending;

  backend.emit("confirm.request", { id: "c2", request: { kind: "command", title: "允许执行命令？", message: "ls" } });
  await store.getState().closeSpace();
  expect(backend.call).toHaveBeenCalledWith("space.close", {});
  expect(store.getState()).toMatchObject({
    space: undefined,
    conversation: { status: "idle", items: [], run: "idle" },
    confirmations: [],
    resources: { sessions: { status: "idle" } },
  });
  expect(store.getState().conversation.sessionId).toBeUndefined();
});
