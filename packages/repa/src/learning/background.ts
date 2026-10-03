import { Check } from "typebox/value";
import { ContextViewSchema, type ContextView } from "./schema.js";
import { RepaFault } from "../errors.js";
import type { BackgroundCodec, BackgroundSource, WorkingMessage } from "../agent/background.js";

export const CONTEXT_MESSAGE_TYPE = "repa.learning-context";

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

export const learningContextCodec: BackgroundCodec = {
  id: "learningContext",
  customType: CONTEXT_MESSAGE_TYPE,
  snapshot: contextSnapshot,
};

export function learningBackground(read: () => Promise<unknown>, enabled: () => boolean = () => true): BackgroundSource {
  return {
    codec: learningContextCodec,
    enabled: (settings) => enabled() && settings.learningContext,
    async prepare() {
      const view = await read();
      if (!Check(ContextViewSchema, view)) throw new RepaFault("invalid_learning_context", "学习语境实现没有返回完整的语境视图。");
      return { message: makeContextMessage(view), revision: view.revision, text: view.text };
    },
  };
}
