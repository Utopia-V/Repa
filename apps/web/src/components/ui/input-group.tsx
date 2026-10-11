// Adapted from shadcn/ui new-york-v4 (MIT); see README.md.
import * as React from "react";
import { cn } from "@/lib/utils";
import { Textarea } from "@/components/ui/textarea";

/**
 * 输入框和附属按钮合成一个整体，边框画在外框上。文本框聚焦时边框粗细不变，只加深成 `input-focus` 色并加阴影，
 * 不叠 2px ring；Addon 里的按钮保留自己的 ring。
 */
function InputGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group"
      role="group"
      className={cn(
        "relative flex w-full min-w-0 items-center rounded-lg border border-input bg-card transition-[border-color,box-shadow] outline-none",
        "has-[[data-slot=input-group-control]:focus-visible]:border-input-focus has-[[data-slot=input-group-control]:focus-visible]:shadow-[0_0_12px_rgb(0_0_0/0.1)]",
        "has-[[data-slot][aria-invalid=true]]:border-border-error",
        className,
      )}
      {...props}
    />
  );
}

function InputGroupAddon({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="group"
      data-slot="input-group-addon"
      className={cn("flex items-center gap-2 p-2", className)}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        event.currentTarget.parentElement?.querySelector<HTMLElement>("[data-slot=input-group-control]")?.focus();
      }}
      {...props}
    />
  );
}

// 上下留白一部分放在外边距：内容滚动时裁切线离外框还有距离，文字不会贴着边框被切掉。
function InputGroupTextarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <Textarea
      data-slot="input-group-control"
      className={cn("my-3 min-h-0 min-w-0 flex-1 self-stretch resize-none rounded-none border-0 bg-transparent py-1 focus-visible:ring-0", className)}
      {...props}
    />
  );
}

export { InputGroup, InputGroupAddon, InputGroupTextarea };
