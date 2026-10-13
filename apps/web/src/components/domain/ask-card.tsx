import { useId, useState, type ReactNode } from "react";
import { CircleAlert, CircleCheck, CircleHelp, CircleX, MessageCircle, PencilLine } from "lucide-react";
import type { Answer, Block, Feedback, Item, ItemResponse, Problem } from "@repa/base/protocol";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Markdown } from "@/components/ui/markdown";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { ErrorNotice } from "@/components/domain/error-notice";
import { answerText, plainText, slotName } from "@/lib/ask";
import type { Ask } from "@/lib/store";
import { cn } from "@/lib/utils";

type Slot = Item["slots"][number];
type ChoiceSlot = Extract<Slot, { type: "choice" }>;
type TextSlot = Extract<Slot, { type: "text" }>;

// “其他”在单选组里的取值；选项 id 以字母或数字开头，不会和它重复。
const OTHER = "_other";

type ChoiceDraft = { selected: string[]; other: boolean; otherText: string };
type Draft = Record<string, ChoiceDraft | string>;

/** 按交互词汇显示内容块：Markdown 按块声明决定是否排公式，代码块按带语言的代码显示。 */
function Content({ blocks, className }: { blocks: Block[] | undefined; className?: string }) {
  if (!blocks || blocks.length === 0) return null;
  return <div className={cn("flex min-w-0 flex-col gap-3", className)}>
    {blocks.map((block, index) => {
      if (block.type === "markdown") return <Markdown key={index} text={block.text} math={block.math === true} />;
      if (block.type === "code") {
        // 代码里有连续反引号时加长围栏，内容按原样显示。
        const fence = "`".repeat(Math.max(3, ...[...block.text.matchAll(/`+/gu)].map((match) => match[0].length + 1)));
        return <Markdown key={index} text={`${fence}${block.language}\n${block.text}\n${fence}`} math={false} />;
      }
      // 没有声明图片能力，后端不会发来；保险起见只给出说明。
      return <p key={index} className="m-0 text-muted-foreground">[图片：{block.alt}]</p>;
    })}
  </div>;
}

function emptyDraft(item: Item): Draft {
  return Object.fromEntries(item.slots.map((slot) => [slot.id, slot.type === "choice" ? { selected: [], other: false, otherText: "" } : ""]));
}

/** 只交用户动过的小问；没答的必答题由后端退回并说明。 */
function buildResponse(item: Item, draft: Draft): ItemResponse {
  const answers: Record<string, Answer> = {};
  for (const slot of item.slots) {
    const value = draft[slot.id];
    if (slot.type === "choice" && typeof value === "object") {
      if (value.selected.length > 0 || value.other) {
        answers[slot.id] = { type: "choice", selected: value.selected, ...(value.other ? { other: value.otherText } : {}) };
      }
    } else if (slot.type === "text" && typeof value === "string" && value !== "") {
      answers[slot.id] = { type: "text", text: value };
    }
  }
  return { item: { id: item.id, version: item.version }, answers };
}

function SlotProblems({ id, problems }: { id: string; problems: Problem[] }) {
  if (problems.length === 0) return null;
  return <div id={id} className="grid gap-1">
    {problems.map((problem, index) => <p key={index} className="m-0 flex items-start gap-1.5 text-sm text-destructive">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{problem.message}
    </p>)}
  </div>;
}

/** 选项的一行；选中时用选中边框和底色，同时有单选或复选框本身的选中标记。 */
function OptionRow({ selected, children }: { selected: boolean; children: ReactNode }) {
  return <div
    data-selected={selected || undefined}
    className="flex min-h-11 items-center gap-3 rounded-md border border-border px-3 py-2 text-sm data-selected:border-border-selected data-selected:bg-accent"
  >{children}</div>;
}

function ChoiceField({ slot, value, onChange, labelId, invalid, describedBy, disabled }: {
  slot: ChoiceSlot;
  value: ChoiceDraft;
  onChange(value: ChoiceDraft): void;
  labelId: string;
  invalid: boolean;
  describedBy: string | undefined;
  disabled: boolean;
}) {
  const base = useId();
  const otherLabel = slot.other?.label ?? "其他";
  const otherInput = slot.other && <Input
    aria-label={`${otherLabel}：自己填写`}
    placeholder="自己填写"
    value={value.otherText}
    disabled={disabled}
    // 开始填写就选中“其他”；单选时同时放下已选的选项。
    onChange={(event) => onChange(slot.multiple === true
      ? { ...value, other: true, otherText: event.target.value }
      : { selected: [], other: true, otherText: event.target.value })}
    className="flex-1"
  />;

  if (slot.multiple === true) {
    const toggle = (id: string, checked: boolean) => onChange({
      ...value,
      selected: checked ? slot.options.map((option) => option.id).filter((option) => option === id || value.selected.includes(option)) : value.selected.filter((option) => option !== id),
    });
    return <div role="group" aria-labelledby={labelId} aria-describedby={describedBy} className="grid gap-2">
      {slot.options.map((option) => {
        const id = `${base}-${option.id}`;
        const checked = value.selected.includes(option.id);
        return <OptionRow key={option.id} selected={checked}>
          <Checkbox id={id} checked={checked} disabled={disabled} aria-invalid={invalid || undefined} onCheckedChange={(next) => toggle(option.id, next === true)} />
          <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer"><Content blocks={option.content} /></label>
        </OptionRow>;
      })}
      {slot.other && <OptionRow selected={value.other}>
        <Checkbox id={`${base}-other`} checked={value.other} disabled={disabled} aria-invalid={invalid || undefined} onCheckedChange={(next) => onChange({ ...value, other: next === true })} />
        <label htmlFor={`${base}-other`} className="cursor-pointer">{otherLabel}</label>
        {otherInput}
      </OptionRow>}
    </div>;
  }

  const current = value.other ? OTHER : value.selected[0] ?? "";
  return <RadioGroup
    aria-labelledby={labelId}
    aria-describedby={describedBy}
    value={current}
    disabled={disabled}
    onValueChange={(next) => onChange(next === OTHER ? { ...value, selected: [], other: true } : { ...value, selected: [next], other: false })}
    className="gap-2"
  >
    {slot.options.map((option) => {
      const id = `${base}-${option.id}`;
      return <OptionRow key={option.id} selected={current === option.id}>
        <RadioGroupItem id={id} value={option.id} aria-invalid={invalid || undefined} />
        <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer"><Content blocks={option.content} /></label>
      </OptionRow>;
    })}
    {slot.other && <OptionRow selected={value.other}>
      <RadioGroupItem id={`${base}-other`} value={OTHER} aria-invalid={invalid || undefined} />
      <label htmlFor={`${base}-other`} className="cursor-pointer">{otherLabel}</label>
      {otherInput}
    </OptionRow>}
  </RadioGroup>;
}

function TextField({ slot, value, onChange, labelId, invalid, describedBy, disabled }: {
  slot: TextSlot;
  value: string;
  onChange(value: string): void;
  labelId: string;
  invalid: boolean;
  describedBy: string | undefined;
  disabled: boolean;
}) {
  // format 只是输入提示：数字给数字键盘，其他按普通文本。
  const inputMode = slot.format === "integer" ? "numeric" : slot.format === "number" ? "decimal" : undefined;
  const common = {
    "aria-labelledby": labelId,
    "aria-describedby": describedBy,
    "aria-invalid": invalid || undefined,
    placeholder: slot.placeholder,
    value,
    disabled,
  };
  return <div className="grid gap-2">
    <div className="flex items-center gap-2">
      {(slot.lines ?? 1) > 1
        ? <Textarea {...common} rows={slot.lines} onChange={(event) => onChange(event.target.value)} />
        : <Input {...common} inputMode={inputMode} onChange={(event) => onChange(event.target.value)} />}
      {slot.suffix && <span className="shrink-0 text-sm text-muted-foreground">{slot.suffix}</span>}
    </div>
    {slot.quick && slot.quick.length > 0 && <div className="flex flex-wrap gap-2">
      {slot.quick.map((text) => <Button key={text} variant="outline" disabled={disabled} onClick={() => onChange(text)}>{text}</Button>)}
    </div>}
  </div>;
}

const verdictText: Record<Feedback["verdict"], string> = {
  correct: "正确",
  partial: "部分正确",
  incorrect: "不正确",
  ungraded: "未判分",
  pending: "正在判分",
};

const criterionText = { yes: "做到了", no: "没做到", unsure: "不确定" } as const;

/** 判分反馈：总评和分数、说明，以及每一问的判定、说明、参考答案和评分要点。 */
function FeedbackView({ item, feedback }: { item: Item; feedback: Feedback }) {
  const score = (value: { earned: number; max: number } | undefined) => value ? ` · ${value.earned} / ${value.max}` : "";
  return <div className="grid gap-3 text-sm">
    <p className="m-0 font-semibold">{verdictText[feedback.verdict]}{score(feedback.score)}</p>
    <Content blocks={feedback.message} />
    {item.slots.map((slot, index) => {
      const result = feedback.slots?.[slot.id];
      if (!result) return null;
      return <div key={slot.id} className="grid gap-1">
        <p className="m-0"><span className="text-muted-foreground">{slotName(slot, index)}：</span>{verdictText[result.verdict]}{score(result.score)}</p>
        <Content blocks={result.message} />
        {result.expected && <p className="m-0"><span className="text-muted-foreground">参考答案：</span>{answerText(slot, result.expected)}</p>}
        {result.criteria && <ul className="m-0 grid list-none gap-1 p-0">
          {result.criteria.map((criterion, position) => <li key={position} className="flex gap-2">
            <span className="shrink-0 font-semibold">{criterionText[criterion.met]}</span>
            <span>{criterion.label}{criterion.comment ? `：${criterion.comment}` : ""}</span>
          </li>)}
        </ul>}
      </div>;
    })}
    {feedback.judge === "model" && <p className="m-0 text-muted-foreground">由模型判分，仅供参考</p>}
  </div>;
}

const endedText = {
  cancelled: "你关闭了这次提问",
  aborted: "提问已结束：运行停止了",
  closed: "提问已结束：空间关闭了",
  disconnected: "提问已结束：连接中断了",
  answered: "提问已结束",
} as const;

/**
 * 对话里的一次询问。等待作答时是一张可以提交、关闭的卡片，练习还可以说“我不会”；交了以后收起成问题和回答，
 * 有判分时附上反馈；在输入框里回了一句话时显示这句话；其他方式结束时只留一行说明。
 */
export function AskCard({ ask, onSubmit, onCancel }: {
  ask: Ask;
  /** 作答；练习里点“我不会”时 answers 为空并带 dontKnow。 */
  onSubmit(response: ItemResponse): void;
  onCancel(): void;
}) {
  const { item, purpose } = ask.request;
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(item));
  const base = useId();
  const titleId = `${base}-title`;
  const practice = purpose === "practice";

  if (ask.closed !== undefined) {
    if (ask.declined !== undefined) {
      return <section aria-labelledby={titleId} className="mb-4 grid gap-2 rounded-md border border-border bg-card p-5 text-card-foreground">
        <h3 id={titleId} className="m-0 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          <MessageCircle aria-hidden="true" className="size-4 shrink-0" />你没有按卡片作答，回了一句话
        </h3>
        <p className="m-0 text-sm break-words whitespace-pre-wrap">{ask.declined}</p>
      </section>;
    }
    if (ask.response?.dontKnow === true) {
      return <p className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
        <CircleCheck aria-hidden="true" className="size-4 shrink-0" />你说这道题不会
      </p>;
    }
    if (ask.response) {
      return <section aria-labelledby={titleId} className="mb-4 grid gap-3 rounded-md border border-border bg-card p-5 text-card-foreground">
        <h3 id={titleId} className="m-0 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          <CircleCheck aria-hidden="true" className="size-4 shrink-0" />{practice ? "你交了这道练习" : "你回答了 Agent 的提问"}
        </h3>
        <dl className="m-0 grid gap-2 text-sm">
          {item.slots.map((slot, index) => <div key={slot.id} className="grid gap-0.5">
            {/* 回看时题面比短标签清楚。 */}
            <dt className="text-muted-foreground">{slot.prompt && slot.prompt.length > 0 ? <Content blocks={slot.prompt} /> : slotName(slot, index)}</dt>
            <dd className="m-0 break-words whitespace-pre-wrap">{answerText(slot, ask.response?.answers[slot.id])}</dd>
          </div>)}
        </dl>
        {ask.feedback && <FeedbackView item={item} feedback={ask.feedback} />}
      </section>;
    }
    const Icon = ask.closed === "cancelled" ? CircleX : CircleAlert;
    return <p className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
      <Icon aria-hidden="true" className="size-4 shrink-0" />{endedText[ask.closed]}
    </p>;
  }

  const slotProblems = (id: string) => ask.problems.filter((problem) => problem.slot === id);
  const general = ask.problems.filter((problem) => problem.slot === undefined || !item.slots.some((slot) => slot.id === problem.slot));
  const numbered = item.slots.length > 1;
  const TitleIcon = practice ? PencilLine : CircleHelp;

  return <section aria-labelledby={titleId} className="mb-4 grid gap-5 rounded-md border border-border-selected bg-card p-5 text-card-foreground">
    <div className="flex items-center justify-between gap-3">
      <h3 id={titleId} className="m-0 flex items-center gap-2 text-base font-semibold">
        <TitleIcon aria-hidden="true" className="size-5 shrink-0 text-primary" />{item.title ?? (practice ? "练习" : "Agent 想问你")}
      </h3>
      <Button variant="ghost" size="icon" aria-label="关闭提问" title="关闭提问，不作答" onClick={onCancel}>
        <CircleX aria-hidden="true" />
      </Button>
    </div>
    <Content blocks={item.body} />
    {item.slots.map((slot, index) => {
      const labelId = `${base}-${slot.id}-label`;
      const problemsId = `${base}-${slot.id}-problems`;
      const problems = slotProblems(slot.id);
      const describedBy = problems.length > 0 ? problemsId : undefined;
      const value = draft[slot.id];
      const update = (next: ChoiceDraft | string) => setDraft((current) => ({ ...current, [slot.id]: next }));
      // 模型常在题面里自己写“可多选”，已经写了就不再重复。
      const multiple = slot.type === "choice" && slot.multiple === true;
      const hint = multiple ? plainText(slot.prompt).includes("多选") ? "" : "（可多选）" : slot.optional === true ? "（可不答）" : "";
      return <div key={slot.id} className="grid gap-2">
        <div id={labelId} className="flex items-start gap-1 text-sm font-semibold">
          {numbered && <span className="shrink-0">{index + 1}.</span>}
          {slot.prompt && slot.prompt.length > 0 ? <Content blocks={slot.prompt} /> : <span>{slotName(slot, index)}</span>}
          {hint && <span className="shrink-0 font-normal text-muted-foreground">{hint}</span>}
        </div>
        {slot.type === "choice" && typeof value === "object" && <ChoiceField
          slot={slot} value={value} onChange={update} labelId={labelId} invalid={problems.length > 0} describedBy={describedBy} disabled={ask.submitting}
        />}
        {slot.type === "text" && typeof value === "string" && <TextField
          slot={slot} value={value} onChange={update} labelId={labelId} invalid={problems.length > 0} describedBy={describedBy} disabled={ask.submitting}
        />}
        <SlotProblems id={problemsId} problems={problems} />
      </div>;
    })}
    <SlotProblems id={`${base}-problems`} problems={general} />
    {ask.error !== undefined && <ErrorNotice title="没能送出" error={ask.error} />}
    <p className="m-0 text-sm text-muted-foreground">不想按卡片答，也可以在下面的输入框里直接回一句。</p>
    <div className="flex flex-wrap items-center justify-end gap-3">
      {practice && <Button
        variant="ghost"
        disabled={ask.submitting}
        onClick={() => onSubmit({ item: { id: item.id, version: item.version }, answers: {}, dontKnow: true })}
        className="mr-auto"
      >我不会</Button>}
      <Button disabled={ask.submitting} onClick={() => onSubmit(buildResponse(item, draft))}>
        {ask.submitting ? "正在提交…" : "提交"}
      </Button>
    </div>
  </section>;
}
