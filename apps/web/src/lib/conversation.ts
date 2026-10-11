import type { AgentEvent, ModelRef, SessionEntry } from "@repa/base/protocol";

export type ToolStatus = "running" | "done" | "failed" | "incomplete";

/** 对话页显示的一项。提示、view、用量等运行细节不显示。 */
export type ConversationItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string }
  | { kind: "tool"; id: string; tool: string; status: ToolStatus }
  | { kind: "error"; id: string; text: string }
  | { kind: "stopped"; id: string };

export type RunStatus = "idle" | "sending" | "running" | "stopping";

export type Conversation = {
  /** 读取会话列表与记录的状态；`idle` 表示进入空间后还没有读取。 */
  status: "idle" | "loading" | "ready" | "error";
  error?: unknown;
  /** 还没有发出第一条消息时为空，发送时才建立会话。 */
  sessionId?: string | undefined;
  /** 会话保存的模型；还没建立的会话里是用户选的模型，没选时为空，建立时用默认模型。 */
  model?: ModelRef | undefined;
  items: ConversationItem[];
  /** 正在接收文字的助手消息；工具调用或消息结束后关闭。 */
  streaming?: string | undefined;
  run: RunStatus;
  /** 发送或停止失败、且没有写进会话记录的错误。 */
  sendError?: unknown;
};

export const emptyConversation: Conversation = { status: "idle", items: [], run: "idle" };

function field(data: unknown, name: string): unknown {
  return data !== null && typeof data === "object" && name in data
    ? (data as Record<string, unknown>)[name]
    : undefined;
}

function text(data: unknown, name: string): string | undefined {
  const value = field(data, name);
  return typeof value === "string" ? value : undefined;
}

/** 助手消息中的工具调用；记录来自后端，格式不对的条目跳过。 */
function toolCalls(data: unknown): { id: string; name: string }[] {
  const calls = field(data, "calls");
  if (!Array.isArray(calls)) return [];
  return calls.flatMap((call: unknown) => {
    const id = text(call, "id");
    const name = text(call, "name");
    return id && name ? [{ id, name }] : [];
  });
}

/** 把会话记录转成显示项。记录是运行结束后的事实，实时拼出的内容以它为准。 */
export function historyItems(entries: SessionEntry[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  const tools = new Map<string, Extract<ConversationItem, { kind: "tool" }>>();
  for (const entry of entries) {
    if (entry.type === "user") {
      items.push({ kind: "user", id: entry.id, text: entry.text ?? "" });
    } else if (entry.type === "assistant") {
      if (entry.text) items.push({ kind: "assistant", id: entry.id, text: entry.text });
      for (const call of toolCalls(entry.data)) {
        const item = { kind: "tool" as const, id: call.id, tool: call.name, status: "incomplete" as ToolStatus };
        tools.set(call.id, item);
        items.push(item);
      }
      const stopReason = text(entry.data, "stopReason");
      if (stopReason === "error") {
        items.push({ kind: "error", id: `${entry.id}:error`, text: text(entry.data, "errorMessage") ?? "模型请求失败" });
      } else if (stopReason === "aborted") {
        items.push({ kind: "stopped", id: `${entry.id}:stopped` });
      }
    } else if (entry.type === "tool") {
      const callId = text(entry.data, "callId");
      const item = callId ? tools.get(callId) : undefined;
      if (item) item.status = field(entry.data, "isError") === true ? "failed" : "done";
    }
  }
  return items;
}

/** 按运行事件更新显示项；事件只用于运行期间的即时反馈。 */
export function applyEvent(conversation: Conversation, event: AgentEvent): Conversation {
  const items = conversation.items;
  // 事件不带条目编号，用运行编号和位置生成本页内唯一的 key；运行结束后换成记录里的编号。
  const nextId = () => `${event.runId ?? "live"}:${items.length}`;
  const running: RunStatus = conversation.run === "stopping" ? "stopping" : "running";

  switch (event.type) {
    case "runStart":
      return { ...conversation, run: running, streaming: undefined };
    case "runEnd":
      return { ...conversation, run: "idle", streaming: undefined };
    case "textDelta": {
      const delta = event.text ?? "";
      const last = items.at(-1);
      if (conversation.streaming && last?.id === conversation.streaming && last.kind === "assistant") {
        return { ...conversation, run: running, items: [...items.slice(0, -1), { ...last, text: last.text + delta }] };
      }
      const id = nextId();
      return { ...conversation, run: running, streaming: id, items: [...items, { kind: "assistant", id, text: delta }] };
    }
    case "message": {
      const role = text(event.data, "role");
      if (role === "user") {
        return { ...conversation, items: [...items, { kind: "user", id: nextId(), text: event.text ?? "" }] };
      }
      if (role !== "assistant") return conversation;
      let next = items;
      const last = items.at(-1);
      if (conversation.streaming && last?.id === conversation.streaming && last.kind === "assistant") {
        // 完整消息覆盖拼接的增量，避免漏收的分段留在界面上。
        next = [...items.slice(0, -1), { ...last, text: event.text ?? last.text }];
      } else if (event.text) {
        next = [...items, { kind: "assistant", id: nextId(), text: event.text }];
      }
      // 模型出错时另有 error 事件，这里只补上停止标记。
      if (text(event.data, "stopReason") === "aborted") next = [...next, { kind: "stopped", id: `${nextId()}:stopped` }];
      return { ...conversation, items: next, streaming: undefined };
    }
    case "toolStart": {
      const id = text(event.data, "callId") ?? nextId();
      const item: ConversationItem = { kind: "tool", id, tool: event.tool ?? "工具", status: "running" };
      return { ...conversation, run: running, streaming: undefined, items: [...items, item] };
    }
    case "toolEnd": {
      const id = text(event.data, "callId");
      const status: ToolStatus = field(event.data, "isError") === true ? "failed" : "done";
      return {
        ...conversation,
        items: items.map((item) => item.kind === "tool" && item.id === id ? { ...item, status } : item),
      };
    }
    case "error": {
      // 带 code 的是整次运行的失败汇总：取消已有停止标记，模型错误已由消息级的 error 事件显示。
      const code = text(event.data, "code");
      if (code === "cancelled" || code === "model_error") return conversation;
      return { ...conversation, streaming: undefined, items: [...items, { kind: "error", id: nextId(), text: event.text ?? "运行出错" }] };
    }
    default:
      return conversation;
  }
}
