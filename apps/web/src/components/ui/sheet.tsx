"use client";

import type { ComponentProps } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { t } from "@/lib/strings";
import { cn } from "@/lib/utils";

/** 侧边抽屉。组件库的抽屉只能从底部出现，这里按现有接口直接用 Base UI 的 Dialog。 */
function Sheet({ open, onOpenChange, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return <DialogPrimitive.Root open={open} onOpenChange={(next) => onOpenChange(next)}>{children}</DialogPrimitive.Root>;
}

const sideClasses = {
  right: "inset-y-0 right-0 h-dvh w-3/4 max-w-full border-l data-ending-style:translate-x-full data-starting-style:translate-x-full",
  left: "inset-y-0 left-0 h-dvh w-3/4 max-w-full border-r data-ending-style:-translate-x-full data-starting-style:-translate-x-full",
} as const;

function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  closeLabel = t("sheet.close.label"),
  ...props
}: Omit<ComponentProps<typeof DialogPrimitive.Popup>, "className" | "children"> & {
  className?: string;
  children: React.ReactNode;
  side?: keyof typeof sideClasses;
  showCloseButton?: boolean;
  closeLabel?: string;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        data-slot="sheet-overlay"
        className="fixed inset-0 z-[var(--z-overlay,40)] bg-black/40 transition-opacity duration-160 data-ending-style:opacity-0 data-starting-style:opacity-0"
      />
      <DialogPrimitive.Popup
        data-slot="sheet-content"
        className={cn(
          "fixed z-[var(--z-modal,50)] flex flex-col gap-4 border-border bg-card text-card-foreground shadow-surface-5 outline-none transition-transform duration-160 ease-out",
          sideClasses[side],
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="sheet-close"
            aria-label={closeLabel}
            className="absolute top-4 right-4 cursor-pointer rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring)]"
          >
            <X aria-hidden="true" className="size-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

function SheetHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="sheet-header" className={cn("flex flex-col gap-2 p-4", className)} {...props} />;
}

function SheetTitle({ className, ...props }: Omit<ComponentProps<typeof DialogPrimitive.Title>, "className"> & { className?: string }) {
  return <DialogPrimitive.Title data-slot="sheet-title" className={cn("weight-semibold text-foreground", className)} {...props} />;
}

function SheetDescription({ className, ...props }: Omit<ComponentProps<typeof DialogPrimitive.Description>, "className"> & { className?: string }) {
  return <DialogPrimitive.Description data-slot="sheet-description" className={cn("text-body text-muted-foreground", className)} {...props} />;
}

export { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription };
