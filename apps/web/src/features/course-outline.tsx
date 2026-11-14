import { useState } from "react";
import { ChevronDown, ChevronUp, Circle, CircleCheck, CircleDashed, LoaderCircle } from "lucide-react";
import type { CourseBuilding, LearningSettings } from "@repa/learning/protocol";

import { Button } from "@/components/ui/button";
import { StatusNotice } from "@/components/ui/status-notice";
import { Switch } from "@/components/ui/switch";
import { ErrorNotice } from "@/components/domain/error-notice";
import { useAppStore } from "@/hooks/use-app-store";
import { estimatedUsd } from "@/lib/format";
import { t } from "@/lib/strings";

type Part = CourseBuilding["parts"][number];
type Shown = Part["status"] | "expanding";

const statusText: Record<Shown, string> = {
  outline: t("outline.status.outline.label"),
  ready: t("outline.status.ready.label"),
  learned: t("outline.status.learned.label"),
  expanding: t("outline.status.expanding.label"),
};

// 状态同时由图标和文字表达：虚线圈是只有轮廓，实线圈可以学，带勾的学过。
const statusIcon = { outline: CircleDashed, ready: Circle, learned: CircleCheck, expanding: LoaderCircle } satisfies Record<Shown, unknown>;

const failureTitle = {
  failed: (titles: string) => t("outline.failure.failed.title", { titles }),
  cancelled: (titles: string) => t("outline.failure.cancelled.title", { titles }),
  not_expanded: (titles: string) => t("outline.failure.notExpanded.title", { titles }),
} as const;

/**
 * 整门课的全貌：花费和自动展开的开关在标题一行，后台展开与它的取消、最近一次没有成功的原因与再试常在；
 * 各部分的清单可以收起。还没有能学的部分时清单展开，有了以后先收起，不把菜单和任务挤下去。
 */
export function CourseOutline({ building, settings }: { building: CourseBuilding; settings: LearningSettings | undefined }) {
  const expandParts = useAppStore((state) => state.expandParts);
  const cancelExpansion = useAppStore((state) => state.cancelExpansion);
  const setAutoExpand = useAppStore((state) => state.setAutoExpand);
  const { parts, expansion, lastFailure, cost } = building;
  const started = parts.some((part) => part.status !== "outline");
  const [open, setOpen] = useState(!started);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ title: string; error: unknown }>();

  const title = (id: string) => parts.find((part) => part.topicId === id)?.title ?? id;
  const titles = (ids: string[]) => ids.map(title).join(" · ");
  const expanding = new Set(expansion?.topicIds ?? []);

  async function act(run: () => Promise<void>, failure: string) {
    setBusy(true);
    setError(undefined);
    try {
      await run();
    } catch (caught) {
      setError({ title: failure, error: caught });
    } finally {
      setBusy(false);
    }
  }

  // 再试只取仍是轮廓的部分；合并或删掉的部分不再出现在课里。
  const retryIds = lastFailure?.topicIds.filter((id) => parts.some((part) => part.topicId === id && part.status === "outline")) ?? [];
  const count = (status: Part["status"]) => parts.filter((part) => part.status === status).length;

  return <section aria-labelledby="course-outline-title" className="grid gap-4">
    {/* 花费跟着标题：清单收起或展开都看得到。 */}
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="grid gap-1">
        <h3 id="course-outline-title" className="m-0 text-title weight-semibold">{t("outline.title")}</h3>
        {building.course && <p className="m-0 text-caption text-muted-foreground tabular-nums">
          {t("outline.cost.label", { amount: estimatedUsd(cost.cost), requests: cost.requests })}
          {Object.values(cost.unpriced).some((value) => value > 0) && t("outline.cost.unpriced.hint")}
        </p>}
      </div>
      {settings && <Switch
        label={t("outline.autoExpand.label")}
        checked={settings.autoExpand}
        disabled={busy}
        onToggle={() => { void act(() => setAutoExpand(!settings.autoExpand), t("outline.autoExpand.error")); }}
      />}
    </div>

    {expansion && <div role="status" className="flex flex-wrap items-center justify-between gap-3">
      <p className="m-0 flex min-w-0 items-center gap-2 text-body">
        <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
        {t("outline.expanding.status", { titles: titles(expansion.topicIds) })}
      </p>
      <Button variant="tertiary" disabled={busy} onClick={() => { void act(cancelExpansion, t("outline.action.error")); }}>{t("outline.expansion.cancel.action")}</Button>
    </div>}

    {!expansion && lastFailure && <div className="grid gap-3">
      {lastFailure.code === "failed" && lastFailure.message !== undefined
        ? <ErrorNotice title={failureTitle.failed(titles(lastFailure.topicIds))} error={new Error(lastFailure.message)} />
        : <StatusNotice status="error" title={failureTitle[lastFailure.code](titles(lastFailure.topicIds))} />}
      {retryIds.length > 0 && <div>
        <Button variant="tertiary" disabled={busy} onClick={() => { void act(() => expandParts(retryIds), t("outline.action.error")); }}>{t("outline.failure.retry.action")}</Button>
      </div>}
    </div>}

    {error && <ErrorNotice title={error.title} error={error.error} />}

    {parts.length > 0 && <div className="grid gap-3">
      <Button
        variant="ghost"
        className="justify-self-start"
        aria-expanded={open}
        aria-controls="course-outline-parts"
        trailingIcon={open ? ChevronUp : ChevronDown}
        onClick={() => setOpen(!open)}
      >
        {t("outline.summary.label", { ready: count("ready"), learned: count("learned"), total: parts.length })}
      </Button>
      {/* 各行共用一套列（subgrid），状态和“先做”在每一行都对齐。 */}
      {open && <ol id="course-outline-parts" className="m-0 grid list-none grid-cols-[2rem_1fr_auto_auto] gap-0 p-0">
        {parts.map((part, index) => {
          const shown: Shown = expanding.has(part.topicId) ? "expanding" : part.status;
          const Icon = statusIcon[shown];
          return <li key={part.topicId} data-status={shown} className="col-span-4 grid grid-cols-subgrid items-start gap-x-3 border-t border-border py-3">
            {/* 编号和标题下移半个按钮高，与右边的状态和按钮对齐。 */}
            <span className="pt-2 text-body text-muted-foreground tabular-nums">{index + 1}</span>
            <div className="grid min-w-0 gap-1 pt-2">
              <span className={shown === "outline" ? "text-body text-muted-foreground" : "text-body weight-semibold"}>{part.title}</span>
              {part.summary !== undefined && <span className="text-caption text-muted-foreground">{part.summary}</span>}
              {part.sources.length > 0 && <span className="text-caption text-muted-foreground">
                {part.sources.map((source) => `${source.title} ${source.where}`).join(" · ")}
              </span>}
            </div>
            <span className="flex min-h-9 items-center gap-1 text-caption whitespace-nowrap text-muted-foreground">
              <Icon aria-hidden="true" className={shown === "expanding" ? "size-4 animate-spin motion-reduce:animate-none" : "size-4"} />
              {statusText[shown]}
            </span>
            <div>
              {shown === "outline" && <Button
                variant="ghost"
                aria-label={t("outline.expand.label", { title: part.title })}
                disabled={busy || expansion !== null}
                onClick={() => { void act(() => expandParts([part.topicId]), t("outline.action.error")); }}
              >{t("outline.expand.action")}</Button>}
            </div>
          </li>;
        })}
      </ol>}
    </div>}

  </section>;
}
