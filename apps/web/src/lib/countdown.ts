/**
 * 后端给的时间都是服务端毫秒。读到状态时记下服务端的 serverNow 和本机的 readAt，两者之差就是两边时钟的差，
 * 换算成本机时间时加回去；菜单的恢复时间与测验的剩余时间用同一种换算。
 */
export function localTime(serverTime: number, serverNow: number, readAt: number): number {
  return serverTime - serverNow + readAt;
}

/** 本机此刻 now 时离截止时间还剩多少毫秒；过了截止时间为 0。 */
export function remainingMs(deadlineAt: number, serverNow: number, readAt: number, now: number): number {
  return Math.max(0, localTime(deadlineAt, serverNow, readAt) - now);
}

/**
 * 显示用的剩余时间只减不增：重新读取状态时两边时钟之差会随网络延迟略有出入，本机时钟也可能被往回拨，
 * 换算出的值因此可能比上一次大一点；取两者中小的那个，倒计时不往回跳。到 0 以后一直是 0。
 */
export function nextRemaining(previous: number | undefined, computed: number): number {
  return previous === undefined ? computed : Math.min(previous, computed);
}

/** 剩余时间写成“分:秒”，秒向上取整：还差几毫秒时仍显示 0:01，显示 0:00 时确实已经到了。 */
export function formatClock(ms: number): string {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * 剩余时间从上一次的 previous 降到这一次的 current 时跨过的播报点；一次跨过几个（例如电脑睡眠以后）取最小的那个，
 * 只播报眼下的情形。没有跨过播报点、或者还没有上一次时为 undefined：打开时已经不到 5 分钟，不补报。
 */
export function crossedMark(previous: number | undefined, current: number, marks: readonly number[]): number | undefined {
  if (previous === undefined) return undefined;
  const crossed = marks.filter((mark) => previous > mark && current <= mark);
  return crossed.length === 0 ? undefined : Math.min(...crossed);
}
