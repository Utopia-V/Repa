import { useEffect, useRef, useState } from "react";
import { AlarmClock, Timer } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { useCountdown } from "@/hooks/use-countdown";
import { crossedMark, formatClock } from "@/lib/countdown";
import { t } from "@/lib/strings";

/** 最后这么久醒目一些：换成闹钟图标和红色，不只靠颜色区分。 */
const URGENT_MS = 60_000;
/** 读屏软件只在剩下这么多时各播报一次，不每秒播报。 */
const ANNOUNCE_MS = [5 * 60_000, 60_000] as const;

/**
 * 测验的剩余时间，显示到秒。截止时间是服务端时间，按读到状态时两边时钟的差换算成本机时间（见 lib/countdown）。
 * 计时区域是 role="timer"（不随每秒变化播报）；另有一个礼貌的播报区，跨过 5 分钟和 1 分钟时各说一次。
 */
export function QuizClock({ deadlineAt, serverNow, readAt }: { deadlineAt: number; serverNow: number; readAt: number | undefined }) {
  const remaining = useCountdown(deadlineAt, serverNow, readAt);
  const previous = useRef<number | undefined>(undefined);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    if (remaining === undefined) return;
    const mark = crossedMark(previous.current, remaining, ANNOUNCE_MS);
    previous.current = remaining;
    if (mark !== undefined) setAnnouncement(t("learn.quiz.remaining.announce", { minutes: mark / 60_000 }));
  }, [remaining]);

  if (remaining === undefined) return null;
  const urgent = remaining <= URGENT_MS;
  const Icon = urgent ? AlarmClock : Timer;
  return <>
    {/* 图标放在徽标外面：Badge 把内容包进一个裁切行高的文字 span，图标放进去会折行。 */}
    <span role="timer" aria-label={t("learn.quiz.remaining.label")} data-urgent={urgent || undefined} className="inline-flex items-center gap-1.5">
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      <Badge color={urgent ? "red" : "gray"}>
        {/* 等宽数字：每秒变化时宽度不跳。 */}
        <span className="tabular-nums">{formatClock(remaining)}</span>
      </Badge>
    </span>
    <span className="sr-only" aria-live="polite">{announcement}</span>
  </>;
}
