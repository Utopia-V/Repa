import { useId, useState } from "react";
import { Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { HistoryRevision } from "@/lib/store";
import { t } from "@/lib/strings";

const changeLabel = { added: t("history.change.added.label"), modified: t("history.change.modified.label"), deleted: t("history.change.deleted.label"), renamed: t("history.change.renamed.label") } as const;

/** 默认显示的文件数，其余的点开再看，一次改了很多文件的记录不会占满整页。 */
const PREVIEW_FILES = 8;

const timeFormat = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" });

export function formatRevisionTime(timestamp: string): string {
  return timeFormat.format(new Date(timestamp));
}

/** 谁做的这次修改。external 是打开空间、运行开始前或监听时发现的、不经过 Repa 的改动，例如编辑器。 */
export function revisionSource(source: HistoryRevision["source"]): string {
  switch (source.kind) {
    case "agent":
      return "Agent";
    case "plugin":
      return t("history.source.plugin.label", { pluginId: source.pluginId });
    case "external":
      return t("history.source.external.label");
    case "undo":
      return t("history.undo.action");
  }
}

/** 一次有文件变化的提交。undone 是它撤回的那一次，不在已读取的记录里时为空。 */
export function HistoryRevisionCard({ revision, undone, onUndo }: {
  revision: HistoryRevision;
  undone?: HistoryRevision | undefined;
  onUndo(): void;
}) {
  const titleId = useId();
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? revision.changes : revision.changes.slice(0, PREVIEW_FILES);
  const hidden = revision.changes.length - shown.length;
  let undoneText: string | undefined;
  if (revision.source.kind === "undo") {
    // 撤回整次运行时指向运行而不是某次提交。
    undoneText = "runId" in revision.source
      ? t("history.undoAgentRun.label")
      : undone
      ? t("history.undoAt.label", { timestamp: formatRevisionTime(undone.timestamp), source: revisionSource(undone.source) })
      : t("history.undoEarlier.label");
  }

  return <article aria-labelledby={titleId}>
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h3 id={titleId} className="text-title weight-semibold break-all">{revisionSource(revision.source)}</h3>
          <p className="text-body text-muted-foreground">
            <time dateTime={revision.timestamp}>{formatRevisionTime(revision.timestamp)}</time>{undoneText}
          </p>
        </div>
        <Button variant="tertiary" aria-describedby={titleId} onClick={onUndo} leadingIcon={Undo2}>{t("history.undo.action")}
        </Button>
      </div>
      <ul aria-label={t("history.files.label")} className="m-0 grid list-none gap-1 p-0 text-body">
        {shown.map((change) => <li key={`${change.kind}:${change.path}`} className="flex min-w-0 gap-2">
          <span className="shrink-0 text-muted-foreground">{changeLabel[change.kind]}</span>
          <span className="min-w-0 break-all">
            {change.kind === "renamed" ? `${change.previousPath} → ${change.path}` : change.path}
          </span>
        </li>)}
      </ul>
      {hidden > 0 && <div>
        <Button variant="ghost" onClick={() => setExpanded(true)}>{t("history.moreFiles.action", { hidden })}</Button>
      </div>}
    </Card>
  </article>;
}
