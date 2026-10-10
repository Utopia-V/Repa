import type { AgentSessionEvent, SessionEntry as PiSessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentEvent, SessionEntry, Usage } from "../schema.js";
import { sectionId } from "./views.js";

export function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item: unknown) => {
    if (item !== null && typeof item === "object" && "type" in item && item.type === "text" && "text" in item && typeof item.text === "string") return item.text;
    return "";
  }).join("");
}

export function usageOf(usage: Usage): Usage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
  };
}

export function entryToPublic(entry: PiSessionEntry): SessionEntry | undefined {
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
          stopReason: message.stopReason,
          errorMessage: message.errorMessage,
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
        data: { callId: message.toolCallId, tool: message.toolName, isError: message.isError },
      };
    }
    return undefined;
  }
  if (entry.type === "custom" && entry.customType === "repa-run") return { ...base, type: "run", data: entry.data };
  if (entry.type === "custom_message") return { ...base, type: "view", text: textContent(entry.content), data: entry.details };
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
    return [{ ...base, type: "toolEnd", tool: event.toolName, data: { callId: event.toolCallId, isError: event.isError } }];
  }
  if (event.type === "message_end" && event.message.role === "assistant") {
    const message = event.message;
    const result: AgentEvent[] = [
      {
        ...base,
        type: "message",
        text: textContent(message.content),
        data: { role: "assistant", stopReason: message.stopReason },
      },
      {
        ...base,
        type: "usage",
        usage: usageOf(message.usage),
        data: { provider: message.provider, model: message.responseModel ?? message.model },
      },
    ];
    if (message.stopReason === "error") result.push({ ...base, type: "error", text: message.errorMessage ?? "模型请求失败" });
    return result;
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
