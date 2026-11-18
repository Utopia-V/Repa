import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { CircleCheck, Circle, LoaderCircle, RefreshCw } from "lucide-react";
import type { ModelFailure } from "@repa/base/protocol";
import type { Delivery, LearningTask, Submission } from "@repa/learning/protocol";

import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusNotice } from "@/components/ui/status-notice";
import { ErrorNotice } from "@/components/domain/error-notice";
import { QuizClock } from "@/components/domain/quiz-clock";
import { buildResponse, emptyDraft, ItemSlots, SlotProblems } from "@/components/domain/item-form";
import { Content, type Draft } from "@/components/domain/item-parts";
import { SubmissionReview } from "@/components/domain/submission-feedback";
import { CodeTrial } from "@/features/code-trial";
import { useAppStore } from "@/hooks/use-app-store";
import { useDeadlineRefresh } from "@/hooks/use-deadline-refresh";
import type { Outgoing } from "@/lib/learning";
import type { RenderLink } from "@/components/ui/markdown";
import { t } from "@/lib/strings";

type Phase = LearningTask["phase"];
type ContentPage = Extract<Phase, { stage: "explanation" }>["page"];

export const kindText = { lesson: t("learn.task.lesson.label"), review: t("learn.task.review.label"), quiz: t("learn.task.quiz.label"), retake: t("learn.task.retake.label") } as const;

/** 判分的模型请求失败时按原因说一句；认不出原因的和不是模型请求失败的用同一句。 */
const ungradedText: Record<ModelFailure, string> = {
  network: t("learn.stage.ungraded.network.description"),
  auth: t("learn.stage.ungraded.auth.description"),
  balance: t("learn.stage.ungraded.balance.description"),
  rate_limit: t("learn.stage.ungraded.rateLimit.description"),
  server: t("learn.stage.ungraded.server.description"),
  other: t("learn.stage.ungraded.description"),
};

const CONCEPT_LINK = "repa:concept/";

/** 课程正文和辅导回复里的 `[名称](repa:concept/<知识点编号>)` 渲染成打开概念卡的按钮。 */
export function useConceptLinks(onConcept: (kpId: string) => void): RenderLink {
  return useCallback((href, children) => {
    if (!href.startsWith(CONCEPT_LINK)) return undefined;
    const kpId = href.slice(CONCEPT_LINK.length);
    return <button
      type="button"
      onClick={() => onConcept(kpId)}
      // 项目不加载 preflight，按钮的边框、底色、内距和字体要自己清掉，看起来才和正文里的链接一样。
      className="m-0 cursor-pointer rounded-sm border-0 bg-transparent p-0 font-[inherit] text-[length:inherit] leading-[inherit] text-primary underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >{children}</button>;
  }, [onConcept]);
}

/** 讲解或例题的一页；后端给的是开头一段时，接着读出剩下的块，整页一起显示。 */
function ContentPageView({ page, renderLink }: { page: ContentPage; renderLink: RenderLink }) {
  const readContent = useAppStore((state) => state.readContent);
  const [rest, setRest] = useState<ContentPage["blocks"]>([]);
  const [error, setError] = useState<unknown>();
  const loaded = page.offset + page.blocks.length;

  useEffect(() => {
    setRest([]);
    setError(undefined);
    if (loaded >= page.total) return;
    let active = true;
    void (async () => {
      const blocks: ContentPage["blocks"] = [];
      let offset = loaded;
      try {
        while (offset < page.total) {
          const [next] = await readContent(page.ref, offset);
          if (!next || next.blocks.length === 0) break;
          blocks.push(...next.blocks);
          offset = next.offset + next.blocks.length;
        }
        if (active) setRest(blocks);
      } catch (failure) {
        if (active) setError(failure);
      }
    })();
    return () => { active = false; };
  }, [page, loaded, readContent]);

  return <div className="grid gap-4">
    <Content blocks={[...page.blocks, ...rest]} renderLink={renderLink} />
    {error !== undefined && <ErrorNotice title={t("learn.task.unfinished.title")} error={error} />}
  </div>;
}

/** 作答。草稿只属于这一份交付；交过但结果不明时，按钮换成确认中的说明，不能再改答案。 */
function AnswerForm({ task, delivery, outgoing, busy }: {
  task: LearningTask;
  delivery: Delivery;
  outgoing: Outgoing | undefined;
  busy: boolean;
}) {
  const submitAnswer = useAppStore((state) => state.submitAnswer);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(delivery.item));
  const { item } = delivery;
  const problems = outgoing?.status === "rejected" ? outgoing.problems ?? [] : [];
  const general = problems.filter((problem) => problem.slot === undefined || !item.slots.some((slot) => slot.id === problem.slot));
  const pending = outgoing?.status === "sending" || outgoing?.status === "unknown";
  const reference = { id: item.id, version: item.version };

  return <div className="grid gap-5">
    <Content blocks={item.body} />
    <ItemSlots
      item={item}
      draft={draft}
      onChange={setDraft}
      problems={problems}
      disabled={pending || busy}
      after={(slot) => {
        const value = draft[slot.id];
        return value?.type === "code"
          ? <CodeTrial deliveryId={delivery.deliveryId} slotId={slot.id} code={value.code} disabled={pending || busy} />
          : null;
      }}
    />
    <SlotProblems id={`${delivery.deliveryId}-problems`} problems={general} />
    {outgoing?.status === "failed" && <ErrorNotice title={t("learn.answer.submit.error")} error={outgoing.error} />}
    {outgoing?.status === "unknown" && <p role="status" className="m-0 flex items-center gap-2 text-body text-muted-foreground">
      <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
      {t("learn.answer.confirming.status")}
    </p>}
    <div className="flex flex-wrap items-center justify-end gap-3">
      {/* 测验不能说“不会”，没答的题由交卷或超时决定。 */}
      {delivery.mode !== "quiz" && <Button
        variant="tertiary"
        disabled={pending || busy}
        onClick={() => { void submitAnswer(delivery, task.taskId, { item: reference, answers: {}, dontKnow: true }); }}
      >{t("learn.answer.dontKnow.action")}</Button>}
      <Button disabled={pending || busy} onClick={() => { void submitAnswer(delivery, task.taskId, buildResponse(item, draft)); }}>
        {outgoing?.status === "sending" ? t("common.submitting.status") : t("common.submit.action")}
      </Button>
    </div>
  </div>;
}

function KpProgress({ task }: { task: LearningTask }) {
  if (task.kps.length === 0) return null;
  return <ol aria-label={t("learn.progress.label")} className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-body">
    {task.kps.map((kp) => <li key={kp.kpId} className="flex items-center gap-1.5">
      {kp.completed
        ? <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-status-complete" />
        : <Circle aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
      <span>{kp.title}</span>
      <span className="sr-only">{kp.completed ? t("learn.progress.mastered.status") : t("learn.progress.notMastered.status")}</span>
    </li>)}
  </ol>;
}

const outcomeText = {
  passed: t("learn.result.passed.status"),
  failed: t("learn.result.failed.status"),
  timeout: t("learn.result.timeout.status"),
  unresolved: t("learn.result.unresolved.status"),
} as const;

function findSubmission(task: LearningTask, submissionId: string): { submission: Submission; delivery: Delivery } | undefined {
  const submission = task.submissions.find((candidate) => candidate.submissionId === submissionId);
  const delivery = submission && task.deliveries.find((candidate) => candidate.deliveryId === submission.deliveryId);
  return submission && delivery ? { submission, delivery } : undefined;
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-end gap-3">{children}</div>;
}

/** 按任务阶段显示当前画面和能做的操作。画面全部来自 LearningState，前端不记自己的进度。 */
function Stage({ task, renderLink }: { task: LearningTask; renderLink: RenderLink }) {
  const learning = useAppStore((store) => store.learning);
  const advanceTask = useAppStore((store) => store.advanceTask);
  const resumeTask = useAppStore((store) => store.resumeTask);
  const retryJudging = useAppStore((store) => store.retryJudging);
  const busy = learning.busy !== undefined;
  const { phase } = task;
  // 测验和重考没有“下一题”可推进：题目一次交付，作答页上直接换题；结束靠交卷或到截止时间。
  const quiz = task.kind === "quiz" || task.kind === "retake";

  switch (phase.stage) {
    case "preparing":
      return <div className="grid gap-4">
        <p className="m-0 text-body text-muted-foreground">{t("learn.stage.preparing.status", { kindText: kindText[task.kind] })}</p>
        <Actions><Button disabled={busy} onClick={() => { void resumeTask(); }}>{t("common.continue.action")}</Button></Actions>
      </div>;
    case "explanation":
    case "example":
      return <div className="grid gap-5">
        <ContentPageView page={phase.page} renderLink={renderLink} />
        <Actions>
          <Button disabled={busy} onClick={() => { void advanceTask(); }}>{phase.stage === "explanation" ? t("learn.stage.example.action") : t("learn.stage.practice.action")}</Button>
        </Actions>
      </div>;
    case "awaiting_answer": {
      // 测验的题都答完了：不再显示那道答过的题，只说明等交卷；交卷按钮在页面底部，这时是主按钮。
      if (quizReady(task)) return <Card role="status">
        <CardHeader>
          <CardTitle>{t("learn.quiz.ready.title")}</CardTitle>
          <CardDescription>{t("learn.quiz.ready.description")}</CardDescription>
        </CardHeader>
      </Card>;
      const delivery = task.deliveries.find((candidate) => candidate.deliveryId === phase.deliveryId);
      if (!delivery) return <StatusNotice status="error" title={t("learn.stage.itemMissing.title")}><p>{t("learn.stage.itemMissing.hint")}</p></StatusNotice>;
      return <AnswerForm
        key={delivery.deliveryId}
        task={task}
        delivery={delivery}
        outgoing={learning.outbox[delivery.submissionId]}
        busy={busy}
      />;
    }
    case "judging":
    case "recovery":
    case "feedback": {
      const found = findSubmission(task, phase.submissionId);
      const processing = found?.submission.processing;
      const failure = processing?.status === "interrupted" ? processing.failure ?? "other" : "other";
      // 点了“再判一次”以后，结果回来之前阶段仍是 recovery；这时说正在判分，而不是上一次没判出的原因。
      const grading = phase.stage === "judging" || (phase.stage === "recovery" && learning.busy === "retry");
      return <div className="grid gap-5">
        {found && <SubmissionReview item={found.delivery.item} submission={found.submission} />}
        {grading && <p role="status" className="m-0 flex items-center gap-2 text-body text-muted-foreground">
          <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />{t("learn.stage.grading.status")}
        </p>}
        {phase.stage === "recovery" && !grading && <p className="m-0 text-body text-muted-foreground">{ungradedText[failure]}</p>}
        <Actions>
          {phase.stage === "recovery" && failure === "auth" && <Button asChild variant="tertiary"><Link to="/settings">{t("common.setupModel.action")}</Link></Button>}
          {phase.stage === "recovery" && <Button variant="tertiary" disabled={busy} onClick={() => { void retryJudging(phase.submissionId); }} leadingIcon={RefreshCw}>{t("learn.stage.regrade.action")}
          </Button>}
          {phase.stage !== "judging" && !quiz && <Button disabled={busy} onClick={() => { void advanceTask(); }}>
            {phase.stage === "recovery" ? t("learn.stage.next.action") : t("common.continue.action")}
          </Button>}
        </Actions>
      </div>;
    }
    case "completed": {
      // 最后一题交完就直接结束，不经过反馈阶段；它的判分在这里补上。
      const last = task.submissions.at(-1);
      const found = last && findSubmission(task, last.submissionId);
      return <div className="grid gap-5">
        {found && <SubmissionReview item={found.delivery.item} submission={found.submission} />}
        <StatusNotice status="complete" title={t("learn.stage.ended.title", { kindText: kindText[task.kind] })}><p>{outcomeText[phase.outcome]}</p></StatusNotice>
      </div>;
    }
    case "aborted":
      return <p className="m-0 text-body text-muted-foreground">{t("learn.stage.aborted.status", { reason: phase.reason })}</p>;
  }
}

/**
 * 测验的题都答完、都判完，只等交卷或到截止时间。后端还没有这一阶段，这时交回的是指向最后一题的“等作答”；
 * 每道题都有作答记录就是这个情形（有作答没判出结果时后端交回的是“判不出结果”）。后端补上这一阶段以后改用它。
 */
export function quizReady(task: LearningTask): boolean {
  if ((task.kind !== "quiz" && task.kind !== "retake") || task.phase.stage !== "awaiting_answer" || task.deliveries.length === 0) return false;
  const answered = new Set(task.submissions.map((submission) => submission.deliveryId));
  return task.deliveries.every((delivery) => answered.has(delivery.deliveryId));
}

/** 测验里当前这道题是第几题：作答中的交付，或者判分中、判不出结果的那份作答所属的交付。结束以后为 undefined。 */
export function quizPosition(task: LearningTask): { current: number; total: number } | undefined {
  // 题都答完了：没有“当前这道题”，不写题号。
  if (quizReady(task)) return undefined;
  const { phase } = task;
  const deliveryId = phase.stage === "awaiting_answer"
    ? phase.deliveryId
    : "submissionId" in phase ? task.submissions.find((submission) => submission.submissionId === phase.submissionId)?.deliveryId
      ?? task.deliveries.find((delivery) => delivery.submissionId === phase.submissionId)?.deliveryId : undefined;
  const index = task.deliveries.findIndex((delivery) => delivery.deliveryId === deliveryId);
  return index < 0 ? undefined : { current: index + 1, total: task.deliveries.length };
}

/** 测验里还有几题没答：交卷或到截止时间以后，这些题算错。 */
export function quizUnanswered(task: LearningTask): number {
  const answered = new Set(task.submissions.map((submission) => submission.deliveryId));
  return task.deliveries.filter((delivery) => !answered.has(delivery.deliveryId)).length;
}

/**
 * 测验和重考的头部：只写类型、第几题和剩余时间。作答时只留当前这道题，不列全部 topic 的名称，也不显示知识点进度。
 */
function QuizHeading({ task }: { task: LearningTask }) {
  const serverNow = useAppStore((store) => store.learning.state?.serverNow);
  const readAt = useAppStore((store) => store.learning.readAt);
  const refreshLearning = useAppStore((store) => store.refreshLearning);
  const position = quizPosition(task);
  const running = task.phase.stage !== "completed" && task.phase.stage !== "aborted";
  // 到了截止时间重新读取：后端按截止时刻结束这一场，画面换成结果。
  const expire = useCallback(() => { void refreshLearning(); }, [refreshLearning]);
  useDeadlineRefresh(running ? task.deadlineAt : null, serverNow, readAt, expire);

  return <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
    <h3 id="learning-task-title" className="m-0 text-title weight-semibold">{kindText[task.kind]}</h3>
    {running && <div className="flex flex-wrap items-center gap-3">
      {position && <p className="m-0 text-body text-muted-foreground">{t("learn.quiz.position.status", position)}</p>}
      {task.deadlineAt !== null && serverNow !== undefined && <QuizClock deadlineAt={task.deadlineAt} serverNow={serverNow} readAt={readAt} />}
    </div>}
  </div>;
}

/** 当前任务：类型、topic 名称、知识点进度和当前阶段的画面；测验和重考的头部见 QuizHeading。 */
export function LearningTaskView({ task, renderLink }: { task: LearningTask; renderLink: RenderLink }) {
  const topics = task.topics.map((topic) => topic.title).join("、");
  const quiz = task.kind === "quiz" || task.kind === "retake";

  return <section aria-labelledby="learning-task-title" className="grid gap-5">
    {quiz ? <QuizHeading task={task} /> : <div className="grid gap-2">
      <p className="m-0 text-body text-muted-foreground">{kindText[task.kind]}</p>
      <h3 id="learning-task-title" className="m-0 text-title weight-semibold">{topics}</h3>
      <KpProgress task={task} />
    </div>}
    <Stage task={task} renderLink={renderLink} />
  </section>;
}
