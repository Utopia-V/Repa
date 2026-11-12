import type { KeyboardEventHandler } from "react";

const GUARDED_KEYS = new Set(["Enter", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

/** 包住文本控件的 onKeyDown：输入法选字时的回车和方向键归输入法，不交给外部处理。 */
export function guardComposition<T extends HTMLElement>(onKeyDown: KeyboardEventHandler<T> | undefined): KeyboardEventHandler<T> {
  return (event) => {
    const composing = event.nativeEvent.isComposing;
    // Safari 确认候选词时 isComposing 已为 false，但 keyCode 仍是 229。
    const confirming = !composing && event.keyCode === 229;
    if ((composing || confirming) && GUARDED_KEYS.has(event.key)) {
      if (confirming && event.key === "Enter") event.preventDefault();
      return;
    }
    onKeyDown?.(event);
  };
}
