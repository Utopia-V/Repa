import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const bubbleVariants = cva("rounded-md border p-3 text-sm wrap-anywhere", {
  variants: {
    variant: {
      default: "border-border bg-surface-inset text-foreground",
      emphasized: "border-transparent bg-primary text-primary-foreground",
    },
  },
  defaultVariants: { variant: "default" },
});

export function MessageBubble({ variant, className, ...props }: ComponentProps<"div"> & VariantProps<typeof bubbleVariants>) {
  return <div data-slot="message-bubble" className={cn(bubbleVariants({ variant }), className)} {...props} />;
}
