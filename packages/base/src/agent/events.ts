import type { AgentSessionEvent, SessionEntry as PiSessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentEvent, SessionEntry, Usage } from "../schema.js";
import { modelFailure } from "./model-failure.js";
import { sectionId } from "./views.js";

export function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item: unknown) => {
    if (item !== null && typeof item === "object" && "type" in item && item.type === "text" && "text" in item && typeof item.text === "string") return item.text;
    return "";
  }).join("");
}

// Pi 实时结果没有约束 result 的类型，在转换边界读取 details。
function resultDetails(result: unknown): { details?: unknown } {
  const details = result !== null && typeof result === "object" && "details" in result ? result.details : undefined;
  return details === undefined ? {} : { details };
}

/**
 * 后端关闭时正在进行的模型请求被取消，Pi 把这条回答记成 error，原文是运行时取消请求的固定消息。
 * 它不是故障：对外按 aborted 交出，界面显示“已停止”，不显示一条英文的出错信息。
 */
const REQUEST_ABORTED = "This operation was aborted";
function stopReasonOf(message: { stopReason: string; errorMessage?: string }): string {
  return message.stopReason === "error" && message.errorMessage === REQUEST_ABORTED ? "aborted" : message.stopReason;
}

export function usageOf(usage: Usage): Usage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
  };
}

/**
 * 历史里被 Pi 自动重试过的失败请求。Pi 重试前用一条 replacement 为 null 的 context_edit 把失败的那条回答移出上下文，
 * 原始记录保留；这样的出错回答不是这次请求的结局，结局在后面的条目里。
 */
export function retriedFailures(branch: PiSessionEntry[]): Set<string> {
  const omitted = new Set(branch.flatMap(entry => entry.type === "context_edit" && entry.replacement === null ? [entry.targetId] : []));
  return new Set(branch.flatMap(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error" && omitted.has(entry.id) ? [entry.id] : []));
}

/** 出错回答的公开数据：原文、Repa 的失败分类，以及 Pi 是否已经自动重试过它。 */
function failureData(errorMessage: string | undefined, retried: boolean) {
  return { errorMessage, failure: modelFailure(errorMessage), ...(retried ? { retried: true } : {}) };
}

/** 把一条 Pi 历史条目转成公开条目；retried 是这条出错的回答已被 Pi 自动重试，见 retriedFailures。 */
export function entryToPublic(entry: PiSessionEntry, retried = false): SessionEntry | undefined {
  const base = { id: entry.id, timestamp: entry.timestamp };
  if (entry.type === "message") {
    const message = entry.message;
    if (message.role === "system") {
      return {
        ...base,
        type: "prompt",
        text: textContent(message.content),
        data: {
          sections: Object.entries(message.sections ?? {}).map(([id, text]) => ({ id: sectionId(id), text })),
          toolsAdded: message.toolsAdded?.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
          toolsRemoved: message.toolsRemoved?.map(tool => tool.name),
        },
      };
    }
    if (message.role === "user") return { ...base, type: "user", text: textContent(message.content) };
    if (message.role === "assistant") {
      return {
        ...base,
        type: "assistant",
        text: textContent(message.content),
        usage: usageOf(message.usage),
        data: {
          stopReason: stopReasonOf(message),
          ...(stopReasonOf(message) === "error" ? failureData(message.errorMessage, retried) : {}),
          provider: message.provider,
          model: message.responseModel ?? message.model,
          calls: message.content.filter(block => block.type === "toolCall").map(call => ({ id: call.id, name: call.name, input: call.arguments })),
        },
      };
    }
    if (message.role === "toolResult") {
      return {
        ...base,
        type: "tool",
        text: textContent(message.content),
        data: { callId: message.toolCallId, tool: message.toolName, isError: message.isError, ...resultDetails(message) },
      };
    }
    return undefined;
  }
  if (entry.type === "custom" && entry.customType === "repa-run") return { ...base, type: "run", data: entry.data };
  if (entry.type === "custom_message") return { ...base, type: entry.customType === "repa-prompt-change" ? "promptChange" : "view", text: textContent(entry.content), data: entry.details };
  if (entry.type === "context_edit") {
    return { ...base, type: "contextEdit", data: { targetId: entry.targetId, replacement: entry.replacement } };
  }
  if (entry.type === "compaction") {
    return {
      ...base,
      type: "compaction",
      text: entry.summary,
      data: { firstKeptEntryId: entry.firstKeptEntryId },
      ...(entry.usage ? { usage: usageOf(entry.usage) } : {}),
    };
  }
  if (entry.type === "usage") {
    return {
      ...base,
      type: "usage",
      data: { kind: entry.kind, provider: entry.provider, model: entry.model },
      usage: usageOf(entry.usage),
    };
  }
  return undefined;
}

export function convertEvent(sessionId: string, event: AgentSessionEvent, runId?: string): AgentEvent[] {
  const base = { sessionId, ...(runId ? { runId } : {}) };
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    return [{ ...base, type: "textDelta", text: event.assistantMessageEvent.delta }];
  }
  if (event.type === "tool_execution_start") {
    return [{ ...base, type: "toolStart", tool: event.toolName, data: { callId: event.toolCallId, input: event.args } }];
  }
  if (event.type === "tool_execution_end") {
    return [{ ...base, type: "toolEnd", tool: event.toolName, data: { callId: event.toolCallId, isError: event.isError, ...resultDetails(event.result) } }];
  }
  if (event.type === "message_end" && event.message.role === "assistant") {
    const message = event.message;
    // 出错的回答不在这里发 error 事件：Pi 可能接着自动重试，每次失败都报会让一次失败显示好几遍。
    // 运行以失败结束时，运行一级的 error 事件（code 为 model_error）带着分类报一次。
    return [
      {
        ...base,
        type: "message",
        text: textContent(message.content),
        data: { role: "assistant", stopReason: stopReasonOf(message) },
      },
      {
        ...base,
        type: "usage",
        usage: usageOf(message.usage),
        data: { provider: message.provider, model: message.responseModel ?? message.model },
      },
    ];
  }
  if (event.type === "message_end" && event.message.role === "user") {
    return [{ ...base, type: "message", text: textContent(event.message.content), data: { role: "user" } }];
  }
  if (event.type === "entry_appended" && event.entry.type === "usage") {
    return [{
      ...base,
      type: "usage",
      usage: usageOf(event.entry.usage),
      data: { kind: event.entry.kind, provider: event.entry.provider, model: event.entry.model },
    }];
  }
  if (event.type === "compaction_end") {
    return [{
      ...base,
      type: "compaction",
      data: { reason: event.reason, aborted: event.aborted, error: event.errorMessage },
    }];
  }
  return [];
}
