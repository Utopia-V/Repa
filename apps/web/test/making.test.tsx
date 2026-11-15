import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import type { SessionInfo } from "@repa/base/protocol";
import type { CourseBuilding, LearningState } from "@repa/learning/protocol";
import type { Material } from "@repa/materials/protocol";

import { StoreProvider } from "../src/hooks/use-app-store";
import { createAppStore } from "../src/lib/store";
import { routes } from "../src/routes";
import { fakeClient } from "./fake-client";
import { mockMatchMedia } from "./match-media";

// 做课这几块界面的文字在测试里换成键名（参数照常跟在后面），按键名找元素：改一句话的措辞不必改测试。
vi.mock("../src/strings/zh-CN", async (importOriginal) => {
  const { strings } = await importOriginal<typeof import("../src/strings/zh-CN")>();
  const byKey = /^(making|outline|filePicker|pluginApproval|materials\.api|learn\.making|toolActivity\.(materials|course|count|learning)|tutor\.unavailable\.answering|learningSpace\.first)/u;
  return {
    strings: Object.fromEntries(Object.entries(strings).map(([key, value]) => [key, byKey.test(key) ? key + (value.match(/\{\w+\}/gu) ?? []).join("") : value])),
  };
});

afterEach(() => { cleanup(); localStorage.clear(); });

const at = 1_792_454_400_000;
const iso = new Date(at).toISOString();
const progress = { day: "2026-11-15", timeZone: "Asia/Shanghai", dailyGoalXp: 20, todayXp: 0, totalXp: 0, completedTopics: 0, totalTopics: 0, completionRate: 0, etaDate: null };
const noCourse: LearningState = {
  revision: 0, serverNow: at, course: null, task: null, menu: null,
  restrictions: { kind: "none", tutorAllowed: false, referenceContentAllowed: false }, progress,
};
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const nothing: CourseBuilding = { course: null, parts: [], expansion: null, lastFailure: null, cost: { requests: 0, usage: zero, cost: 0, unpriced: zero }, sessionId: null };
const files: Material[] = [
  { path: "materials/第一章.pdf", size: 2048, status: "text", format: "pdf", parts: 52 },
  { path: "materials/引论.pptx", size: 4096, status: "text", format: "pptx", parts: 18 },
  { path: "materials/扫描.pdf", size: 9000, status: "failed", format: "pdf", reason: "scanned", message: "这份 PDF 没有文字层，可能是扫描件或图片，读不出文字。" },
];
const source = { title: "第二章课件", file: "materials/第二章.pdf", where: "第 3–8 张" };
const outlined: CourseBuilding = {
  ...nothing,
  course: { id: "os", title: "操作系统", version: "1.0.0" },
  parts: [
    { topicId: "os01", title: "进程状态", summary: "三种状态与转换。", status: "learned", sources: [source] },
    { topicId: "os02", title: "进程控制块", status: "ready", sources: [] },
    { topicId: "os03", title: "进程调度", status: "outline", sources: [] },
    { topicId: "os04", title: "死锁", status: "outline", sources: [] },
  ],
  cost: { requests: 47, usage: zero, cost: 0.08341, unpriced: zero },
  sessionId: "making-1",
};

type Handler = (params: Record<string, unknown>) => Promise<unknown>;

/** 学习页做课用到的底座、学习插件与课件插件的方法；handlers 按“插件.方法”或底座方法名替换个别结果。 */
function backend(handlers: Record<string, Handler> = {}, sessions: SessionInfo[] = []) {
  const call = vi.fn((method: string, params: Record<string, unknown>): Promise<unknown> => {
    const name = method === "plugin.call" ? `${params.pluginId as string}.${params.method as string}` : method;
    const replaced = handlers[name];
    if (replaced) return replaced(method === "plugin.call" ? params.input as Record<string, unknown> : params);
    switch (name) {
      case "space.open":
        return Promise.resolve({ root: "/notes/os", opening: "opening-1", plugins: [] });
      case "space.list":
      case "model.list":
      case "model.providers":
        return Promise.resolve([]);
      case "session.list":
        return Promise.resolve(sessions);
      case "session.history":
        return Promise.resolve([]);
      case "model.getDefault":
        return Promise.resolve({ provider: "deepseek", id: "deepseek-flash" });
      case "plugin.list":
        return Promise.resolve([{ id: "learning", source: "bundled", state: "running", pages: [], methods: [], tools: [] }]);
      case "learning.state.get":
        return Promise.resolve(noCourse);
      case "learning.building.get":
        return Promise.resolve(nothing);
      case "learning.settings.get":
        return Promise.resolve({ autoExpand: true });
      case "materials.list":
        return Promise.resolve({ files });
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

function start(client: ReturnType<typeof backend>["client"], wide = true) {
  mockMatchMedia(wide);
  localStorage.setItem("repa.web.preferences", JSON.stringify({ state: { space: "/notes/os" }, version: 0 }));
  const store = createAppStore();
  store.getState().setClient(client);
  render(<StoreProvider store={store}><RouterProvider router={createMemoryRouter(routes, { initialEntries: ["/learn"] })} /></StoreProvider>);
  return store;
}

it("还没有课时学习页是做课的起点：列出课件，读不出文字的写明原因；填了要求点开始，新建通用会话、记下它、发出插件给的消息", async () => {
  let building = nothing;
  const fake = backend({
    "learning.building.get": () => Promise.resolve(building),
    "session.create": () => Promise.resolve({ id: "making-1", createdAt: iso, updatedAt: iso, agent: "general", model: { provider: "deepseek", id: "deepseek-flash" } }),
    "learning.building.begin": () => {
      building = { ...nothing, sessionId: "making-1" };
      return Promise.resolve({ text: "我把课件放进了 materials/……" });
    },
    "session.send": () => new Promise(() => undefined),
  });
  start(fake.client);

  const cards = within(await screen.findByRole("region", { name: "making.materials.title" }));
  expect(await cards.findByText("第一章.pdf")).toBeTruthy();
  expect(cards.getByText("making.materials.pages.label52")).toBeTruthy();
  expect(cards.getByText("making.materials.slides.label18")).toBeTruthy();
  expect(cards.getByText("这份 PDF 没有文字层，可能是扫描件或图片，读不出文字。")).toBeTruthy();
  // 没有课也没有做课的对话时不说“没有任务”，右侧也还没有面板。
  expect(screen.queryByText("现在没有任务，也没有可以开始的内容。")).toBeNull();
  expect(screen.queryByRole("complementary")).toBeNull();

  fireEvent.change(screen.getByLabelText("making.request.label"), { target: { value: "一月中旬考试" } });
  fireEvent.click(screen.getByRole("button", { name: "making.start.action" }));

  await vi.waitFor(() => expect(calls(fake.call, "session.send")).toEqual([{ sessionId: "making-1", text: "我把课件放进了 materials/……" }]));
  // 通用 Agent 的会话：不指定 agent。
  expect(calls(fake.call, "session.create")).toEqual([{}]);
  expect(calls(fake.call, "learning.building.begin")).toEqual([{ sessionId: "making-1", materials: true, request: "一月中旬考试" }]);
  // 页面换成做课：右侧是做课的对话，正文等轮廓出来。
  expect(await screen.findByRole("complementary", { name: "making.panel.label" })).toBeTruthy();
  expect(screen.getByText("outline.pending.status")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "making.start.action" })).toBeNull();
});

it("没有可用模型时开始不可用，并指向设置", async () => {
  const fake = backend({
    "model.getDefault": () => Promise.resolve(null),
    "materials.list": () => Promise.resolve({ files: [] }),
  });
  start(fake.client);

  expect(await screen.findByText("making.materials.empty")).toBeTruthy();
  expect(await screen.findByText("making.noModel.description")).toBeTruthy();
  expect(screen.getByRole("link", { name: "去设置模型" }).getAttribute("href")).toBe("/settings");
  expect((screen.getByRole("button", { name: "making.start.action" }) as HTMLButtonElement).disabled).toBe(true);
});

it("没有课件时写了想学什么就能开始：输入框问想学什么，记下没有课件，发出插件给的那条消息", async () => {
  const fake = backend({
    "materials.list": () => Promise.resolve({ files: [] }),
    "session.create": () => Promise.resolve({ id: "making-1", createdAt: iso, updatedAt: iso, agent: "general", model: { provider: "deepseek", id: "deepseek-flash" } }),
    "learning.building.begin": () => Promise.resolve({ text: "我手里没有课件……" }),
    "session.send": () => new Promise(() => undefined),
  });
  start(fake.client);

  expect(await screen.findByText("making.materials.empty")).toBeTruthy();
  const button = screen.getByRole("button", { name: "making.start.action" }) as HTMLButtonElement;
  // 什么都没写时不能开始；只写空白也不行。
  expect(button.disabled).toBe(true);
  expect(screen.queryByLabelText("making.request.label")).toBeNull();
  const wish = screen.getByLabelText("making.request.wish.label");
  fireEvent.change(wish, { target: { value: "   " } });
  expect(button.disabled).toBe(true);
  fireEvent.change(wish, { target: { value: "线性代数，期末考试用" } });
  expect(button.disabled).toBe(false);
  fireEvent.click(button);

  await vi.waitFor(() => expect(calls(fake.call, "session.send")).toEqual([{ sessionId: "making-1", text: "我手里没有课件……" }]));
  expect(calls(fake.call, "learning.building.begin")).toEqual([{ sessionId: "making-1", materials: false, request: "线性代数，期末考试用" }]);
});

it("添加课件：在本机文件夹里勾选文件，由课件插件复制进 materials/；已有同名文件时如实报错，勾选不丢", async () => {
  let added = 0;
  const fake = backend({
    "materials.list": () => Promise.resolve({ files: [] }),
    "space.roots": () => Promise.resolve([{ path: "/", label: "/" }]),
    "space.browse": (params) => Promise.resolve(params.path === "/home/me/课件"
      ? { path: "/home/me/课件", parent: "/home/me", space: false, truncated: false, entries: [{ name: "第一章.pdf", path: "/home/me/课件/第一章.pdf", space: false, file: true, size: 2_500_000 }] }
      : { path: "/home/me", parent: "/home", space: false, truncated: false, entries: [{ name: "课件", path: "/home/me/课件", space: false }] }),
    "materials.add": () => (++added === 1
      ? Promise.reject(Object.assign(new Error("materials/ 里已经有 第一章.pdf。"), { data: { code: "file_exists" } }))
      : Promise.resolve({ files: files.slice(0, 1) })),
  });
  start(fake.client);

  fireEvent.click(await screen.findByRole("button", { name: "making.materials.add.action" }));
  const dialog = within(await screen.findByRole("dialog"));
  expect(calls(fake.call, "space.browse")).toEqual([{ files: true }]);
  fireEvent.click(await dialog.findByRole("button", { name: "课件" }));
  fireEvent.click(await dialog.findByRole("checkbox", { name: "第一章.pdf" }));
  expect(dialog.getByText("2.4 MB")).toBeTruthy();

  fireEvent.click(dialog.getByRole("button", { name: "filePicker.add.action1" }));
  expect(await dialog.findByText("materials/ 里已经有 第一章.pdf。")).toBeTruthy();
  expect(dialog.getByRole("checkbox", { name: "第一章.pdf" }).getAttribute("aria-checked")).toBe("true");

  fireEvent.click(dialog.getByRole("button", { name: "filePicker.add.action1" }));
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(calls(fake.call, "materials.add")).toEqual([{ paths: ["/home/me/课件/第一章.pdf"] }, { paths: ["/home/me/课件/第一章.pdf"] }]);
  expect(await screen.findByText("第一章.pdf")).toBeTruthy();
});

it("有了课：轮廓按顺序列出，状态有文字不只靠颜色；先做某一部分、取消展开、再试和自动展开都调用学习插件；花费只留两位有效数字", async () => {
  let building: CourseBuilding = { ...outlined, expansion: { topicIds: ["os03"], startedAt: at, sessionId: null } };
  const fake = backend({
    "learning.building.get": () => Promise.resolve(building),
    "learning.building.cancel": () => {
      building = { ...outlined, lastFailure: { topicIds: ["os03"], at, code: "failed", message: "model request failed: 429" } };
      return Promise.resolve(building);
    },
    "learning.building.expand": (input) => Promise.resolve({ ...outlined, expansion: { topicIds: input.topicIds as string[], startedAt: at, sessionId: null } }),
    "learning.settings.set": (input) => Promise.resolve(input),
  }, [{ id: "making-1", createdAt: iso, updatedAt: iso, agent: "general" }]);
  start(fake.client);

  const outline = within(await screen.findByRole("region", { name: "outline.title" }));
  expect(outline.getByRole("status").textContent).toContain("outline.expanding.status进程调度");
  expect(outline.getByText("outline.cost.labelUS$0.08347")).toBeTruthy();
  // 已经有能学的部分：清单先收起，展开后逐项可读。
  const toggle = outline.getByRole("button", { name: "outline.summary.label411" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  const rows = outline.getAllByRole("listitem");
  expect(rows.map((row) => row.getAttribute("data-status"))).toEqual(["learned", "ready", "expanding", "outline"]);
  expect(within(rows[0]!).getByText("outline.status.learned.label")).toBeTruthy();
  expect(within(rows[0]!).getByText("第二章课件 第 3–8 张")).toBeTruthy();
  // 正在展开时不能再要求展开另一部分。
  expect((within(rows[3]!).getByRole("button", { name: "outline.expand.label死锁" }) as HTMLButtonElement).disabled).toBe(true);

  fireEvent.click(outline.getByRole("button", { name: "outline.expansion.cancel.action" }));
  expect(await outline.findByText("model request failed: 429")).toBeTruthy();
  expect(outline.getByText("outline.failure.failed.title进程调度")).toBeTruthy();

  fireEvent.click(outline.getByRole("button", { name: "outline.failure.retry.action" }));
  await vi.waitFor(() => expect(calls(fake.call, "learning.building.expand")).toEqual([{ topicIds: ["os03"] }]));

  await act(async () => { fake.emit("plugin.event", { pluginId: "learning", event: { type: "building.changed" } }); });
  building = { ...outlined };
  await act(async () => { fake.emit("plugin.event", { pluginId: "learning", event: { type: "building.changed" } }); });
  const fresh = within(await screen.findByRole("region", { name: "outline.title" }));
  fireEvent.click(await fresh.findByRole("button", { name: "outline.expand.label死锁" }));
  await vi.waitFor(() => expect(calls(fake.call, "learning.building.expand")).toContainEqual({ topicIds: ["os04"] }));

  const autoExpand = fresh.getByRole("switch", { name: "outline.autoExpand.label" });
  await vi.waitFor(() => expect(autoExpand.hasAttribute("data-disabled")).toBe(false));
  fireEvent.click(autoExpand);
  await vi.waitFor(() => expect(calls(fake.call, "learning.settings.set")).toEqual([{ autoExpand: false }]));
});

it("后端拒绝展开时如实显示原因", async () => {
  const fake = backend({
    "learning.building.get": () => Promise.resolve({ ...outlined, parts: outlined.parts.map((part) => ({ ...part, status: "outline" as const })) }),
    "learning.building.expand": () => Promise.reject(new Error("这些部分不在课里，或已经展开了")),
  }, [{ id: "making-1", createdAt: iso, updatedAt: iso, agent: "general" }]);
  start(fake.client);

  // 还没有能学的部分：清单直接展开。
  const outline = within(await screen.findByRole("region", { name: "outline.title" }));
  fireEvent.click(await outline.findByRole("button", { name: "outline.expand.label死锁" }));
  expect(await outline.findByText("这些部分不在课里，或已经展开了")).toBeTruthy();
  expect(outline.getByText("outline.action.error")).toBeTruthy();
});

it("窄屏时做课的对话在抽屉里：Agent 提问时抽屉自己打开", async () => {
  const fake = backend({
    "learning.building.get": () => Promise.resolve({ ...outlined, parts: outlined.parts.map((part) => ({ ...part, status: "outline" as const })) }),
  }, [{ id: "making-1", createdAt: iso, updatedAt: iso, agent: "general" }]);
  start(fake.client, false);

  expect(await screen.findByRole("button", { name: "learn.making.action" })).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  await vi.waitFor(() => expect(calls(fake.call, "session.history")).toEqual([{ sessionId: "making-1" }]));
  await act(async () => {
    fake.emit("ask.request", {
      id: "a1", origin: { kind: "agent", sessionId: "making-1" },
      item: { id: "q", version: `sha256:${"1".repeat(64)}`, requires: ["block.markdown"], body: [{ type: "markdown", text: "照此划分推进吗？" }], slots: [] },
    });
  });
  const drawer = within(await screen.findByRole("dialog"));
  expect(drawer.getByText("照此划分推进吗？")).toBeTruthy();
});

it("批准自写插件：列出名称、版本、页面和文件；批准、拒绝与关掉分别回答 true、false 与 null", async () => {
  const fake = backend({ "confirm.reply": () => Promise.resolve(null) });
  start(fake.client);
  await screen.findByRole("region", { name: "making.materials.title" });
  const plugin = {
    id: "weekly", title: "每周打卡", version: "0.2.0", digest: "a".repeat(64), base: "recorded" as const,
    pages: [{ id: "main", title: "打卡" }], files: [{ path: "index.js", change: "modified" as const }, { path: "old.js", change: "removed" as const }],
  };
  for (const [id, action] of [["p1", "approve"], ["p2", "deny"], ["p3", "close"]] as const) {
    await act(async () => { fake.emit("confirm.request", { id, request: { kind: "plugin", title: "", plugin } }); });
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByRole("heading", { name: "pluginApproval.title每周打卡" })).toBeTruthy();
    expect(dialog.getByText("pluginApproval.update.description")).toBeTruthy();
    expect(dialog.getByText("pluginApproval.version.label0.2.0", { exact: false })).toBeTruthy();
    expect(dialog.getByText("打卡")).toBeTruthy();
    expect(dialog.getByText("old.js")).toBeTruthy();
    expect(dialog.getByText("pluginApproval.change.removed.label")).toBeTruthy();
    if (action === "approve") fireEvent.click(dialog.getByRole("button", { name: "pluginApproval.approve.action" }));
    else if (action === "deny") fireEvent.click(dialog.getByRole("button", { name: "pluginApproval.deny.action" }));
    else fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  }
  expect(calls(fake.call, "confirm.reply")).toEqual([{ id: "p1", value: true }, { id: "p2", value: false }, { id: "p3", value: null }]);
});

const python: LearningState = {
  ...noCourse,
  course: { id: "python", title: "Python：读懂代码，说清需求", version: "0.2.0" },
  restrictions: { kind: "none", tutorAllowed: true, referenceContentAllowed: true },
  menu: { menuId: "m1", candidates: [{ id: "c1", kind: "lesson", title: "给数据起名，再按顺序读", topicIds: ["py01"] }] },
};

it("还没有学习记录的空间整页是起点：不显示随包课的课名、今日 XP 和菜单；改学随包课以后显示原来的菜单", async () => {
  const fake = backend({ "learning.state.get": () => Promise.resolve(python) });
  start(fake.client);

  expect(await screen.findByRole("button", { name: "making.start.action" })).toBeTruthy();
  expect(screen.queryByText("Python：读懂代码，说清需求")).toBeNull();
  expect(screen.queryByText("给数据起名，再按顺序读")).toBeNull();
  expect(screen.queryByLabelText("今天的目标完成度")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "making.useBundled.action" }));
  expect(await screen.findByText("给数据起名，再按顺序读")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Python：读懂代码，说清需求" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "making.start.action" })).toBeNull();
});

it("已经在学随包课的空间（有学习记录）不显示起点，与以前一样", async () => {
  const fake = backend({ "learning.state.get": () => Promise.resolve({ ...python, revision: 5 }) });
  start(fake.client);

  expect(await screen.findByText("给数据起名，再按顺序读")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Python：读懂代码，说清需求" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "making.start.action" })).toBeNull();
  expect(screen.queryByRole("region", { name: "making.materials.title" })).toBeNull();
});

it("只有轮廓时不显示菜单那句“没有可开始的任务”；连续写的文件在做课的对话里合成一行", async () => {
  const done = (id: string, tool: string) => [
    { id: `a${id}`, type: "assistant", timestamp: iso, text: "", data: { stopReason: "toolUse", calls: [{ id: `c${id}`, name: tool, input: {} }] } },
    { id: `t${id}`, type: "tool", timestamp: iso, text: "好", data: { callId: `c${id}`, tool, isError: false } },
  ];
  const fake = backend({
    "learning.state.get": () => Promise.resolve({ ...noCourse, revision: 3, course: outlined.course, menu: { menuId: "m1", candidates: [], unavailableReason: "当前没有可开始的任务" } }),
    "learning.building.get": () => Promise.resolve({ ...outlined, parts: outlined.parts.map((part) => ({ ...part, status: "outline" as const })) }),
    "session.history": () => Promise.resolve([
      ...done("1", "materials_list"), ...done("2", "write"), ...done("3", "write"), ...done("4", "write"), ...done("5", "course_check"),
      { id: "a6", type: "assistant", timestamp: iso, text: "轮廓出来了。", data: { stopReason: "stop" } },
    ]),
  }, [{ id: "making-1", createdAt: iso, updatedAt: iso, agent: "general" }]);
  start(fake.client);

  const panel = within(await screen.findByRole("complementary", { name: "making.panel.label" }));
  expect(await panel.findByText("轮廓出来了。")).toBeTruthy();
  expect(panel.getByText("toolActivity.count.label3")).toBeTruthy();
  expect(panel.getAllByText("写入文件")).toHaveLength(1);
  expect(screen.getByRole("region", { name: "outline.title" })).toBeTruthy();
  expect(screen.queryByText("当前没有可开始的任务")).toBeNull();
});

it("做课的会话在对话页打开：同一段记录和同一张提问卡片，在那里作答交给同一次询问", async () => {
  const fake = backend({
    "learning.building.get": () => Promise.resolve({ ...outlined, parts: outlined.parts.map((part) => ({ ...part, status: "outline" as const })) }),
    "session.history": () => Promise.resolve([{ id: "a1", type: "assistant", timestamp: iso, text: "轮廓出来了。", data: { stopReason: "stop" } }]),
    "ask.reply": () => Promise.resolve({ status: "accepted" }),
  }, [{ id: "making-1", createdAt: iso, updatedAt: iso, agent: "general" }]);
  mockMatchMedia(true);
  localStorage.setItem("repa.web.preferences", JSON.stringify({ state: { space: "/notes/os" }, version: 0 }));
  const store = createAppStore();
  store.getState().setClient(fake.client);
  const router = createMemoryRouter(routes, { initialEntries: ["/learn"] });
  render(<StoreProvider store={store}><RouterProvider router={router} /></StoreProvider>);

  expect(await screen.findByText("轮廓出来了。")).toBeTruthy();
  await act(async () => {
    fake.emit("ask.request", {
      id: "a1", origin: { kind: "agent", sessionId: "making-1" },
      item: { id: "q", version: `sha256:${"1".repeat(64)}`, requires: ["block.markdown"], body: [{ type: "markdown", text: "照此划分推进吗？" }], slots: [] },
    });
  });
  expect(await screen.findByText("照此划分推进吗？")).toBeTruthy();
  await act(async () => { await router.navigate("/conversation"); });
  const transcript = within(await screen.findByRole("region", { name: "对话记录" }));
  expect(transcript.getByText("轮廓出来了。")).toBeTruthy();
  expect(transcript.getByText("照此划分推进吗？")).toBeTruthy();
  expect(store.getState().conversation.sessionId).toBe("making-1");
});

it("第一次使用：问这门课叫什么，在主目录的 Repa/<名称> 新建空间并打开，落到放课件的起点；不能作文件夹名或文件夹已有内容时如实报错", async () => {
  let attempts = 0;
  const fake = backend({
    "space.list": () => Promise.resolve([]),
    "space.browse": () => Promise.resolve({ path: "/home/me", parent: "/home", space: false, truncated: false, entries: [] }),
    "space.create": (params) => (++attempts === 1
      ? Promise.reject(Object.assign(new Error("这个文件夹已经存在，里面有别的内容"), { data: { code: "directory_not_empty" } }))
      : Promise.resolve({ root: params.root, opening: "opening-1", plugins: [] })),
  });
  mockMatchMedia(true);
  const store = createAppStore();
  store.getState().setClient(fake.client);
  const router = createMemoryRouter(routes, { initialEntries: ["/learning-space"] });
  render(<StoreProvider store={store}><RouterProvider router={router} /></StoreProvider>);

  const name = await screen.findByLabelText("learningSpace.first.name.label");
  const create = screen.getByRole("button", { name: "learningSpace.first.create.action" }) as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  // 选已有文件夹的路保留。
  expect(screen.getByRole("button", { name: "选择文件夹" })).toBeTruthy();

  fireEvent.change(name, { target: { value: "操作系统/期末" } });
  expect(await screen.findByText("learningSpace.first.name.invalid.error")).toBeTruthy();
  expect(name.getAttribute("aria-invalid")).toBe("true");
  expect(create.disabled).toBe(true);

  fireEvent.change(name, { target: { value: "  操作系统 " } });
  expect(await screen.findByText("learningSpace.first.location.hint/home/me/Repa/操作系统")).toBeTruthy();
  fireEvent.click(create);
  expect(await screen.findByText("这个文件夹已经存在，里面有别的内容")).toBeTruthy();
  expect((name as HTMLInputElement).value).toBe("  操作系统 ");

  fireEvent.click(create);
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/learn"));
  expect(calls(fake.call, "space.create")).toEqual([{ root: "/home/me/Repa/操作系统", fresh: true }, { root: "/home/me/Repa/操作系统", fresh: true }]);
  expect(store.getState().space).toBe("/home/me/Repa/操作系统");
  expect(await screen.findByRole("region", { name: "making.materials.title" })).toBeTruthy();
});

it("做课进行中、还没有换用过自制课：标题栏不显示随包课的课名和今日 XP；做课的 Agent 运行时“先做”不可用", async () => {
  const fake = backend({
    "learning.state.get": () => Promise.resolve({ ...python, revision: 2 }),
    "learning.building.get": () => Promise.resolve({ ...nothing, sessionId: "making-1" }),
  }, [{ id: "making-1", createdAt: iso, updatedAt: iso, agent: "general" }]);
  start(fake.client);
  expect(await screen.findByText("outline.pending.status")).toBeTruthy();
  expect(screen.queryByText("Python：读懂代码，说清需求")).toBeNull();
  expect(screen.queryByLabelText("今天的目标完成度")).toBeNull();
  cleanup();

  const running = backend({
    "learning.building.get": () => Promise.resolve({ ...outlined, parts: outlined.parts.map((part) => ({ ...part, status: "outline" as const })) }),
  }, [{ id: "making-1", createdAt: iso, updatedAt: iso, agent: "general" }]);
  const store = start(running.client);
  const outline = within(await screen.findByRole("region", { name: "outline.title" }));
  const expand = await outline.findByRole("button", { name: "outline.expand.label死锁" }) as HTMLButtonElement;
  await vi.waitFor(() => expect(store.getState().conversation.sessionId).toBe("making-1"));
  expect(expand.disabled).toBe(false);
  act(() => { store.setState((state) => ({ conversation: { ...state.conversation, run: "running" } })); });
  expect(expand.disabled).toBe(true);
});

it("有学习任务时不显示整门课；新课作答时辅导栏用新课的提示；辅导工具有名称；后台任务的会话不进侧栏", async () => {
  const kp = { kpId: "os02.k1", title: "PCB", attempts: 0, consecutiveCorrect: 0, completed: false };
  const task = {
    taskId: "t1", kind: "lesson" as const, topics: [{ id: "os02", title: "进程控制块" }], phase: { stage: "awaiting_answer" as const, deliveryId: "d1" },
    startedAt: at, deadlineAt: null, kps: [kp], submissions: [],
    deliveries: [{
      deliveryId: "d1", submissionId: "s1", topicId: "os02", kpId: "os02.k1", mode: "practice" as const, repeated: false, requiresServices: [],
      item: { id: "q1", version: `sha256:${"1".repeat(64)}`, requires: ["block.markdown", "slot.text"], body: [{ type: "markdown" as const, text: "PCB 是什么？" }], slots: [{ id: "a", type: "text" as const }] },
    }],
  };
  const fake = backend({
    "learning.state.get": () => Promise.resolve({ ...noCourse, revision: 9, course: outlined.course, task, restrictions: { kind: "none", tutorAllowed: false, referenceContentAllowed: false } }),
    "learning.building.get": () => Promise.resolve(outlined),
    "session.history": (params) => Promise.resolve(params.sessionId === "tutor-1" ? [
      { id: "a1", type: "assistant", timestamp: iso, text: "", data: { stopReason: "toolUse", calls: [{ id: "c1", name: "learning_task", input: {} }] } },
      { id: "t1", type: "tool", timestamp: iso, text: "好", data: { callId: "c1", tool: "learning_task", isError: false } },
    ] : []),
  }, [
    { id: "tutor-1", createdAt: iso, updatedAt: iso, agent: "learning-tutor" },
    { id: "making-1", createdAt: iso, updatedAt: iso, agent: "general", preview: "我把课件放进了 materials/" },
    { id: "bg-1", createdAt: iso, updatedAt: iso, agent: "general", preview: "在后台展开空间里 course/ 这几部分", background: true },
  ]);
  const store = start(fake.client);

  expect(await screen.findByText("PCB 是什么？")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "outline.title" })).toBeNull();
  const tutor = within(await screen.findByRole("complementary"));
  expect(tutor.getByText("tutor.unavailable.answering.hint")).toBeTruthy();
  expect(await tutor.findByText("toolActivity.learningTask.label")).toBeTruthy();
  // 侧栏与自动打开的会话都取自这份列表。
  await vi.waitFor(() => expect(store.getState().resources.sessions.data?.map((session) => session.id)).toEqual(["tutor-1", "making-1"]));
});
