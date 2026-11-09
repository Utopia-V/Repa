import { useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router";
import { RefreshCw } from "lucide-react";
import type { Result } from "@repa/base/protocol";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusNotice } from "@/components/ui/status-notice";
import { ErrorNotice } from "@/components/domain/error-notice";
import { HistoryRevisionCard, formatRevisionTime, revisionSource } from "@/components/domain/history-revision";
import { useAppStore } from "@/hooks/use-app-store";
import { HISTORY_LIMIT, type HistoryRevision } from "@/lib/store";
import { folderName } from "@/lib/paths";
import { t } from "@/lib/strings";

export function HistoryPage() {
  const space = useAppStore((state) => state.space);
  if (!space) return <Navigate to="/learning-space" replace />;
  return <SpaceHistory space={space} />;
}

function SpaceHistory({ space }: { space: string }) {
  const history = useAppStore((state) => state.resources.history);
  const loadHistory = useAppStore((state) => state.loadHistory);
  const undoRevision = useAppStore((state) => state.undoRevision);
  const [target, setTarget] = useState<HistoryRevision>();
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<unknown>();
  const [outcome, setOutcome] = useState<Result<"history.undo">>();

  // 后端不推送历史变化，每次进入页面重新读取。
  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const revisions = useMemo(() => history.data?.revisions ?? [], [history.data]);
  const byId = useMemo(() => new Map(revisions.map((revision) => [revision.id, revision])), [revisions]);
  // 初始状态不能撤回；没有文件变化的 Agent 运行和全部冲突的撤回也有提交，不列出。
  const changed = revisions.filter((revision) => revision.parent !== null && revision.changes.length > 0);
  const baseline = history.data?.complete ? revisions.find((revision) => revision.parent === null) : undefined;

  function chooseUndo(revision: HistoryRevision) {
    setUndoError(undefined);
    setTarget(revision);
  }

  async function confirmUndo() {
    if (!target) return;
    setUndoing(true);
    setUndoError(undefined);
    setOutcome(undefined);
    try {
      setOutcome(await undoRevision(target.id));
      setTarget(undefined);
    } catch (error) {
      setUndoError(error);
    } finally {
      setUndoing(false);
    }
  }

  return <div className="mx-auto grid w-full max-w-3xl gap-8 px-4 py-16 md:px-8">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="grid min-w-0 gap-2">
        <h2 className="text-display weight-semibold">{t("history.page.title")}</h2>
        <p className="text-body text-muted-foreground">
          <span className="break-all" title={space}>{folderName(space)}</span> {t("history.page.description")}
        </p>
      </div>
      <Button
        variant="tertiary"
        disabled={history.status === "loading"}
        aria-busy={history.status === "loading"}
        onClick={() => { void loadHistory(); }}
       leadingIcon={RefreshCw}>{t("history.refresh.action")}
      </Button>
    </header>

    {outcome && <UndoOutcome result={outcome} />}

    {history.status === "error" && <div className="grid gap-3">
      <ErrorNotice title={t("history.load.error")} error={history.error} />
      <div>
        <Button variant="tertiary" onClick={() => { void loadHistory(); }} leadingIcon={RefreshCw}>{t("common.retry.action")}
        </Button>
      </div>
    </div>}
    {history.data === undefined && history.status !== "error" && <p role="status" className="text-body text-muted-foreground">{t("common.loading.status")}</p>}

    {history.data && <section aria-label={t("history.list.label")} className="grid gap-3">
      {changed.length === 0
        ? <p className="text-body text-muted-foreground">{t("history.list.empty")}</p>
        : <ol className="m-0 grid list-none gap-3 p-0">
          {changed.map((revision) => <li key={revision.id}>
            <HistoryRevisionCard
              revision={revision}
              undone={revision.source.kind === "undo" && "revision" in revision.source ? byId.get(revision.source.revision) : undefined}
              onUndo={() => chooseUndo(revision)}
            />
          </li>)}
        </ol>}
      {baseline && <p className="text-body text-muted-foreground">
        {t("history.since.hint", { timestamp: formatRevisionTime(baseline.timestamp) })}
      </p>}
      {!history.data.complete && <p className="text-body text-muted-foreground">
        {t("history.limit.hint", { HISTORY_LIMIT })}
      </p>}
    </section>}

    {/* 撤回进行中不能关闭，结果出来前用户无从判断文件处于什么状态。 */}
    <Dialog open={target !== undefined} onOpenChange={(open) => { if (!open && !undoing) setTarget(undefined); }}>
      {target && <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("history.undo.title")}</DialogTitle>
          <DialogDescription>
            {t("history.undo.description", { source: revisionSource(target.source), timestamp: formatRevisionTime(target.timestamp), length: target.changes.length })}
          </DialogDescription>
        </DialogHeader>
        <p className="text-body">{t("history.undo.hint")}</p>
        {undoError !== undefined && <ErrorNotice title={t("history.undo.error")} error={undoError} />}
        <DialogFooter>
          <Button variant="tertiary" disabled={undoing} onClick={() => setTarget(undefined)}>{t("common.cancel.action")}</Button>
          <Button disabled={undoing} aria-busy={undoing} onClick={() => { void confirmUndo(); }}>
            {undoing ? t("history.undo.running.status") : t("history.undo.action")}
          </Button>
        </DialogFooter>
      </DialogContent>}
    </Dialog>
  </div>;
}

/** 撤回按文件进行：之后又被改过的文件算冲突，保持现状，其余照常恢复。 */
function UndoOutcome({ result }: { result: Result<"history.undo"> }) {
  const { restored, conflicts } = result;
  if (conflicts.length === 0) {
    return <StatusNotice status="complete" title={t("history.undone.title")}>
      <p>{restored.length > 0 ? t("history.undone.count.status", { length: restored.length }) : t("history.undone.nothing.status")}</p>
    </StatusNotice>;
  }
  return <StatusNotice status="error" title={restored.length > 0 ? t("history.undone.partial.title") : t("history.undone.none.title")}>
    {restored.length > 0 && <p>{t("history.undone.count.status", { length: restored.length })}</p>}
    <p>{t("history.undone.skipped.description")}</p>
    <ul aria-label={t("history.undone.skipped.label")} className="m-0 mt-2 grid list-none gap-1 p-0">
      {conflicts.map((path) => <li key={path} className="break-all">{path}</li>)}
    </ul>
  </StatusNotice>;
}
