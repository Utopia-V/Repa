import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { prepareItem, type AskRoute } from "../ask.js";
import type { Answer, Block, ItemDraft, Slot } from "../interaction.js";
import { ASK_USER_TOOL, type AskOutcome } from "../plugin.js";
import { currentRun } from "../run-context.js";
import { object, RepaFault } from "../schema.js";

// 参数只描述问题；工具参数会经 session.event 和 session.history 发给所有连接。
// 每次 1–4 问、每问 2–6 个选项的上限沿用草案，参照 Claude Code 的 AskUserQuestion。
const AskUserSchema = object({
  questions: Type.Array(object({
    id: Type.Optional(Type.String({ maxLength: 40, pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$", description: "可选的问题标识" })),
    question: Type.String({ minLength: 1, maxLength: 2_000, description: "问题，Markdown" }),
    header: Type.Optional(Type.String({ maxLength: 16, description: "很短的标签" })),
    options: Type.Optional(Type.Array(object({
      label: Type.String({ minLength: 1, maxLength: 80, description: "选项，Markdown" }),
      description: Type.Optional(Type.String({ maxLength: 300, description: "选项说明，Markdown" })),
    }), { minItems: 2, maxItems: 6 })),
    multiple: Type.Optional(Type.Boolean({ description: "有选项时允许多选" })),
    allowOther: Type.Optional(Type.Boolean({ description: "有选项时允许用户自填，默认允许" })),
    input: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("longText"), Type.Literal("number")], {
      description: "没有选项时的输入方式，默认 text",
    })),
  }), { minItems: 1, maxItems: 4 }),
});
type AskUserInput = Static<typeof AskUserSchema>;
type Question = AskUserInput["questions"][number];

const DESCRIPTION = [
  "向用户提出 1–4 个问题，等用户在界面上作答，回答原样作为工具结果交回。",
  "用于需要用户决定、选择或澄清的地方。",
  "用户可以不按卡片作答而回一句话，也可以关掉询问。",
].join("");

// 只给含 $ 的块要求 markdown.math，普通卡片仍能交给不支持公式的前端。
function markdown(text: string): Block {
  return { type: "markdown", text, ...(text.includes("$") ? { math: true } : {}) };
}

function slotFor(question: Question, id: string): Slot {
  const prompt = [markdown(question.question)];
  const label = question.header === undefined ? {} : { label: question.header };
  if (question.options !== undefined) {
    return {
      id,
      type: "choice",
      prompt,
      ...label,
      options: question.options.map((option, index) => ({
        id: `o${index + 1}`,
        label: option.label,
        content: [markdown(option.description === undefined ? option.label : `**${option.label}**：${option.description}`)],
      })),
      ...(question.multiple === true ? { multiple: true } : {}),
      ...(question.allowOther === false ? {} : { other: { label: "其他" } }),
    };
  }
  return {
    id,
    type: "text",
    prompt,
    ...label,
    ...(question.input === "longText" ? { lines: 5 } : {}),
    ...(question.input === "number" ? { format: "number" } : {}),
  };
}

function questionIds(questions: Question[]): string[] {
  const ids = questions.map((question, index) => question.id ?? `q${index + 1}`);
  if (new Set(ids).size !== ids.length) throw new RepaFault("invalid_input", "问题的 id 不能重复");
  return ids;
}

function answerText(question: Question, answer: Answer | undefined): string {
  if (answer?.type === "choice") {
    const chosen = answer.selected.map((selected) => question.options?.[Number(selected.slice(1)) - 1]?.label ?? selected);
    if (answer.other !== undefined) chosen.push(`其他：${answer.other}`);
    return chosen.length === 0 ? "（一项都没选）" : chosen.join("、");
  }
  if (answer?.type === "text") return answer.text;
  return "（没有作答）";
}

/** 交回模型的文字：问题 → 选择或填写的内容；不按卡片作答时原样带上用户的话。 */
function describe(questions: Question[], ids: string[], outcome: AskOutcome): string {
  if (outcome.action === "decline") {
    return outcome.message === undefined ? "用户没有按卡片作答。" : `用户没有按卡片作答，留言：${outcome.message}`;
  }
  if (outcome.action === "cancel") return "用户关闭了询问，没有作答。";
  if (outcome.action === "unsupported") return "当前界面无法显示这张询问卡片，用户没有看到问题。请改用文字提问。";
  const answers = outcome.response.answers;
  const lines = questions.map((question, index) => {
    const id = ids[index] ?? "";
    const answer = Object.hasOwn(answers, id) ? answers[id] : undefined;
    return `- ${question.question.replace(/\s+/gu, " ").trim()} → ${answerText(question, answer)}`;
  });
  return `用户已作答：\n${lines.join("\n")}`;
}

/** 底座的 ask_user：把参数转换成 Item，经询问路由发给发起这次运行的连接。 */
export function askUserTool(route: AskRoute | undefined): ToolDefinition {
  return defineTool({
    name: ASK_USER_TOOL,
    label: ASK_USER_TOOL,
    description: DESCRIPTION,
    parameters: AskUserSchema,
    execute: async (callId, input, signal) => {
      if (route === undefined) throw new RepaFault("ask_unavailable", "当前运行没有可以作答的用户连接");
      const ids = questionIds(input.questions);
      const draft: ItemDraft = { id: `ask:${randomUUID()}`, body: [], slots: input.questions.map((question, index) => slotFor(question, ids[index] ?? "")) };
      const item = await prepareItem(draft);
      const run = currentRun();
      const outcome = await route({
        origin: { kind: "agent", ...(run === undefined ? {} : { sessionId: run.sessionId }), callId },
        item,
      }, signal === undefined ? {} : { signal });
      return {
        content: [{ type: "text" as const, text: describe(input.questions, ids, outcome) }],
        details: { item, outcome },
      };
    },
  });
}
