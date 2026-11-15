import { useState } from "react";
import type { Result } from "@repa/base/protocol";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { ErrorNotice } from "@/components/domain/error-notice";
import { CreatedFile } from "@/features/created-file";
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

  if (result) return <CreatedFile
    title={t("feedback.created.title")}
    description={t("feedback.created.description")}
    pathLabel={t("feedback.created.path.label")}
    path={result.path}
    revealError={revealError}
    onReveal={() => reveal(result.path)}
    onClose={onClose}
  />;

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
