import { Fragment } from "react";
import { Clock } from "lucide-react";

import type { RenderLink } from "@/components/ui/markdown";
import { AskCard } from "@/components/domain/ask-card";
import { ConversationItemView } from "@/components/domain/conversation-item";
import { ConversationMessage } from "@/components/domain/conversation-message";
import { useAppStore } from "@/hooks/use-app-store";
import { restoredAsk } from "@/lib/ask";
import type { Ask } from "@/lib/store";
import { t } from "@/lib/strings";

/**
 * 当前会话的记录：消息、工具活动、询问卡片、“正在处理”和排队的消息。对话页与学习页的做课对话共用；
 * 读取中、读取失败和空记录由调用的页面各自显示。
 */
export function ConversationTranscript({ workingText, onFork, forkDisabled = true, renderLink }: {
  /** 运行中、还没有文字流出时显示的状态。 */
  workingText: string;
  /** 给出时，能作为分叉点的回答带分叉按钮。 */
  onFork?: ((entryId: string) => void) | undefined;
  forkDisabled?: boolean;
  renderLink?: RenderLink | undefined;
}) {
  const conversation = useAppStore((state) => state.conversation);
  const asks = useAppStore((state) => state.asks);
  const submitAsk = useAppStore((state) => state.submitAsk);
  const cancelAsk = useAppStore((state) => state.cancelAsk);
  const { run, items } = conversation;
  const running = run !== "idle";
  // 询问显示在发起它的工具调用下面；找不到那次调用时（例如插件或子 Agent 发起的）放在记录末尾。
  const toolIds = new Set(items.flatMap((item) => item.kind === "tool" ? [item.id] : []));
  const asksAt = (id: string) => asks.filter((ask) => ask.request.origin.callId === id);
  const unplaced = asks.filter((ask) => ask.request.origin.callId === undefined || !toolIds.has(ask.request.origin.callId));
  const waiting = asks.some((ask) => ask.closed === undefined);
  const askCard = (ask: Ask) => <AskCard
    key={ask.request.id}
    ask={ask}
    onSubmit={(response) => { void submitAsk(ask.request.id, response); }}
    onCancel={() => { void cancelAsk(ask.request.id); }}
  />;

  return <>
    {items.map((item) => <Fragment key={item.id}>
      <ConversationItemView
        item={item}
        streaming={item.id === conversation.streaming}
        onFork={onFork && item.kind === "assistant" && item.forkable ? () => onFork(item.id) : undefined}
        forkDisabled={forkDisabled}
        renderLink={renderLink}
      />
      {/* 运行期间的卡片优先；重新读取会话后没有了，按记录里保存的提问显示。 */}
      {item.kind === "tool" && (asksAt(item.id).length > 0
        ? asksAt(item.id).map(askCard)
        : item.ask && askCard(restoredAsk(item.id, item.ask)))}
    </Fragment>)}
    {unplaced.map(askCard)}
    {/* 等待作答时卡片本身就是状态，不再显示“正在处理”。 */}
    {running && !waiting && conversation.streaming === undefined && <p role="status" className="mb-4 text-body text-muted-foreground">
      {run === "stopping" ? t("common.stopping.status") : workingText}
    </p>}
    {/* 排队的消息留在记录末尾，送达后换成记录里的用户消息，位置基本不动。 */}
    {conversation.queued.map((message) => <div key={message.id} className="mb-4 grid justify-items-end gap-1">
      <ConversationMessage sender="user" className="mb-0">{message.text}</ConversationMessage>
      <p className="flex items-center gap-1 text-body text-muted-foreground">
        <Clock aria-hidden="true" className="size-4 shrink-0" />{t("conversation.queued.status")}
      </p>
    </div>)}
  </>;
}
