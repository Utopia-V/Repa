import { useId, useState, type KeyboardEvent } from "react";

import { Textarea } from "@/components/ui/textarea";
import type { FieldProps, Slot } from "@/components/domain/item-parts";

type CodeSlot = Extract<Slot, { type: "code" }>;

const INDENT = "    ";

/**
 * 代码题：在起始代码上修改。Tab 插入 4 个空格；按过 Esc 之后的下一次 Tab 照常移走焦点，键盘不会被困在编辑框里。
 * 只是等宽的文本框，没有语法高亮和补全。
 */
export function CodeField({ value, onChange, labelId, invalid, describedBy, disabled }: FieldProps<CodeSlot, string>) {
  const hintId = useId();
  const [escaped, setEscaped] = useState(false);
  const lines = value.split("\n").length;

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      setEscaped(true);
      return;
    }
    if (event.key !== "Tab" || escaped || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
      setEscaped(false);
      return;
    }
    event.preventDefault();
    const element = event.currentTarget;
    const { selectionStart, selectionEnd } = element;
    onChange(`${value.slice(0, selectionStart)}${INDENT}${value.slice(selectionEnd)}`);
    // 受控组件重新渲染后光标会跑到末尾，放回插入点之后。
    requestAnimationFrame(() => element.setSelectionRange(selectionStart + INDENT.length, selectionStart + INDENT.length));
  }

  return <div className="grid gap-1">
    <Textarea
      aria-labelledby={labelId}
      aria-describedby={[disabled ? undefined : hintId, describedBy].filter(Boolean).join(" ") || undefined}
      aria-invalid={invalid || undefined}
      value={value}
      disabled={disabled}
      rows={Math.min(30, Math.max(6, lines + 1))}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      wrap="off"
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      className="font-mono text-[length:var(--type-code-size)] leading-[var(--type-code-line)]"
    />
    {!disabled && <p id={hintId} className="m-0 text-xs text-muted-foreground">Tab 缩进 4 个空格；先按 Esc 再按 Tab 可以离开编辑框。</p>}
  </div>;
}
