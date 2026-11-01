import type { ReactNode } from "react";
import { CircleCheck, CircleDashed, CircleX } from "lucide-react";
import type { Block, Item } from "@repa/base/protocol";

import { Markdown } from "@/components/ui/markdown";
import { cn } from "@/lib/utils";

export type Slot = Item["slots"][number];

export type ChoiceDraft = { type: "choice"; selected: string[]; other: boolean; otherText: string };
export type OrderDraft = { type: "order"; items: string[]; indents: number[] };
/** 表格输入格的草稿：cells[行][列]，文本格是文字，选择格是选中的选项 id，没选时为空串。 */
export type TableDraft = { type: "table"; cells: Record<string, Record<string, string>> };
/** 一个作答位正在编辑的内容，按作答位类型区分。 */
export type SlotDraft =
  | ChoiceDraft
  | { type: "text"; text: string }
  | OrderDraft
  | TableDraft
  | { type: "code"; code: string };
/** 一道题各作答位的草稿，以作答位 id 为键。 */
export type Draft = Record<string, SlotDraft>;

/** 选项、单元格（"行 id/列 id"）或排列位置上的判分标记，与学习插件反馈里的 marks 同义。 */
export type Mark = "correct" | "incorrect" | "missed";
/** 回看作答时每个作答位上的标记，以作答位 id 为键。 */
export type SlotMarks = Record<string, Record<string, Mark>>;

/** 按交互词汇显示内容块：Markdown 按块声明决定是否排公式，代码块按带语言的代码显示。 */
export function Content({ blocks, className, renderLink }: {
  blocks: Block[] | undefined;
  className?: string;
  renderLink?: Parameters<typeof Markdown>[0]["renderLink"];
}) {
  if (!blocks || blocks.length === 0) return null;
  return <div className={cn("flex min-w-0 flex-col gap-3", className)}>
    {blocks.map((block, index) => {
      if (block.type === "markdown") return <Markdown key={index} text={block.text} math={block.math === true} renderLink={renderLink} />;
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

const markText = { correct: "正确", incorrect: "不对", missed: "应该选上" } as const;

/** 判分标记：图标加文字，不只靠颜色区分。 */
export function MarkBadge({ mark }: { mark: Mark | undefined }) {
  if (!mark) return null;
  const Icon = mark === "correct" ? CircleCheck : mark === "incorrect" ? CircleX : CircleDashed;
  return <span className={cn(
    "flex shrink-0 items-center gap-1 text-sm",
    mark === "correct" ? "text-status-complete" : "text-destructive",
  )}>
    <Icon aria-hidden="true" className="size-4" />{markText[mark]}
  </span>;
}

/** 选项的一行；选中时用选中边框和底色，同时有单选或复选框本身的选中标记。 */
export function OptionRow({ selected, children }: { selected: boolean; children: ReactNode }) {
  return <div
    data-selected={selected || undefined}
    className="flex min-h-11 items-center gap-3 rounded-md border border-border px-3 py-2 text-sm data-selected:border-border-selected data-selected:bg-accent"
  >{children}</div>;
}

export type FieldProps<S extends Slot, D> = {
  slot: S;
  value: D;
  onChange(value: D): void;
  labelId: string;
  invalid: boolean;
  describedBy: string | undefined;
  disabled: boolean;
  marks: Record<string, Mark> | undefined;
};


type TableRow = Extract<Slot, { type: "table" }>["rows"][number];

/**
 * 表格一行的名称，用于输入格的可访问名称和参考答案：有行标题用行标题，没有时用这一行第一个固定文字格
 * （课程常把“名字”放在第一列），都没有时按行号。
 */
export function rowName(row: TableRow, index: number): string {
  if (row.header !== undefined) return row.header;
  const first = Object.values(row.cells).find((cell) => "value" in cell);
  return first && "value" in first ? first.value.replace(/`/gu, "") : `第 ${index + 1} 行`;
}
