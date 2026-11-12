import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CircleCheck, Circle, LoaderCircle, RefreshCw } from "lucide-react";
import type { Delivery, LearningTask, Submission } from "@repa/learning/protocol";

import { Button } from "@/components/ui/button";
import { StatusNotice } from "@/components/ui/status-notice";
import { ErrorNotice } from "@/components/domain/error-notice";
import { buildResponse, emptyDraft, ItemSlots, SlotProblems } from "@/components/domain/item-form";
import { Content, type Draft } from "@/components/domain/item-parts";
import { SubmissionReview } from "@/components/domain/submission-feedback";
import { CodeTrial } from "@/features/code-trial";
import { useAppStore } from "@/hooks/use-app-store";
import type { Outgoing } from "@/lib/learning";
import type { RenderLink } from "@/components/ui/markdown";
import { t } from "@/lib/strings";

type Phase = LearningTask["phase"];
type ContentPage = Extract<Phase, { stage: "explanation" }>["page"];

export const kindText = { lesson: t("learn.task.lesson.label"), review: t("learn.task.review.label"), quiz: t("learn.task.quiz.label"), retake: t("learn.task.retake.label") } as const;

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
      return <div className="grid gap-5">
        {found && <SubmissionReview item={found.delivery.item} submission={found.submission} />}
        {phase.stage === "judging" && <p role="status" className="m-0 flex items-center gap-2 text-body text-muted-foreground">
          <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />{t("learn.stage.grading.status")}
        </p>}
        {phase.stage === "recovery" && <p className="m-0 text-body text-muted-foreground">{t("learn.stage.ungraded.description")}</p>}
        <Actions>
          {phase.stage === "recovery" && <Button variant="tertiary" disabled={busy} onClick={() => { void retryJudging(phase.submissionId); }} leadingIcon={RefreshCw}>{t("learn.stage.regrade.action")}
          </Button>}
          {phase.stage !== "judging" && <Button disabled={busy} onClick={() => { void advanceTask(); }}>
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

/** 当前任务：类型、topic 名称、知识点进度和当前阶段的画面。 */
export function LearningTaskView({ task, renderLink }: { task: LearningTask; renderLink: RenderLink }) {
  const topics = task.topics.map((topic) => topic.title).join("、");

  return <section aria-labelledby="learning-task-title" className="grid gap-5">
    <div className="grid gap-2">
      <p className="m-0 text-body text-muted-foreground">{kindText[task.kind]}</p>
      <h3 id="learning-task-title" className="m-0 text-title weight-semibold">{topics}</h3>
      <KpProgress task={task} />
    </div>
    <Stage task={task} renderLink={renderLink} />
  </section>;
}
