import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { RpcError } from "@repa/base/client";
import type { Result } from "@repa/base/protocol";
import type { LearningState } from "@repa/learning/protocol";

import { StoreProvider } from "../src/hooks/use-app-store";
import { dateTime, fileSize } from "../src/lib/format";
import { createAppStore } from "../src/lib/store";
import { routes } from "../src/routes";
import { fakeClient } from "./fake-client";
import { mockMatchMedia } from "./match-media";

// 备份、恢复与导出的文字在测试里换成键名（参数照常跟在后面），按键名找元素：改一句话的措辞不必改测试。
vi.mock("../src/strings/zh-CN", async (importOriginal) => {
  const { strings } = await importOriginal<typeof import("../src/strings/zh-CN")>();
  const byKey = /^(settings\.(backup|export)|export\.|learningSpace\.(backup|restore)|common\.(increase|decrease))/u;
  return {
    strings: Object.fromEntries(Object.entries(strings).map(([key, value]) => [key, byKey.test(key) ? key + (value.match(/\{\w+\}/gu) ?? []).join("") : value])),
  };
});

afterEach(() => { cleanup(); localStorage.clear(); });

const ROOT = "/home/learner/Repa/操作系统";
const at = 1_792_454_400_000;
const progress = { day: "2026-11-15", timeZone: "Asia/Shanghai", dailyGoalXp: 20, todayXp: 0, totalXp: 0, completedTopics: 0, totalTopics: 0, completionRate: 0, etaDate: null };
const state: LearningState = {
  revision: 3, serverNow: at, started: true, course: null, task: null, menu: null,
  restrictions: { kind: "none", tutorAllowed: false, referenceContentAllowed: false }, progress,
};
const regular = { id: "b2", createdAt: "2026-11-15T06:30:00.000Z", bytes: 2048, kind: "regular" as const };
const older = { id: "b1", createdAt: "2026-11-14T06:30:00.000Z", bytes: 1024, kind: "regular" as const };
const before = { id: "b3", createdAt: "2026-11-15T07:00:00.000Z", bytes: 4096, kind: "beforeRestore" as const };
const files = [
  { name: "records.jsonl", bytes: 5120, records: 12, redactions: 0 },
  { name: "learning.json", bytes: 120, redactions: 0 },
];
const withSessions = [...files, { name: "sessions/2026-11-15_s1.jsonl", bytes: 9000, records: 40, redactions: 2 }];

type Handler = (params: Record<string, unknown>) => Promise<unknown>;

/** 设置页与选空间页用到的方法；handlers 按“插件.方法”或底座方法名替换个别结果。 */
function backend(handlers: Record<string, Handler> = {}) {
  const call = vi.fn((method: string, params: Record<string, unknown>): Promise<unknown> => {
    const name = method === "plugin.call" ? `${params.pluginId as string}.${params.method as string}` : method;
    const replaced = handlers[name];
    if (replaced) return replaced(method === "plugin.call" ? params.input as Record<string, unknown> : params);
    switch (name) {
      case "space.open":
        return Promise.resolve({ root: params.root, opening: "opening-1", plugins: [] });
      case "space.close":
      case "backup.delete":
        return Promise.resolve(null);
      case "space.list":
        return Promise.resolve([ROOT]);
      case "model.list":
      case "model.providers":
      case "session.list":
      case "prompt.list":
      case "mcp.list":
        return Promise.resolve([]);
      case "model.getDefault":
        return Promise.resolve(null);
      case "settings.get":
        return Promise.resolve({ commandPolicy: "ask", recentSpaces: [ROOT], prompts: {}, backup: { intervalMinutes: 30, keep: 5 } });
      case "plugin.list":
        return Promise.resolve([{ id: "learning", source: "bundled", state: "running", pages: [], methods: [], tools: [] }]);
      case "backup.status":
        return Promise.resolve({ root: ROOT, lastSuccess: regular.createdAt, failure: null });
      case "backup.list":
        return Promise.resolve([{ root: ROOT, exists: true, backups: [before, regular, older] }]);
      case "learning.state.get":
        return Promise.resolve(state);
      case "learning.building.get":
        return Promise.resolve({ course: null, parts: [], expansion: null, lastFailure: null, cost: { requests: 0, usage: {}, cost: 0, unpriced: {} }, sessionId: null });
      case "learning.settings.get":
        return Promise.resolve({ autoExpand: true });
      case "learning.export.prepare":
        return Promise.resolve({ exportId: (params.input as { sessions: boolean }).sessions ? "e2" : "e1", files: (params.input as { sessions: boolean }).sessions ? withSessions : files });
      case "learning.export.create":
        return Promise.resolve({ path: "/home/learner/.config/repa/exports/repa-learning-export-20261115-143000.zip" });
      default:
        return Promise.reject(new Error(`未模拟的方法 ${name}`));
    }
  });
  return { call, ...fakeClient(call) };
}

function calls(call: ReturnType<typeof backend>["call"], name: string) {
  return call.mock.calls.flatMap(([method, params]) => {
    const full = method === "plugin.call" ? `${params.pluginId as string}.${params.method as string}` : method;
    return full === name ? [method === "plugin.call" ? params.input : params] : [];
  });
}

/** 以打开着 ROOT 的状态进入 path；space 为 false 时没有打开的空间。 */
function start(client: ReturnType<typeof backend>["client"], path: string, space = true) {
  mockMatchMedia(false);
  if (space) localStorage.setItem("repa.web.preferences", JSON.stringify({ state: { space: ROOT }, version: 0 }));
  const store = createAppStore();
  store.getState().setClient(client);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<StoreProvider store={store}><RouterProvider router={router} /></StoreProvider>);
  return { store, router };
}

it("导出学习数据：默认不带会话，先列出清单；勾选会话后重新预览，导出的是看过的那一份，做完显示文件路径", async () => {
  const { call, client } = backend();
  start(client, "/settings");

  fireEvent.click(await screen.findByRole("button", { name: "settings.export.action" }));
  const dialog = within(await screen.findByRole("dialog"));
  const list = await dialog.findByRole("list", { name: "export.files.label" });
  expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    `records.jsonl${fileSize(5120)} · export.file.records.label12`,
    `learning.json${fileSize(120)}`,
  ]);
  expect(calls(call, "learning.export.prepare")).toEqual([{ sessions: false }]);
  expect(dialog.getByRole("checkbox", { name: "export.sessions.label" }).getAttribute("aria-checked")).toBe("false");

  fireEvent.click(dialog.getByRole("checkbox", { name: "export.sessions.label" }));
  expect(await dialog.findByText("sessions/2026-11-15_s1.jsonl")).toBeTruthy();
  expect(dialog.getByText(/export\.file\.redactions\.label2/u)).toBeTruthy();
  expect(calls(call, "learning.export.prepare")).toEqual([{ sessions: false }, { sessions: true }]);

  fireEvent.click(dialog.getByRole("button", { name: "export.create.action" }));
  const path = await screen.findByLabelText("export.created.path.label");
  expect(path.textContent).toBe("/home/learner/.config/repa/exports/repa-learning-export-20261115-143000.zip");
  expect(calls(call, "learning.export.create")).toEqual([{ exportId: "e2" }]);
});

it("导出失败时如实显示原因，清单还在，可以再导出一次", async () => {
  let fail = true;
  const { call, client } = backend({
    "learning.export.create": () => {
      if (!fail) return Promise.resolve({ path: "/tmp/repa-learning-export-20261115-143000.zip" });
      fail = false;
      return Promise.reject(new RpcError(-32000, "读不到保存的凭据，无法脱敏", { code: "export_redaction_failed" }));
    },
  });
  start(client, "/settings");

  fireEvent.click(await screen.findByRole("button", { name: "settings.export.action" }));
  const dialog = within(await screen.findByRole("dialog"));
  await dialog.findByRole("list", { name: "export.files.label" });
  fireEvent.click(dialog.getByRole("button", { name: "export.create.action" }));
  const alert = await dialog.findByRole("alert");
  expect(alert.textContent).toContain("export.create.error");
  expect(alert.textContent).toContain("读不到保存的凭据，无法脱敏");
  expect(dialog.getByRole("list", { name: "export.files.label" })).toBeTruthy();

  fireEvent.click(dialog.getByRole("button", { name: "export.create.action" }));
  expect((await screen.findByLabelText("export.created.path.label")).textContent).toBe("/tmp/repa-learning-export-20261115-143000.zip");
  expect(calls(call, "learning.export.create")).toEqual([{ exportId: "e1" }, { exportId: "e1" }]);
});

it("预览已经失效时可以重新预览，再导出的是新的那一份", async () => {
  let previews = 0;
  const { call, client } = backend({
    "learning.export.prepare": () => Promise.resolve({ exportId: `p${++previews}`, files: [] }),
    "learning.export.create": (input) => input.exportId === "p1"
      ? Promise.reject(new RpcError(-32000, "这份预览已经失效，请重新预览后再导出", { code: "export_expired" }))
      : Promise.resolve({ path: "/tmp/repa-learning-export-20261115-143000.zip" }),
  });
  start(client, "/settings");

  fireEvent.click(await screen.findByRole("button", { name: "settings.export.action" }));
  const dialog = within(await screen.findByRole("dialog"));
  await vi.waitFor(() => expect((dialog.getByRole("button", { name: "export.create.action" }) as HTMLButtonElement).disabled).toBe(false));
  // 没有失效时不出现重新预览。
  expect(dialog.queryByRole("button", { name: "export.preview.retry.action" })).toBeNull();
  fireEvent.click(dialog.getByRole("button", { name: "export.create.action" }));
  expect((await dialog.findByRole("alert")).textContent).toContain("这份预览已经失效");

  fireEvent.click(dialog.getByRole("button", { name: "export.preview.retry.action" }));
  await vi.waitFor(() => expect(calls(call, "learning.export.prepare")).toHaveLength(2));
  expect(dialog.queryByRole("alert")).toBeNull();
  await vi.waitFor(() => expect((dialog.getByRole("button", { name: "export.create.action" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(dialog.getByRole("button", { name: "export.create.action" }));
  expect((await screen.findByLabelText("export.created.path.label")).textContent).toBe("/tmp/repa-learning-export-20261115-143000.zip");
  expect(calls(call, "learning.export.create")).toEqual([{ exportId: "p1" }, { exportId: "p2" }]);
});

it("没有打开空间时设置页没有导出，也不显示备份状态，只有间隔与份数", async () => {
  const { client } = backend();
  start(client, "/settings", false);

  expect(await screen.findByLabelText("settings.backup.interval.label")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "settings.export.action" })).toBeNull();
  expect(screen.queryByRole("button", { name: "settings.backup.now.action" })).toBeNull();
});

it("设置页显示最近一次备份的时间；立即备份没有变化时说明，失败时显示后端记下的原因，之后成功时原因消失", async () => {
  const { call, client, emit } = backend({
    "backup.create": () => Promise.resolve({ created: false, backup: regular }),
  });
  start(client, "/settings");

  const status = await screen.findByText(`settings.backup.lastSuccess.status${dateTime(regular.createdAt)}`);
  fireEvent.click(screen.getByRole("button", { name: "settings.backup.now.action" }));
  await waitFor(() => expect(status.textContent).toContain("settings.backup.unchanged.status"));
  expect(calls(call, "backup.create")).toHaveLength(1);

  const failedAt = "2026-11-15T07:30:00.000Z";
  act(() => emit("backup.updated", { root: ROOT, lastSuccess: regular.createdAt, failure: { code: "ENOSPC", message: "备份没有完成：磁盘已满", at: failedAt } }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(`settings.backup.failure.title${dateTime(failedAt)}`);
  expect(alert.textContent).toContain("备份没有完成：磁盘已满");

  act(() => emit("backup.updated", { root: ROOT, lastSuccess: before.createdAt, failure: null }));
  expect(await screen.findByText(`settings.backup.lastSuccess.status${dateTime(before.createdAt)}`)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("改检查间隔与保留份数：超出范围时标出那一项、不能保存；保存后用后端返回的设置", async () => {
  const { call, client } = backend({
    "settings.set": (params) => Promise.resolve({ commandPolicy: "ask", recentSpaces: [ROOT], prompts: {}, backup: params.backup }),
  });
  start(client, "/settings");

  const interval = await screen.findByLabelText("settings.backup.interval.label");
  expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
  fireEvent.change(interval, { target: { value: "2" } });
  expect(interval.getAttribute("aria-invalid")).toBe("true");
  expect(screen.getByText("settings.backup.interval.invalid.error51440")).toBeTruthy();
  expect(screen.getByRole("button", { name: "保存" }).hasAttribute("disabled")).toBe(true);

  fireEvent.change(interval, { target: { value: "60" } });
  fireEvent.change(screen.getByLabelText("settings.backup.keep.label"), { target: { value: "10" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "保存" })).toBeNull());
  expect(calls(call, "settings.set")).toEqual([{ backup: { intervalMinutes: 60, keep: 10 } }]);
  expect((screen.getByLabelText("settings.backup.interval.label") as HTMLInputElement).value).toBe("60");
});

/** 选空间页展开备份，返回 ROOT 那一组。 */
async function openBackups() {
  fireEvent.click(await screen.findByRole("button", { name: "learningSpace.backup.title" }));
  return within(await screen.findByRole("region", { name: "操作系统" }));
}

it("选空间页的备份平时收起；展开后从新到旧列出时间、大小与种类，“恢复前”的可以删除，删除前确认", async () => {
  const { call, client } = backend();
  start(client, "/learning-space");

  const toggle = await screen.findByRole("button", { name: "learningSpace.backup.title" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  const group = await openBackups();
  expect(group.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    `${dateTime(before.createdAt, { seconds: true })}${fileSize(4096)}learningSpace.backup.beforeRestore.labellearningSpace.backup.delete.actionlearningSpace.backup.restore.action`,
    `${dateTime(regular.createdAt, { seconds: true })}${fileSize(2048)}learningSpace.backup.restore.action`,
    `${dateTime(older.createdAt, { seconds: true })}${fileSize(1024)}learningSpace.backup.restore.action`,
  ]);

  fireEvent.click(group.getByRole("button", { name: `learningSpace.backup.delete.label${dateTime(before.createdAt, { seconds: true })}` }));
  const dialog = within(await screen.findByRole("dialog"));
  expect(calls(call, "backup.delete")).toEqual([]);
  fireEvent.click(dialog.getByRole("button", { name: "learningSpace.backup.delete.confirm.action" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(calls(call, "backup.delete")).toEqual([{ root: ROOT, id: "b3" }]);
});

it("恢复到原位置：先说明并确认；空间开着时先关闭，再恢复，然后重新打开它进学习页", async () => {
  const { call, client } = backend({
    "backup.restore": () => Promise.resolve(before),
  });
  const { store, router } = start(client, "/learning-space");
  await waitFor(() => expect(store.getState().opening).toBe("opening-1"));

  const group = await openBackups();
  fireEvent.click(group.getByRole("button", { name: `learningSpace.backup.restore.label${dateTime(regular.createdAt, { seconds: true })}` }));
  const dialog = within(await screen.findByRole("dialog"));
  expect(dialog.getByRole("heading", { name: `learningSpace.restore.title${dateTime(regular.createdAt, { seconds: true })}` })).toBeTruthy();
  expect(dialog.getByRole("radio", { name: "learningSpace.restore.inPlace.label" }).getAttribute("aria-checked")).toBe("true");
  // 开着的空间会先被关闭，说明里带上这一句。
  expect(dialog.getByText(/learningSpace\.restore\.inPlace\.active\.hint/u)).toBeTruthy();
  expect(calls(call, "backup.restore")).toEqual([]);

  fireEvent.click(dialog.getByRole("button", { name: "learningSpace.restore.inPlace.action" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/learn"));
  const order = call.mock.calls.map(([method]) => method).filter((method) => ["space.close", "backup.restore", "space.open"].includes(method));
  expect(order.slice(-3)).toEqual(["space.close", "backup.restore", "space.open"]);
  expect(calls(call, "backup.restore")).toEqual([{ root: ROOT, id: "b2" }]);
  expect(store.getState().space).toBe(ROOT);
});

it("空间文件夹已经不在时只能恢复到新文件夹，位置预填原来的路径；恢复后打开新空间", async () => {
  const { call, client } = backend({
    "backup.list": () => Promise.resolve([{ root: ROOT, exists: false, backups: [regular] }]),
    "backup.restoreTo": (params) => Promise.resolve({ root: params.target }),
  });
  const { store, router } = start(client, "/learning-space", false);

  const group = await openBackups();
  expect(group.getByText("learningSpace.backup.missing.label")).toBeTruthy();
  fireEvent.click(group.getByRole("button", { name: `learningSpace.backup.restore.label${dateTime(regular.createdAt, { seconds: true })}` }));
  const dialog = within(await screen.findByRole("dialog"));
  expect(dialog.queryByRole("radio")).toBeNull();
  const target = dialog.getByLabelText("learningSpace.restore.target.label") as HTMLInputElement;
  expect(target.value).toBe(ROOT);
  fireEvent.change(target, { target: { value: "/home/learner/Repa/操作系统（恢复）" } });

  fireEvent.click(dialog.getByRole("button", { name: "learningSpace.restore.copy.action" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/learn"));
  expect(calls(call, "backup.restoreTo")).toEqual([{ root: ROOT, id: "b2", target: "/home/learner/Repa/操作系统（恢复）" }]);
  expect(store.getState().space).toBe("/home/learner/Repa/操作系统（恢复）");
});

it("恢复失败时留在确认框里显示原因，可以改了位置再试", async () => {
  const { client } = backend({
    "backup.restoreTo": () => Promise.reject(new RpcError(-32000, "选定的位置已有同名的文件或文件夹", { code: "restore_target_exists" })),
  });
  start(client, "/learning-space", false);

  const group = await openBackups();
  fireEvent.click(group.getByRole("button", { name: `learningSpace.backup.restore.label${dateTime(older.createdAt, { seconds: true })}` }));
  const dialog = within(await screen.findByRole("dialog"));
  fireEvent.click(dialog.getByRole("radio", { name: "learningSpace.restore.copy.label" }));
  expect((dialog.getByLabelText("learningSpace.restore.target.label") as HTMLInputElement).value).toMatch(/^\/home\/learner\/Repa\/操作系统-\d{8}-\d{4}$/u);
  fireEvent.click(dialog.getByRole("button", { name: "learningSpace.restore.copy.action" }));
  const alert = await dialog.findByRole("alert");
  expect(alert.textContent).toContain("选定的位置已有同名的文件或文件夹");
  expect(dialog.getByRole("button", { name: "learningSpace.restore.copy.action" }).hasAttribute("disabled")).toBe(false);
});

it("打开空间报上次恢复没有完成时，说明原因并带到这个空间的备份", async () => {
  const { client } = backend({
    "space.open": () => Promise.reject(new RpcError(-32000, "上次从备份恢复没有完成，请重新恢复", { code: "restore_incomplete", details: { root: ROOT } })),
  });
  start(client, "/learning-space", false);

  fireEvent.click(within(await screen.findByRole("list", { name: "最近打开" })).getByRole("button", { name: /操作系统/u }));
  expect((await screen.findByRole("alert")).textContent).toContain("上次从备份恢复没有完成，请重新恢复");
  expect(screen.getByRole("button", { name: "learningSpace.backup.title" }).getAttribute("aria-expanded")).toBe("false");

  fireEvent.click(screen.getByRole("button", { name: "learningSpace.restoreIncomplete.action" }));
  const group = await screen.findByRole("region", { name: "操作系统" });
  await waitFor(() => expect(document.activeElement).toBe(group));
  expect(screen.getByRole("button", { name: "learningSpace.backup.title" }).getAttribute("aria-expanded")).toBe("true");
});

it("没有任何备份时选空间页不出现备份", async () => {
  const empty: Result<"backup.list"> = [];
  const { call, client } = backend({ "backup.list": () => Promise.resolve(empty) });
  start(client, "/learning-space", false);

  await screen.findByRole("list", { name: "最近打开" });
  await waitFor(() => expect(calls(call, "backup.list")).toHaveLength(1));
  expect(screen.queryByRole("button", { name: "learningSpace.backup.title" })).toBeNull();
});
