import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepaClient } from "repa/client";

import { App, type LoadConnection } from "../src/renderer/src/app";
import { mockMatchMedia } from "./match-media";

vi.mock("repa/client", () => ({ RepaClient: { connect: vi.fn() } }));

beforeEach(() => { mockMatchMedia(); });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const connection = { url: "ws://127.0.0.1:4411/rpc", token: "secret" };

describe("Desktop App bootstrap", () => {
  it("开发态重复挂载不会建立即刻废弃的连接", async () => {
    vi.mocked(RepaClient.connect).mockResolvedValue({
      close: vi.fn(),
      onConnectionChange: vi.fn(() => vi.fn()),
    } as unknown as RepaClient);
    const loadConnection = vi.fn(() => Promise.resolve(connection));

    render(
      <StrictMode>
        <App loadConnection={loadConnection} />
      </StrictMode>,
    );

    await screen.findByRole("navigation", { name: "主导航" });
    expect(loadConnection).toHaveBeenCalledTimes(2);
    expect(RepaClient.connect).toHaveBeenCalledOnce();
  });

  it("自动获取连接并呈现工作台", async () => {
    const client = {
      close: vi.fn(),
      onConnectionChange: vi.fn(() => vi.fn()),
    };
    vi.mocked(RepaClient.connect).mockResolvedValue(client as unknown as RepaClient);
    const loadConnection = vi.fn().mockResolvedValue(connection);

    render(<App loadConnection={loadConnection} />);

    expect(screen.getByRole("heading", { name: "正在准备 Repa" })).toBeTruthy();
    expect(await screen.findByRole("navigation", { name: "主导航" })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("link", { name: "Learning Space" }).getAttribute("aria-current")).toBe("page"));
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(["Learning Space", "Settings"]);
    expect(loadConnection).toHaveBeenCalledOnce();
    expect(RepaClient.connect).toHaveBeenCalledWith(connection);
  });

  it("启动失败时显示原因并允许重试", async () => {
    const loadConnection = vi
      .fn<LoadConnection>()
      .mockRejectedValueOnce(new Error("Node 不可用"))
      .mockResolvedValueOnce(connection);
    vi.mocked(RepaClient.connect).mockResolvedValue({
      close: vi.fn(),
      onConnectionChange: vi.fn(() => vi.fn()),
    } as unknown as RepaClient);

    render(<App loadConnection={loadConnection} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Node 不可用");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("navigation", { name: "主导航" })).toBeTruthy();
  });

  it("保留工作台并显示自动重连状态", async () => {
    let listener: ((connected: boolean) => void) | undefined;
    const loadConnection = () => Promise.resolve(connection);
    vi.mocked(RepaClient.connect).mockResolvedValue({
      close: vi.fn(),
      onConnectionChange: vi.fn((value: (connected: boolean) => void) => {
        listener = value;
        return vi.fn();
      }),
    } as unknown as RepaClient);

    render(<App loadConnection={loadConnection} />);
    await screen.findByRole("navigation", { name: "主导航" });
    act(() => listener?.(false));
    expect(screen.getByText("后端连接已中断，正在自动重连…")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Repa" })).toBeTruthy();
  });

  it("使用桌面 Memory Router 导航并保留折叠侧栏", async () => {
    vi.mocked(RepaClient.connect).mockResolvedValue({
      close: vi.fn(),
      onConnectionChange: vi.fn(() => vi.fn()),
    } as unknown as RepaClient);
    render(<App loadConnection={() => Promise.resolve(connection)} />);

    await screen.findByRole("navigation", { name: "主导航" });
    fireEvent.click(screen.getByRole("button", { name: "收起导航" }));
    fireEvent.click(screen.getByRole("link", { name: "Settings" }));
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("aria-current")).toBe("page");
    expect(document.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state")).toBe("collapsed");
  });

  it("窄窗口使用导航抽屉，选中目标后关闭", async () => {
    mockMatchMedia(true);
    vi.mocked(RepaClient.connect).mockResolvedValue({
      close: vi.fn(),
      onConnectionChange: vi.fn(() => vi.fn()),
    } as unknown as RepaClient);
    render(<App loadConnection={() => Promise.resolve(connection)} />);

    const trigger = await screen.findByRole("button", { name: "打开导航" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "工作台导航" });
    fireEvent.click(within(dialog).getByRole("link", { name: "Settings" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(trigger);
    expect(within(screen.getByRole("dialog", { name: "工作台导航" })).getByRole("link", { name: "Settings" }).getAttribute("aria-current")).toBe("page");
  });
});
