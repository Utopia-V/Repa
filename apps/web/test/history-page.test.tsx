import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { RpcError } from "@repa/base/client";
import type { Result } from "@repa/base/protocol";

import { StoreProvider } from "../src/hooks/use-app-store";
import { createAppStore, HISTORY_LIMIT, type HistoryRevision } from "../src/lib/store";
import { routes } from "../src/routes";
import { fakeClient } from "./fake-client";
import { mockMatchMedia } from "./match-media";

beforeEach(() => { mockMatchMedia(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

type Undo = Result<"history.undo">;

/**
 * 模拟后端的空间历史：revisions 从旧到新，第一条是初始状态。
 * 撤回默认恢复目标的全部文件并记一次 undo 提交；undo 可以换成测试控制的结果。
 */
function historyBackend() {
  const revisions: HistoryRevision[] = [];
  function commit(source: HistoryRevision["source"], changes: HistoryRevision["changes"]): HistoryRevision {
    const revision = {
      id: (revisions.length + 1).toString(16).padStart(40, "0"),
      parent: revisions.at(-1)?.id ?? null,
      source,
      timestamp: new Date(Date.UTC(2026, 9, 12, 8, revisions.length)).toISOString(),
      changes,
    };
    revisions.push(revision);
    return revision;
  }
  const state = {
    failList: undefined as unknown,
    undo(revision: string): Promise<Undo> {
      const target = revisions.find((item) => item.id === revision)!;
      const undone = commit({ kind: "undo", revision }, target.changes.map((change) => ({ kind: "modified", path: change.path })));
      return Promise.resolve({ revision: undone.id, restored: target.changes.map((change) => change.path), conflicts: [] });
    },
  };
  const call = vi.fn((method: string, params: Record<string, unknown>) => {
    switch (method) {
      case "space.open":
        return Promise.resolve({ root: params.root });
      case "space.list":
      case "session.list":
        return Promise.resolve([]);
      case "history.list": {
        if (state.failList) return Promise.reject(state.failList);
        const newest = [...revisions].reverse().slice(0, Number(params.limit ?? 100));
        return Promise.resolve(newest.map(({ changes: _changes, ...revision }) => revision));
      }
      case "history.changes": {
        const start = params.since === undefined ? 0 : revisions.findIndex((item) => item.id === params.since) + 1;
        return Promise.resolve({ revision: revisions.at(-1)!.id, revisions: structuredClone(revisions.slice(start)) });
      }
      case "history.undo":
        return state.undo(String(params.revision));
      default:
        return Promise.reject(new Error(`未模拟的方法 ${method}`));
    }
  });
  return { call, revisions, commit, state, ...fakeClient(call) };
}

async function renderHistory(backend: ReturnType<typeof historyBackend>, path = "/history") {
  const store = createAppStore();
  store.getState().setClient(backend.client);
  await store.getState().openSpace("/notes/calculus");
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<StoreProvider store={store}><RouterProvider router={router} /></StoreProvider>);
  return { store, router };
}

const records = () => screen.getAllByRole("article");
const record = (name: string) => screen.getByRole("article", { name });
const files = (article: HTMLElement) => within(within(article).getByRole("list", { name: "改动的文件" }))
  .getAllByRole("listitem").map((item) => item.textContent);

/** 一个打开过的空间：初始状态、Agent 改了两个文件、一次没改文件的运行、插件重命名。 */
function sampleHistory() {
  const backend = historyBackend();
  backend.commit({ kind: "external" }, [{ kind: "added", path: "notes.md" }]);
  const run = backend.commit({ kind: "agent", runId: "r1" }, [{ kind: "added", path: "导数.md" }, { kind: "modified", path: "notes.md" }]);
  backend.commit({ kind: "agent", runId: "r2" }, []);
  backend.commit({ kind: "plugin", pluginId: "learning" }, [{ kind: "renamed", previousPath: "导数.md", path: "微积分/导数.md" }]);
  return { backend, run };
}

it("列出有文件变化的修改，最新的在前并标明来源；没改文件的运行不列出，初始状态只注明开始时间", async () => {
  const { backend } = sampleHistory();
  backend.commit({ kind: "external" }, Array.from({ length: 10 }, (_, i) => ({ kind: "deleted" as const, path: `草稿/${i}.md` })));
  await renderHistory(backend);

  await screen.findByRole("heading", { name: "外部程序" });
  expect(records().map((article) => within(article).getByRole("heading").textContent)).toEqual(["外部程序", "插件 learning", "Agent"]);
  expect(files(record("Agent"))).toEqual(["新增导数.md", "修改notes.md"]);
  expect(files(record("插件 learning"))).toEqual(["重命名导数.md → 微积分/导数.md"]);
  expect(screen.getByText(/开始记录，更早的修改不在历史里/)).toBeTruthy();

  // 一次改了很多文件时先显示一部分。
  const many = record("外部程序");
  expect(files(many)).toHaveLength(8);
  fireEvent.click(within(many).getByRole("button", { name: "显示其余 2 个文件" }));
  expect(files(many)).toHaveLength(10);
});

it("确认后撤回一次修改，显示恢复了几个文件，撤回本身也出现在列表里；取消不撤回", async () => {
  const { backend, run } = sampleHistory();
  await renderHistory(backend);
  const agent = await screen.findByRole("article", { name: "Agent" });

  fireEvent.click(within(agent).getByRole("button", { name: "撤回" }));
  let dialog = await screen.findByRole("dialog", { name: "撤回这次修改？" });
  expect(within(dialog).getByText(/改动的 2 个文件会恢复到修改之前/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(backend.call).not.toHaveBeenCalledWith("history.undo", expect.anything());

  fireEvent.click(within(agent).getByRole("button", { name: "撤回" }));
  dialog = await screen.findByRole("dialog", { name: "撤回这次修改？" });
  fireEvent.click(within(dialog).getByRole("button", { name: "撤回" }));

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(backend.call).toHaveBeenCalledWith("history.undo", { revision: run.id });
  const notice = screen.getByRole("status");
  expect(notice.textContent).toContain("已撤回");
  expect(notice.textContent).toContain("恢复了 2 个文件。");
  const undone = records()[0]!;
  expect(within(undone).getByRole("heading").textContent).toBe("撤回");
  expect(within(undone).getByText(/的修改（Agent）/)).toBeTruthy();
});

it("之后又有变化的文件不被覆盖，结果里列出没有撤回的文件", async () => {
  const { backend } = sampleHistory();
  backend.state.undo = () => Promise.resolve({ revision: "f".repeat(40), restored: ["导数.md"], conflicts: ["notes.md"] });
  await renderHistory(backend);

  fireEvent.click(within(await screen.findByRole("article", { name: "Agent" })).getByRole("button", { name: "撤回" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "撤回" }));

  const notice = await screen.findByRole("alert");
  expect(notice.textContent).toContain("部分文件没有撤回");
  expect(notice.textContent).toContain("恢复了 1 个文件。");
  expect(within(within(notice).getByRole("list", { name: "没有撤回的文件" })).getAllByRole("listitem").map((item) => item.textContent))
    .toEqual(["notes.md"]);
});

it("撤回进行中不能关闭对话框；失败时对话框保留并显示原因，可以重试", async () => {
  const { backend } = sampleHistory();
  let fail: ((error: unknown) => void) | undefined;
  const succeed = backend.state.undo;
  backend.state.undo = () => new Promise((_, reject) => { fail = reject; });
  await renderHistory(backend);

  fireEvent.click(within(await screen.findByRole("article", { name: "Agent" })).getByRole("button", { name: "撤回" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "撤回" }));
  const pending = await within(dialog).findByRole("button", { name: "正在撤回…" });
  expect((pending as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.getByRole("dialog")).toBe(dialog);

  await act(async () => fail?.(new RpcError(-32000, "历史修订不存在", { code: "revision_not_found" })));
  expect(within(dialog).getByRole("alert").textContent).toContain("历史修订不存在");

  backend.state.undo = succeed;
  fireEvent.click(within(dialog).getByRole("button", { name: "撤回" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByRole("status").textContent).toContain("已撤回");
});

it("读取失败时显示原因，重试后列出修改", async () => {
  const { backend } = sampleHistory();
  backend.state.failList = new RpcError(-32000, "请先打开空间", { code: "space_not_open" });
  await renderHistory(backend);

  const notice = await screen.findByRole("alert");
  expect(notice.textContent).toContain("无法读取修改历史");
  backend.state.failList = undefined;
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByRole("article", { name: "Agent" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("记录多于一次读取的数量时只列出最近的，并注明更早的没有显示", async () => {
  const backend = historyBackend();
  backend.commit({ kind: "external" }, []);
  for (let i = 0; i < HISTORY_LIMIT + 5; i++) backend.commit({ kind: "plugin", pluginId: "learning" }, [{ kind: "modified", path: `${i}.md` }]);
  await renderHistory(backend);

  await screen.findByText(`只列出最近 ${HISTORY_LIMIT} 条记录里的修改，更早的没有显示。`);
  expect(records()).toHaveLength(HISTORY_LIMIT);
  expect(screen.queryByText(/开始记录/)).toBeNull();
});

it("打开空间后侧栏出现 History，进入修改历史页；没有打开空间时回到 Learning Space", async () => {
  const { backend } = sampleHistory();
  const { router } = await renderHistory(backend, "/learning-space");
  const navigation = screen.getByRole("navigation", { name: "主导航" });
  fireEvent.click(within(navigation).getByRole("link", { name: "History" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/history"));
  expect(await screen.findByRole("heading", { name: "修改历史" })).toBeTruthy();
  cleanup();
  localStorage.clear();

  const empty = createMemoryRouter(routes, { initialEntries: ["/history"] });
  render(<StoreProvider store={createAppStore()}><RouterProvider router={empty} /></StoreProvider>);
  await waitFor(() => expect(empty.state.location.pathname).toBe("/learning-space"));
  expect(screen.queryByRole("link", { name: "History" })).toBeNull();
});

it("换空间时清空上一个空间的修改历史", async () => {
  const { backend } = sampleHistory();
  const store = createAppStore();
  store.getState().setClient(backend.client);
  await store.getState().openSpace("/notes/calculus");
  await store.getState().loadHistory();
  expect(store.getState().resources.history.status).toBe("ready");
  await store.getState().openSpace("/notes/algebra");
  expect(store.getState().resources.history).toEqual({ status: "idle" });
});
