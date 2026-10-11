import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RpcError, type RepaClient } from "@repa/base/client";

import { StoreProvider } from "../src/hooks/use-app-store";
import { createAppStore } from "../src/lib/store";
import { LearningSpacePage } from "../src/pages/learning-space";

afterEach(cleanup);

/** 模拟后端的最近空间记录：打开的空间移到最前。 */
function fakeBackend(recent: string[], options: { failOpen?: unknown; failList?: unknown } = {}) {
  let spaces = [...recent];
  const call = vi.fn((method: string, params: { root?: string }) => {
    if (method === "space.list") {
      if (options.failList) {
        const error = options.failList;
        options.failList = undefined;
        return Promise.reject(error);
      }
      return Promise.resolve([...spaces]);
    }
    if (method === "space.open") {
      if (options.failOpen) return Promise.reject(options.failOpen);
      const root = params.root ?? "";
      spaces = [root, ...spaces.filter((item) => item !== root)];
      return Promise.resolve({ root });
    }
    return Promise.reject(new Error(`未模拟的方法 ${method}`));
  });
  return { call, client: { call } as unknown as RepaClient };
}

function renderPage(client: RepaClient) {
  const store = createAppStore();
  store.getState().setClient(client);
  render(<StoreProvider store={store}><LearningSpacePage /></StoreProvider>);
  return store;
}

it("列出最近空间，显示文件夹名和完整路径", async () => {
  const { client } = fakeBackend(["/notes/physics", "/notes/history"]);
  renderPage(client);

  const list = await screen.findByRole("list", { name: "最近打开" });
  const items = within(list).getAllByRole("button");
  expect(items.map((item) => item.textContent)).toEqual(["physics/notes/physics", "history/notes/history"]);
  expect(items.every((item) => item.getAttribute("aria-pressed") === "false")).toBe(true);
});

it("点击最近空间后打开它，并按后端结果更新顺序", async () => {
  const { call, client } = fakeBackend(["/notes/physics", "/notes/history"]);
  renderPage(client);

  fireEvent.click(await screen.findByRole("button", { name: /history/ }));

  expect(await screen.findByText("已打开 history，会话界面正在接入。")).toBeTruthy();
  expect(call).toHaveBeenCalledWith("space.open", { root: "/notes/history" });
  const items = within(screen.getByRole("list", { name: "最近打开" })).getAllByRole("button");
  expect(items[0]?.textContent).toContain("/notes/history");
  expect(items[0]?.getAttribute("aria-pressed")).toBe("true");
});

it("打开失败时显示后端说明，列表仍可再次选择", async () => {
  const { client } = fakeBackend(["/notes/physics"], {
    failOpen: new RpcError(-32000, "目录不存在", { code: "space_missing" }),
  });
  renderPage(client);

  const item = await screen.findByRole("button", { name: /physics/ });
  fireEvent.click(item);

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("无法打开 physics");
  expect(alert.textContent).toContain("目录不存在");
  expect((item as HTMLButtonElement).disabled).toBe(false);
});

it("读取最近空间失败时显示原因，重试后列出空间", async () => {
  const { client } = fakeBackend(["/notes/physics"], { failList: new Error("读取超时") });
  renderPage(client);

  expect((await screen.findByRole("alert")).textContent).toContain("读取超时");
  fireEvent.click(screen.getByRole("button", { name: "重试" }));

  expect(await screen.findByRole("button", { name: /physics/ })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("第一次使用时只引导选择文件夹，不显示最近列表", async () => {
  const { client } = fakeBackend([]);
  renderPage(client);

  expect(await screen.findByRole("heading", { name: "开始第一个学习空间" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "选择文件夹" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "最近打开" })).toBeNull();
});

it("有最近空间时选择文件夹退为次要操作", async () => {
  const { client } = fakeBackend(["/notes/physics"]);
  renderPage(client);

  await screen.findByRole("list", { name: "最近打开" });
  expect(screen.getByRole("button", { name: "选择其他文件夹" }).getAttribute("data-variant")).toBe("outline");
});

it("读取失败时选择文件夹是主要入口", async () => {
  const { client } = fakeBackend([], { failList: new Error("读取超时") });
  renderPage(client);

  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "选择文件夹" }).getAttribute("data-variant")).toBe("default");
});
