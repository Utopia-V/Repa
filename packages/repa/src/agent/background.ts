import { isDeepStrictEqual } from "node:util";
import {
  sessionEntryToContextMessages,
  type ContextEvent,
  type SessionManager,
  type SessionProjection,
} from "@earendil-works/pi-coding-agent";
import type { PromptSettings } from "../configuration/schema.js";

export type WorkingMessage = ContextEvent["messages"][number];
export interface BackgroundCodec {
  id: string;
  customType: string;
  snapshot(message: WorkingMessage): unknown | undefined;
}
export interface PreparedBackground {
  message: WorkingMessage;
  revision: string;
  text: string;
}
export interface BackgroundSource {
  codec: BackgroundCodec;
  reference?: string;
  enabled(settings: PromptSettings): boolean;
  prepare(): Promise<PreparedBackground>;
  /** 静态预览独立于运行准备，不调用后台工厂或能力。 */
  preview?(): Promise<PreparedBackground>;
}
export interface BackgroundState {
  codec: BackgroundCodec;
  enabled: boolean;
}
export interface ProjectionSettings {
  backgrounds: readonly BackgroundState[];
  fileChanges: PromptSettings["fileChanges"];
}

function compactedSnapshot(manager: SessionManager, codec: BackgroundCodec) {
  const contextEntries = manager.buildContextEntries();
  const compaction = contextEntries[0];
  if (compaction?.type !== "compaction") return undefined;
  const branch = manager.getBranch(compaction.id);
  for (let index = branch.length - 2; index >= 0; index--) {
    const sourceEntry = branch[index]!;
    const snapshot = sessionEntryToContextMessages(sourceEntry).findLast(message => codec.snapshot(message) !== undefined);
    if (!snapshot || snapshot.role !== "custom") continue;
    // 显式上下文编辑仍有效；不从原始历史复活已排除或替换的快照。
    const edit = manager.getBranch().findLast(item => item.type === "context_edit" && item.targetId === sourceEntry.id);
    if (edit?.type === "context_edit" &&
      (edit.replacement === null || !isDeepStrictEqual(edit.replacement.content, snapshot.content))) return undefined;
    if (contextEntries.some(kept => kept.id === sourceEntry.id)) return undefined;
    return { sourceEntry, snapshot, compaction };
  }
  return undefined;
}

/** 只投影模型工作视图，快照含义由能力提供，历史与分支继续由 Pi 持有。 */
export function projectBackgrounds(messages: WorkingMessage[], manager: SessionManager, sources: readonly BackgroundState[]): WorkingMessage[] {
  let projected = messages;
  for (const { codec, enabled } of sources) {
    if (!enabled) {
      projected = projected.filter(message => message.role !== "custom" || message.customType !== codec.customType);
      continue;
    }
    const restored = compactedSnapshot(manager, codec);
    if (!restored) continue;
    const { compaction, snapshot } = restored;
    const summaryIndex = projected.findIndex(message => message.role === "compactionSummary" &&
      message.summary === compaction.summary && message.tokensBefore === compaction.tokensBefore &&
      message.timestamp === Date.parse(compaction.timestamp));
    if (summaryIndex < 0 || projected.some(message => isDeepStrictEqual(message, snapshot))) continue;
    projected = [...projected.slice(0, summaryIndex + 1), snapshot, ...projected.slice(summaryIndex + 1)];
  }
  return projected;
}

export function projectSessionBackgrounds(projection: SessionProjection, manager: SessionManager, settings: ProjectionSettings): SessionProjection {
  const messages = projectBackgrounds(projection.messages, manager, settings.backgrounds)
    .filter(message => settings.fileChanges !== "on-demand" || message.role !== "custom" || message.customType !== "repa.file-changes");
  const selected = new Set(messages);
  const entries = projection.entries.map(entry => ({ ...entry, messages: entry.messages.filter(message => selected.has(message)) }));
  const original = new Set(projection.messages);
  for (const restored of messages.filter(message => !original.has(message))) {
    const codec = settings.backgrounds.find(source => source.codec.snapshot(restored) !== undefined)?.codec;
    const sourceEntry = codec && compactedSnapshot(manager, codec)?.sourceEntry;
    if (!sourceEntry) throw new Error("背景快照缺少会话来源。");
    const previous = messages[messages.indexOf(restored) - 1];
    const boundary = entries.findIndex(entry => entry.messages.includes(previous!));
    entries.splice(boundary + 1, 0, { sourceEntry, messages: [restored] });
  }
  return { ...projection, entries, messages };
}

/** SDK 的计量和请求使用同一投影；其他 SessionManager 行为保持原样。 */
export function withModelBackgrounds(manager: SessionManager, settings: () => ProjectionSettings): SessionManager {
  const projection = () => projectSessionBackgrounds(manager.buildSessionProjection(), manager, settings());
  return new Proxy(manager, {
    get(target, property) {
      if (property === "buildSessionProjection") return projection;
      if (property === "buildSessionContext") return () => {
        const { messages, thinkingLevel, model } = projection();
        return { messages, thinkingLevel, model };
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
