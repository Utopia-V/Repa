import {
  type Answer,
  type Block,
  type ClientCapabilities,
  type Item,
} from "@repa/base/protocol";

import type { PastAsk } from "@/lib/conversation";
import type { Ask } from "@/lib/store";
import { t } from "@/lib/strings";

type Slot = Item["slots"][number];

/** 询问卡片和学习任务区能显示的作答位和内容块；连接时在 initialize 里声明，后端只发这些能显示的题。 */
export const interactionCapabilities = {
  supports: ["slot.choice", "slot.text", "slot.order", "slot.table", "slot.code", "block.markdown", "block.code", "markdown.math"],
} satisfies NonNullable<ClientCapabilities["interaction"]>;

/** 内容块的纯文字，用于没有 label 的选项回显和读屏名称。 */
export function plainText(content: Block[] | undefined): string {
  return (content ?? []).map((block) => block.type === "image" ? block.alt : block.text).join(" ").replace(/\s+/gu, " ").trim();
}

/** 小问的简短名称：label，否则题面文字，都没有时按序号。 */
export function slotName(slot: Slot, index: number): string {
  return slot.label ?? (plainText(slot.prompt) || t("item.ask.slot.label", { value: index + 1 }));
}

/** 作答的文字回显：选项按 label 或内容，自填的加“其他”前缀。 */
export function answerText(slot: Slot, answer: Answer | undefined): string {
  if (answer?.type === "choice" && slot.type === "choice") {
    const chosen = answer.selected.map((id) => {
      const option = slot.options.find((candidate) => candidate.id === id);
      return option ? option.label ?? plainText(option.content) : id;
    });
    if (answer.other !== undefined) chosen.push(`${slot.other?.label ?? t("item.other.label")}：${answer.other}`);
    return chosen.length === 0 ? t("item.ask.noChoice.status") : chosen.join("、");
  }
  if (answer?.type === "text") return answer.text === "" ? t("item.ask.noInput.status") : answer.text;
  if (answer?.type === "order" && slot.type === "order") {
    return answer.items.map((id, index) => {
      const block = slot.items.find((candidate) => candidate.id === id);
      const text = block ? block.label ?? plainText(block.content) : id;
      return `${" ".repeat(4 * (answer.indents?.[index] ?? 0))}${text}`;
    }).join("\n");
  }
  if (answer?.type === "table") {
    const filled = Object.values(answer.cells).reduce((count, row) => count + Object.keys(row).length, 0);
    return t("item.ask.filled.status", { filled });
  }
  if (answer?.type === "code") return answer.code;
  return t("item.ask.noAnswer.status");
}

/** 会话记录里的一次 ask_user 换成已结束的询问，卡片按结束方式显示；callId 同时作为询问的 id。 */
export function restoredAsk(callId: string, { item, outcome }: PastAsk): Ask {
  const request = { id: callId, origin: { kind: "agent" as const, callId }, item };
  const base = { request, submitting: false, problems: [] };
  if (outcome.action === "submit") return { ...base, closed: "answered", response: outcome.response };
  if (outcome.action === "decline") return { ...base, closed: "answered", declined: outcome.message };
  return { ...base, closed: outcome.action === "cancel" ? "cancelled" : "unsupported" };
}
