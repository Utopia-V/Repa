import { useEffect, useRef, useState } from "react";

import { nextRemaining, remainingMs } from "@/lib/countdown";

/**
 * 离截止时间还剩多少毫秒，显示的秒数一变就更新一次；没有截止时间或还没读到状态时为 undefined。
 * 同一个截止时间下只减不增（见 nextRemaining），换了截止时间（另一场测验）重新算。
 */
export function useCountdown(deadlineAt: number | null, serverNow: number, readAt: number | undefined): number | undefined {
  const shown = useRef<{ deadlineAt: number; value: number } | undefined>(undefined);
  const [remaining, setRemaining] = useState<number | undefined>(() =>
    deadlineAt === null || readAt === undefined ? undefined : remainingMs(deadlineAt, serverNow, readAt, Date.now()));

  useEffect(() => {
    if (deadlineAt === null || readAt === undefined) {
      setRemaining(undefined);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const previous = shown.current?.deadlineAt === deadlineAt ? shown.current.value : undefined;
      const value = nextRemaining(previous, remainingMs(deadlineAt, serverNow, readAt, Date.now()));
      shown.current = { deadlineAt, value };
      setRemaining(value);
      // 秒数向上取整显示，到下一个整秒时它才变；到 0 以后不再计时。
      if (value > 0) timer = setTimeout(tick, value % 1000 || 1000);
    };
    tick();
    return () => clearTimeout(timer);
  }, [deadlineAt, serverNow, readAt]);

  return remaining;
}
