import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppStore } from "@/hooks/use-app-store";
import type { PendingConfirmation } from "@/lib/store";
import { t } from "@/lib/strings";

/**
 * Agent 执行命令或调用 MCP 工具前的授权。挂在工作区布局上，离开对话页时运行也不会卡在没人看见的请求上。
 * 关闭对话框按拒绝处理，后端在回答之前一直等待。
 */
export function CommandConfirmationDialog() {
  const current = useAppStore((state) => state.confirmations.find((item) => item.request.kind === "command" || item.request.kind === "mcp"));
  const reply = useAppStore((state) => state.replyConfirmation);
  const text = current && confirmationText(current);

  return <Dialog open={current !== undefined} onOpenChange={(open) => { if (!open && current) void reply(current.id, false); }}>
    {current && text && <DialogContent>
      <DialogHeader>
        <DialogTitle>{text.title}</DialogTitle>
        <DialogDescription>{text.description}</DialogDescription>
      </DialogHeader>
      <pre className="m-0 max-h-60 overflow-auto rounded-lg border border-border bg-surface-inset p-3 font-mono text-[length:var(--type-code-size)] leading-[var(--type-code-line)] whitespace-pre-wrap break-all">
        {text.detail}
      </pre>
      <DialogFooter>
        <Button variant="tertiary" onClick={() => { void reply(current.id, false); }}>{t("settings.commandConfirmation.deny.action")}</Button>
        <Button onClick={() => { void reply(current.id, true); }}>{t("settings.commandConfirmation.allow.action")}</Button>
      </DialogFooter>
    </DialogContent>}
  </Dialog>;
}

/** 命令的标题由后端给出，下面是命令原文；MCP 调用写明服务器与工具，下面是模型给的参数。 */
function confirmationText({ request }: PendingConfirmation): { title: string; description: string; detail: string } {
  const call = request.mcp;
  if (request.kind === "mcp" && call) {
    return {
      title: t("settings.mcpConfirmation.title", { server: call.server, tool: call.tool }),
      description: t("settings.mcpConfirmation.description"),
      detail: JSON.stringify(call.input, null, 2),
    };
  }
  return { title: request.title, description: t("settings.commandConfirmation.description"), detail: request.message ?? "" };
}
