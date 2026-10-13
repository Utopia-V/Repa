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
        <h2 className="text-2xl font-semibold">修改历史</h2>
        <p className="text-sm text-muted-foreground">
          <span className="break-all" title={space}>{folderName(space)}</span> 里文件的每次修改，最新的在前；外部程序指编辑器等不经过 Repa 的改动。撤回一次修改，会把它改动的文件恢复到修改之前。
        </p>
      </div>
      <Button
        variant="outline"
        disabled={history.status === "loading"}
        aria-busy={history.status === "loading"}
        onClick={() => { void loadHistory(); }}
      >
        <RefreshCw aria-hidden="true" />刷新
      </Button>
    </header>

    {outcome && <UndoOutcome result={outcome} />}

    {history.status === "error" && <div className="grid gap-3">
      <ErrorNotice title="无法读取修改历史" error={history.error} />
      <div>
        <Button variant="outline" onClick={() => { void loadHistory(); }}>
          <RefreshCw aria-hidden="true" />重试
        </Button>
      </div>
    </div>}
    {history.data === undefined && history.status !== "error" && <p role="status" className="text-sm text-muted-foreground">正在读取…</p>}

    {history.data && <section aria-label="修改记录" className="grid gap-3">
      {changed.length === 0
        ? <p className="text-sm text-muted-foreground">还没有文件修改。Agent、插件或其他程序改动空间里的文件后，会显示在这里。</p>
        : <ol className="m-0 grid list-none gap-3 p-0">
          {changed.map((revision) => <li key={revision.id}>
            <HistoryRevisionCard
              revision={revision}
              undone={revision.source.kind === "undo" && "revision" in revision.source ? byId.get(revision.source.revision) : undefined}
              onUndo={() => chooseUndo(revision)}
            />
          </li>)}
        </ol>}
      {baseline && <p className="text-sm text-muted-foreground">
        从 {formatRevisionTime(baseline.timestamp)} 开始记录，更早的修改不在历史里。
      </p>}
      {!history.data.complete && <p className="text-sm text-muted-foreground">
        只列出最近 {HISTORY_LIMIT} 条记录里的修改，更早的没有显示。
      </p>}
    </section>}

    {/* 撤回进行中不能关闭，结果出来前用户无从判断文件处于什么状态。 */}
    <Dialog open={target !== undefined} onOpenChange={(open) => { if (!open && !undoing) setTarget(undefined); }}>
      {target && <DialogContent>
        <DialogHeader>
          <DialogTitle>撤回这次修改？</DialogTitle>
          <DialogDescription>
            这次修改（{revisionSource(target.source)}，{formatRevisionTime(target.timestamp)}）改动的 {target.changes.length} 个文件会恢复到修改之前：新增的文件被删除，修改、删除或重命名的文件恢复原样。之后又有变化的文件保持现状，不会被覆盖。
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm">撤回也会记成一次修改，需要时可以再撤回它。</p>
        {undoError !== undefined && <ErrorNotice title="撤回失败" error={undoError} />}
        <DialogFooter>
          <Button variant="outline" disabled={undoing} onClick={() => setTarget(undefined)}>取消</Button>
          <Button disabled={undoing} aria-busy={undoing} onClick={() => { void confirmUndo(); }}>
            {undoing ? "正在撤回…" : "撤回"}
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
    return <StatusNotice status="complete" title="已撤回">
      <p>{restored.length > 0 ? `恢复了 ${restored.length} 个文件。` : "这次修改没有需要恢复的文件。"}</p>
    </StatusNotice>;
  }
  return <StatusNotice status="error" title={restored.length > 0 ? "部分文件没有撤回" : "没有撤回任何文件"}>
    {restored.length > 0 && <p>恢复了 {restored.length} 个文件。</p>}
    <p>下面的文件在这次修改之后又有变化，或者已经不在历史记录的范围内，为了不覆盖现在的内容，保持原样：</p>
    <ul aria-label="没有撤回的文件" className="m-0 mt-2 grid list-none gap-1 p-0">
      {conflicts.map((path) => <li key={path} className="break-all">{path}</li>)}
    </ul>
  </StatusNotice>;
}
