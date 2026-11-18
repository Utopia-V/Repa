import { useEffect, useRef } from "react";

import { remainingMs } from "@/lib/countdown";

/** 定时器的上限约 24.8 天；更远的截止时间等页面再次可见或得到焦点时检查。 */
const MAX_DELAY = 2 ** 31 - 1;

/**
 * 到了截止时间就调用一次 onExpired（重新读取状态，后端按截止时刻结束过期的测验）。
 * 计时器在电脑睡眠时不走、在后台页面里会被推迟，所以页面重新可见或窗口重新得到焦点时也检查一遍：过了截止时间就读，没过不读。
 * 计时器偶尔早到一点：没到就按剩下的时间再排一次。同一次读取到的状态下最多调用一次；读到新状态（serverNow、readAt 变了）重新开始。
 */
export function useDeadlineRefresh(deadlineAt: number | null, serverNow: number | undefined, readAt: number | undefined, onExpired: () => void): void {
  const callback = useRef(onExpired);
  useEffect(() => { callback.current = onExpired; }, [onExpired]);

  useEffect(() => {
    if (deadlineAt === null || serverNow === undefined || readAt === undefined) return;
    let fired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const left = () => remainingMs(deadlineAt, serverNow, readAt, Date.now());
    const check = () => {
      if (fired || left() > 0) return false;
      fired = true;
      clearTimeout(timer);
      callback.current();
      return true;
    };
    const schedule = () => {
      if (check()) return;
      const delay = left();
      if (delay <= MAX_DELAY) timer = setTimeout(schedule, delay);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    schedule();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
    };
  }, [deadlineAt, serverNow, readAt]);
}
