import { useState } from "react";
import { Copy, FolderOpen } from "lucide-react";
import type { Result } from "@repa/base/protocol";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusNotice } from "@/components/ui/status-notice";
import { Textarea } from "@/components/ui/textarea";
import { ErrorNotice } from "@/components/domain/error-notice";
import { useAppStore } from "@/hooks/use-app-store";
import { revealFile } from "@/lib/host";
import { t } from "@/lib/strings";

/**
 * 反馈问题：用户补一句说明，可选让 Agent 自述，生成脱敏后的反馈包并在文件管理器里选中它。
 * 生成期间由调用方禁止关闭，结果出来前用户不知道包有没有写出来。
 */
export function FeedbackDialog({ onBusyChange, onClose }: { onBusyChange(busy: boolean): void; onClose(): void }) {
  const createFeedback = useAppStore((state) => state.createFeedback);
  const [note, setNote] = useState("");
  const [describe, setDescribe] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<unknown>();
  const [result, setResult] = useState<Result<"feedback.create">>();
  const [revealError, setRevealError] = useState<unknown>();

  function reveal(path: string) {
    setRevealError(undefined);
    revealFile(path).catch((failure: unknown) => setRevealError(failure));
  }

  async function create() {
    setCreating(true);
    onBusyChange(true);
    setError(undefined);
    try {
      const created = await createFeedback({ describe, note });
      setResult(created);
      // 生成后直接打开一次，用户不用再点；失败时留下路径和重试按钮。
      reveal(created.path);
    } catch (failure) {
      setError(failure);
    } finally {
      setCreating(false);
      onBusyChange(false);
    }
  }

  if (result) return <FeedbackCreated path={result.path} revealError={revealError} onReveal={() => reveal(result.path)} onClose={onClose} />;

  return <DialogContent>
    <DialogHeader>
      <DialogTitle>{t("feedback.dialog.title")}</DialogTitle>
      <DialogDescription>
        {t("feedback.dialog.description")}
      </DialogDescription>
    </DialogHeader>
    <div className="grid gap-2">
      <label htmlFor="feedback-note" className="text-body weight-semibold">{t("feedback.note.label")}</label>
      <Textarea
        id="feedback-note"
        value={note}
        maxLength={4000}
        disabled={creating}
        placeholder={t("feedback.note.placeholder")}
        onChange={(event) => setNote(event.target.value)}
      />
    </div>
    <div className="grid gap-1">
      <div className="flex items-center gap-3">
        <Checkbox id="feedback-describe" checked={describe} disabled={creating} onCheckedChange={(next) => setDescribe(next === true)} />
        <label htmlFor="feedback-describe" className="text-body">{t("feedback.describe.label")}</label>
      </div>
      <p className="pl-7 text-body text-muted-foreground">{t("feedback.describe.hint")}</p>
    </div>
    <div className="grid gap-1 text-body">
      <p>{t("feedback.contents.hint")}</p>
      <p className="text-muted-foreground">{t("feedback.privacy.hint")}</p>
    </div>
    {error !== undefined && <ErrorNotice title={t("feedback.create.error")} error={error} />}
    <DialogFooter>
      <Button variant="tertiary" disabled={creating} onClick={onClose}>{t("common.cancel.action")}</Button>
      <Button disabled={creating} aria-busy={creating} onClick={() => { void create(); }}>
        {creating ? t("feedback.create.running.status") : t("feedback.create.action")}
      </Button>
    </DialogFooter>
  </DialogContent>;
}

function FeedbackCreated({ path, revealError, onReveal, onClose }: { path: string; revealError: unknown; onReveal(): void; onClose(): void }) {
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
      <DialogTitle>{t("feedback.created.title")}</DialogTitle>
      <DialogDescription>{t("feedback.created.description")}</DialogDescription>
    </DialogHeader>
    <p className="text-body break-all select-all" aria-label={t("feedback.created.path.label")}>{path}</p>
    {copied === "done" && <p role="status" className="text-body text-muted-foreground">{t("feedback.created.copied.status")}</p>}
    {copied === "failed" && <p role="status" className="text-body text-muted-foreground">{t("feedback.created.copyFailed.error")}</p>}
    {revealError !== undefined && <StatusNotice status="error" title={t("feedback.created.reveal.error")}>
      <p>{revealError instanceof Error ? revealError.message : t("common.revealFolder.error")}{t("feedback.created.revealHint.hint")}</p>
    </StatusNotice>}
    <DialogFooter>
      <Button variant="tertiary" onClick={() => { void copy(); }} leadingIcon={Copy}>{t("feedback.created.copy.action")}</Button>
      <Button variant="tertiary" onClick={onReveal} leadingIcon={FolderOpen}>{t("feedback.created.reveal.action")}</Button>
      <Button onClick={onClose}>{t("common.done.action")}</Button>
    </DialogFooter>
  </DialogContent>;
}
