import { ItemResponseSchema, readItem, readLenient, type AgentEvent, type Item, type ItemResponse, type ModelRef, type SessionEntry } from "@repa/base/protocol";

export type ToolStatus = "running" | "done" | "failed" | "incomplete";

/** 会话记录里保存的一次 ask_user 提问：问了什么，以及怎样结束的。 */
export type PastAsk = {
  item: Item;
  outcome:
    | { action: "submit"; response: ItemResponse }
    | { action: "decline"; message?: string }
    | { action: "cancel" }
    | { action: "unsupported" };
};

/** 对话页显示的一项。提示、view、用量等运行细节不显示；压缩只留一个标记，摘要本身不显示。 */
export type ConversationItem =
  | { kind: "user"; id: string; text: string }
  | {
    kind: "assistant"; id: string; text: string;
    /** 会话记录里结束一轮回答的消息可以作为分叉点，这时 id 是记录条目的 id；实时拼出的消息没有。 */
    forkable?: true;
  }
  | {
    kind: "tool"; id: string; tool: string; status: ToolStatus;
    /** 会话记录里 ask_user 的结果带着完整的提问，重新读取后据此显示卡片。 */
    ask?: PastAsk;
  }
  | { kind: "error"; id: string; text: string }
  | { kind: "stopped"; id: string }
  | { kind: "compaction"; id: string };

export type RunStatus = "idle" | "sending" | "running" | "stopping";

/** 运行中发出、还没送到 Agent 的消息。 */
export type QueuedMessage = { id: string; text: string };

export type Conversation = {
  /** 读取会话列表与记录的状态；`idle` 表示进入空间后还没有读取。 */
  status: "idle" | "loading" | "ready" | "error";
  error?: unknown;
  /** 还没有发出第一条消息时为空，发送时才建立会话。 */
  sessionId?: string | undefined;
  /** 会话保存的模型；还没建立的会话里是用户选的模型，没选时为空，建立时用默认模型。 */
  model?: ModelRef | undefined;
  /** 还没建立的会话要用的 Agent；为空时用后端默认的通用 Agent。 */
  agent?: string | undefined;
  /** 学习页的辅导会话所属的任务；建立会话后据此记下对应关系。 */
  learningTask?: string | undefined;
  items: ConversationItem[];
  /** 正在接收文字的助手消息；工具调用或消息结束后关闭。 */
  streaming?: string | undefined;
  run: RunStatus;
  /** 运行中经 `session.steer` 排队的消息，按发出顺序；送达后作为用户消息出现在 items 里。 */
  queued: QueuedMessage[];
  /** 发送或停止失败、且没有写进会话记录的错误。 */
  sendError?: unknown;
};

export const emptyConversation: Conversation = { status: "idle", items: [], run: "idle", queued: [] };

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

/** ask_user 结果的 details：Item 按词汇宽松读取，读不懂的部分不显示卡片。 */
function pastAsk(details: unknown): PastAsk | undefined {
  const item = readItem(field(details, "item"));
  const outcome = field(details, "outcome");
  if (!item.ok) return undefined;
  const action = field(outcome, "action");
  if (action === "submit") {
    const response = readLenient<ItemResponse>(ItemResponseSchema, field(outcome, "response"));
    return response.ok ? { item: item.value, outcome: { action, response: response.value } } : undefined;
  }
  if (action === "decline") {
    const message = text(outcome, "message");
    return { item: item.value, outcome: message === undefined ? { action } : { action, message } };
  }
  if (action === "cancel" || action === "unsupported") return { item: item.value, outcome: { action } };
  return undefined;
}

/** 把会话记录转成显示项。记录是运行结束后的事实，实时拼出的内容以它为准。 */
export function historyItems(entries: SessionEntry[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  const tools = new Map<string, Extract<ConversationItem, { kind: "tool" }>>();
  for (const entry of entries) {
    if (entry.type === "user") {
      items.push({ kind: "user", id: entry.id, text: entry.text ?? "" });
    } else if (entry.type === "assistant") {
      const calls = toolCalls(entry.data);
      const stopReason = text(entry.data, "stopReason");
      // 分叉保留到这条消息为止。带工具调用的消息后面还缺工具结果，出错或停止的回答不完整，都不作为分叉点。
      const forkable = calls.length === 0 && stopReason !== "error" && stopReason !== "aborted";
      if (entry.text) items.push({ kind: "assistant", id: entry.id, text: entry.text, ...(forkable ? { forkable } : {}) });
      for (const call of calls) {
        const item = { kind: "tool" as const, id: call.id, tool: call.name, status: "incomplete" as ToolStatus };
        tools.set(call.id, item);
        items.push(item);
      }
      if (stopReason === "error") {
        items.push({ kind: "error", id: `${entry.id}:error`, text: text(entry.data, "errorMessage") ?? "模型请求失败" });
      } else if (stopReason === "aborted") {
        items.push({ kind: "stopped", id: `${entry.id}:stopped` });
      }
    } else if (entry.type === "tool") {
      const callId = text(entry.data, "callId");
      const item = callId ? tools.get(callId) : undefined;
      if (item) {
        item.status = field(entry.data, "isError") === true ? "failed" : "done";
        const ask = item.tool === "ask_user" ? pastAsk(field(entry.data, "details")) : undefined;
        if (ask) item.ask = ask;
      }
    } else if (entry.type === "compaction") {
      // 之前的记录仍然显示，标记说明 Agent 从这里起看到的是较早对话的摘要。
      items.push({ kind: "compaction", id: entry.id });
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
        const delivered = event.text ?? "";
        // 后端不转发队列变化。Pi 自己也按文字在队列里找到送达的那条并移除，这里用同样的方式对应。
        const index = conversation.queued.findIndex((message) => message.text === delivered);
        const queued = index === -1 ? conversation.queued : conversation.queued.filter((_, position) => position !== index);
        return { ...conversation, queued, items: [...items, { kind: "user", id: nextId(), text: delivered }] };
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
