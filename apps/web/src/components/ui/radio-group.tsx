"use client";

import type { ComponentProps } from "react";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { cn } from "@/lib/utils";

/**
 * 接口沿用 shadcn 的 RadioGroup / RadioGroupItem，圆圈和圆点照 Fluid Functionalism。
 * 组件库的 RadioItem 只收字符串标签，放不下题目里的 Markdown 选项。
 */
function RadioGroup({
  className,
  onValueChange,
  ...props
}: Omit<ComponentProps<typeof RadioGroupPrimitive>, "className" | "onValueChange"> & {
  className?: string;
  onValueChange?: (value: string) => void;
}) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn("grid gap-3", className)}
      onValueChange={(value) => {
        if (typeof value === "string") onValueChange?.(value);
      }}
      {...props}
    />
  );
}

function RadioGroupItem({
  className,
  ...props
}: Omit<ComponentProps<typeof RadioPrimitive.Root>, "className"> & { className?: string }) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      className={cn(
        "relative inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full border-[1.5px] border-solid border-input bg-transparent outline-none transition-[border-color] duration-80",
        "hover:not-data-checked:border-input-focus data-checked:border-transparent aria-invalid:not-data-checked:border-destructive",
        "focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring)] data-disabled:pointer-events-none data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <RadioPrimitive.Indicator
        keepMounted
        className="block size-2 rounded-full bg-foreground transition-[opacity,scale] duration-80 data-unchecked:scale-30 data-unchecked:opacity-0"
      />
    </RadioPrimitive.Root>
  );
}

export { RadioGroup, RadioGroupItem };
