import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import type { LearningResult } from "@repa/learning/protocol";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ErrorNotice } from "@/components/domain/error-notice";
import { CreatedFile } from "@/features/created-file";
import { useAppStore } from "@/hooks/use-app-store";
import { fileSize } from "@/lib/format";
import { revealFile } from "@/lib/host";
import { t } from "@/lib/strings";

type Preview = LearningResult<"export.prepare">;

/**
 * 设置页里导出当前空间的学习数据。打开空间、装了学习插件才出现；导出的是学习插件的白名单（学习记录与版本信息），
 * 学习者选择时再带上会话记录。
 */
export function LearningExportSection() {
  const learnable = useAppStore((state) => state.space !== undefined && state.learning.available === true);
  const [open, setOpen] = useState(false);
  // 写出期间不能关：结果出来前学习者不知道文件有没有写出来。
  const [busy, setBusy] = useState(false);
  if (!learnable) return null;
  return <section aria-labelledby="learning-export" className="grid gap-3">
    <h3 id="learning-export" className="text-title weight-semibold">{t("settings.export.title")}</h3>
    <div>
      <Button variant="tertiary" leadingIcon={Download} onClick={() => setOpen(true)}>{t("settings.export.action")}</Button>
    </div>
    <Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
      {/* 每次打开都重新预览：上一次的预览在写出成功或再次预览以后就失效了。 */}
      {open && <ExportDialog onBusyChange={setBusy} onClose={() => setOpen(false)} />}
    </Dialog>
  </section>;
}

/**
 * 先预览再写出：export.prepare 冻结一份已脱敏的内容并给出清单，学习者看过清单再导出，写出的就是这一份。
 * 改了是否带会话就重新预览。zip 放在后端的缺省位置，做完显示完整路径。
 */
function ExportDialog({ onBusyChange, onClose }: { onBusyChange(busy: boolean): void; onClose(): void }) {
  const prepareExport = useAppStore((state) => state.prepareExport);
  const createExport = useAppStore((state) => state.createExport);
  const [sessions, setSessions] = useState(false);
  const [preview, setPreview] = useState<Preview>();
  const [prepareError, setPrepareError] = useState<unknown>();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>();
  const [path, setPath] = useState<string>();
  const [revealError, setRevealError] = useState<unknown>();
  // 先发后到的预览作废，清单与要写出的那一份始终一致。
  const request = useRef(0);

  useEffect(() => {
    const id = ++request.current;
    setPreview(undefined);
    setPrepareError(undefined);
    prepareExport(sessions).then(
      (next) => { if (id === request.current) setPreview(next); },
      (error: unknown) => { if (id === request.current) setPrepareError(error); },
    );
  }, [prepareExport, sessions]);

  async function create(exportId: string) {
    setCreating(true);
    onBusyChange(true);
    setCreateError(undefined);
    try {
      setPath(await createExport(exportId));
    } catch (error) {
      setCreateError(error);
    } finally {
      setCreating(false);
      onBusyChange(false);
    }
  }

  function reveal(file: string) {
    setRevealError(undefined);
    revealFile(file).catch((failure: unknown) => setRevealError(failure));
  }

  if (path !== undefined) return <CreatedFile
    title={t("export.created.title")}
    pathLabel={t("export.created.path.label")}
    path={path}
    revealError={revealError}
    onReveal={() => reveal(path)}
    onClose={onClose}
  />;

  return <DialogContent>
    <DialogHeader>
      <DialogTitle>{t("export.dialog.title")}</DialogTitle>
    </DialogHeader>
    <div className="grid gap-1">
      <div className="flex items-center gap-3">
        <Checkbox id="export-sessions" checked={sessions} disabled={creating} onCheckedChange={setSessions} />
        <label htmlFor="export-sessions" className="text-body">{t("export.sessions.label")}</label>
      </div>
      <p className="pl-7 text-body text-muted-foreground">{t("export.sessions.hint")}</p>
    </div>
    {preview === undefined && prepareError === undefined && <p role="status" className="text-body text-muted-foreground">{t("common.loading.status")}</p>}
    {prepareError !== undefined && <ErrorNotice title={t("export.prepare.error")} error={prepareError} />}
    {preview && <ul aria-label={t("export.files.label")} className="m-0 grid list-none gap-2 p-0">
      {preview.files.map((file) => <li key={file.name} className="grid gap-1">
        <span className="text-body break-all">{file.name}</span>
        <span className="text-caption text-muted-foreground">
          {[
            fileSize(file.bytes),
            file.records === undefined ? undefined : t("export.file.records.label", { count: file.records }),
            file.redactions === 0 ? undefined : t("export.file.redactions.label", { count: file.redactions }),
          ].filter((part) => part !== undefined).join(" · ")}
        </span>
      </li>)}
    </ul>}
    {createError !== undefined && <ErrorNotice title={t("export.create.error")} error={createError} />}
    <DialogFooter>
      <Button variant="tertiary" disabled={creating} onClick={onClose}>{t("common.cancel.action")}</Button>
      <Button disabled={preview === undefined || creating} aria-busy={creating} onClick={() => { if (preview) void create(preview.exportId); }}>
        {creating ? t("export.create.running.status") : t("export.create.action")}
      </Button>
    </DialogFooter>
  </DialogContent>;
}
