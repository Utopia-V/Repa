"use client";

import * as React from "react";
import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import { cn } from "@/lib/utils";

function Progress({
  className,
  value,
  ...props
}: Omit<React.ComponentProps<typeof ProgressPrimitive.Root>, "className" | "value"> & {
  className?: string;
  value?: number | null;
}) {
  return (
    <ProgressPrimitive.Root data-slot="progress" value={value ?? null} className={cn("w-full", className)} {...props}>
      <ProgressPrimitive.Track className="h-2 w-full overflow-hidden rounded-full bg-accent">
        <ProgressPrimitive.Indicator data-slot="progress-indicator" className="h-full bg-foreground transition-[width] duration-160" />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  );
}

export { Progress };
