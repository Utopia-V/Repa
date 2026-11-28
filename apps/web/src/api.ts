// 后端接口的客户端：请求与回应的形状照 packages/repa/README.md 的接口表，对话的事件类型直接用后端的 protocol.ts。
import type { SessionInfo, SessionStatus } from "@repa/protocol";

/** 列表里的一张卡片或专题。日期都是 YYYY-MM-DD。 */
export interface CardSummary {
  path: string;
  title: string;
  folder: string;
  summary: string;
  moc: boolean;
  keep: boolean;
  error?: string;
  review?: string;
  memory?: number;
  due: boolean;
  overdueDays: number;
  nextDue?: string;
  lastPracticed?: string;
  /** 文件的建立时间（毫秒）；requires 与 links 只在全部卡片的列表里有 */
  created?: number;
  requires?: Link[];
  links?: Link[];
}

/** 一处链接：target 是写下的文字，path 是找到的卡片，找不到是 null。 */
export interface Link {
  target: string;
  path: string | null;
}

/** 一次练习：题目、作答（null 是没有作答）和最后一条判定。 */
export interface Practice {
  id: string;
  t: string;
  questions: Array<{ text: string; options?: string[] }>;
  answers: string[] | null;
  result?: "pass" | "partial" | "fail";
  note?: string;
  external?: string;
}

/** 一张卡片的全部。 */
export interface CardDetail extends Omit<CardSummary, "requires"> {
  text: string;
  body: string;
  mtime: number;
  requires: Link[];
  members: Array<{ path: string; title: string }>;
  broken: string[];
  backlinks: Array<{ path: string; title: string }>;
  practices: Practice[];
}

/** 资料：_ 开头的文件夹、仓库，或不是 Markdown 的文件。 */
export interface Material {
  path: string;
  kind: "folder" | "repo" | "file";
}

/** 文件夹树。根是空字符串。 */
export interface Tree {
  folders: Array<{ path: string; name: string; count: number }>;
  pages: Array<{ path: string; title: string; folder: string; moc: boolean }>;
  materials: Material[];
}

/** 一个文件夹的概况。 */
export interface FolderInfo {
  path: string;
  agents: { text: string; mtime: number } | null;
  materials: Material[];
}

/** 今日的建议。 */
export interface Today {
  practiced: number;
  limit: number | null;
  done: boolean;
  due: CardSummary[];
  dueTotal: number;
  fresh: CardSummary[];
  freshTotal: number;
  recent: string[];
}

/** 对话列表的一项。 */
export interface SessionSummary {
  id: string;
  folder: string;
  kind: "learn" | "review";
  title: string;
  modified: string;
  running: boolean;
  waiting: boolean;
}

/** 设置。root 是知识库在本机的位置，只读。 */
export interface Settings {
  confirmEdits: boolean;
  confirmCommands: boolean;
  dailyLimit: number | null;
  appearance: "system" | "light" | "dark";
  keys?: Record<string, unknown>;
  model?: string;
  thinking?: string;
  root: string;
}

/** 注入的上下文。 */
export interface ContextInfo {
  usage: { tokens: number | null; contextWindow: number; percent: number | null } | null;
  agentsFiles: string[];
  mode: string;
  map: string;
  review: string;
  attachments: string[];
}

/** 一次改动的逐行差异，diff 是 diff 包 diffLines 的结果。 */
export interface Change {
  version: string;
  created: boolean;
  deleted: boolean;
  diff: Array<{ value: string; added?: boolean; removed?: boolean }>;
}

/** 接口回的错误。status 409 时 details 带着文件的最新内容。 */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly details?: { text?: string; mtime?: number }) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  const value = (await response.json()) as T & { error?: string; details?: { text?: string; mtime?: number } };
  if (!response.ok) throw new ApiError(response.status, value.error ?? response.statusText, value.details);
  return value;
}

/** GET 一个接口；参数里的 undefined 不发。 */
export function get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const query = new URLSearchParams(Object.entries(params).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])));
  return call<T>("GET", query.size ? `${path}?${query}` : path);
}

/** 写入类的请求，一律是 JSON。 */
export const post = <T = unknown>(path: string, body: unknown = {}) => call<T>("POST", path, body);
/** PUT 一个 JSON。 */
export const put = <T = unknown>(path: string, body: unknown) => call<T>("PUT", path, body);

/** 打开一段对话：给了 id 就打开它，fresh 新开一段，否则接着这个文件夹最近的学习对话；review 给出卡片路径时新开复习对话。 */
export const openSession = (body: { folder?: string; id?: string; fresh?: boolean; review?: string }) => post<SessionInfo>("/api/sessions", body);

/** 订阅一个 SSE 事件流。返回关掉它的函数。 */
export function listen<T>(path: string, onEvent: (event: T) => void, onState: (open: boolean, closed: boolean) => void): () => void {
  const source = new EventSource(path);
  source.onmessage = (message: MessageEvent<string>) => onEvent(JSON.parse(message.data) as T);
  source.onopen = () => onState(true, false);
  source.onerror = () => onState(false, source.readyState === EventSource.CLOSED);
  return () => source.close();
}

export type { SessionStatus };
