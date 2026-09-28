import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** A persistent selection. Keyboard focus remains an independent ring. */
export function SelectableCard({
  selected,
  className,
  ...props
}: ComponentProps<"button"> & { selected: boolean }) {
  return (
    <button
      type="button"
      data-slot="selectable-card"
      aria-pressed={selected}
      className={cn(
        "w-full rounded-md border border-border bg-card p-5 text-left text-card-foreground transition-colors hover:bg-accent/50 active:bg-accent aria-pressed:border-border-selected aria-pressed:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
