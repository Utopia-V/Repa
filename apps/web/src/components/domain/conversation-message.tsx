import type { ComponentProps } from "react";
import { MessageBubble } from "@/components/ui/message-bubble";
import { cn } from "@/lib/utils";

export function ConversationMessage({ sender, className, ...props }: Omit<ComponentProps<typeof MessageBubble>, "variant"> & { sender: "user" | "assistant" }) {
  return <MessageBubble
    {...props}
    data-sender={sender}
    variant={sender === "user" ? "emphasized" : "default"}
    // 用户消息靠右、宽度随内容并按原文保留换行；助手消息占满整列，由调用方渲染成 Markdown。
    className={cn("mb-4", sender === "user" && "ml-auto w-fit max-w-[95%] whitespace-pre-wrap", className)}
  />;
}
