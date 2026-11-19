import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { useDeadlineRefresh } from "../src/hooks/use-deadline-refresh";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

/** 本机比服务端快 2 秒：读到状态时服务端是 998 000，本机是 1 000 000。 */
const serverNow = 998_000;
const readAt = 1_000_000;

function wake(): void {
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
}

it("到了截止时间恰好读取一次；之后页面可见、得到焦点也不再读", () => {
  const expired = vi.fn();
  renderHook(() => useDeadlineRefresh(serverNow + 60_000, serverNow, readAt, expired));

  vi.advanceTimersByTime(59_999);
  expect(expired).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(expired).toHaveBeenCalledTimes(1);

  vi.advanceTimersByTime(60_000);
  wake();
  expect(expired).toHaveBeenCalledTimes(1);
});

it("电脑睡眠时计时器没有走：醒来页面可见时已经过了截止时间，就读取一次", () => {
  const expired = vi.fn();
  renderHook(() => useDeadlineRefresh(serverNow + 60_000, serverNow, readAt, expired));

  // 只拨本机时钟，不让计时器到点，就像睡眠期间计时器停着。
  vi.setSystemTime(readAt + 10 * 60_000);
  expect(expired).not.toHaveBeenCalled();
  wake();
  expect(expired).toHaveBeenCalledTimes(1);
});

it("页面可见、得到焦点时还没到截止时间，不读取", () => {
  const expired = vi.fn();
  renderHook(() => useDeadlineRefresh(serverNow + 60_000, serverNow, readAt, expired));

  vi.setSystemTime(readAt + 30_000);
  wake();
  expect(expired).not.toHaveBeenCalled();
});

it("计时器早到了一点：没到截止时间就按剩下的时间再等，到点只读一次", () => {
  const expired = vi.fn();
  renderHook(() => useDeadlineRefresh(serverNow + 60_000, serverNow, readAt, expired));

  // 本机时钟被往回拨了 2 秒：计时器按原定的 60 秒到点时，按本机时间还差 2 秒。
  vi.advanceTimersByTime(30_000);
  vi.setSystemTime(Date.now() - 2_000);
  vi.advanceTimersByTime(30_000);
  expect(expired).not.toHaveBeenCalled();
  vi.advanceTimersByTime(2_000);
  expect(expired).toHaveBeenCalledTimes(1);
});

it("读到了新的状态（测验还没结束）就按新的读数重新等，不会连着读", () => {
  const expired = vi.fn();
  const { rerender } = renderHook(({ now, read }) => useDeadlineRefresh(serverNow + 60_000, now, read, expired), {
    initialProps: { now: serverNow, read: readAt },
  });
  vi.advanceTimersByTime(60_000);
  expect(expired).toHaveBeenCalledTimes(1);

  // 后端说还差 5 秒（本机时钟走快了）：交回的状态里测验还在进行。
  rerender({ now: serverNow + 55_000, read: Date.now() });
  expect(expired).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(4_999);
  expect(expired).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  expect(expired).toHaveBeenCalledTimes(2);
});

it("没有截止时间（准备阶段或测验已经结束）时不读取", () => {
  const expired = vi.fn();
  renderHook(() => useDeadlineRefresh(null, serverNow, readAt, expired));

  vi.setSystemTime(readAt + 60 * 60_000);
  vi.advanceTimersByTime(60 * 60_000);
  wake();
  expect(expired).not.toHaveBeenCalled();
});
