import { useState } from "react";
import { Copy, FolderOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusNotice } from "@/components/ui/status-notice";
import { t } from "@/lib/strings";

/**
 * 后端写出的文件（反馈包、学习数据导出）：显示完整路径，可以复制，也可以请宿主在文件管理器里打开所在文件夹。
 * 打开失败时路径仍在页面上，说明可以手动打开。
 */
export function CreatedFile({ title, description, pathLabel, path, revealError, onReveal, onClose }: {
  title: string;
  description?: string | undefined;
  pathLabel: string;
  path: string;
  revealError: unknown;
  onReveal(): void;
  onClose(): void;
}) {
  const [copied, setCopied] = useState<"done" | "failed">();

  async function copy() {
    try {
      await navigator.clipboard.writeText(path);
      setCopied("done");
    } catch {
      // 浏览器拒绝写剪贴板时路径仍在页面上，提示用户手动选中复制。
      setCopied("failed");
    }
  }

  return <DialogContent>
    <DialogHeader>
      <DialogTitle>{title}</DialogTitle>
      {description !== undefined && <DialogDescription>{description}</DialogDescription>}
    </DialogHeader>
    <p className="text-body break-all select-all" aria-label={pathLabel}>{path}</p>
    {copied === "done" && <p role="status" className="text-body text-muted-foreground">{t("common.copyPath.done.status")}</p>}
    {copied === "failed" && <p role="status" className="text-body text-muted-foreground">{t("common.copyPath.failed.error")}</p>}
    {revealError !== undefined && <StatusNotice status="error" title={t("common.revealFolder.failed.title")}>
      <p>{revealError instanceof Error ? revealError.message : t("common.revealFolder.error")}{t("common.revealFolder.hint")}</p>
    </StatusNotice>}
    <DialogFooter>
      <Button variant="tertiary" onClick={() => { void copy(); }} leadingIcon={Copy}>{t("common.copyPath.action")}</Button>
      <Button variant="tertiary" onClick={onReveal} leadingIcon={FolderOpen}>{t("common.revealFolder.action")}</Button>
      <Button onClick={onClose}>{t("common.done.action")}</Button>
    </DialogFooter>
  </DialogContent>;
}
