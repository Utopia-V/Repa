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
        const info = { id: `s${sessions.length + 1}`, createdAt: at };
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
      case "confirm.reply":
        return Promise.resolve(null);
      default:
        return Promise.reject(new Error(`未模拟的方法 ${method}`));
    }
  });
  return { call, runs, aborts, history, failOpen: (error: unknown) => { failOpen = error; }, ...fakeClient(call) };
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

it("进入空间时读取最近建立的会话和它的记录", async () => {
  const backend = sessionBackend(
    [{ id: "old", createdAt: "2026-10-01T00:00:00.000Z" }, { id: "new", createdAt: "2026-10-11T00:00:00.000Z" }],
    { new: [{ id: "u1", type: "user", timestamp: at, text: "昨天学到哪了" }] },
  );
  const store = await openedStore(backend);

  expect(store.getState().conversation).toMatchObject({
    status: "ready",
    sessionId: "new",
    items: [{ kind: "user", id: "u1", text: "昨天学到哪了" }],
  });
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
    { kind: "assistant", id: "a1", text: "导数描述变化率。" },
  ]));
  expect(store.getState().conversation.run).toBe("idle");
});

it("没写进会话记录的失败返回 false 并保留原因；模型出错由记录显示，不另外提示", async () => {
  const backend = sessionBackend([{ id: "s1", createdAt: at }]);
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
  const backend = sessionBackend([{ id: "s1", createdAt: at }]);
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
  const backend = sessionBackend([{ id: "s1", createdAt: at }]);
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
  const backend = sessionBackend([{ id: "s1", createdAt: at }], { s1: [] });
  const store = await openedStore(backend);
  backend.history.s1 = [{ id: "u1", type: "user", timestamp: at, text: "断线前发的" }];

  const next = sessionBackend([{ id: "s1", createdAt: at }], backend.history);
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
