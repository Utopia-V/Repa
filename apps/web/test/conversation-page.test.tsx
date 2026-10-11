import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import { RpcError } from "@repa/base/client";
import type { SessionEntry } from "@repa/base/protocol";

import { CommandConfirmationDialog } from "../src/features/command-confirmation";
import { StoreProvider } from "../src/hooks/use-app-store";
import { createAppStore } from "../src/lib/store";
import { ConversationPage } from "../src/pages/conversation";
import { fakeClient } from "./fake-client";

afterEach(cleanup);

const at = "2026-10-12T00:00:00.000Z";

function backend(history: SessionEntry[] = [], defaultModel: { provider: string; id: string } | null = { provider: "test", id: "m" }) {
  const sends: { text: string; finish(error?: unknown): void }[] = [];
  const call = vi.fn((method: string, params: Record<string, unknown>) => {
    switch (method) {
      case "space.open":
        return Promise.resolve({ root: params.root });
      case "space.list":
        return Promise.resolve([]);
      case "session.list":
        return Promise.resolve([{ id: "s1", createdAt: at }]);
      case "session.history":
        return Promise.resolve(history);
      case "model.getDefault":
        return Promise.resolve(defaultModel);
      case "session.send":
        return new Promise((resolve, reject) => {
          sends.push({ text: String(params.text), finish: (error) => error ? reject(error) : resolve(null) });
        });
      case "session.abort":
      case "confirm.reply":
        return Promise.resolve(null);
      default:
        return Promise.reject(new Error(`未模拟的方法 ${method}`));
    }
  });
  return { call, sends, ...fakeClient(call) };
}

async function renderConversation(fake: ReturnType<typeof backend>, { open = true } = {}) {
  const store = createAppStore();
  store.getState().setClient(fake.client);
  if (open) await store.getState().openSpace("/notes/calculus");
  render(<StoreProvider store={store}>
    <MemoryRouter initialEntries={["/conversation"]}>
      <Routes>
        <Route path="/learning-space" element={<h2>空间页</h2>} />
        <Route path="/settings" element={<h2>设置页</h2>} />
        <Route path="/conversation" element={<ConversationPage />} />
      </Routes>
    </MemoryRouter>
    <CommandConfirmationDialog />
  </StoreProvider>);
  return store;
}

it("没有打开空间时回到空间选择", async () => {
  await renderConversation(backend(), { open: false });
  expect(await screen.findByRole("heading", { name: "空间页" })).toBeTruthy();
});

it("显示最近会话的记录，Enter 发送消息并清空输入框，运行中可以停止", async () => {
  const fake = backend([
    { id: "u1", type: "user", timestamp: at, text: "什么是极限" },
    { id: "a1", type: "assistant", timestamp: at, text: "极限描述趋近的过程。", data: { stopReason: "toolUse", calls: [{ id: "c1", name: "read" }] } },
    { id: "t1", type: "tool", timestamp: at, data: { callId: "c1", isError: false } },
  ]);
  await renderConversation(fake);

  const record = await screen.findByRole("region", { name: "对话记录" });
  expect(await within(record).findByText("什么是极限")).toBeTruthy();
  expect(within(record).getByText("极限描述趋近的过程。")).toBeTruthy();
  expect(within(record).getByText("读取文件")).toBeTruthy();
  expect(within(record).getByText("· 已完成")).toBeTruthy();

  const input = screen.getByRole("textbox", { name: "消息" });
  fireEvent.change(input, { target: { value: "那导数呢" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(fake.sends).toHaveLength(0);
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  expect(fake.sends).toHaveLength(0);
  fireEvent.keyDown(input, { key: "Enter" });

  await vi.waitFor(() => expect(fake.sends.map((send) => send.text)).toEqual(["那导数呢"]));
  expect((input as HTMLTextAreaElement).value).toBe("");
  act(() => fake.emit("session.event", { sessionId: "s1", runId: "r1", type: "textDelta", text: "导数是" }));
  expect(within(record).getByText("导数是")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "停止" }));
  expect(fake.call).toHaveBeenCalledWith("session.abort", { sessionId: "s1" });
  await act(async () => fake.sends[0]?.finish(new RpcError(-32000, "会话运行已取消", { code: "cancelled" })));
  expect(await screen.findByRole("button", { name: "发送" })).toBeTruthy();
});

it("助手消息按 Markdown 显示，用户消息按原文显示", async () => {
  await renderConversation(backend([
    { id: "u1", type: "user", timestamp: at, text: "**不要**加粗" },
    { id: "a1", type: "assistant", timestamp: at, text: "**导数**是 $f'(x)$", data: { stopReason: "stop" } },
  ]));

  const record = await screen.findByRole("region", { name: "对话记录" });
  expect(await within(record).findByText("**不要**加粗")).toBeTruthy();
  expect(within(record).getByText("导数").tagName).toBe("STRONG");
  expect(record.querySelector("annotation")?.textContent).toBe("f'(x)");
});

it("消息没发出去时显示原因，内容回到输入框", async () => {
  const fake = backend();
  await renderConversation(fake);
  const input = await screen.findByRole("textbox", { name: "消息" });
  await vi.waitFor(() => expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true));

  fireEvent.change(input, { target: { value: "你好" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await vi.waitFor(() => expect(fake.sends).toHaveLength(1));
  await act(async () => fake.sends[0]?.finish(new RpcError(-32000, "空间尚未打开", { code: "space_not_open" })));

  expect((await screen.findByRole("alert")).textContent).toContain("空间尚未打开");
  expect((input as HTMLTextAreaElement).value).toBe("你好");
});

it("没有可用模型时提示去设置页", async () => {
  await renderConversation(backend([], null));
  expect((await screen.findByRole("alert")).textContent).toContain("还没有可用的模型");
  fireEvent.click(screen.getByRole("link", { name: "去设置模型" }));
  expect(await screen.findByRole("heading", { name: "设置页" })).toBeTruthy();
});

it("发送时后端报告没有可用模型，同样引导去设置，不重复显示错误", async () => {
  const fake = backend();
  await renderConversation(fake);
  const input = await screen.findByRole("textbox", { name: "消息" });
  fireEvent.change(input, { target: { value: "你好" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await vi.waitFor(() => expect(fake.sends).toHaveLength(1));
  await act(async () => fake.sends[0]?.finish(new RpcError(-32000, "请选择可用模型", { code: "model_required" })));

  expect((await screen.findAllByRole("alert")).map((alert) => alert.textContent)).toEqual(["还没有可用的模型连接一个模型提供方后才能对话。"]);
  expect(screen.getByRole("link", { name: "去设置模型" }).getAttribute("href")).toBe("/settings");
  expect((input as HTMLTextAreaElement).value).toBe("你好");
});

it("Agent 要执行命令时弹出授权，显示命令，允许后回复后端", async () => {
  const fake = backend();
  await renderConversation(fake);
  await screen.findByRole("textbox", { name: "消息" });

  act(() => fake.emit("confirm.request", { id: "c1", request: { kind: "command", title: "允许执行命令？", message: "npm test" } }));
  const dialog = await screen.findByRole("dialog", { name: "允许执行命令？" });
  expect(within(dialog).getByText("npm test")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "允许" }));

  expect(fake.call).toHaveBeenCalledWith("confirm.reply", { id: "c1", value: true });
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("关闭授权对话框按拒绝回复", async () => {
  const fake = backend();
  await renderConversation(fake);
  await screen.findByRole("textbox", { name: "消息" });

  act(() => fake.emit("confirm.request", { id: "c1", request: { kind: "command", title: "允许执行命令？", message: "rm -rf build" } }));
  await screen.findByRole("dialog", { name: "允许执行命令？" });
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

  await vi.waitFor(() => expect(fake.call).toHaveBeenCalledWith("confirm.reply", { id: "c1", value: false }));
});
