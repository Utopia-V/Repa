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
import { CourseOutline } from "@/features/course-outline";
import { LearningMenuView } from "@/features/learning-menu";
import { kindText, LearningTaskView, useConceptLinks } from "@/features/learning-task";
import { MakingPanel, useMakingSession } from "@/features/making-panel";
import { MakingStart } from "@/features/making-start";
import { TutorPanel } from "@/features/tutor-panel";
import { useAppStore } from "@/hooks/use-app-store";
import { errorCode } from "@/lib/errors";
import { t } from "@/lib/strings";

const WIDE = "(min-width: 1280px)";

/**
 * 宽屏时右侧的面板常驻，窄屏时收进抽屉。断点按左侧导航、任务区和面板三栏都放得下来定。
 * 只挂一份面板，避免两处同时绑定会话。
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
  const [panelOpen, setPanelOpen] = useState(false);
  // 在做课的起点选了改学随包的课；开始一节课以后有了学习记录，起点本来就不再出现。
  const [bundledChosen, setBundledChosen] = useState(false);
  const asking = useAppStore((state) => state.asks.some((ask) => ask.closed === undefined));
  const conversation = useAppStore((state) => state.conversation);
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

  // 窄屏时做课的对话在抽屉里：Agent 提问时它在等学习者回答，打开抽屉让问题被看到。
  const makingOpen = !learning.state?.task && learning.building?.sessionId != null;
  useMakingSession(makingOpen ? learning.building?.sessionId ?? undefined : undefined);
  useEffect(() => {
    if (asking && makingOpen) setPanelOpen(true);
  }, [asking, makingOpen]);

  // 换了任务、阶段或题目，从新画面的开头看起；同一画面里的刷新不动滚动位置。
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [position]);

  if (learning.available === false) {
    return <div className="mx-auto grid max-w-3xl gap-3 px-4 py-16 md:px-8">
      <StatusNotice status="error" title={t("learn.noPlugin.title")}><p>{t("learn.noPlugin.description")}</p></StatusNotice>
    </div>;
  }
  const { state } = learning;
  if (!state) {
    return <div className="mx-auto grid max-w-3xl gap-3 px-4 py-16 md:px-8">
      {learning.status === "error"
        ? <>
          <ErrorNotice title={t("learn.load.error")} error={learning.loadError} />
          <div><Button variant="tertiary" onClick={() => { void loadLearning(); }} leadingIcon={RefreshCw}>{t("common.retry.action")}</Button></div>
        </>
        : <p role="status" className="text-body text-muted-foreground">{t("learn.loading.status")}</p>}
    </div>;
  }

  const { task, menu, progress, restrictions } = state;
  const { building, settings } = learning;
  const active = task !== null && task.phase.stage !== "completed" && task.phase.stage !== "aborted";
  const goal = Math.min(100, Math.round(progress.todayXp / progress.dailyGoalXp * 100));
  // 做课：有了自制课或做课的对话以后显示整门课的全貌。
  const makingSession = building?.sessionId ?? undefined;
  const making = building !== undefined && (building.course !== null || makingSession !== undefined);
  // 一个空间学一门课。还没有选定课的空间（没有自制课、没有做课的对话，也没有任何学习记录，或者根本没有可学的课）
  // 整页是做课的起点；已经在学随包课的空间照旧。
  const startable = building !== undefined && !making && !active && !bundledChosen && (state.revision === 0 || state.course === null);
  // 只有轮廓、还没有能学的部分时，Agent 正在和学习者商量轮廓，菜单那句“没有可开始的任务”放在这里不对，不显示。
  const outlineOnly = making && !building.parts.some((part) => part.status !== "outline");
  // 还没有换用过自制课时，学的不是随包的那门：标题栏与起点一样，不显示随包课的课名和今日 XP。
  const plain = startable || (making && building.course === null);
  // 做课的 Agent 正在运行时，它和后台展开会同时改 course/，“先做”与“再试”先不让点。
  const makingRunning = makingSession !== undefined && conversation.sessionId === makingSession && conversation.run !== "idle";
  // 右侧：有学习任务时是辅导，行为不变；没有任务而有做课的对话时是做课的对话。
  const panel = task
    ? { label: t("tutor.panel.label"), action: t("learn.tutor.action"), content: <TutorPanel allowed={restrictions.tutorAllowed} restriction={restrictions.kind} renderLink={renderLink} /> }
    : makingSession !== undefined
      ? { label: t("making.panel.label"), action: t("learn.making.action"), content: <MakingPanel sessionId={makingSession} /> }
      : undefined;
  const makingPanel = !task && makingSession !== undefined;

  return <div className="flex h-dvh flex-col">
    {/* 移动端左侧让出浮动的导航按钮。 */}
    <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border py-2 pr-4 pl-16 md:px-6">
      <h2 className="m-0 min-w-0 truncate text-title weight-semibold">{(plain ? undefined : state.course?.title ?? building?.course?.title) ?? t("learn.page.title")}</h2>
      <div className="flex items-center gap-3">
        {!plain && <div className="grid w-40 gap-1">
          <span className="text-caption text-muted-foreground">{t("learn.dailyGoal.label", { todayXp: progress.todayXp, dailyGoalXp: progress.dailyGoalXp })}</span>
          <Progress value={goal} aria-label={t("learn.dailyGoal.progress.label")} />
        </div>}
        {panel && !wide && <Button variant="tertiary" onClick={() => setPanelOpen(true)} leadingIcon={MessageCircle}>{panel.action}
        </Button>}
      </div>
    </header>

    <div className="flex min-h-0 flex-1">
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-3xl gap-6 px-4 py-6 md:px-8">
          {learning.replaced && <StatusNotice status="error" title={t("learn.stale.title")}><p>{t("learn.stale.description")}</p></StatusNotice>}
          {/* 剩下的题都要模型判分而没有可用模型：任务保留，接上模型后再继续。 */}
          {errorCode(learning.actionError) === "model_required" ? <div className="grid gap-3">
            <StatusNotice status="error" title={t("common.noModel.title")}><p>{t("learn.noModel.description")}</p></StatusNotice>
            <div><Button asChild variant="tertiary"><Link to="/settings">{t("common.setupModel.action")}</Link></Button></div>
          </div> : learning.actionError !== undefined && <div className="grid gap-3">
            <ErrorNotice title={t("learn.action.error")} error={learning.actionError} />
            <div><Button variant="tertiary" onClick={() => { void refreshLearning(); }} leadingIcon={RefreshCw}>{t("learn.reload.action")}</Button></div>
          </div>}
          {task && <LearningTaskView task={task} renderLink={renderLink} />}
          {active && <div className="flex justify-end">
            <Button variant="ghost" disabled={learning.busy !== undefined} onClick={() => setConfirmAbort(true)}>{t("learn.abort.action", { kindText: kindText[task.kind] })}</Button>
          </div>}
          {startable && <MakingStart
            onStarted={() => setPanelOpen(true)}
            onUseBundled={state.course === null ? undefined : () => setBundledChosen(true)}
          />}
          {!startable && !outlineOnly && menu && learning.readAt !== undefined && <LearningMenuView menu={menu} serverNow={state.serverNow} readAt={learning.readAt} />}
          {/* 上课、做题时整门课不出现，学习者专心在任务上；任务结束回到菜单时再出现。 */}
          {making && !active && (building.parts.length > 0 || building.course !== null
            ? <CourseOutline building={building} settings={settings} agentRunning={makingRunning} />
            : <p role="status" className="m-0 text-body text-muted-foreground">{t("outline.pending.status")}</p>)}
          {building === undefined && learning.buildingError !== undefined && <ErrorNotice title={t("outline.load.error")} error={learning.buildingError} />}
          {!task && !menu && !startable && !making && <p className="m-0 text-body text-muted-foreground">{t("learn.menu.noTask.empty")}</p>}
        </div>
      </div>
      {panel && wide && <aside aria-label={panel.label} className="flex w-96 shrink-0 flex-col border-l border-border">
        <h3 className="m-0 px-4 pt-4 text-title weight-semibold">{panel.label}</h3>
        {panel.content}
      </aside>}
    </div>

    {panel && !wide && <Sheet open={panelOpen} onOpenChange={setPanelOpen}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{panel.label}</SheetTitle>
          {!makingPanel && <SheetDescription>{t("learn.tutor.description")}</SheetDescription>}
        </SheetHeader>
        {panel.content}
      </SheetContent>
    </Sheet>}

    <Dialog open={concept !== undefined} onOpenChange={(open) => { if (!open) setConcept(undefined); }}>
      {concept !== undefined && <ConceptCardDialog kpId={concept} renderLink={renderLink} />}
    </Dialog>

    <Dialog open={confirmAbort} onOpenChange={setConfirmAbort}>
      {task && <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("learn.abort.title", { kindText: kindText[task.kind] })}</DialogTitle>
          <DialogDescription>{t("learn.abort.description")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild><Button variant="tertiary">{t("learn.abort.cancel.action")}</Button></DialogClose>
          <Button variant="destructive" onClick={() => { setConfirmAbort(false); void abortTask(); }}>{t("learn.abort.confirm.action")}</Button>
        </DialogFooter>
      </DialogContent>}
    </Dialog>
  </div>;
}
