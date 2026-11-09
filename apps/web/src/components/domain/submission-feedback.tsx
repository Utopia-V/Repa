import { useMemo } from "react";
import { CircleAlert, CircleCheck, CircleDashed, CircleX, Info } from "lucide-react";
import type { Answer, Item } from "@repa/base/protocol";
import type { Feedback, SlotFeedback, Submission, TestResult, Verdict } from "@repa/learning/protocol";

import { draftFromResponse, ItemSlots } from "@/components/domain/item-form";
import { Content, rowName, type Mark, type Slot, type SlotMarks } from "@/components/domain/item-parts";
import { answerText } from "@/lib/ask";
import { cn } from "@/lib/utils";
import { t } from "@/lib/strings";

const verdictText: Record<Verdict, string> = {
  correct: t("item.feedback.correct.status"),
  partial: t("item.feedback.partial.status"),
  incorrect: t("item.result.incorrect.label"),
  ungraded: t("item.feedback.ungraded.status"),
  pending: t("item.feedback.pending.status"),
};

const testText: Record<TestResult["result"], string> = {
  passed: t("item.feedback.passed.status"),
  failed: t("item.feedback.failed.status"),
  error: t("common.runError.status"),
  timeout: t("item.feedback.timeout.status"),
};

/** 判分结果的标题：图标加文字，对错不只靠颜色。 */
export function VerdictHeading({ verdict }: { verdict: Verdict }) {
  const Icon = verdict === "correct" ? CircleCheck : verdict === "incorrect" ? CircleX : verdict === "partial" ? CircleDashed : Info;
  return <p className={cn(
    "m-0 flex items-center gap-2 text-title weight-semibold",
    verdict === "correct" && "text-status-complete",
    (verdict === "incorrect" || verdict === "partial") && "text-destructive",
  )}>
    <Icon aria-hidden="true" className="size-5 shrink-0" />{verdictText[verdict]}
  </p>;
}

/** 表格题的参考答案逐格列出；其他题型按作答的文字回显。 */
function expectedText(slot: Slot, expected: Answer): string {
  if (expected.type === "table" && slot.type === "table") {
    return slot.rows.flatMap((row, index) => Object.entries(expected.cells[row.id] ?? {}).map(([column, cell]) => {
      const header = slot.columns.find((candidate) => candidate.id === column)?.header ?? column;
      const input = row.cells[column];
      const value = cell.type === "text"
        ? cell.text
        : cell.selected.map((id) => input && "input" in input && input.input.type === "choice" ? input.input.options.find((option) => option.id === id)?.label ?? id : id).join("、");
      return `${rowName(row, index)}，${header}：${value}`;
    })).join("\n");
  }
  return answerText(slot, expected);
}

function SlotResult({ slot, feedback }: { slot: Slot; feedback: SlotFeedback | undefined }) {
  if (!feedback) return null;
  const hasDetail = feedback.message || feedback.expected || feedback.tests?.length || feedback.criteria?.length;
  if (!hasDetail) return null;
  return <div className="grid gap-2 rounded-lg border border-border bg-card p-3 text-body">
    <Content blocks={feedback.message} />
    {feedback.expected && <div className="grid gap-1">
      <p className="m-0 text-muted-foreground">{t("item.feedback.reference.label")}</p>
      <p className={cn("m-0 break-words whitespace-pre-wrap", (slot.type === "code" || slot.type === "order") && "font-mono")}>{expectedText(slot, feedback.expected)}</p>
    </div>}
    {feedback.tests && feedback.tests.length > 0 && <ul className="m-0 grid list-none gap-2 p-0">
      {feedback.tests.map((test, index) => <li key={index} className="grid gap-1">
        <p className={cn("m-0 flex items-center gap-2", test.result === "passed" ? "text-status-complete" : "text-destructive")}>
          {test.result === "passed" ? <CircleCheck aria-hidden="true" className="size-4 shrink-0" /> : <CircleAlert aria-hidden="true" className="size-4 shrink-0" />}
          <span className="text-foreground">{test.hidden ? t("item.feedback.hiddenTests.label") : test.name}</span>：{testText[test.result]}
        </p>
        <Content blocks={test.detail} />
      </li>)}
    </ul>}
    {feedback.criteria && feedback.criteria.length > 0 && <ul className="m-0 grid list-none gap-1 p-0">
      {feedback.criteria.map((criterion, index) => <li key={index}>
        <span className="weight-semibold">{criterion.label}</span>：{criterion.met === "yes" ? t("item.feedback.achieved.label") : criterion.met === "no" ? t("item.feedback.notAchieved.label") : t("item.feedback.uncertain.label")}
        {criterion.comment && <span className="text-muted-foreground">。{criterion.comment}</span>}
      </li>)}
    </ul>}
  </div>;
}

function marksOf(feedback: Feedback | undefined): SlotMarks | undefined {
  if (!feedback?.slots) return undefined;
  const marks: SlotMarks = {};
  for (const [slot, result] of Object.entries(feedback.slots)) {
    if (result.marks) marks[slot] = result.marks satisfies Record<string, Mark>;
  }
  return marks;
}

/**
 * 一份已交的作答：题面之后先给整题的判分结论和说明，再照原样只读显示学习者的答案和判分标记，
 * 各作答位下面是参考答案、测试结果和评分要点，最后是解析。反馈或解析还没释放时只显示答案本身。
 */
export function SubmissionReview({ item, submission }: { item: Item; submission: Submission }) {
  const draft = useMemo(() => draftFromResponse(item, submission.response), [item, submission.response]);
  const { feedback } = submission;
  return <div className="grid gap-5">
    <Content blocks={item.body} />
    {feedback && <div className="grid gap-2">
      <VerdictHeading verdict={feedback.verdict} />
      {feedback.score && <p className="m-0 text-body text-muted-foreground">{t("item.feedback.score.label", { earned: feedback.score.earned, max: feedback.score.max })}</p>}
      {feedback.evidence?.status === "ineligible" && <p className="m-0 text-body text-muted-foreground">
        {t("item.feedback.notCounted.status")}{feedback.evidence.reason ? `：${feedback.evidence.reason}` : ""}。
      </p>}
      <Content blocks={feedback.message} />
    </div>}
    {submission.response.dontKnow === true
      ? <p className="m-0 text-body text-muted-foreground">{t("item.feedback.dontKnow.status")}</p>
      : <ItemSlots
        item={item}
        draft={draft}
        onChange={() => undefined}
        problems={[]}
        disabled
        marks={marksOf(feedback)}
        after={(slot) => <SlotResult slot={slot} feedback={feedback?.slots?.[slot.id]} />}
      />}
    {submission.explanation && submission.explanation.length > 0 && <section aria-label={t("item.feedback.explanation.label")} className="grid gap-2">
      <h4 className="m-0 text-body weight-semibold">{t("item.feedback.explanation.label")}</h4>
      <Content blocks={submission.explanation} />
    </section>}
  </div>;
}
