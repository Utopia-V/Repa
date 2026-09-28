import type { ComponentProps } from "react";
import { Check } from "lucide-react";
import { cva } from "class-variance-authority";
import { Button } from "./button";
import { cn } from "@/lib/utils";

const selectionVariants = cva("justify-start", {
  variants: {
    selected: {
      true: "bg-accent text-accent-foreground",
      false: "text-muted-foreground",
    },
    size: {
      md: "",
      icon: "relative w-10 justify-center border-border",
    },
  },
  compoundVariants: [
    { size: "icon", selected: false, className: "bg-card" },
    { size: "icon", selected: true, className: "border-border-selected" },
  ],
});

/** 持续选择独立于键盘焦点，并始终提供可见标记。 */
export function SelectionButton({
  selected,
  children,
  className,
  size = "md",
  ...props
}: Omit<ComponentProps<typeof Button>, "variant" | "aria-pressed"> & {
  selected: boolean;
}) {
  return (
    <Button
      {...props}
      size={size}
      variant="ghost"
      aria-pressed={selected}
      className={cn(selectionVariants({ selected, size }), className)}
    >
      {children}
      <Check
        aria-hidden="true"
        className={cn(
          size === "icon"
            ? "absolute -right-1 -top-1 size-3 rounded-full bg-card text-accent-foreground"
            : "ml-auto",
          !selected && "invisible",
        )}
      />
    </Button>
  );
}
