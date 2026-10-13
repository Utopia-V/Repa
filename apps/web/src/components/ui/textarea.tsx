// Adapted from shadcn/ui new-york-v4 (MIT); see README.md.
import * as React from "react";
import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm max-md:text-base transition-[color,box-shadow] outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30",
        "focus-visible:ring-2 focus-visible:ring-ring",
        "aria-invalid:border-border-error",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
