import { isDeepStrictEqual } from "node:util";
import {
  formatSkillsForPrompt,
  sessionEntryToContextMessages,
  type BuildSystemPromptOptions,
  type ContextEvent,
  type SessionManager,
  type SessionProjection,
} from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import type { PromptSettings } from "../configuration/schema.js";
import { ContextViewSchema, type ContextView } from "../content/schema.js";

export type WorkingMessage = ContextEvent["messages"][number];
export const CONTEXT_MESSAGE_TYPE = "repa.learning-context";

/** 装配由 Repa 选择的来源，包括显式为空的基础提示。 */
export function assembleSystemPrompt(
  options: BuildSystemPromptOptions,
  settings: PromptSettings,
): string {
  const sections = [settings.base, ...settings.append];
  if (settings.projectInstructions && options.contextFiles?.length) {
    sections.push(
      [
        "<project_context>",
        "Project-specific instructions and guidelines:",
        ...options.contextFiles.map(
          ({ path, content }) =>
            `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
        ),
        "</project_context>",
      ].join("\n\n"),
    );
  }
  if (
    settings.skillCatalog &&
    (!options.selectedTools || options.selectedTools.includes("read"))
  ) {
    sections.push(formatSkillsForPrompt(options.skills ?? []).trim());
  }
  if (settings.environment) {
    sections.push(`Current working directory: ${options.cwd.replace(/\\/g, "/")}`);
  }
  return sections.filter((section) => section.length > 0).join("\n\n");
}

function contextContent(view: ContextView): string {
  const source = JSON.stringify({ revision: view.revision, sources: view.sources });
  return [
    "<repa_learning_context>",
    "学习空间中持续维护的学习背景，以下为本次完整视图。",
    `来源与修订：${source}`,
    "",
    view.text,
    "</repa_learning_context>",
  ].join("\n");
}

export function makeContextMessage(
  view: ContextView,
  timestamp: number = Date.now(),
): WorkingMessage {
  return {
    role: "custom",
    customType: CONTEXT_MESSAGE_TYPE,
    content: contextContent(view),
    display: false,
    details: structuredClone(view),
    timestamp,
  };
}

export function contextSnapshot(message: WorkingMessage): ContextView | undefined {
  if (
    message.role !== "custom" ||
    message.customType !== CONTEXT_MESSAGE_TYPE ||
    !Check(ContextViewSchema, message.details)
  ) {
    return undefined;
  }
  // details 不能将已被其他处理改写或截断的正文当作完整模型输入。
  return message.content === contextContent(message.details)
    ? message.details
    : undefined;
}

function compactedSnapshot(manager: SessionManager) {
  const contextEntries = manager.buildContextEntries();
  const compaction = contextEntries[0];
  if (compaction?.type !== "compaction") return undefined;

  // 查询该压缩点的祖先，后续快照和其他分支不能改变边界时的背景。
  const branch = manager.getBranch(compaction.id);
  for (let index = branch.length - 2; index >= 0; index--) {
    const sourceEntry = branch[index]!;
    const snapshot = sessionEntryToContextMessages(sourceEntry).findLast(
      (message) => contextSnapshot(message) !== undefined,
    );
    if (!snapshot || snapshot.role !== "custom") continue;
    // Pi 的显式上下文编辑仍有效，不能从原始历史复活已排除或替换的背景。
    const edit = manager.getBranch().findLast(
      (item) => item.type === "context_edit" && item.targetId === sourceEntry.id,
    );
    if (edit?.type === "context_edit" &&
        (edit.replacement === null || !isDeepStrictEqual(edit.replacement.content, snapshot.content))) return undefined;
    if (contextEntries.some((kept) => kept.id === sourceEntry.id)) return undefined;
    return { sourceEntry, snapshot, compaction };
  }
  return undefined;
}

/** 只投影模型工作视图；会话记录及其分支结构继续由 Pi 持有。 */
export function projectContext(
  messages: WorkingMessage[],
  manager: SessionManager,
  enabled: boolean,
): WorkingMessage[] {
  if (!enabled) {
    return messages.filter(
      (message) =>
        message.role !== "custom" || message.customType !== CONTEXT_MESSAGE_TYPE,
    );
  }
  const restored = compactedSnapshot(manager);
  if (!restored) return messages;
  const { compaction, snapshot } = restored;
  const summaryIndex = messages.findIndex(
    (message) =>
      message.role === "compactionSummary" &&
      message.summary === compaction.summary &&
      message.tokensBefore === compaction.tokensBefore &&
      message.timestamp === Date.parse(compaction.timestamp),
  );
  if (summaryIndex < 0 || isDeepStrictEqual(messages[summaryIndex + 1], snapshot)) return messages;
  return [...messages.slice(0, summaryIndex + 1), snapshot, ...messages.slice(summaryIndex + 1)];
}

/** 保持来源对应，使 Pi 的原有计量与请求投影消费同一份工作视图。 */
export function projectSessionContext(
  projection: SessionProjection,
  manager: SessionManager,
  settings: Pick<PromptSettings, "learningContext" | "fileChanges">,
): SessionProjection {
  const messages = projectContext(projection.messages, manager, settings.learningContext)
    .filter((message) => settings.fileChanges !== "on-demand" ||
      message.role !== "custom" || message.customType !== "repa.file-changes");
  const selected = new Set(messages);
  const entries = projection.entries.map((entry) => ({
    ...entry, messages: entry.messages.filter((message) => selected.has(message)),
  }));
  const original = new Set(projection.messages);
  const restored = messages.find((message) => !original.has(message));
  if (restored) {
    const sourceEntry = compactedSnapshot(manager)?.sourceEntry;
    if (!sourceEntry) throw new Error("语境快照缺少会话来源。");
    const boundary = entries.findIndex((entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0);
    entries.splice(boundary + 1, 0, { sourceEntry, messages: [restored] });
  }
  return { ...projection, entries, messages };
}

/** 只适配公开的模型投影查询；所有历史读写仍委托给原 SessionManager。 */
export function withModelContext(
  manager: SessionManager,
  settings: () => Pick<PromptSettings, "learningContext" | "fileChanges">,
): SessionManager {
  const projection = () => projectSessionContext(manager.buildSessionProjection(), manager, settings());
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
