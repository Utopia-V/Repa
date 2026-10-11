import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectionError, RpcError } from "@repa/base/client";

import { ErrorNotice } from "../src/components/domain/error-notice";
import { describeError } from "../src/lib/errors";

afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

it("后端业务错误显示后端给出的中文说明并保留错误码", () => {
  const error = new RpcError(-32000, "服务正在关闭", { code: "closed", details: { root: "/space" } });
  expect(describeError(error)).toEqual({
    title: "操作失败",
    message: "服务正在关闭",
    code: "closed",
    details: { root: "/space" },
  });
});

it("协议层错误不向用户展示英文原文", () => {
  expect(describeError(new RpcError(-32602, "Invalid params"))).toEqual({
    title: "请求失败",
    message: "后端无法完成这次请求。",
    code: "-32602",
  });
});

it("连接中断说明操作结果未确定", () => {
  const description = describeError(new ConnectionError());
  expect(description.title).toBe("连接中断");
  expect(description.message).toContain("结果未确定");
  expect(description.code).toBeUndefined();
});

it("其他错误沿用自身说明，非 Error 值给出通用说明", () => {
  expect(describeError(new Error("后端不可用"))).toEqual({ title: "操作失败", message: "后端不可用" });
  expect(describeError("boom").message).toBe("发生未知错误。");
});

it("开发模式显示错误码与细节，生产模式只显示说明", () => {
  const error = new RpcError(-32000, "服务正在关闭", { code: "closed" });
  render(<ErrorNotice error={error} />);
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("操作失败");
  expect(alert.textContent).toContain("服务正在关闭");
  expect(alert.textContent).toContain("closed");
  cleanup();
  vi.stubEnv("DEV", false);
  render(<ErrorNotice title="暂时无法连接" error={error} />);
  expect(screen.getByRole("alert").textContent).toContain("暂时无法连接");
  expect(screen.getByRole("alert").textContent).not.toContain("closed");
});
