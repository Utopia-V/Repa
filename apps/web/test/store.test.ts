import { afterEach, expect, it, vi } from "vitest";

import { createAppStore } from "../src/lib/store";
import { fakeClient } from "./fake-client";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

/** 每次调用返回一个由测试决定何时完成的结果。 */
function deferredClient() {
  const calls: { method: string; resolve: (value: unknown) => void }[] = [];
  const call = vi.fn((method: string) => new Promise((resolve) => { calls.push({ method, resolve }); }));
  return { calls, ...fakeClient(call) };
}

it("同一份数据读取未完成时，重复读取只发一次请求", async () => {
  const backend = deferredClient();
  const store = createAppStore();
  store.getState().setClient(backend.client);

  const first = store.getState().loadSpaces();
  const second = store.getState().loadSpaces();
  expect(backend.calls).toHaveLength(1);
  backend.calls[0]?.resolve(["/notes/physics"]);
  await Promise.all([first, second]);

  expect(store.getState().resources.spaces).toEqual({ status: "ready", data: ["/notes/physics"] });
});

it("重新连接后重新读取读过的数据，旧连接晚到的结果被丢弃", async () => {
  const old = deferredClient();
  const store = createAppStore();
  store.getState().setClient(old.client);
  const stale = store.getState().loadSpaces();

  const next = deferredClient();
  store.getState().setClient(next.client);
  expect(next.calls.map((call) => call.method)).toEqual(["space.list"]);
  next.calls[0]?.resolve(["/notes/history"]);
  await vi.waitFor(() => expect(store.getState().resources.spaces.data).toEqual(["/notes/history"]));

  old.calls[0]?.resolve(["/notes/physics"]);
  await stale;
  expect(store.getState().resources.spaces).toEqual({ status: "ready", data: ["/notes/history"] });
});

it("没有读过的数据在重新连接时不读取", () => {
  const backend = deferredClient();
  const store = createAppStore();
  store.getState().setClient(backend.client);
  expect(backend.calls).toHaveLength(0);
});

it("重新读取期间保留上一次的数据", async () => {
  const backend = deferredClient();
  const store = createAppStore();
  store.getState().setClient(backend.client);
  const first = store.getState().loadSpaces();
  backend.calls[0]?.resolve(["/notes/physics"]);
  await first;

  void store.getState().reloadLoaded();
  expect(store.getState().resources.spaces).toMatchObject({ status: "loading", data: ["/notes/physics"] });
});

it("侧栏偏好保存到浏览器，新建的 store 读回它", () => {
  const store = createAppStore();
  store.getState().setSidebarOpen(false);
  store.getState().setSidebarWidth(360);

  expect(JSON.parse(localStorage.getItem("repa.web.preferences") ?? "null")).toEqual({
    state: { sidebar: { open: false, width: 360 }, tutorSessions: {} },
    version: 0,
  });
  expect(createAppStore().getState().sidebar).toEqual({ open: false, width: 360 });
});

it("保存的偏好格式不对时逐项回到默认值", () => {
  localStorage.setItem("repa.web.preferences", JSON.stringify({ state: { sidebar: { open: "no", width: 300 } }, version: 0 }));
  expect(createAppStore().getState().sidebar).toEqual({ open: true, width: 300 });

  localStorage.setItem("repa.web.preferences", "{");
  expect(createAppStore().getState().sidebar).toEqual({ open: true });
});

it("浏览器存储不可用时侧栏状态仍可在本页切换", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("SecurityError"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("QuotaExceededError"); });
  const store = createAppStore();

  expect(() => store.getState().setSidebarOpen(false)).not.toThrow();
  expect(store.getState().sidebar.open).toBe(false);
});
