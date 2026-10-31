import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate } from "react-router";
import { MessageCircle, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { StatusNotice } from "@/components/ui/status-notice";
import { ErrorNotice } from "@/components/domain/error-notice";
import { ConceptCardDialog } from "@/features/concept-card";
import { LearningMenuView } from "@/features/learning-menu";
import { kindText, LearningTaskView, useConceptLinks } from "@/features/learning-task";
import { TutorPanel } from "@/features/tutor-panel";
import { useAppStore } from "@/hooks/use-app-store";
import { errorCode } from "@/lib/errors";

const WIDE = "(min-width: 1280px)";

/**
 * 宽屏时辅导常驻在右侧，窄屏时收进抽屉。断点按左侧导航、任务区和辅导三栏都放得下来定。
 * 只挂一份辅导面板，避免两处同时绑定会话。
 */
function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
  useEffect(() => {
    const query = window.matchMedia(WIDE);
    const onChange = () => setWide(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return wide;
}

export function LearnPage() {
  const space = useAppStore((state) => state.space);
  if (!space) return <Navigate to="/learning-space" replace />;
  return <Learn space={space} />;
}

function Learn({ space }: { space: string }) {
  const learning = useAppStore((state) => state.learning);
  const loadLearning = useAppStore((state) => state.loadLearning);
  const refreshLearning = useAppStore((state) => state.refreshLearning);
  const abortTask = useAppStore((state) => state.abortTask);
  const [concept, setConcept] = useState<string>();
  const [tutorOpen, setTutorOpen] = useState(false);
  const [confirmAbort, setConfirmAbort] = useState(false);
  const wide = useWide();
  const scroller = useRef<HTMLDivElement>(null);
  const current = learning.state?.task;
  const position = current ? `${current.taskId}:${current.phase.stage}:${"deliveryId" in current.phase ? current.phase.deliveryId : ""}` : "";
  const openConcept = useCallback((kpId: string) => setConcept(kpId), []);
  const renderLink = useConceptLinks(openConcept);

  useEffect(() => {
    if (learning.available === undefined && learning.status === "idle") void loadLearning();
  }, [learning.available, learning.status, loadLearning]);

  // 换了任务、阶段或题目，从新画面的开头看起；同一画面里的刷新不动滚动位置。
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [position]);

  if (learning.available === false) {
    return <div className="mx-auto grid max-w-3xl gap-3 px-4 py-16 md:px-8">
      <StatusNotice status="error" title="这个空间没有学习内容"><p>后端没有加载学习插件。</p></StatusNotice>
    </div>;
  }
  const { state } = learning;
  if (!state) {
    return <div className="mx-auto grid max-w-3xl gap-3 px-4 py-16 md:px-8">
      {learning.status === "error"
        ? <>
          <ErrorNotice title="无法读取学习状态" error={learning.loadError} />
          <div><Button variant="outline" onClick={() => { void loadLearning(); }}><RefreshCw aria-hidden="true" />重试</Button></div>
        </>
        : <p role="status" className="text-sm text-muted-foreground">正在读取学习状态…</p>}
    </div>;
  }

  const { task, menu, progress, restrictions } = state;
  const active = task !== null && task.phase.stage !== "completed" && task.phase.stage !== "aborted";
  const goal = Math.min(100, Math.round(progress.todayXp / progress.dailyGoalXp * 100));
  const tutor = task && <TutorPanel allowed={restrictions.tutorAllowed} renderLink={renderLink} />;

  return <div className="flex h-dvh flex-col">
    {/* 移动端左侧让出浮动的导航按钮。 */}
    <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border py-2 pr-4 pl-16 md:px-6">
      <h2 className="m-0 min-w-0 truncate text-base font-semibold">{state.course?.title ?? "学习"}</h2>
      <div className="flex items-center gap-3">
        <div className="grid w-40 gap-1">
          <span className="text-xs text-muted-foreground">今天 {progress.todayXp} / {progress.dailyGoalXp} XP</span>
          <Progress value={goal} aria-label="今天的目标完成度" />
        </div>
        {tutor && !wide && <Button variant="outline" onClick={() => setTutorOpen(true)}>
          <MessageCircle aria-hidden="true" />问辅导
        </Button>}
      </div>
    </header>

    <div className="flex min-h-0 flex-1">
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-3xl gap-6 px-4 py-6 md:px-8">
          {learning.replaced && <StatusNotice status="error" title="画面已经更新"><p>刚才的操作基于旧画面，没有执行。请看一下现在的内容再操作。</p></StatusNotice>}
          {/* 剩下的题都要模型判分而没有可用模型：任务保留，接上模型后再继续。 */}
          {errorCode(learning.actionError) === "model_required" ? <div className="grid gap-3">
            <StatusNotice status="error" title="还没有可用的模型"><p>剩下的题要由模型判分，连接一个模型提供方后才能继续，这项任务会保留。</p></StatusNotice>
            <div><Button asChild variant="outline"><Link to="/settings">去设置模型</Link></Button></div>
          </div> : learning.actionError !== undefined && <div className="grid gap-3">
            <ErrorNotice title="操作没有完成" error={learning.actionError} />
            <div><Button variant="outline" onClick={() => { void refreshLearning(); }}><RefreshCw aria-hidden="true" />重新读取</Button></div>
          </div>}
          {task && <LearningTaskView state={state} task={task} renderLink={renderLink} />}
          {active && <div className="flex justify-end">
            <Button variant="ghost" disabled={learning.busy !== undefined} onClick={() => setConfirmAbort(true)}>中止{kindText[task.kind]}</Button>
          </div>}
          {menu && learning.readAt !== undefined && <LearningMenuView menu={menu} serverNow={state.serverNow} readAt={learning.readAt} />}
          {!task && !menu && <p className="m-0 text-sm text-muted-foreground">现在没有任务，也没有可以开始的内容。</p>}
        </div>
      </div>
      {tutor && wide && <aside aria-label="辅导" className="flex w-96 shrink-0 flex-col border-l border-border">
        <h3 className="m-0 px-4 pt-4 text-base font-semibold">辅导</h3>
        {tutor}
      </aside>}
    </div>

    {tutor && !wide && <Sheet open={tutorOpen} onOpenChange={setTutorOpen}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>辅导</SheetTitle>
          <SheetDescription>辅导知道你正在做的题。</SheetDescription>
        </SheetHeader>
        {tutor}
      </SheetContent>
    </Sheet>}

    <Dialog open={concept !== undefined} onOpenChange={(open) => { if (!open) setConcept(undefined); }}>
      {concept !== undefined && <ConceptCardDialog kpId={concept} renderLink={renderLink} />}
    </Dialog>

    <Dialog open={confirmAbort} onOpenChange={setConfirmAbort}>
      {task && <DialogContent>
        <DialogHeader>
          <DialogTitle>中止这次{kindText[task.kind]}？</DialogTitle>
          <DialogDescription>已经交的作答照样算数；还没判出结果的不等结果，直接结束。</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">不中止</Button></DialogClose>
          <Button variant="destructive" onClick={() => { setConfirmAbort(false); void abortTask(); }}>中止</Button>
        </DialogFooter>
      </DialogContent>}
    </Dialog>
  </div>;
}
