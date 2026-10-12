import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMemoryRouter } from "react-router";
import { RpcError } from "@repa/base/client";
import { RouterProvider } from "react-router/dom";
import { StoreProvider } from "../src/hooks/use-app-store";
import { createAppStore } from "../src/lib/store";
import { routes } from "../src/routes";
import { fakeClient } from "./fake-client";
import { mockMatchMedia } from "./match-media";

beforeEach(() => { mockMatchMedia(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

function renderWorkspace(path = "/", store = createAppStore()) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<StoreProvider store={store}><RouterProvider router={router} /></StoreProvider>);
  return router;
}

it("默认进入 Learning Space，侧栏有 Learning Space 和 Settings 两个栏目", async () => {
  const router = renderWorkspace();
  await waitFor(() => expect(router.state.location.pathname).toBe("/learning-space"));
  expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(["Learning Space", "Settings"]);
  expect(screen.getByRole("link", { name: "Learning Space" }).getAttribute("aria-current")).toBe("page");
});

it("打开空间后 Learning Space 一项换成这个空间，下面是新会话，History 和 Settings 排在最后；点击空间进入对话页，换空间回到选空间页", async () => {
  const call = vi.fn((method: string, params: Record<string, unknown>) => {
    switch (method) {
      case "space.open":
        return Promise.resolve({ root: params.root });
      case "space.list":
      case "session.list":
        return Promise.resolve([]);
      default:
        return Promise.reject(new Error(`未模拟的方法 ${method}`));
    }
  });
  const store = createAppStore();
  store.getState().setClient(fakeClient(call).client);
  const router = renderWorkspace("/learning-space", store);
  expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(["Learning Space", "Settings"]);

  await act(() => store.getState().openSpace("/notes/calculus"));
  const navigation = screen.getByRole("navigation", { name: "主导航" });
  expect(within(navigation).getAllByRole("link").map((link) => link.getAttribute("aria-label") ?? link.textContent)).toEqual(["calculus", "换空间", "History", "Settings"]);
  const space = within(navigation).getByRole("link", { name: "calculus" });
  expect(space.getAttribute("title")).toBe("/notes/calculus");
  fireEvent.click(space);

  await waitFor(() => expect(router.state.location.pathname).toBe("/conversation"));
  // 当前项标在空间下面的会话上；还没有会话时是新会话。
  await waitFor(() => expect(within(navigation).getByRole("button", { name: "新会话" }).getAttribute("aria-current")).toBe("true"));
  expect(space.getAttribute("aria-current")).toBeNull();

  fireEvent.click(within(navigation).getByRole("link", { name: "换空间" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/learning-space"));
  expect(within(navigation).getByRole("link", { name: "换空间" }).getAttribute("aria-current")).toBe("page");
  expect(within(navigation).getByRole("link", { name: "calculus" })).toBeTruthy();
});

it("空间下面列出它的会话，点击打开；新会话从任意页面开始一个空会话；运行中不能切换", async () => {
  const at = "2026-10-12T00:00:00.000Z";
  let finish: (() => void) | undefined;
  const call = vi.fn((method: string, params: Record<string, unknown>) => {
    switch (method) {
      case "space.open":
        return Promise.resolve({ root: params.root });
      case "space.list":
        return Promise.resolve([]);
      case "session.list":
        return Promise.resolve([
          { id: "a", createdAt: at, updatedAt: "2026-10-12T02:00:00.000Z", preview: "导数是什么" },
          { id: "b", createdAt: at, updatedAt: "2026-10-12T01:00:00.000Z", preview: "极限怎么求" },
        ]);
      case "session.history":
        return Promise.resolve([{ id: `${String(params.sessionId)}-u`, type: "user", timestamp: at, text: `${String(params.sessionId)} 的记录` }]);
      case "session.send":
        return new Promise((resolve) => { finish = () => resolve(null); });
      default:
        return Promise.reject(new Error(`未模拟的方法 ${method}`));
    }
  });
  const store = createAppStore();
  store.getState().setClient(fakeClient(call).client);
  await act(() => store.getState().openSpace("/notes/calculus"));
  const router = renderWorkspace("/learning-space", store);
  const navigation = screen.getByRole("navigation", { name: "主导航" });

  await within(navigation).findByRole("button", { name: "导数是什么" });
  const sessions = within(navigation).getByRole("button", { name: "新会话" }).closest("ul")!;
  expect(within(sessions).getAllByRole("button").map((button) => button.textContent)).toEqual(["新会话", "导数是什么", "极限怎么求"]);
  fireEvent.click(within(sessions).getByRole("button", { name: "极限怎么求" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/conversation"));
  expect(await screen.findByText("b 的记录")).toBeTruthy();
  expect(within(sessions).getByRole("button", { name: "极限怎么求" }).getAttribute("aria-current")).toBe("true");

  await act(() => router.navigate("/settings"));
  fireEvent.click(within(sessions).getByRole("button", { name: "新会话" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/conversation"));
  expect(await screen.findByText("这是一个新会话。说说你想学什么，或者直接提问。")).toBeTruthy();
  expect(within(sessions).getByRole("button", { name: "新会话" }).getAttribute("aria-current")).toBe("true");
  expect(within(sessions).getByRole("button", { name: "极限怎么求" }).getAttribute("aria-current")).toBeNull();

  fireEvent.click(within(sessions).getByRole("button", { name: "导数是什么" }));
  await screen.findByText("a 的记录");
  act(() => { void store.getState().sendMessage("继续"); });
  await waitFor(() => expect(finish).toBeDefined());
  expect((within(sessions).getByRole("button", { name: "极限怎么求" }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(sessions).getByRole("button", { name: "新会话" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { finish?.(); });
});

it("关闭当前空间后回到 Learning Space；运行中不能关，关闭失败时显示原因并可以再关", async () => {
  let finish: (() => void) | undefined;
  let closeFails = true;
  const call = vi.fn((method: string, params: Record<string, unknown>) => {
    switch (method) {
      case "space.open":
        return Promise.resolve({ root: params.root });
      case "space.list":
      case "session.list":
      case "session.history":
        return Promise.resolve([]);
      case "session.create":
        return Promise.resolve({ id: "s1", createdAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:00:00.000Z" });
      case "session.send":
        return new Promise((resolve) => { finish = () => resolve(null); });
      case "space.close":
        if (closeFails) {
          closeFails = false;
          return Promise.reject(new RpcError(-32603, "Internal error"));
        }
        return Promise.resolve(null);
      default:
        return Promise.reject(new Error(`未模拟的方法 ${method}`));
    }
  });
  const store = createAppStore();
  store.getState().setClient(fakeClient(call).client);
  await act(() => store.getState().openSpace("/notes/calculus"));
  const router = renderWorkspace("/conversation", store);
  const navigation = screen.getByRole("navigation", { name: "主导航" });
  const close = within(navigation).getByRole("button", { name: "关闭空间 calculus" });
  await screen.findByText("这是一个新会话。说说你想学什么，或者直接提问。");

  act(() => { void store.getState().sendMessage("继续"); });
  await waitFor(() => expect(finish).toBeDefined());
  await waitFor(() => expect((close as HTMLButtonElement).disabled).toBe(true));
  await act(async () => { finish?.(); });
  await waitFor(() => expect((close as HTMLButtonElement).disabled).toBe(false));

  fireEvent.click(close);
  expect((await within(navigation).findByRole("alert")).textContent).toContain("关闭空间时出错");
  expect(router.state.location.pathname).toBe("/conversation");

  fireEvent.click(close);
  await waitFor(() => expect(router.state.location.pathname).toBe("/learning-space"));
  expect(call.mock.calls.filter(([method]) => method === "space.close")).toHaveLength(2);
  expect(within(navigation).queryByRole("link", { name: "calculus" })).toBeNull();
  await waitFor(() => expect(within(navigation).getByRole("link", { name: "Learning Space" }).getAttribute("aria-current")).toBe("page"));
  expect(within(navigation).queryByRole("alert")).toBeNull();
  expect(store.getState().space).toBeUndefined();
});

it("导航抽屉可关闭、恢复焦点，选择目标后关闭并保留当前路由", async () => {
  mockMatchMedia(true);
  const router = renderWorkspace("/missing");
  const trigger = screen.getByRole("button", { name: "打开导航" });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "工作台导航" });
  fireEvent.click(within(dialog).getByRole("link", { name: "Learning Space" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/learning-space"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("回到桌面宽度时释放抽屉的模态焦点约束", async () => {
  const media = mockMatchMedia(true);
  renderWorkspace("/learning-space");
  fireEvent.click(screen.getByRole("button", { name: "打开导航" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  act(() => { media.matches = false; media.dispatchEvent(new Event("change")); });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});


it("Sidebar 的桌面开关可收起并重新打开导航", () => {
  renderWorkspace("/learning-space");
  fireEvent.click(screen.getByRole("button", { name: "收起导航" }));
  expect(document.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state")).toBe("collapsed");
  const openButtons = screen.getAllByRole("button", { name: "打开导航" });
  fireEvent.click(openButtons[openButtons.length - 1]!);
  expect(document.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state")).toBe("expanded");
});


it("刷新后保留桌面侧栏的收起状态和拖动出的宽度", () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  renderWorkspace("/learning-space");
  const rail = screen.getByRole("button", { name: "切换侧栏" });
  vi.spyOn(document.querySelector<HTMLElement>('[data-slot="sidebar-container"]')!, "getBoundingClientRect")
    .mockReturnValue({ width: 280 } as DOMRect);
  fireEvent.pointerDown(rail, { clientX: 280, button: 0 });
  fireEvent.pointerMove(rail, { clientX: 350 });
  fireEvent.pointerUp(rail);
  fireEvent.click(screen.getByRole("button", { name: "收起导航" }));
  cleanup();

  // 新的 store 相当于刷新页面，从浏览器存储恢复。
  renderWorkspace("/learning-space");
  expect(document.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state")).toBe("collapsed");
  expect(document.querySelector<HTMLElement>('[data-slot="sidebar-wrapper"]')?.style.getPropertyValue("--sidebar-width")).toContain("350px");
});


it("折叠为图标栏后保留可访问名称与当前项", () => {
  renderWorkspace("/learning-space");
  fireEvent.click(screen.getByRole("button", { name: "收起导航" }));
  const sidebar = document.querySelector('[data-slot="sidebar"]');
  expect(sidebar?.getAttribute("data-state")).toBe("collapsed");
  expect(sidebar?.getAttribute("data-collapsible")).toBe("icon");
  // 文字由 CSS 在视觉上隐藏，但链接名称和当前项仍可被辅助技术识别。
  expect(screen.getByRole("link", { name: "Learning Space" }).getAttribute("aria-current")).toBe("page");
  // 折叠时用 title 为鼠标用户补回标签，展开后移除。
  expect(screen.getByRole("link", { name: "Learning Space" }).getAttribute("title")).toBe("Learning Space");
  fireEvent.click(screen.getByRole("button", { name: "打开导航" }));
  expect(screen.getByRole("link", { name: "Learning Space" }).getAttribute("title")).toBeNull();
});


it("侧栏边缘把手可切换展开与收起", () => {
  renderWorkspace("/learning-space");
  const rail = screen.getByRole("button", { name: "切换侧栏" });
  fireEvent.click(rail);
  expect(document.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state")).toBe("collapsed");
  fireEvent.click(rail);
  expect(document.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state")).toBe("expanded");
});


it("拖动改宽、拖窄收起、向外展开，并清理拖动状态", () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  renderWorkspace("/learning-space");
  const rail = screen.getByRole("button", { name: "切换侧栏" });
  const wrapper = document.querySelector<HTMLElement>('[data-slot="sidebar-wrapper"]')!;
  const container = document.querySelector<HTMLElement>('[data-slot="sidebar-container"]')!;
  const sidebar = document.querySelector<HTMLElement>('[data-slot="sidebar"]')!;
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue({ width: 280 } as DOMRect);
  fireEvent.pointerDown(rail, { clientX: 280, button: 0 });
  fireEvent.pointerMove(rail, { clientX: 350 });
  expect(wrapper.style.getPropertyValue("--sidebar-width")).toContain("350px");
  expect(document.body.style.userSelect).toBe("none");
  fireEvent.pointerUp(rail);
  fireEvent.click(rail);
  expect(sidebar.dataset.state).toBe("expanded");
  expect(document.body.style.userSelect).toBe("");
  expect(wrapper.dataset.resizing).toBeUndefined();
  fireEvent.pointerDown(rail, { clientX: 280, button: 0 });
  fireEvent.pointerMove(rail, { clientX: 190 });
  expect(wrapper.dataset.resizing).toBeUndefined();
  fireEvent.pointerUp(rail);
  expect(sidebar.dataset.state).toBe("collapsed");
  vi.mocked(container.getBoundingClientRect).mockReturnValue({ width: 56 } as DOMRect);
  fireEvent.pointerDown(rail, { clientX: 56, button: 0 });
  fireEvent.pointerMove(rail, { clientX: 80 });
  fireEvent.pointerMove(rail, { clientX: 100 });
  expect(sidebar.dataset.state).toBe("collapsed");
  fireEvent.pointerMove(rail, { clientX: 210 });
  expect(sidebar.dataset.state).toBe("expanded");
  expect(wrapper.dataset.resizing).toBeUndefined();
  fireEvent.pointerCancel(rail);
  expect(document.body.style.userSelect).toBe("");
  fireEvent.keyDown(rail, { key: "Home" });
  expect(wrapper.style.getPropertyValue("--sidebar-width")).toContain("280px");
});
