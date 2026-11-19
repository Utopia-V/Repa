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
import { t } from "../src/lib/strings";

beforeEach(() => { mockMatchMedia(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

function renderWorkspace(path = "/", store = createAppStore()) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<StoreProvider store={store}><RouterProvider router={router} /></StoreProvider>);
  return router;
}

it("默认进入学习空间，侧栏有“学习空间”和“设置”两个栏目", async () => {
  const router = renderWorkspace();
  await waitFor(() => expect(router.state.location.pathname).toBe("/learning-space"));
  expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(["学习空间", "设置"]);
  expect(screen.getByRole("link", { name: "学习空间" }).getAttribute("aria-current")).toBe("page");
});

it("打开空间后 学习空间 一项换成这个空间，下面是新会话，History 和 Settings 排在最后；点击空间回到选空间页", async () => {
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
  expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(["学习空间", "设置"]);

  await act(() => store.getState().openSpace("/notes/calculus"));
  const navigation = screen.getByRole("navigation", { name: "主导航" });
  expect(within(navigation).getAllByRole("link").map((link) => link.textContent)).toEqual(["calculus", t("sidebar.newSpace.action"), "修改历史", "设置"]);
  expect(within(navigation).queryByRole("button", { name: /关闭空间/ })).toBeNull();
  const space = within(navigation).getByRole("link", { name: "calculus" });
  expect(space.getAttribute("title")).toBe("/notes/calculus");
  expect(space.getAttribute("aria-current")).toBe("page");

  fireEvent.click(within(navigation).getByRole("button", { name: "新会话" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/conversation"));
  // 当前项标在空间下面的会话上；还没有会话时是新会话。
  await waitFor(() => expect(within(navigation).getByRole("button", { name: "新会话" }).getAttribute("aria-current")).toBe("true"));
  expect(space.getAttribute("aria-current")).toBeNull();

  fireEvent.click(space);
  await waitFor(() => expect(router.state.location.pathname).toBe("/learning-space"));
  expect(space.getAttribute("aria-current")).toBe("page");
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
          { id: "a", createdAt: at, updatedAt: "2026-10-12T02:00:00.000Z", preview: "导数是什么", agent: "general" },
          { id: "b", createdAt: at, updatedAt: "2026-10-12T01:00:00.000Z", preview: "极限怎么求", agent: "general" },
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
  // 进的是一段还没建立的空会话：对话页读完了、没有接着任何会话，记录区里一条也没有。
  // 不能只看“b 的记录”不在页面上：上一步转到了设置页，那时它本来就不在。
  await waitFor(() => expect(store.getState().conversation.status).toBe("ready"));
  expect(store.getState().conversation.sessionId).toBeUndefined();
  expect(screen.getByRole("region", { name: "对话记录" }).textContent).toBe("");
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

it("在选空间页关闭当前空间，侧栏回到 学习空间；运行中不能关，关闭失败时显示原因并可以再关", async () => {
  let finish: (() => void) | undefined;
  let closeFails = true;
  const call = vi.fn((method: string, params: Record<string, unknown>) => {
    switch (method) {
      case "space.open":
        return Promise.resolve({ root: params.root });
      case "space.list":
        return Promise.resolve(["/notes/calculus"]);
      case "session.list":
      case "session.history":
      case "backup.list":
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
  const router = renderWorkspace("/learning-space", store);
  const navigation = screen.getByRole("navigation", { name: "主导航" });
  const workspace = screen.getByRole("main");
  const close = await within(workspace).findByRole("button", { name: "关闭空间 calculus" });

  act(() => { void store.getState().sendMessage("继续"); });
  await waitFor(() => expect(finish).toBeDefined());
  await waitFor(() => expect((close as HTMLButtonElement).disabled).toBe(true));
  await act(async () => { finish?.(); });
  await waitFor(() => expect((close as HTMLButtonElement).disabled).toBe(false));

  fireEvent.click(close);
  expect((await within(workspace).findByRole("alert")).textContent).toContain("关闭 calculus 时出错");
  expect(store.getState().space).toBe("/notes/calculus");

  fireEvent.click(close);
  await waitFor(() => expect(store.getState().space).toBeUndefined());
  expect(call.mock.calls.filter(([method]) => method === "space.close")).toHaveLength(2);
  expect(router.state.location.pathname).toBe("/learning-space");
  expect(within(navigation).queryByRole("link", { name: "calculus" })).toBeNull();
  expect(within(navigation).getByRole("link", { name: "学习空间" }).getAttribute("aria-current")).toBe("page");
  expect(within(workspace).queryByRole("button", { name: /关闭空间/ })).toBeNull();
  expect(within(workspace).queryByRole("alert")).toBeNull();
});

it("导航抽屉可关闭、恢复焦点，选择目标后关闭并保留当前路由", async () => {
  mockMatchMedia(true);
  const router = renderWorkspace("/missing");
  const trigger = screen.getByRole("button", { name: "打开导航" });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "工作台导航" });
  fireEvent.click(within(dialog).getByRole("link", { name: "学习空间" }));
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
  expect(screen.getByRole("link", { name: "学习空间" }).getAttribute("aria-current")).toBe("page");
  // 折叠时用 title 为鼠标用户补回标签，展开后移除。
  expect(screen.getByRole("link", { name: "学习空间" }).getAttribute("title")).toBe("学习空间");
  fireEvent.click(screen.getByRole("button", { name: "打开导航" }));
  expect(screen.getByRole("link", { name: "学习空间" }).getAttribute("title")).toBeNull();
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

it("侧栏先列当前空间里的课，再列最近的空间：点别的空间就换过去，运行中不能换；打开了空间时新建课程建在这个空间里；会话只列学习者自己开的通用对话", async () => {
  const at = "2026-10-12T00:00:00.000Z";
  let finish: (() => void) | undefined;
  const recent = ["/home/me/Repa/操作系统", "/home/me/Repa/线性代数", "/notes/a", "/notes/b", "/notes/c", "/notes/d", "/notes/e"];
  const call = vi.fn((method: string, params: Record<string, unknown>) => {
    switch (method) {
      case "space.open":
        return Promise.resolve({ root: params.root, opening: `o-${String(params.root)}`, plugins: [] });
      case "space.list":
        return Promise.resolve(recent);
      case "space.browse":
        return Promise.resolve({ path: "/home/me", parent: "/home", space: false, truncated: false, entries: [] });
      case "plugin.list":
        return Promise.resolve([]);
      case "session.list":
        return Promise.resolve(params === undefined ? [] : [
          { id: "own", createdAt: at, updatedAt: at, preview: "自己开的对话", agent: "general" },
          { id: "tutor", createdAt: at, updatedAt: at, preview: "问辅导的一句", agent: "learning-tutor" },
          { id: "making", createdAt: at, updatedAt: at, preview: "我把课件放进了 materials/", agent: "general" },
        ]);
      case "session.history":
        return Promise.resolve([]);
      case "session.create":
        return Promise.resolve({ id: "s1", createdAt: at, updatedAt: at, agent: "general" });
      case "session.send":
        return new Promise((resolve) => { finish = () => resolve(null); });
      default:
        return Promise.reject(new Error(`未模拟的方法 ${method}`));
    }
  });
  const store = createAppStore();
  store.getState().setClient(fakeClient(call).client);
  await act(() => store.getState().openSpace("/home/me/Repa/操作系统"));
  // 学习插件记下的做课对话（building.get 的 sessionId）。
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  store.setState((state) => ({ learning: { ...state.learning, building: { key: null, folder: null, course: null, parts: [], expansion: null, lastFailure: null, cost: { requests: 0, usage: zero, cost: 0, unpriced: zero }, sessionId: "making" },
    courses: { canCreate: true, courses: [
      { key: "c1", folder: "courses/操作系统原理", bundled: false, title: "操作系统原理", learnable: true, missing: false },
      { key: "c2", folder: "courses/编译", bundled: false, title: null, learnable: false, missing: false },
    ] } } }));
  const router = renderWorkspace("/learning-space", store);
  const navigation = screen.getByRole("navigation", { name: "主导航" });

  // 当前空间里的课：有标题的写标题，还没做好的写文件夹名。
  expect(within(navigation).getByRole("button", { name: "操作系统原理" })).toBeTruthy();
  expect(within(navigation).getByRole("button", { name: "编译" })).toBeTruthy();
  // 最近的空间；当前空间进选空间页（在那里看全部），下面只有自己开的通用对话。
  await within(navigation).findByRole("button", { name: "线性代数" });
  expect(within(navigation).getByRole("link", { name: "操作系统" }).getAttribute("href")).toBe("/learning-space");
  expect(within(navigation).queryByRole("button", { name: "e" })).toBeNull();
  expect(await within(navigation).findByRole("button", { name: "自己开的对话" })).toBeTruthy();
  expect(within(navigation).queryByRole("button", { name: "问辅导的一句" })).toBeNull();
  expect(within(navigation).queryByRole("button", { name: "我把课件放进了 materials/" })).toBeNull();

  fireEvent.click(within(navigation).getByRole("link", { name: t("sidebar.newSpace.action") }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/new-space"));
  expect(screen.getByRole("heading", { name: t("learningSpace.new.title") })).toBeTruthy();
  expect(screen.getByLabelText(t("learningSpace.first.name.label"))).toBeTruthy();
  // 课建在当前空间里，不再选文件夹。
  expect(screen.queryByRole("button", { name: "选择文件夹" })).toBeNull();

  // 运行中不能换空间，原因在提示里。
  act(() => { void store.getState().sendMessage("你好"); });
  await waitFor(() => expect(finish).toBeDefined());
  const other = within(navigation).getByRole("button", { name: "线性代数" }) as HTMLButtonElement;
  expect(other.disabled).toBe(true);
  expect(other.getAttribute("title")).toBe(t("learningSpace.recent.running.hint"));
  await act(async () => { finish?.(); });

  await waitFor(() => expect(other.disabled).toBe(false));
  fireEvent.click(other);
  await waitFor(() => expect(store.getState().space).toBe("/home/me/Repa/线性代数"));
  await waitFor(() => expect(router.state.location.pathname).toBe("/conversation"));
});
