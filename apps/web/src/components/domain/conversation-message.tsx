import type { ComponentProps, ReactNode } from "react";
import { MessageBubble } from "@/components/ui/message-bubble";
import { cn } from "@/lib/utils";

export function ConversationMessage({ sender, actions, className, ...props }: Omit<ComponentProps<typeof MessageBubble>, "variant"> & {
  sender: "user" | "assistant";
  /** 消息下方的操作按钮。能悬停的设备上悬停或键盘聚焦到这条消息时才显示，触屏上一直显示。 */
  actions?: ReactNode;
}) {
  const bubble = <MessageBubble
    {...props}
    data-sender={sender}
    variant={sender === "user" ? "emphasized" : "default"}
    // 用户消息靠右、宽度随内容并按原文保留换行；助手消息占满整列，由调用方渲染成 Markdown。
    className={cn(!actions && "mb-4", sender === "user" && "ml-auto w-fit max-w-[95%] whitespace-pre-wrap", className)}
  />;
  if (!actions) return bubble;
  // 隐藏时只是透明，仍占位、仍在 Tab 顺序里，显示出来时下面的内容不跳动。
  return <div className="group mb-4">
    {bubble}
    <div className={cn(
      "mt-1 flex gap-1",
      sender === "user" && "justify-end",
      "pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-within:opacity-100",
    )}>
      {actions}
    </div>
  </div>;
}
