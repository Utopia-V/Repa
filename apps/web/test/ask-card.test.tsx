import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import type { AskRequest, Item, SubmitResult } from "@repa/base/protocol";

import { StoreProvider } from "../src/hooks/use-app-store";
import { createAppStore } from "../src/lib/store";
import { ConversationPage } from "../src/pages/conversation";
import { fakeClient } from "./fake-client";

afterEach(() => { cleanup(); localStorage.clear(); });

const at = "2026-10-13T00:00:00.000Z";
const version = `sha256:${"0".repeat(64)}`;

// 和 ask_user 生成的题目同样的形状：一道带“其他”的单选，一道数字填写。
const item: Item = {
  id: "ask:1",
  version,
  requires: ["block.markdown", "slot.choice", "slot.text"],
  body: [],
  slots: [
    {
      id: "q1",
      type: "choice",
      prompt: [{ type: "markdown", text: "这周想复习哪一章？" }],
      options: [
        { id: "o1", label: "极限", content: [{ type: "markdown", text: "**极限**：第 1 章" }] },
        { id: "o2", label: "导数", content: [{ type: "markdown", text: "导数" }] },
      ],
      other: { label: "其他" },
    },
    { id: "q2", type: "text", prompt: [{ type: "markdown", text: "每天大概有多少分钟？" }], format: "number" },
  ],
};

function request(overrides: Partial<AskRequest> = {}): AskRequest {
  return { id: "a1", origin: { kind: "agent", sessionId: "s1", callId: "c1" }, purpose: "question", item, ...overrides };
}

function backend(replies: (SubmitResult | Error)[] = []) {
  const call = vi.fn((method: string, params: Record<string, unknown>) => {
    switch (method) {
      case "space.open":
        return Promise.resolve({ root: params.root });
      case "space.list":
        return Promise.resolve([]);
      case "session.list":
        return Promise.resolve([{ id: "s1", createdAt: at, updatedAt: at, agent: "general" }]);
      case "session.history":
        return Promise.resolve([
          { id: "u1", type: "user", timestamp: at, text: "帮我安排复习" },
          { id: "m1", type: "assistant", timestamp: at, text: "先问两件事。", data: { stopReason: "toolUse", calls: [{ id: "c1", name: "ask_user" }] } },
        ]);
      case "model.getDefault":
        return Promise.resolve({ provider: "test", id: "m" });
      case "model.list":
      case "model.providers":
        return Promise.reject(new Error("未模拟"));
      case "ask.reply": {
        if (params.action !== "submit") return Promise.resolve(null);
        const next = replies.shift() ?? { status: "recorded" };
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      }
      default:
        return Promise.reject(new Error(`未模拟的方法 ${method}`));
    }
  });
  return { call, ...fakeClient(call) };
}

async function renderPage(fake: ReturnType<typeof backend>) {
  const store = createAppStore();
  store.getState().setClient(fake.client);
  await store.getState().openSpace("/notes/calculus");
  render(<StoreProvider store={store}>
    <MemoryRouter><ConversationPage /></MemoryRouter>
  </StoreProvider>);
  await screen.findByText("先问两件事。");
  return store;
}

it("卡片出现在发起它的工具调用下面，格式不对时问题标在小问下，改好后收起成问题和回答", async () => {
  const fake = backend([{ status: "rejected", problems: [{ slot: "q2", message: "这一小问还没有作答" }] }]);
  await renderPage(fake);
  act(() => fake.emit("ask.request", request()));

  const card = screen.getByRole("region", { name: "Agent 想问你" });
  const tool = screen.getByText("向你提问");
  expect(tool.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  const choices = within(card).getByRole("radiogroup", { name: /这周想复习哪一章/ });
  fireEvent.click(within(choices).getByRole("radio", { name: "极限：第 1 章" }));
  fireEvent.click(within(card).getByRole("button", { name: "提交" }));
  await vi.waitFor(() => expect(fake.call).toHaveBeenCalledWith("ask.reply", {
    id: "a1",
    action: "submit",
    response: { item: { id: "ask:1", version }, answers: { q1: { type: "choice", selected: ["o1"] } } },
  }));

  const minutes = await within(card).findByRole("textbox", { name: /每天大概有多少分钟/ });
  expect(minutes.getAttribute("aria-invalid")).toBe("true");
  expect(minutes.getAttribute("inputmode")).toBe("decimal");
  expect(within(card).getByText("这一小问还没有作答").closest("[id]")?.id).toBe(minutes.getAttribute("aria-describedby"));

  // 填“其他”会替换单选里已选的选项。
  fireEvent.change(within(card).getByRole("textbox", { name: "其他：自己填写" }), { target: { value: "错题本" } });
  fireEvent.change(minutes, { target: { value: "40" } });
  fireEvent.click(within(card).getByRole("button", { name: "提交" }));
  await vi.waitFor(() => expect(fake.call).toHaveBeenLastCalledWith("ask.reply", {
    id: "a1",
    action: "submit",
    response: { item: { id: "ask:1", version }, answers: { q1: { type: "choice", selected: [], other: "错题本" }, q2: { type: "text", text: "40" } } },
  }));
  act(() => fake.emit("ask.closed", { id: "a1", reason: "answered" }));

  const answered = await screen.findByRole("region", { name: "你回答了 Agent 的提问" });
  expect(within(answered).getByText("其他：错题本")).toBeTruthy();
  expect(within(answered).getByText("40")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "提交" })).toBeNull();
});

it("多选可以同时选几项和其他，判分反馈显示在回答下面", async () => {
  const practice: Item = {
    ...item,
    slots: [{ ...item.slots[0], multiple: true } as Item["slots"][number]],
  };
  const fake = backend([{
    status: "recorded",
    feedback: {
      item: { id: "ask:1", version },
      verdict: "partial",
      judge: "model",
      score: { earned: 1, max: 2 },
      slots: { q1: { verdict: "partial", message: [{ type: "markdown", text: "还漏了导数" }] } },
    },
  }]);
  await renderPage(fake);
  act(() => fake.emit("ask.request", request({ purpose: "practice", item: practice })));

  const card = screen.getByRole("region", { name: "练习" });
  const group = within(card).getByRole("group", { name: /这周想复习哪一章/ });
  fireEvent.click(within(group).getByRole("checkbox", { name: "导数" }));
  fireEvent.click(within(group).getByRole("checkbox", { name: "极限：第 1 章" }));
  fireEvent.change(within(group).getByRole("textbox", { name: "其他：自己填写" }), { target: { value: "错题本" } });
  fireEvent.click(within(card).getByRole("button", { name: "提交" }));

  await vi.waitFor(() => expect(fake.call).toHaveBeenCalledWith("ask.reply", expect.objectContaining({
    response: { item: { id: "ask:1", version }, answers: { q1: { type: "choice", selected: ["o1", "o2"], other: "错题本" } } },
  })));
  const answered = await screen.findByRole("region", { name: "你交了这道练习" });
  expect(within(answered).getByText("极限、导数、其他：错题本")).toBeTruthy();
  expect(within(answered).getByText("部分正确 · 1 / 2")).toBeTruthy();
  expect(within(answered).getByText("还漏了导数")).toBeTruthy();
  expect(within(answered).getByText("由模型判分，仅供参考")).toBeTruthy();
});

it("关闭提问告诉后端不作答；运行中止和断线时只留一行说明", async () => {
  const fake = backend();
  const store = await renderPage(fake);
  act(() => fake.emit("ask.request", request()));
  fireEvent.click(screen.getByRole("button", { name: "关闭提问" }));
  await vi.waitFor(() => expect(fake.call).toHaveBeenCalledWith("ask.reply", { id: "a1", action: "cancel" }));
  expect(await screen.findByText("你关闭了这次提问")).toBeTruthy();

  act(() => fake.emit("ask.request", request({ id: "a2", origin: { kind: "plugin", pluginId: "learning" } })));
  act(() => fake.emit("ask.closed", { id: "a2", reason: "aborted" }));
  expect(screen.getByText("提问已结束：运行停止了")).toBeTruthy();

  act(() => fake.emit("ask.request", request({ id: "a3" })));
  expect(screen.getByRole("region", { name: "Agent 想问你" })).toBeTruthy();
  act(() => store.getState().setClient(fake.client));
  expect(screen.getByText("提问已结束：连接中断了")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Agent 想问你" })).toBeNull();
});

it("前端显示不了的题直接回复 unsupported，不出卡片", async () => {
  const fake = backend();
  await renderPage(fake);
  act(() => fake.emit("ask.request", request({ item: { ...item, requires: [...item.requires, "slot.table"] } })));
  await vi.waitFor(() => expect(fake.call).toHaveBeenCalledWith("ask.reply", { id: "a1", action: "unsupported" }));
  expect(screen.queryByRole("region", { name: "Agent 想问你" })).toBeNull();
});

it("卡片开着时输入框里的话代替作答交回 Agent，卡片收起成这句话", async () => {
  const fake = backend();
  await renderPage(fake);
  act(() => fake.emit("ask.request", request()));

  const input = screen.getByRole("textbox", { name: "消息" });
  expect(input.getAttribute("placeholder")).toBe("直接回一句话，代替作答");
  fireEvent.change(input, { target: { value: "这周先不安排了" } });
  fireEvent.keyDown(input, { key: "Enter" });

  await vi.waitFor(() => expect(fake.call).toHaveBeenCalledWith("ask.reply", { id: "a1", action: "decline", message: "这周先不安排了" }));
  expect(fake.call).not.toHaveBeenCalledWith("session.steer", expect.anything());
  const declined = await screen.findByRole("region", { name: "你没有按卡片作答，回了一句话" });
  expect(within(declined).getByText("这周先不安排了")).toBeTruthy();
  expect((input as HTMLTextAreaElement).value).toBe("");
  expect(input.getAttribute("placeholder")).toBe("问点什么，或者说说你想学什么");
});

it("练习可以说不会，提问卡片没有这个按钮", async () => {
  const fake = backend();
  await renderPage(fake);
  act(() => fake.emit("ask.request", request()));
  expect(screen.queryByRole("button", { name: "我不会" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "关闭提问" }));

  act(() => fake.emit("ask.request", request({ id: "a2", purpose: "practice" })));
  fireEvent.click(screen.getByRole("button", { name: "我不会" }));
  await vi.waitFor(() => expect(fake.call).toHaveBeenCalledWith("ask.reply", {
    id: "a2",
    action: "submit",
    response: { item: { id: "ask:1", version }, answers: {}, dontKnow: true },
  }));
  expect(await screen.findByText("你说这道题不会")).toBeTruthy();
});

it("多选题的题面已经写了可多选时不再重复提示", async () => {
  const fake = backend();
  await renderPage(fake);
  const choice = item.slots[0] as Extract<Item["slots"][number], { type: "choice" }>;
  const slots: Item["slots"] = [
    { ...choice, multiple: true, prompt: [{ type: "markdown", text: "你偏好哪种复习方式?(可多选)" }] },
    { ...choice, id: "q2", multiple: true },
  ];
  act(() => fake.emit("ask.request", request({ item: { ...item, slots } })));

  // 只有第二问加提示；第一问的名称里只有模型写的那一次。
  expect(screen.getAllByText("（可多选）")).toHaveLength(1);
  expect(screen.getByRole("group", { name: /^1\.\s*你偏好哪种复习方式\?\(可多选\)$/u })).toBeTruthy();
});
