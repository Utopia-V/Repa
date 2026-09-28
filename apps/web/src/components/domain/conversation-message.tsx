import type { ComponentProps } from "react";
import { MessageBubble } from "@/components/ui/message-bubble";
import { cn } from "@/lib/utils";

export function ConversationMessage({ sender, className, ...props }: Omit<ComponentProps<typeof MessageBubble>, "variant"> & { sender: "user" | "assistant" }) {
  return <MessageBubble
    {...props}
    data-sender={sender}
    variant={sender === "user" ? "emphasized" : "default"}
    className={cn("mb-4 max-w-[95%]", sender === "user" && "ml-auto w-fit", className)}
  />;
}
