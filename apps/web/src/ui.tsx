// 这些画面用到的几个基础部件。菜单与弹出块的焦点、键盘、Esc 逐层退出和焦点归还交给 Base UI；
// 文本框守住输入法选字时的回车，按键位表分辨发送与换行。
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import { forwardRef, useLayoutEffect, useRef, type KeyboardEvent, type ReactElement, type ReactNode, type TextareaHTMLAttributes } from "react";

import { Icon } from "./glyph";
import type { IconName } from "./icons";

/** 只有图标的按钮：名字给读屏，悬停时浮出同一个名字。 */
export const IconButton = forwardRef<HTMLButtonElement, { icon: IconName; label: string; className?: string; onClick?: () => void; disabled?: boolean; expanded?: boolean }>(
  function IconButton({ icon, label, className = "", onClick, disabled, expanded, ...rest }, ref) {
    return <button ref={ref} type="button" className={`ibtn ${className}`} aria-label={label} data-tip={label} onClick={onClick} disabled={disabled} aria-expanded={expanded} {...rest}><Icon name={icon} /></button>;
  },
);

/** 分段选择：浅色槽里，选中的一段抬到输入面。 */
export function Seg<T extends string>({ items, value, onChange, label }: { items: Array<[T, string]>; value: T; onChange: (value: T) => void; label: string }) {
  return <div className="seg" role="radiogroup" aria-label={label}>
    {items.map(([key, text]) => <button key={key} type="button" role="radio" aria-checked={key === value} onClick={() => onChange(key)}>{text}</button>)}
  </div>;
}

/** 开关。 */
export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return <button type="button" className="switch" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}><i /></button>;
}

/** 弹出的一小块，挂在 trigger 上；关掉时焦点回到 trigger。 */
export function Pop({ trigger, children, className = "", open, onOpenChange, align = "start" }: { trigger: ReactElement; children: ReactNode; className?: string; open?: boolean; onOpenChange?: (open: boolean) => void; align?: "start" | "end" }) {
  return <Popover.Root {...(open === undefined ? {} : { open })} {...(onOpenChange ? { onOpenChange } : {})}>
    <Popover.Trigger render={trigger} />
    <Popover.Portal>
      <Popover.Positioner className="layer" sideOffset={4} align={align}><Popover.Popup className={`pop ${className}`}>{children}</Popover.Popup></Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}

/** 菜单：每项一行。 */
export function Menu({ trigger, children, align = "end" }: { trigger: ReactElement; children: ReactNode; align?: "start" | "end" }) {
  return <BaseMenu.Root>
    <BaseMenu.Trigger render={trigger} />
    <BaseMenu.Portal>
      <BaseMenu.Positioner className="layer" sideOffset={4} align={align}><BaseMenu.Popup className="pop menu">{children}</BaseMenu.Popup></BaseMenu.Positioner>
    </BaseMenu.Portal>
  </BaseMenu.Root>;
}

/** 菜单里的一项。 */
export function MenuItem({ icon, children, onClick }: { icon?: IconName; children: ReactNode; onClick: () => void }) {
  return <BaseMenu.Item className="menu-item" onClick={onClick}>{icon && <Icon name={icon} />}{children}</BaseMenu.Item>;
}

/** 菜单里的单选组：选中的一项后面一个勾。 */
export function MenuChoice({ label, items, value, onChange }: { label?: string; items: Array<[string, string]>; value: string | undefined; onChange: (value: string) => void }) {
  return <BaseMenu.RadioGroup value={value ?? null} onValueChange={(next: string) => onChange(next)}>
    {label && <BaseMenu.GroupLabel className="menu-label">{label}</BaseMenu.GroupLabel>}
    {items.map(([key, text]) => <BaseMenu.RadioItem key={key} value={key} className="menu-item" closeOnClick>{text}<Icon name="check" className="ok" /></BaseMenu.RadioItem>)}
  </BaseMenu.RadioGroup>;
}

/** 菜单里的开关。 */
export function MenuToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <BaseMenu.CheckboxItem className="menu-item" checked={checked} onCheckedChange={onChange}>{label}<span className="switch" role="presentation" aria-checked={checked}><i /></span></BaseMenu.CheckboxItem>;
}

/** 菜单里的分隔线。 */
export const MenuSep = () => <BaseMenu.Separator className="menu-sep" />;

// ── 键位 ────────────────────────────────────────────

/** 键位的动作与缺省按键。设置页逐项改，存在 .repa/settings.json 的 keys 里。 */
export const KEY_DEFAULTS = {
  send: "Enter",
  newline: "Shift+Enter",
  submit: "Enter",
  filter: "/",
  chat: "Ctrl+.",
  side: "Ctrl+\\",
} as const;
/** 一个键位动作。 */
export type KeyAction = keyof typeof KEY_DEFAULTS;

/** 一次按键写成 Ctrl+Shift+K 这样的字。只按了修饰键时是空字符串。 */
export function comboOf(event: { key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string {
  if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return "";
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  return [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.metaKey && "Meta", event.shiftKey && key.length > 1 && "Shift", key].filter(Boolean).join("+");
}

/** 一个动作现在的按键。 */
export function keyOf(keys: Record<string, unknown> | undefined, action: KeyAction): string {
  const own = keys?.[action];
  return typeof own === "string" ? own : KEY_DEFAULTS[action];
}

// ── 文本框 ──────────────────────────────────────────

/** 输入法选字时的回车和方向键归输入法：Safari 确认候选词时 isComposing 已为 false，但 keyCode 仍是 229。 */
export function composing(event: KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

/** 随内容长高的多行文本框。enter 是按下“发送”或“提交”那个键时做的事；其余按键照常输入。 */
export function AutoText({ enter, enterKey, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { enter?: () => void; enterKey?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight + (element.offsetHeight - element.clientHeight)}px`;
  }, [props.value]);
  return <textarea ref={ref} rows={1} {...props} onKeyDown={(event) => {
    if (composing(event)) return;
    if (enter && comboOf(event) === (enterKey ?? "Enter")) {
      event.preventDefault();
      enter();
      return;
    }
    props.onKeyDown?.(event);
  }} />;
}
