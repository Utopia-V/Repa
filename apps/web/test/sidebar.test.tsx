import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { routes } from "../src/routes";
import { mockMatchMedia } from "./match-media";

beforeEach(() => { mockMatchMedia(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderWorkspace(path = "/") {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

it("默认进入 Learning Space，侧栏仅有两个栏目", async () => {
  const router = renderWorkspace();
  await waitFor(() => expect(router.state.location.pathname).toBe("/learning-space"));
  expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(["Learning Space", "Settings"]);
  expect(screen.getByRole("link", { name: "Learning Space" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("button", { name: "开始学习" })).toBeTruthy();
  expect(screen.queryByText("尚未选择学习空间")).toBeNull();
});

it("切换栏目和返回历史更新当前项及内容", async () => {
  const router = renderWorkspace("/learning-space");
  fireEvent.click(screen.getByRole("link", { name: "Settings" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
  expect(screen.getByRole("link", { name: "Settings" }).getAttribute("aria-current")).toBe("page");
  expect(screen.queryByRole("button", { name: "开始学习" })).toBeNull();
  await act(() => router.navigate(-1));
  expect(screen.getByRole("link", { name: "Learning Space" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("button", { name: "开始学习" })).toBeTruthy();
});

it("导航抽屉可关闭、恢复焦点，选择目标后关闭并保留当前路由", async () => {
  mockMatchMedia(true);
  const router = renderWorkspace("/learning-space");
  const trigger = screen.getByRole("button", { name: "打开导航" });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "工作台导航" });
  fireEvent.click(within(dialog).getByRole("link", { name: "Settings" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
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


it("折叠为图标栏后保留可访问名称与当前项", () => {
  renderWorkspace("/learning-space");
  fireEvent.click(screen.getByRole("button", { name: "收起导航" }));
  const sidebar = document.querySelector('[data-slot="sidebar"]');
  expect(sidebar?.getAttribute("data-state")).toBe("collapsed");
  expect(sidebar?.getAttribute("data-collapsible")).toBe("icon");
  // 文字由 CSS 在视觉上隐藏，但链接名称和当前项仍可被辅助技术识别。
  expect(screen.getByRole("link", { name: "Learning Space" }).getAttribute("aria-current")).toBe("page");
  // 折叠时用 title 为鼠标用户补回标签，展开后移除。
  expect(screen.getByRole("link", { name: "Settings" }).getAttribute("title")).toBe("Settings");
  fireEvent.click(screen.getByRole("button", { name: "打开导航" }));
  expect(screen.getByRole("link", { name: "Settings" }).getAttribute("title")).toBeNull();
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
