import { useId, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import type { Answer, Item, ItemResponse, Problem } from "@repa/base/protocol";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { CodeField } from "@/components/domain/code-field";
import {
  Content, MarkBadge, OptionRow,
  type ChoiceDraft, type Draft, type FieldProps, type Slot, type SlotDraft, type SlotMarks, type TableDraft,
} from "@/components/domain/item-parts";
import { OrderField } from "@/components/domain/order-field";
import { TableField } from "@/components/domain/table-field";
import { plainText, slotName } from "@/lib/ask";

type ChoiceSlot = Extract<Slot, { type: "choice" }>;
type TextSlot = Extract<Slot, { type: "text" }>;

// “其他”在单选组里的取值；选项 id 以字母或数字开头，不会和它重复。
const OTHER = "_other";

export function emptyDraft(item: Item): Draft {
  return Object.fromEntries(item.slots.map((slot): [string, SlotDraft] => {
    switch (slot.type) {
      case "choice":
        return [slot.id, { type: "choice", selected: [], other: false, otherText: "" }];
      case "text":
        return [slot.id, { type: "text", text: "" }];
      case "order": {
        const items = slot.partial === true ? [] : slot.items.map((block) => block.id);
        return [slot.id, { type: "order", items, indents: items.map(() => 0) }];
      }
      case "table":
        return [slot.id, { type: "table", cells: {} }];
      case "code":
        return [slot.id, { type: "code", code: slot.starter }];
    }
  }));
}

/** 把一份已交的作答还原成草稿，用于回看；没有作答的小问保持新题的样子。 */
export function draftFromResponse(item: Item, response: ItemResponse | undefined): Draft {
  const draft = emptyDraft(item);
  for (const slot of item.slots) {
    const answer = response?.answers[slot.id];
    if (!answer || answer.type !== slot.type) continue;
    if (answer.type === "choice") {
      draft[slot.id] = { type: "choice", selected: answer.selected, other: answer.other !== undefined, otherText: answer.other ?? "" };
    } else if (answer.type === "text") {
      draft[slot.id] = { type: "text", text: answer.text };
    } else if (answer.type === "order") {
      draft[slot.id] = { type: "order", items: answer.items, indents: answer.indents ?? answer.items.map(() => 0) };
    } else if (answer.type === "table") {
      const cells: TableDraft["cells"] = {};
      for (const [row, columns] of Object.entries(answer.cells)) {
        cells[row] = Object.fromEntries(Object.entries(columns).map(([column, cell]) => [column, cell.type === "text" ? cell.text : cell.selected[0] ?? ""]));
      }
      draft[slot.id] = { type: "table", cells };
    } else {
      draft[slot.id] = { type: "code", code: answer.code };
    }
  }
  return draft;
}

function slotAnswer(slot: Slot, value: SlotDraft | undefined): Answer | undefined {
  if (!value || value.type !== slot.type) return undefined;
  switch (value.type) {
    case "choice":
      if (value.selected.length === 0 && !value.other) return undefined;
      return { type: "choice", selected: value.selected, ...(value.other ? { other: value.otherText } : {}) };
    case "text":
      return value.text === "" ? undefined : { type: "text", text: value.text };
    case "order":
      if (value.items.length === 0) return undefined;
      return { type: "order", items: value.items, ...(slot.type === "order" && slot.indent !== undefined ? { indents: value.indents } : {}) };
    case "table": {
      if (slot.type !== "table") return undefined;
      const cells: Extract<Answer, { type: "table" }>["cells"] = {};
      for (const row of slot.rows) {
        for (const [column, cell] of Object.entries(row.cells)) {
          const text = value.cells[row.id]?.[column] ?? "";
          if (!("input" in cell) || text === "") continue;
          cells[row.id] = { ...cells[row.id], [column]: cell.input.type === "text" ? { type: "text", text } : { type: "choice", selected: [text] } };
        }
      }
      return Object.keys(cells).length === 0 ? undefined : { type: "table", cells };
    }
    case "code":
      return { type: "code", code: value.code };
  }
}

/** 只交用户填过的小问；没答的必答题由后端退回并说明。排列和代码题本身就有初始内容，总是交出。 */
export function buildResponse(item: Item, draft: Draft): ItemResponse {
  const answers: Record<string, Answer> = {};
  for (const slot of item.slots) {
    const answer = slotAnswer(slot, draft[slot.id]);
    if (answer) answers[slot.id] = answer;
  }
  return { item: { id: item.id, version: item.version }, answers };
}

export function SlotProblems({ id, problems }: { id: string; problems: Problem[] }) {
  if (problems.length === 0) return null;
  return <div id={id} className="grid gap-1">
    {problems.map((problem, index) => <p key={index} className="m-0 flex items-start gap-1.5 text-sm text-destructive">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{problem.message}
    </p>)}
  </div>;
}

function ChoiceField({ slot, value, onChange, labelId, invalid, describedBy, disabled, marks }: FieldProps<ChoiceSlot, ChoiceDraft>) {
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
      : { ...value, selected: [], other: true, otherText: event.target.value })}
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
          <MarkBadge mark={marks?.[option.id]} />
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
        <MarkBadge mark={marks?.[option.id]} />
      </OptionRow>;
    })}
    {slot.other && <OptionRow selected={value.other}>
      <RadioGroupItem id={`${base}-other`} value={OTHER} aria-invalid={invalid || undefined} />
      <label htmlFor={`${base}-other`} className="cursor-pointer">{otherLabel}</label>
      {otherInput}
    </OptionRow>}
  </RadioGroup>;
}

function TextField({ slot, value, onChange, labelId, invalid, describedBy, disabled }: FieldProps<TextSlot, string>) {
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

function SlotField(props: FieldProps<Slot, SlotDraft>) {
  const { slot, value, onChange } = props;
  if (slot.type === "choice" && value.type === "choice") return <ChoiceField {...props} slot={slot} value={value} onChange={onChange} />;
  if (slot.type === "text" && value.type === "text") {
    return <TextField {...props} slot={slot} value={value.text} onChange={(text) => onChange({ type: "text", text })} />;
  }
  if (slot.type === "order" && value.type === "order") return <OrderField {...props} slot={slot} value={value} onChange={onChange} />;
  if (slot.type === "table" && value.type === "table") return <TableField {...props} slot={slot} value={value} onChange={onChange} />;
  if (slot.type === "code" && value.type === "code") {
    return <CodeField {...props} slot={slot} value={value.code} onChange={(code) => onChange({ type: "code", code })} />;
  }
  return null;
}

/**
 * 一道题的全部作答位：题号、题面、输入和各自的结构问题。作答和回看共用：回看时传入 disabled 和判分标记，
 * 每个作答位下方可以放调用方给的内容（例如判分反馈）。
 */
export function ItemSlots({ item, draft, onChange, problems, disabled, marks, after }: {
  item: Item;
  draft: Draft;
  onChange(draft: Draft): void;
  problems: Problem[];
  disabled: boolean;
  marks?: SlotMarks | undefined;
  after?: ((slot: Slot) => ReactNode) | undefined;
}) {
  const base = useId();
  const numbered = item.slots.length > 1;
  return <>
    {item.slots.map((slot, index) => {
      const labelId = `${base}-${slot.id}-label`;
      const problemsId = `${base}-${slot.id}-problems`;
      const slotProblems = problems.filter((problem) => problem.slot === slot.id);
      const value = draft[slot.id];
      if (!value) return null;
      // 模型常在题面里自己写“可多选”，已经写了就不再重复。
      const multiple = slot.type === "choice" && slot.multiple === true;
      const hint = multiple ? plainText(slot.prompt).includes("多选") ? "" : "（可多选）" : slot.optional === true ? "（可不答）" : "";
      return <div key={slot.id} className="grid gap-2">
        <div id={labelId} className="flex items-start gap-1 text-sm font-semibold">
          {numbered && <span className="shrink-0">{index + 1}.</span>}
          {slot.prompt && slot.prompt.length > 0 ? <Content blocks={slot.prompt} /> : <span>{slotName(slot, index)}</span>}
          {hint && <span className="shrink-0 font-normal text-muted-foreground">{hint}</span>}
        </div>
        <SlotField
          slot={slot}
          value={value}
          onChange={(next) => onChange({ ...draft, [slot.id]: next })}
          labelId={labelId}
          invalid={slotProblems.length > 0}
          describedBy={slotProblems.length > 0 ? problemsId : undefined}
          disabled={disabled}
          marks={marks?.[slot.id]}
        />
        <SlotProblems id={problemsId} problems={slotProblems} />
        {after?.(slot)}
      </div>;
    })}
  </>;
}
