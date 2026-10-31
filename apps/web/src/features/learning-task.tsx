import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CircleCheck, Circle, LoaderCircle, RefreshCw } from "lucide-react";
import type { Delivery, LearningState, LearningTask, Submission } from "@repa/learning/protocol";

import { Button } from "@/components/ui/button";
import { StatusNotice } from "@/components/ui/status-notice";
import { ErrorNotice } from "@/components/domain/error-notice";
import { buildResponse, emptyDraft, ItemSlots, SlotProblems } from "@/components/domain/item-form";
import { Content, type Draft } from "@/components/domain/item-parts";
import { SubmissionReview } from "@/components/domain/submission-feedback";
import { useAppStore } from "@/hooks/use-app-store";
import type { Outgoing } from "@/lib/learning";
import type { RenderLink } from "@/components/ui/markdown";

type Phase = LearningTask["phase"];
type ContentPage = Extract<Phase, { stage: "explanation" }>["page"];

export const kindText = { lesson: "新课", review: "复习", quiz: "测验", retake: "重考" } as const;

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
    {error !== undefined && <ErrorNotice title="这一页没有读完" error={error} />}
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
    <ItemSlots item={item} draft={draft} onChange={setDraft} problems={problems} disabled={pending || busy} />
    <SlotProblems id={`${delivery.deliveryId}-problems`} problems={general} />
    {outgoing?.status === "failed" && <ErrorNotice title="没能交上" error={outgoing.error} />}
    {outgoing?.status === "unknown" && <p role="status" className="m-0 flex items-center gap-2 text-sm text-muted-foreground">
      <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
      连接断了，正在确认这份作答有没有交上，确认后会自动处理。
    </p>}
    <div className="flex flex-wrap items-center justify-end gap-3">
      {/* 测验不能说“不会”，没答的题由交卷或超时决定。 */}
      {delivery.mode !== "quiz" && <Button
        variant="outline"
        disabled={pending || busy}
        onClick={() => { void submitAnswer(delivery, task.taskId, { item: reference, answers: {}, dontKnow: true }); }}
      >不会</Button>}
      <Button disabled={pending || busy} onClick={() => { void submitAnswer(delivery, task.taskId, buildResponse(item, draft)); }}>
        {outgoing?.status === "sending" ? "正在提交…" : "提交"}
      </Button>
    </div>
  </div>;
}

function KpProgress({ task, titles }: { task: LearningTask; titles: Record<string, string> }) {
  if (task.kps.length === 0) return null;
  return <ol aria-label="知识点" className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-sm">
    {task.kps.map((kp) => <li key={kp.kpId} className="flex items-center gap-1.5">
      {kp.completed
        ? <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-status-complete" />
        : <Circle aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
      <span>{titles[kp.kpId] ?? kp.kpId}</span>
      <span className="sr-only">{kp.completed ? "，已掌握" : "，还没掌握"}</span>
    </li>)}
  </ol>;
}

const outcomeText = {
  passed: "这一节通过了。",
  failed: "这次没有通过，过一会儿可以再来。",
  timeout: "时间到了。",
  unresolved: "还有作答没判出结果，判出来以后结论会更新。",
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
        <p className="m-0 text-sm text-muted-foreground">正在准备{kindText[task.kind]}：辅导会先停下来。</p>
        <Actions><Button disabled={busy} onClick={() => { void resumeTask(); }}>继续</Button></Actions>
      </div>;
    case "explanation":
    case "example":
      return <div className="grid gap-5">
        <ContentPageView page={phase.page} renderLink={renderLink} />
        <Actions>
          <Button disabled={busy} onClick={() => { void advanceTask(); }}>{phase.stage === "explanation" ? "看例题" : "开始练习"}</Button>
        </Actions>
      </div>;
    case "awaiting_answer": {
      const delivery = task.deliveries.find((candidate) => candidate.deliveryId === phase.deliveryId);
      if (!delivery) return <StatusNotice status="error" title="找不到这道题"><p>请刷新后再试。</p></StatusNotice>;
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
        {phase.stage === "judging" && <p role="status" className="m-0 flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />正在判分…
        </p>}
        {phase.stage === "recovery" && <p className="m-0 text-sm text-muted-foreground">这份作答没能判出结果，不算错。可以再判一次，也可以先做下一题，条件具备时会自动补判。</p>}
        <Actions>
          {phase.stage === "recovery" && <Button variant="outline" disabled={busy} onClick={() => { void retryJudging(phase.submissionId); }}>
            <RefreshCw aria-hidden="true" />再判一次
          </Button>}
          {phase.stage !== "judging" && <Button disabled={busy} onClick={() => { void advanceTask(); }}>
            {phase.stage === "recovery" ? "先做下一题" : "继续"}
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
        <StatusNotice status="complete" title={`${kindText[task.kind]}结束`}><p>{outcomeText[phase.outcome]}</p></StatusNotice>
      </div>;
    }
    case "aborted":
      return <p className="m-0 text-sm text-muted-foreground">已中止。{phase.reason}</p>;
  }
}

/** 当前任务：类型、topic 名称、知识点进度和当前阶段的画面。 */
export function LearningTaskView({ state, task, renderLink }: { state: LearningState; task: LearningTask; renderLink: RenderLink }) {
  const titles = useAppStore((store) => store.learning.titles);
  const resolveTitles = useAppStore((store) => store.resolveTitles);
  const topics = task.topicIds.map((id) => titles[id] ?? id).join("、");

  useEffect(() => {
    // 受限任务进行中不能读内容，名称等结束后再补。
    if (state.restrictions.referenceContentAllowed) void resolveTitles([...task.topicIds, ...task.kps.map((kp) => kp.kpId)]);
  }, [task.topicIds, task.kps, state.restrictions.referenceContentAllowed, resolveTitles]);

  return <section aria-labelledby="learning-task-title" className="grid gap-5">
    <div className="grid gap-2">
      <p className="m-0 text-sm text-muted-foreground">{kindText[task.kind]}</p>
      <h3 id="learning-task-title" className="m-0 text-lg font-semibold">{topics}</h3>
      <KpProgress task={task} titles={titles} />
    </div>
    <Stage task={task} renderLink={renderLink} />
  </section>;
}
