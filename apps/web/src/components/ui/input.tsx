// Adapted from shadcn/ui new-york-v4 (MIT); see README.md.
import * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "ui-control w-full min-w-0 rounded-md border border-input bg-transparent px-3 text-sm max-md:text-base font-normal transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30",
        "focus-visible:ring-2 focus-visible:ring-ring",
        "aria-invalid:border-border-error ",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
