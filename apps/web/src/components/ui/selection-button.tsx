import type { ComponentProps } from "react";
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { Check } from "lucide-react";
import { useShape } from "@/lib/shape-context";
import { typeClass } from "@/lib/type-scale";
import { cn } from "@/lib/utils";

/** 持续选择独立于键盘焦点，并始终提供可见标记。Button 固定高度且文字不换行，放不下两行内容，所以这里单独画成一行。 */
export function SelectionButton({
  selected,
  children,
  className,
  ...props
}: Omit<ComponentProps<"button">, "aria-pressed" | "ref"> & {
  selected: boolean;
}) {
  const shape = useShape();
  return (
    <ButtonPrimitive
      {...props}
      data-slot="selection-button"
      aria-pressed={selected}
      className={cn(
        "flex min-h-9 cursor-pointer items-center justify-start gap-2 px-3 py-2 text-left outline-none transition-colors duration-80",
        "hover:bg-hover active:bg-active disabled:pointer-events-none disabled:opacity-50",
        "focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring)]",
        typeClass("body"),
        shape.button,
        selected ? "bg-active text-foreground" : "text-muted-foreground",
        className,
      )}
    >
      {children}
      <Check aria-hidden="true" className={cn("ml-auto size-4 shrink-0", !selected && "invisible")} />
    </ButtonPrimitive>
  );
}
