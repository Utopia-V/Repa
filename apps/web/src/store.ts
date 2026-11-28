// 界面的状态：中间看什么（地址）、左栏与对话面板是否打开、当前的对话、引文、后端是否连着。
// 布局只由“中间看什么”和“对话是否打开”决定；开合与当前对话记在 localStorage，页面就是地址，可以后退前进。
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { get, listen, type CardSummary, type SessionStatus, type Settings, type Tree } from "./api";

/** 中间的一页。review 时中间没有内容，对话独自居中。 */
export type Route =
  | { page: "today" }
  | { page: "kb" }
  | { page: "folder"; path: string; agents?: boolean }
  | { page: "card"; path: string }
  | { page: "settings" }
  | { page: "review" };

/** 当前的对话。 */
export interface Talk {
  id: string;
  folder: string;
  kind: "learn" | "review";
  card?: string;
}

interface State {
  route: Route;
  side: boolean;
  chat: boolean;
  talk?: Talk;
  quote?: string;
  tick: number;
  offline: boolean;
  statuses: Record<string, SessionStatus>;
  settings?: Settings;
  tree?: Tree;
  cards?: CardSummary[];
  /** “再来几张”累计加的张数，带着所属的日子，换日以后不再算 */
  extra: { day: string; n: number };
  at: number;
  last: number;
}

const saved = <T,>(key: string, fallback: T): T => {
  const text = localStorage.getItem(`repa.${key}`);
  return text === null ? fallback : (JSON.parse(text) as T);
};
const remember = (key: string, value: unknown) => localStorage.setItem(`repa.${key}`, JSON.stringify(value));

const seg = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** 一页的地址。 */
export function hrefOf(route: Route): string {
  switch (route.page) {
    case "today": return "/";
    case "kb": return "/kb";
    case "settings": return "/settings";
    case "review": return "/review";
    case "folder": return `/f/${seg(route.path)}${route.agents ? "?agents" : ""}`;
    case "card": return `/c/${seg(route.path)}`;
  }
}

function parse(location: Location): Route {
  const path = location.pathname;
  const rest = (prefix: string) => path.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
  if (path === "/kb") return { page: "kb" };
  if (path === "/settings") return { page: "settings" };
  if (path === "/review") return { page: "review" };
  if (path === "/f" || path.startsWith("/f/")) return { page: "folder", path: path === "/f" ? "" : rest("/f/"), agents: location.search.includes("agents") };
  if (path.startsWith("/c/")) return { page: "card", path: rest("/c/") };
  return { page: "today" };
}

const savedTalk = saved<Talk | null>("talk", null);
// at 是这一页在浏览历史里的位置，last 是能前进到的最后一页，左上角的箭头据此可用或不可用。
const historyAt = (): number => (window.history.state as { at?: number } | null)?.at ?? 0;
let state: State = {
  route: parse(window.location),
  side: saved("side", true),
  chat: saved("chat", false),
  ...(savedTalk ? { talk: savedTalk } : {}),
  tick: 0,
  offline: false,
  statuses: {},
  extra: { day: "", n: 0 },
  at: historyAt(),
  last: historyAt(),
};
const listeners = new Set<() => void>();

/** 改状态；开合与当前对话同时记下。 */
export function update(change: Partial<State> | ((current: State) => Partial<State>)): void {
  const next = { ...state, ...(typeof change === "function" ? change(state) : change) };
  if (next.side !== state.side) remember("side", next.side);
  if (next.chat !== state.chat) remember("chat", next.chat);
  if (next.talk !== state.talk) remember("talk", next.talk ?? null);
  state = next;
  for (const listener of listeners) listener();
}

/** 取状态，状态变了重新渲染。 */
export function useApp(): State {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => state);
}

/** 现在的状态，供事件处理里读。 */
export const current = () => state;

/** 换中间的一页，记进浏览历史。 */
export function go(route: Route): void {
  if (hrefOf(route) === hrefOf(state.route)) return;
  const at = state.at + 1;
  window.history.pushState({ at }, "", hrefOf(route));
  update({ route, at, last: at });
}
window.addEventListener("popstate", () => update({ route: parse(window.location), at: historyAt() }));

/** 正在看的文件夹：文件夹页或卡片所在的；今日、知识库与设置没有。 */
export function viewingFolder(route: Route): string | undefined {
  if (route.page === "folder") return route.path;
  if (route.page === "card") return route.path.includes("/") ? route.path.slice(0, route.path.lastIndexOf("/")) : "";
  return undefined;
}

/** 文件夹的显示名：根是“知识库”，其余以“ / ”分隔。 */
export const folderLabel = (folder: string, root: string) => (folder ? folder.split("/").join(" / ") : root);

/** 取一个接口的数据；窗口重新获得焦点、后端重连以后，或 deps 变了，重新取一次。 */
export function useData<T>(load: () => Promise<T>, deps: unknown[]): { data?: T; error?: string; reload: () => void } {
  const { tick } = useApp();
  const [result, setResult] = useState<{ data?: T; error?: string; key?: string }>({});
  const [own, setOwn] = useState(0);
  // 换了一张卡片、一个文件夹以后，不再显示上一张的内容；只是重新读取时照旧显示，免得闪一下
  const key = JSON.stringify(deps);
  useEffect(() => {
    let live = true;
    load().then((data) => live && setResult({ data, key }), (error: unknown) => live && setResult((before) => ({ ...(before.key === key ? before : {}), key, error: error instanceof Error ? error.message : String(error) })));
    return () => { live = false; };
  }, [...deps, tick, own]);
  const reload = useCallback(() => setOwn((value) => value + 1), []);
  return result.key === key ? { ...result, reload } : { reload };
}

/** 今天的日子，凌晨 4 点换日，与复习的计算一致。 */
export function dayKey(now = new Date()): string {
  const day = new Date(now.getTime() - 4 * 3600 * 1000);
  return `${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`;
}

/** 今天“再来几张”累计加的张数。 */
export const extraToday = () => (state.extra.day === dayKey() ? state.extra.n : 0);

/** “再来几张”。 */
export const addExtra = (n: number) => update({ extra: { day: dayKey(), n: extraToday() + n } });

/** 让所有页面重新取数据；知识库的树和全部卡片放在这里，左栏、今日、知识库和链接共用。 */
export function refresh(): void {
  update((current) => ({ tick: current.tick + 1 }));
  void Promise.all([get<Tree>("/api/tree"), get<{ cards: CardSummary[] }>("/api/cards")]).then(([tree, { cards }]) => update({ tree, cards }));
}

/** 启动时：读设置，连上全局的状态事件流（左栏的点靠它，断开时显示状态并自动重连），窗口重新获得焦点时刷新。 */
export function start(): void {
  void get<Settings>("/api/settings").then((settings) => update({ settings }));
  let stop = () => {};
  const connect = () => {
    stop = listen<SessionStatus>("/api/events", (status) => update((current) => ({ statuses: { ...current.statuses, [status.id]: status } })), (open, closed) => {
      if (open && state.offline) {
        update({ offline: false, statuses: {} });
        refresh();
      }
      if (!open) update({ offline: true });
      if (closed) setTimeout(() => { stop(); connect(); }, 2000);
    });
  };
  connect();
  refresh();
  window.addEventListener("focus", refresh);
}
