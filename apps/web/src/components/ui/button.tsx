// Adapted from shadcn/ui new-york-v4 (MIT); see README.md.
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Slot } from "radix-ui";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center border border-transparent text-sm font-semibold whitespace-normal transition-[color,background-color,box-shadow] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-border-error [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90 active:bg-destructive/80 dark:bg-destructive/60 ",
        outline:
          "border-border bg-background hover:bg-accent hover:text-accent-foreground active:bg-accent/80 dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80 active:bg-secondary/60",
        ghost:
          "hover:bg-accent hover:text-accent-foreground active:bg-accent/80 dark:hover:bg-accent/50",
      },
      size: {
        md: "ui-button-md",
        icon: "ui-button-md ui-button-icon shrink-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "md",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "md",
  type = "button",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      type={type}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
