import { useEffect } from "react";
import type { LearningMenu } from "@repa/learning/protocol";

import { Button } from "@/components/ui/button";
import { kindText } from "@/features/learning-task";
import { useAppStore } from "@/hooks/use-app-store";

/** 后端的时间是服务端毫秒；按读取时的时差换算成本机时间显示。 */
function localTime(serverTime: number, serverNow: number, readAt: number): string {
  return new Date(serverTime - serverNow + readAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

/**
 * 下一步的选项：程序按学习状态给出最多三项，学习者挑一项开始。没有选项时说明原因和最早什么时候可以继续，
 * 到了那个时间重新读取状态（到期的变化不写事实，后端不会发事件）。
 */
export function LearningMenuView({ menu, serverNow, readAt }: { menu: LearningMenu; serverNow: number; readAt: number }) {
  const busy = useAppStore((state) => state.learning.busy !== undefined);
  const selectCandidate = useAppStore((state) => state.selectCandidate);
  const refreshLearning = useAppStore((state) => state.refreshLearning);

  useEffect(() => {
    if (menu.availableAt === undefined) return;
    const delay = Math.max(0, menu.availableAt - serverNow - (Date.now() - readAt));
    // 定时器的上限约 24.8 天；更远的时间等页面再次打开时重新读取。
    if (delay > 2 ** 31 - 1) return;
    const timer = setTimeout(() => { void refreshLearning(); }, delay + 500);
    return () => clearTimeout(timer);
  }, [menu.availableAt, serverNow, readAt, refreshLearning]);

  return <section aria-labelledby="learning-menu-title" className="grid gap-3">
    <h3 id="learning-menu-title" className="m-0 text-base font-semibold">接下来</h3>
    {menu.candidates.length === 0 && <p className="m-0 text-sm text-muted-foreground">
      {menu.unavailableReason ?? "现在没有可以开始的内容。"}
      {menu.availableAt !== undefined && ` ${localTime(menu.availableAt, serverNow, readAt)} 以后可以继续。`}
    </p>}
    <ul className="m-0 grid list-none gap-3 p-0">
      {menu.candidates.map((candidate) => <li key={candidate.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card p-4">
        <div className="grid min-w-0 gap-1">
          <span className="text-sm text-muted-foreground">{kindText[candidate.kind]}</span>
          <span className="font-semibold">{candidate.title}</span>
        </div>
        <Button disabled={busy} onClick={() => { void selectCandidate(candidate.id); }}>开始</Button>
      </li>)}
    </ul>
  </section>;
}
