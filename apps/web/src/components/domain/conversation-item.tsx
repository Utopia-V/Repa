import { Link } from "react-router";
import { Split } from "lucide-react";
import type { ModelFailure } from "@repa/base/protocol";

import { Button } from "@/components/ui/button";
import { Markdown, type RenderLink } from "@/components/ui/markdown";
import { StatusNotice } from "@/components/ui/status-notice";
import { ConversationMessage } from "@/components/domain/conversation-message";
import { ToolActivity } from "@/components/domain/tool-activity";
import type { ConversationItem } from "@/lib/conversation";
import { t } from "@/lib/strings";

/** 模型请求失败时说给学习者的一句话：发生了什么、该做什么。 */
const modelErrorTitle: Record<ModelFailure, string> = {
  network: t("modelError.network.title"),
  auth: t("modelError.auth.title"),
  balance: t("modelError.balance.title"),
  rate_limit: t("modelError.rateLimit.title"),
  server: t("modelError.server.title"),
  other: t("modelError.other.title"),
};

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
        aria-label={t("conversation.fork.label")}
        title={t("conversation.fork.hint")}
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
    case "error": {
      const { failure } = item;
      if (!failure) return <div className="mb-4"><StatusNotice status="error" title={t("common.runError.status")}><p>{item.text}</p></StatusNotice></div>;
      // 模型请求失败先说一句人能看懂的话；提供方的原文折叠起来，排查时还看得到。
      return <div className="mb-4 grid gap-3">
        <StatusNotice status="error" title={modelErrorTitle[failure]}>
          <details>
            <summary className="cursor-pointer">{t("common.errorDetails.label")}</summary>
            <p className="mt-2 break-all">{item.text}</p>
          </details>
        </StatusNotice>
        {failure === "auth" && <div><Button asChild variant="tertiary"><Link to="/settings">{t("common.setupModel.action")}</Link></Button></div>}
      </div>;
    }
    case "stopped":
      return <p className="mb-4 text-body text-muted-foreground">{t("conversation.stopped.status")}</p>;
    case "compaction":
      return <p className="mb-4 text-body text-muted-foreground">{t("conversation.compacted.status")}</p>;
  }
}
