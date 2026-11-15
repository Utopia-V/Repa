import { Link } from "react-router";
import { Split } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Markdown, type RenderLink } from "@/components/ui/markdown";
import { StatusNotice } from "@/components/ui/status-notice";
import { ConversationMessage } from "@/components/domain/conversation-message";
import { ToolActivity } from "@/components/domain/tool-activity";
import type { ConversationItem } from "@/lib/conversation";
import { t } from "@/lib/strings";

type ModelErrorKind = "auth" | "quota" | "rateLimit";

/** 按提供方回的 HTTP 状态码分类：401、403 是密钥不对或没有权限，402 是额度不足，429 是请求太频繁；其余照原文显示。 */
function modelErrorKind(status: number): ModelErrorKind | undefined {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status === 429) return "rateLimit";
  return undefined;
}

const modelErrorTitle: Record<ModelErrorKind, string> = {
  auth: t("modelError.auth.title"),
  quota: t("modelError.quota.title"),
  rateLimit: t("modelError.rateLimit.title"),
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
      const kind = item.status === undefined ? undefined : modelErrorKind(item.status);
      if (!kind) return <div className="mb-4"><StatusNotice status="error" title={t("common.runError.status")}><p>{item.text}</p></StatusNotice></div>;
      // 认得出的模型错误先说一句人能看懂的话；提供方的原文折叠起来，排查时还看得到。
      return <div className="mb-4 grid gap-3">
        <StatusNotice status="error" title={modelErrorTitle[kind]}>
          <details>
            <summary className="cursor-pointer">{t("common.errorDetails.label")}</summary>
            <p className="mt-2 break-all">{item.text}</p>
          </details>
        </StatusNotice>
        {kind === "auth" && <div><Button asChild variant="tertiary"><Link to="/settings">{t("common.setupModel.action")}</Link></Button></div>}
      </div>;
    }
    case "stopped":
      return <p className="mb-4 text-body text-muted-foreground">{t("conversation.stopped.status")}</p>;
    case "compaction":
      return <p className="mb-4 text-body text-muted-foreground">{t("conversation.compacted.status")}</p>;
  }
}
