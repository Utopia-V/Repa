import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { QuizClock } from "../src/components/domain/quiz-clock";
import { t } from "../src/lib/strings";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** 本机比服务端快 2 秒；截止时间是服务端时间。 */
const serverNow = 998_000;
const readAt = 1_000_000;
const clock = () => screen.getByRole("timer", { name: t("learn.quiz.remaining.label") });
const live = () => document.querySelector("[aria-live=polite]")?.textContent ?? "";

it("按读到状态时两边时钟的差换算剩余时间，显示到秒，每过一秒少一秒", () => {
  render(<QuizClock deadlineAt={serverNow + 15 * 60_000} serverNow={serverNow} readAt={readAt} />);
  expect(clock().textContent).toBe("15:00");

  act(() => { vi.advanceTimersByTime(1_000); });
  expect(clock().textContent).toBe("14:59");
  act(() => { vi.advanceTimersByTime(59_000); });
  expect(clock().textContent).toBe("14:00");
});

it("最后 1 分钟秒表换成闹钟；最后 10 秒只有图标呼吸，数字不动；到 0 以后停在 0:00、不再呼吸", () => {
  const { container } = render(<QuizClock deadlineAt={serverNow + 61_000} serverNow={serverNow} readAt={readAt} />);
  const icon = () => container.querySelector("svg")?.getAttribute("class") ?? "";
  expect(icon()).toContain("lucide-timer");
  const breathing = () => [...container.querySelectorAll("[class*=animate-breathe]")];

  act(() => { vi.advanceTimersByTime(1_000); });
  expect(clock().textContent).toBe("1:00");
  expect(icon()).toContain("lucide-alarm-clock");
  expect(breathing()).toEqual([]);

  act(() => { vi.advanceTimersByTime(49_000); });
  expect(clock().textContent).toBe("0:11");
  expect(breathing()).toEqual([]);
  act(() => { vi.advanceTimersByTime(1_000); });
  expect(clock().textContent).toBe("0:10");
  expect(breathing().map((element) => element.tagName.toLowerCase())).toEqual(["svg"]);
  expect(icon()).toContain("motion-reduce:animate-none");

  act(() => { vi.advanceTimersByTime(120_000); });
  expect(clock().textContent).toBe("0:00");
  expect(breathing()).toEqual([]);
});

it("读屏软件只在跨过 5 分钟和 1 分钟时各播报一次", () => {
  render(<QuizClock deadlineAt={serverNow + 5 * 60_000 + 2_000} serverNow={serverNow} readAt={readAt} />);
  expect(live()).toBe("");

  act(() => { vi.advanceTimersByTime(1_000); });
  expect(live()).toBe("");
  act(() => { vi.advanceTimersByTime(1_000); });
  expect(live()).toBe(t("learn.quiz.remaining.announce", { minutes: 5 }));
  act(() => { vi.advanceTimersByTime(3 * 60_000); });
  expect(live()).toBe(t("learn.quiz.remaining.announce", { minutes: 5 }));
  act(() => { vi.advanceTimersByTime(60_000); });
  expect(live()).toBe(t("learn.quiz.remaining.announce", { minutes: 1 }));
});

it("同一场测验重新读取后，换算出的值大一点也不往回跳", () => {
  const deadlineAt = serverNow + 10 * 60_000;
  const { rerender } = render(<QuizClock deadlineAt={deadlineAt} serverNow={serverNow} readAt={readAt} />);
  act(() => { vi.advanceTimersByTime(30_000); });
  expect(clock().textContent).toBe("9:30");

  // 这次读取路上多花了 3 秒，按它换算还剩 9:33。
  rerender(<QuizClock deadlineAt={deadlineAt} serverNow={serverNow + 27_000} readAt={readAt + 30_000} />);
  expect(clock().textContent).toBe("9:30");
});
