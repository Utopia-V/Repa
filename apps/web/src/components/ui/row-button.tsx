import type { ComponentProps } from "react";
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { useShape } from "@/lib/shape-context";
import { typeClass } from "@/lib/type-scale";
import { cn } from "@/lib/utils";

/** 占满一行、左对齐、可以放多个元素的按钮。Button 固定高度且内容居中，放不下这种列表行。 */
export function RowButton({
  outlined = false,
  className,
  ...props
}: Omit<ComponentProps<"button">, "ref"> & { outlined?: boolean }) {
  const shape = useShape();
  return (
    <ButtonPrimitive
      {...props}
      className={cn(
        "flex min-h-9 w-full cursor-pointer items-center justify-start gap-2 px-3 py-2 text-left outline-none transition-colors duration-80",
        "hover:bg-hover active:bg-active disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
        "focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring)]",
        typeClass("body"),
        shape.button,
        outlined && "border border-border",
        className,
      )}
    />
  );
}
