import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { CompletionRequest } from "../plugin.js";
import type { ModelRef, SessionEntry } from "../schema.js";

// 交给模型的对话记录上限。保留末尾：问题通常出在最近几轮。这是 Repa 的假设，按实际反馈调整。
const TRANSCRIPT_LIMIT = 60_000;
const TOOL_TEXT_LIMIT = 2_000;

const SYSTEM = [
  "你在帮 Repa 的开发者整理一份问题反馈。下面是用户和 Agent 的一次对话记录，用户认为其中出了问题。",
  "请用简体中文写四段，每段都引用记录里的工具调用或工具结果作为依据：",
  "1. 用户要求了什么。",
  "2. Agent 实际调用了哪些工具，参数和结果是什么。",
  "3. Agent 对用户说了什么，例如声称完成了什么。",
  "4. 哪里可能和事实不一致，或者哪里出了错。",
  "只根据记录判断；记录里看不出来的，写明看不出来，不要猜测。",
].join("\n");

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…（截断，共 ${text.length} 字）`;
}

// 只取写记录用得到的字段；会话条目的 data 由 events.ts 生成，这里按可选字段宽松读取。
const AssistantDataSchema = Type.Object({ calls: Type.Optional(Type.Array(Type.Unknown())), errorMessage: Type.Optional(Type.String()) });
const ToolDataSchema = Type.Object({ tool: Type.Optional(Type.String()), isError: Type.Optional(Type.Boolean()) });

function line(entry: SessionEntry): string | undefined {
  if (entry.type === "user") return `[用户 ${entry.timestamp}]\n${entry.text ?? ""}`;
  if (entry.type === "assistant") {
    const data: Static<typeof AssistantDataSchema> = Value.Check(AssistantDataSchema, entry.data) ? entry.data : {};
    const calls = (data.calls ?? []).map(call => `调用工具：${JSON.stringify(call)}`);
    const failure = data.errorMessage === undefined ? [] : [`模型请求出错：${data.errorMessage}`];
    return [`[Agent ${entry.timestamp}]`, entry.text ?? "", ...calls, ...failure].filter(part => part.length > 0).join("\n");
  }
  if (entry.type === "tool") {
    const data: Static<typeof ToolDataSchema> = Value.Check(ToolDataSchema, entry.data) ? entry.data : {};
    const tool = data.tool ?? "未知工具";
    const failed = data.isError === true ? "，出错" : "";
    return `[工具结果 ${tool}${failed} ${entry.timestamp}]\n${clip(entry.text ?? "", TOOL_TEXT_LIMIT)}`;
  }
  return undefined;
}

export function transcript(history: readonly SessionEntry[]): string {
  const text = history.flatMap(entry => {
    const converted = line(entry);
    return converted === undefined ? [] : [converted];
  }).join("\n\n");
  return text.length <= TRANSCRIPT_LIMIT ? text : `（前面的记录已省略）\n${text.slice(-TRANSCRIPT_LIMIT)}`;
}

/**
 * Agent 自述：用会话记录做一次不带工具的模型调用。不带工具，也就不会在写描述时改文件或运行命令；
 * 自述可能是错的，所以包里原始会话照样保留，自述只是阅读原始材料的索引。
 */
export async function describe(
  complete: (request: CompletionRequest) => Promise<string>,
  history: readonly SessionEntry[],
  options: { model?: ModelRef; note?: string; signal?: AbortSignal },
): Promise<string> {
  const note = options.note === undefined || options.note.trim().length === 0 ? "" : `用户补充的说明：${options.note}\n\n`;
  return complete({
    system: SYSTEM,
    prompt: `${note}对话记录：\n\n${transcript(history)}`,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}
