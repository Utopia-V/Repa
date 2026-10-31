import { Split } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Markdown, type RenderLink } from "@/components/ui/markdown";
import { StatusNotice } from "@/components/ui/status-notice";
import { ConversationMessage } from "@/components/domain/conversation-message";
import { ToolActivity } from "@/components/domain/tool-activity";
import type { ConversationItem } from "@/lib/conversation";

/** 对话记录里的一项：用户和助手的消息、工具调用、错误和停止、压缩标记。 */
export function ConversationItemView({ item, streaming, onFork, forkDisabled, renderLink }: {
  item: ConversationItem;
  streaming: boolean;
  /** 只有能作为分叉点的消息才有。 */
  onFork?: (() => void) | undefined;
  forkDisabled: boolean;
  /** 助手消息里非外部地址的链接，例如学习页辅导回复里的概念链接。 */
  renderLink?: RenderLink | undefined;
}) {
  switch (item.kind) {
    case "user":
      return <ConversationMessage sender="user">{item.text}</ConversationMessage>;
    case "assistant": {
      // 分叉保留这条回答和它之前的全部内容，在新会话里换个方向接着问；原会话不变。
      const actions = onFork && <Button
        variant="ghost"
        size="icon"
        aria-label="从这里分叉"
        title="从这里分叉：保留到这条回答，在新会话里继续"
        disabled={forkDisabled}
        onClick={onFork}
      >
        <Split aria-hidden="true" />
      </Button>;
      return <ConversationMessage sender="assistant" actions={actions}>
        <Markdown text={item.text} streaming={streaming} renderLink={renderLink} />
      </ConversationMessage>;
    }
    case "tool":
      return <ToolActivity tool={item.tool} status={item.status} />;
    case "error":
      return <div className="mb-4"><StatusNotice status="error" title="运行出错"><p>{item.text}</p></StatusNotice></div>;
    case "stopped":
      return <p className="mb-4 text-sm text-muted-foreground">已停止</p>;
    case "compaction":
      return <p className="mb-4 text-sm text-muted-foreground">已压缩上下文，较早的对话已整理成摘要</p>;
  }
}
