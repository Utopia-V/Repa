import type { ContextEditEntryDraft, CustomMessageEntry, SessionManager, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";

export interface ViewSnapshot {
  id: string;
  text: string;
}

const VIEW_TYPE = "repa-view";

function viewId(entry: CustomMessageEntry): string | undefined {
  const details: unknown = entry.details;
  if (details === null || typeof details !== "object" || !("id" in details)) return undefined;
  return typeof details.id === "string" ? details.id : undefined;
}

/** 当前视图来自会话投影；context_edit 不改写原始记录。 */
export function activeViews(manager: Pick<SessionManager, "buildSessionProjection">): CustomMessageEntry[] {
  return manager.buildSessionProjection().entries.flatMap(({ sourceEntry, messages }) => {
    if (sourceEntry.type !== "custom_message" || sourceEntry.customType !== VIEW_TYPE || messages.length === 0) return [];
    return [sourceEntry];
  });
}

export function viewMessage(view: ViewSnapshot): Extract<SessionBoundaryDraft, { type: "custom_message" }> {
  return {
    type: "custom_message",
    customType: VIEW_TYPE,
    content: `<repa-view source=${JSON.stringify(view.id)}>\n${view.text}\n</repa-view>`,
    display: false,
    details: { id: view.id, text: view.text },
  };
}

export function changedViews(manager: Pick<SessionManager, "buildSessionProjection">, views: ViewSnapshot[]): ViewSnapshot[] {
  const latest = new Map<string, CustomMessageEntry>();
  for (const entry of activeViews(manager)) {
    const id = viewId(entry);
    if (id !== undefined) latest.set(id, entry);
  }
  return views.filter(view => latest.get(view.id)?.content !== viewMessage(view).content);
}

/** 同一来源批量清旧版；删除来源时全部清除，避免旧状态被误认为当前值。 */
export function staleViewEdits(manager: Pick<SessionManager, "buildSessionProjection">, currentIds: Set<string>, batchSize: number, force = false): ContextEditEntryDraft[] {
  const grouped = new Map<string, CustomMessageEntry[]>();
  for (const entry of activeViews(manager)) {
    const id = viewId(entry);
    if (id === undefined) continue;
    const entries = grouped.get(id) ?? [];
    entries.push(entry);
    grouped.set(id, entries);
  }
  const edits: ContextEditEntryDraft[] = [];
  for (const [id, entries] of grouped) {
    const stale = currentIds.has(id) ? entries.slice(0, -1) : entries;
    if (!force && currentIds.has(id) && stale.length < batchSize) continue;
    for (const entry of stale) edits.push({ type: "context_edit", targetId: entry.id, replacement: null });
  }
  return edits;
}

export function sectionName(id: string): string {
  return `repa-${Buffer.from(id, "utf8").toString("hex")}`;
}

export function sectionId(name: string): string {
  if (/^repa-(?:[0-9a-f]{2})+$/.test(name)) return Buffer.from(name.slice(5), "hex").toString("utf8");
  return name === "preamble" ? "runtime" : name;
}
