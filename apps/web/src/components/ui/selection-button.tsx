import type { ComponentProps } from "react";
import { Check } from "lucide-react";
import { RowButton } from "./row-button";
import { cn } from "@/lib/utils";

/** 持续选择独立于键盘焦点，并始终提供可见标记。 */
export function SelectionButton({
  selected,
  children,
  className,
  ...props
}: Omit<ComponentProps<typeof RowButton>, "aria-pressed" | "outlined"> & {
  selected: boolean;
}) {
  return (
    <RowButton
      {...props}
      data-slot="selection-button"
      aria-pressed={selected}
      className={cn(selected ? "bg-active text-foreground" : "text-muted-foreground", className)}
    >
      {children}
      <Check aria-hidden="true" className={cn("ml-auto", !selected && "invisible")} />
    </RowButton>
  );
}
