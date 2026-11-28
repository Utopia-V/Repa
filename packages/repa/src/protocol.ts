// 后端与界面之间的对话事件。后端把 Pi 的事件换成这几种，界面因此不依赖 Pi 的类型；applyEvent 两边共用。
import type { Question } from "./log.js";

/** 对话里的一项：学习者的消息（quote 是随它引用的一段话）、Agent 的回复、一次工具调用、一次压缩或一条错误。change 是 write/edit 改动的知识库内的文件。 */
export type Item =
  | { type: "user"; text: string; quote?: string }
  | { type: "assistant"; text: string }
  | { type: "tool"; id: string; name: string; args: Record<string, unknown>; done: boolean; isError: boolean; output: string; details?: unknown; change?: string }
  | { type: "compaction" }
  | { type: "error"; text: string };

/** 等学习者回应的一张卡片：题目卡片，或改卡片、运行命令前的确认卡片。id 是工具调用编号。 */
export type PendingRequest =
  | { kind: "quiz"; questions: Question[]; card?: string }
  | { kind: "confirm"; tool: string; target: string };

/** 一张待回应的卡片。 */
export type Pending = PendingRequest & { id: string };

/** 学习者的回应：题目卡片交回作答（null 是没有作答），确认卡片交回是否同意和理由。 */
export interface PendingReply {
  answers?: string[] | null;
  approve?: boolean;
  reason?: string;
}

/** 一段对话的概况。kind 区分学习对话与复习对话。 */
export interface SessionInfo {
  id: string;
  folder: string;
  kind: "learn" | "review";
  mode: string;
  model?: string;
  thinking?: string;
  thinkingLevels?: string[];
}

/** 推给界面的事件。snapshot 在连上时发一次，之后是增量。 */
export type UiEvent =
  | { type: "snapshot"; session: SessionInfo; items: Item[]; pending: Pending[]; running: boolean }
  | { type: "item"; item: Item }
  | { type: "delta"; text: string }
  | { type: "tool_end"; id: string; isError: boolean; output: string; details?: unknown }
  | { type: "pending"; pending: Pending }
  | { type: "resolved"; id: string }
  | { type: "running"; running: boolean }
  | { type: "session"; session: SessionInfo };

/** 对话在界面上的状态。 */
export interface Conversation {
  session?: SessionInfo;
  items: Item[];
  pending: Pending[];
  running: boolean;
}

/** 把一个事件应用到对话上，返回新的对话，不修改输入。 */
export function applyEvent(state: Conversation, event: UiEvent): Conversation {
  switch (event.type) {
    case "snapshot":
      return { session: event.session, items: event.items, pending: event.pending, running: event.running };
    case "item":
      return { ...state, items: [...state.items, event.item] };
    case "delta": {
      const items = [...state.items];
      const last = items.at(-1);
      if (last?.type === "assistant") items[items.length - 1] = { ...last, text: last.text + event.text };
      else items.push({ type: "assistant", text: event.text });
      return { ...state, items };
    }
    case "tool_end":
      return {
        ...state,
        items: state.items.map((item) => (item.type === "tool" && item.id === event.id
          ? { ...item, done: true, isError: event.isError, output: event.output, ...(event.details === undefined ? {} : { details: event.details }) }
          : item)),
      };
    case "pending":
      return { ...state, pending: [...state.pending.filter((item) => item.id !== event.pending.id), event.pending] };
    case "resolved":
      return { ...state, pending: state.pending.filter((item) => item.id !== event.id) };
    case "running":
      return { ...state, running: event.running };
    case "session":
      return { ...state, session: event.session };
  }
}
