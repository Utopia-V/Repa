import { ArrowDown, ArrowUp, IndentDecrease, IndentIncrease, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Content, MarkBadge, type FieldProps, type OrderDraft, type Slot } from "@/components/domain/item-parts";
import { plainText } from "@/lib/ask";

type OrderSlot = Extract<Slot, { type: "order" }>;

/**
 * 排列题：用按钮上移、下移，有缩进时加减缩进；可以留下不用的块时，从候选里加入、再移出。
 * 不用拖拽，键盘和读屏都能完成全部操作。判分标记的键是排列位置（从 0 开始）。
 */
export function OrderField({ slot, value, onChange, labelId, describedBy, disabled, marks }: FieldProps<OrderSlot, OrderDraft>) {
  const blocks = new Map(slot.items.map((block) => [block.id, block]));
  const unused = slot.items.filter((block) => !value.items.includes(block.id));
  const maxIndent = slot.indent ?? 0;
  const name = (id: string) => plainText(blocks.get(id)?.content) || id;

  function move(index: number, offset: number) {
    const target = index + offset;
    if (target < 0 || target >= value.items.length) return;
    const items = [...value.items];
    const indents = [...value.indents];
    [items[index], items[target]] = [items[target] ?? "", items[index] ?? ""];
    [indents[index], indents[target]] = [indents[target] ?? 0, indents[index] ?? 0];
    onChange({ ...value, items, indents });
  }

  function indent(index: number, change: number) {
    const indents = value.indents.map((level, at) => at === index ? Math.min(maxIndent, Math.max(0, level + change)) : level);
    onChange({ ...value, indents });
  }

  return <div className="grid gap-3" aria-describedby={describedBy}>
    <ol aria-labelledby={labelId} className="m-0 grid list-none gap-2 p-0">
      {value.items.length === 0 && <li className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
        还没有排入任何块，从下面的候选里加入。
      </li>}
      {value.items.map((id, index) => {
        const level = value.indents[index] ?? 0;
        return <li
          key={id}
          // 缩进表示代码的层级，按 4 个空格的宽度往右排。
          style={{ marginInlineStart: `${level * 2}rem` }}
          className="flex min-h-11 items-center gap-2 rounded-md border border-border bg-card px-3 py-1"
        >
          <span className="w-6 shrink-0 text-sm text-muted-foreground">{index + 1}</span>
          <Content blocks={blocks.get(id)?.content} className="flex-1 text-sm" />
          <MarkBadge mark={marks?.[String(index)]} />
          {!disabled && <div className="flex shrink-0 flex-wrap justify-end">
            <Button variant="ghost" size="icon" aria-label={`上移：${name(id)}`} disabled={index === 0} onClick={() => move(index, -1)}>
              <ArrowUp aria-hidden="true" />
            </Button>
            <Button variant="ghost" size="icon" aria-label={`下移：${name(id)}`} disabled={index === value.items.length - 1} onClick={() => move(index, 1)}>
              <ArrowDown aria-hidden="true" />
            </Button>
            {maxIndent > 0 && <>
              <Button variant="ghost" size="icon" aria-label={`减少缩进：${name(id)}`} disabled={level === 0} onClick={() => indent(index, -1)}>
                <IndentDecrease aria-hidden="true" />
              </Button>
              <Button variant="ghost" size="icon" aria-label={`增加缩进：${name(id)}`} disabled={level >= maxIndent} onClick={() => indent(index, 1)}>
                <IndentIncrease aria-hidden="true" />
              </Button>
            </>}
            {slot.partial === true && <Button
              variant="ghost"
              size="icon"
              aria-label={`移出：${name(id)}`}
              onClick={() => onChange({ ...value, items: value.items.filter((_, at) => at !== index), indents: value.indents.filter((_, at) => at !== index) })}
            >
              <X aria-hidden="true" />
            </Button>}
          </div>}
        </li>;
      })}
    </ol>
    {slot.partial === true && !disabled && unused.length > 0 && <div className="grid gap-2">
      <p className="m-0 text-sm text-muted-foreground">候选（不一定都要用上）</p>
      <ul className="m-0 grid list-none gap-2 p-0">
        {unused.map((block) => <li key={block.id} className="flex min-h-11 items-center gap-2 rounded-md border border-dashed border-border px-3 py-1">
          <Content blocks={block.content} className="flex-1 text-sm" />
          <Button variant="ghost" size="icon" aria-label={`加入：${name(block.id)}`} onClick={() => onChange({ ...value, items: [...value.items, block.id], indents: [...value.indents, 0] })}>
            <Plus aria-hidden="true" />
          </Button>
        </li>)}
      </ul>
    </div>}
  </div>;
}
