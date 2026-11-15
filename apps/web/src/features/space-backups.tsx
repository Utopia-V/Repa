import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ErrorNotice } from "@/components/domain/error-notice";
import { useAppStore } from "@/hooks/use-app-store";
import { dateTime, fileSize } from "@/lib/format";
import { folderName } from "@/lib/paths";
import type { BackupInfo } from "@/lib/store";
import { t } from "@/lib/strings";

type BackupGroup = { root: string; exists: boolean };
type Chosen = { group: BackupGroup; backup: BackupInfo };

/**
 * 选空间页的备份：各空间的备份从新到旧，可以恢复到原位置或新文件夹，可以删除“恢复前”的备份。
 * 平时收起，只占一行；show 变化时（打开空间报 restore_incomplete）展开并带到那个空间的备份。
 * 恢复以后由 onRestored 打开恢复好的空间。没有任何备份时整节不出现。
 */
export function SpaceBackups({ show, onRestored }: { show?: { root: string; n: number } | undefined; onRestored(root: string): void }) {
  const backups = useAppStore((state) => state.resources.backups);
  const loadBackups = useAppStore((state) => state.loadBackups);
  const [expanded, setExpanded] = useState(false);
  const [restoring, setRestoring] = useState<Chosen>();
  const [deleting, setDeleting] = useState<Chosen>();
  const groups = useRef(new Map<string, HTMLElement>());
  const listId = useId();

  useEffect(() => {
    void loadBackups();
  }, [loadBackups]);

  useEffect(() => {
    if (show) setExpanded(true);
  }, [show]);

  // 展开以后再找那一组：收起时它还没有渲染。聚焦同时把它滚进视野，读屏软件也从这里读起。
  // 每次带过去只聚焦一次：之后列表重读（例如删了一份）不再抢焦点。
  const focused = useRef(0);
  useEffect(() => {
    if (!show || !expanded || focused.current === show.n) return;
    const element = groups.current.get(show.root);
    if (!element) return;
    focused.current = show.n;
    element.focus();
  }, [show, expanded, backups.data]);

  const data = (backups.data ?? []).filter((group) => group.backups.length > 0);
  if (backups.status === "error" && backups.data === undefined) {
    return <section className="grid gap-3">
      <ErrorNotice title={t("learningSpace.backup.load.error")} error={backups.error} />
      <div><Button variant="tertiary" onClick={() => { void loadBackups(); }} leadingIcon={RefreshCw}>{t("common.retry.action")}</Button></div>
    </section>;
  }
  if (data.length === 0) return null;

  return <section className="grid gap-3">
    <h3 className="m-0 text-title weight-semibold">
      <Button
        variant="ghost"
        aria-expanded={expanded}
        aria-controls={listId}
        leadingIcon={expanded ? ChevronDown : ChevronRight}
        onClick={() => setExpanded((value) => !value)}
      >{t("learningSpace.backup.title")}</Button>
    </h3>
    {expanded && <div id={listId} className="grid gap-6">
      {data.map((group) => <section
        key={group.root}
        ref={(element) => { if (element) groups.current.set(group.root, element); else groups.current.delete(group.root); }}
        tabIndex={-1}
        aria-label={folderName(group.root)}
        className="grid gap-2 outline-none"
      >
        <div className="grid gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="weight-semibold">{folderName(group.root)}</span>
            {!group.exists && <Badge variant="dot" color="gray">{t("learningSpace.backup.missing.label")}</Badge>}
          </div>
          <span className="text-caption break-all text-muted-foreground">{group.root}</span>
        </div>
        <ul className="m-0 grid list-none gap-1 p-0">
          {group.backups.map((backup) => {
            const time = dateTime(backup.createdAt, { seconds: true });
            return <li key={backup.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-body tabular-nums">{time}</span>
              <span className="text-body text-muted-foreground tabular-nums">{fileSize(backup.bytes)}</span>
              {backup.kind === "beforeRestore" && <Badge variant="solid" color="gray">{t("learningSpace.backup.beforeRestore.label")}</Badge>}
              <span className="ml-auto flex gap-1">
                {backup.kind === "beforeRestore" && <Button
                  variant="ghost"
                  aria-label={t("learningSpace.backup.delete.label", { time })}
                  onClick={() => setDeleting({ group, backup })}
                >{t("learningSpace.backup.delete.action")}</Button>}
                <Button
                  variant="tertiary"
                  aria-label={t("learningSpace.backup.restore.label", { time })}
                  onClick={() => setRestoring({ group, backup })}
                >{t("learningSpace.backup.restore.action")}</Button>
              </span>
            </li>;
          })}
        </ul>
      </section>)}
    </div>}

    <Dialog open={restoring !== undefined} onOpenChange={(open) => { if (!open) setRestoring(undefined); }}>
      {restoring && <RestoreDialog chosen={restoring} onRestored={(root) => { setRestoring(undefined); onRestored(root); }} />}
    </Dialog>
    <Dialog open={deleting !== undefined} onOpenChange={(open) => { if (!open) setDeleting(undefined); }}>
      {deleting && <DeleteDialog chosen={deleting} onDeleted={() => setDeleting(undefined)} />}
    </Dialog>
  </section>;
}

/** 恢复到新文件夹时预填的位置：原文件夹已经不在就用原来的路径，否则在旁边加上备份的时间。 */
function suggestedTarget({ group, backup }: Chosen): string {
  if (!group.exists) return group.root;
  const date = new Date(backup.createdAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${group.root}-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/**
 * 恢复会覆盖现状，所以先说清两种做法再让人确认。原位置：要恢复的空间正打开着就先关闭它；后端先把现状存成“恢复前”的备份。
 * 原文件夹已经不在时只能恢复到新文件夹。对话运行中两种都不行：关闭或换空间会中止运行。
 */
function RestoreDialog({ chosen, onRestored }: { chosen: Chosen; onRestored(root: string): void }) {
  const restoreBackup = useAppStore((state) => state.restoreBackup);
  const restoreBackupTo = useAppStore((state) => state.restoreBackupTo);
  const active = useAppStore((state) => state.space);
  const running = useAppStore((state) => state.conversation.run !== "idle");
  const { group, backup } = chosen;
  const [mode, setMode] = useState<"inPlace" | "copy">(group.exists ? "inPlace" : "copy");
  const [target, setTarget] = useState(() => suggestedTarget(chosen));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const targetId = useId();
  const time = dateTime(backup.createdAt, { seconds: true });

  async function restore(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFailure(undefined);
    try {
      if (mode === "inPlace") {
        await restoreBackup(group.root, backup.id);
        onRestored(group.root);
      } else {
        onRestored(await restoreBackupTo(group.root, backup.id, target.trim()));
      }
    } catch (error) {
      setFailure(error);
      setBusy(false);
    }
  }

  return <DialogContent>
    <form className="grid gap-4" onSubmit={(event) => { void restore(event); }}>
      <DialogHeader>
        <DialogTitle>{t("learningSpace.restore.title", { time })}</DialogTitle>
        <DialogDescription>{folderName(group.root)}</DialogDescription>
      </DialogHeader>
      {group.exists && <RadioGroup aria-label={t("learningSpace.restore.mode.label")} value={mode} onValueChange={(value) => setMode(value === "copy" ? "copy" : "inPlace")} disabled={busy}>
        <div className="flex items-start gap-3">
          <RadioGroupItem id="restore-in-place" value="inPlace" aria-describedby="restore-in-place-description" className="mt-1" />
          <div className="grid min-w-0 gap-1">
            <label htmlFor="restore-in-place" className="text-body weight-semibold">{t("learningSpace.restore.inPlace.label")}</label>
            <p id="restore-in-place-description" className="text-body text-muted-foreground">
              {t("learningSpace.restore.inPlace.description")}
              {group.root === active && t("learningSpace.restore.inPlace.active.hint")}
            </p>
          </div>
        </div>
        <div className="flex items-start gap-3">
          <RadioGroupItem id="restore-copy" value="copy" className="mt-1" />
          <label htmlFor="restore-copy" className="text-body weight-semibold">{t("learningSpace.restore.copy.label")}</label>
        </div>
      </RadioGroup>}
      {mode === "copy" && <div className="grid gap-2">
        <label htmlFor={targetId} className="text-body weight-semibold">{t("learningSpace.restore.target.label")}</label>
        <Input id={targetId} value={target} disabled={busy} onChange={(event) => setTarget(event.target.value)} />
      </div>}
      {running && <p className="m-0 text-body text-muted-foreground">{t("learningSpace.recent.running.hint")}</p>}
      {failure !== undefined && <ErrorNotice title={t("learningSpace.restore.error")} error={failure} />}
      <DialogFooter>
        <DialogClose asChild><Button variant="tertiary" disabled={busy}>{t("common.cancel.action")}</Button></DialogClose>
        <Button
          type="submit"
          variant={mode === "inPlace" ? "destructive" : "primary"}
          disabled={busy || running || (mode === "copy" && target.trim() === "")}
          aria-busy={busy}
        >
          {busy ? t("learningSpace.restore.running.status") : mode === "inPlace" ? t("learningSpace.restore.inPlace.action") : t("learningSpace.restore.copy.action")}
        </Button>
      </DialogFooter>
    </form>
  </DialogContent>;
}

/** 删除“恢复前”的备份：删了就不能再用它撤回那次恢复，所以先确认。 */
function DeleteDialog({ chosen, onDeleted }: { chosen: Chosen; onDeleted(): void }) {
  const deleteBackup = useAppStore((state) => state.deleteBackup);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();

  async function remove() {
    setBusy(true);
    setFailure(undefined);
    try {
      await deleteBackup(chosen.group.root, chosen.backup.id);
      onDeleted();
    } catch (error) {
      setFailure(error);
      setBusy(false);
    }
  }

  return <DialogContent size="sm">
    <DialogHeader>
      <DialogTitle>{t("learningSpace.backup.delete.title", { time: dateTime(chosen.backup.createdAt, { seconds: true }) })}</DialogTitle>
      <DialogDescription>{folderName(chosen.group.root)}</DialogDescription>
    </DialogHeader>
    {failure !== undefined && <ErrorNotice title={t("learningSpace.backup.delete.error")} error={failure} />}
    <DialogFooter>
      <DialogClose asChild><Button variant="tertiary" disabled={busy}>{t("common.cancel.action")}</Button></DialogClose>
      <Button variant="destructive" disabled={busy} aria-busy={busy} onClick={() => { void remove(); }}>{t("learningSpace.backup.delete.confirm.action")}</Button>
    </DialogFooter>
  </DialogContent>;
}
