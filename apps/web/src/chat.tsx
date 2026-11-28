// 对话面板：顶部是所在的文件夹、模式和上下文用量，其余收在一个菜单里；中间是对话，底部是提问栏。
// 对话的事件经 SSE 推来，用后端同一个 applyEvent 更新；切走的对话在后端继续进行，切回来先收到一份快照。
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";

import { applyEvent, type Conversation, type UiEvent } from "@repa/protocol";

import { openTalk } from "./actions";
import { ApiError, get, listen, openSession, post, put, type ContextInfo, type SessionSummary, type Settings } from "./api";
import { SelectionAsk } from "./card";
import { Icon } from "./glyph";
import { Items } from "./items";
import { current, folderLabel, refresh, update, useApp, viewingFolder } from "./store";
import { t } from "./strings";
import { AutoText, IconButton, keyOf, Menu, MenuChoice, MenuItem, MenuSep, MenuToggle, Pop } from "./ui";

type Action = UiEvent | { type: "reset" };
const EMPTY: Conversation = { items: [], pending: [], running: false };
const reduce = (state: Conversation, action: Action) => (action.type === "reset" ? EMPTY : applyEvent(state, action));

/** 连着一段对话：先确认它在后端打开着（后端重启以后要重新打开），再订阅事件流；断开以后重连。 */
function useConversation(id: string | undefined, folder: string): Conversation {
  const [state, dispatch] = useReducer(reduce, EMPTY);
  useEffect(() => {
    dispatch({ type: "reset" });
    if (!id) return;
    let stop = () => {};
    let alive = true;
    const connect = () => {
      openSession({ folder, id }).then(() => {
        if (!alive) return;
        stop = listen<UiEvent>(`/api/sessions/${encodeURIComponent(id)}/events`, dispatch, (_open, closed) => {
          if (closed && alive) setTimeout(connect, 2000);
        });
      }, (error: unknown) => {
        // 这段对话已经不在了：接着这个文件夹最近的一段
        if (error instanceof ApiError && error.status === 404) void openTalk(folder);
        else if (alive) setTimeout(connect, 2000);
      });
    };
    connect();
    return () => { alive = false; stop(); };
  }, [id, folder]);
  return state;
}

function Context({ id, running, used }: { id: string; running: boolean; used: ContextInfo | undefined }) {
  const [note, setNote] = useState<string>();
  const percent = Math.round(used?.usage?.percent ?? 0);
  const compact = async () => {
    const result = await post<{ compacted: boolean; reason?: string }>(`/api/sessions/${encodeURIComponent(id)}/compact`);
    setNote(result.compacted ? t("chat.compacted") : t("chat.notCompacted", { reason: result.reason ?? "" }));
  };
  const block = (title: string, text: string) => text.trim() && <div><h3>{title}</h3><pre>{text}</pre></div>;
  return <Pop align="end" className="ctx-pop" onOpenChange={() => setNote(undefined)} trigger={<button type="button" className="ctx" aria-label={t("chat.context")} data-tip={t("chat.context")}><i style={{ "--used": `${percent}%` } as React.CSSProperties} />{percent}%</button>}>
    {used && <>
      <p className="pop-row num"><span>{used.usage?.tokens ?? "—"} / {used.usage?.contextWindow ?? "—"}</span>
        <button type="button" className="btn btn-line btn-s" disabled={running} onClick={() => void compact()}>{t("chat.compact")}</button></p>
      {note && <p className="pop-row">{note}</p>}
      {block(t("chat.agents"), used.agentsFiles.join("\n"))}
      {block(t("chat.mode"), used.mode)}
      {block(t("chat.map"), used.map)}
      {block(t("chat.reviewMap"), used.review)}
      {used.attachments.map((text, index) => <div key={index}>{block(t("chat.attachments"), text)}</div>)}
    </>}
  </Pop>;
}

function More({ folder, info }: { folder: string; info: Conversation["session"] }) {
  const { settings } = useApp();
  const [models, setModels] = useState<Array<{ provider: string; id: string; name: string }>>([]);
  const [past, setPast] = useState<SessionSummary[]>([]);
  const load = () => {
    void get<{ models: typeof models }>("/api/models").then((result) => setModels(result.models));
    void get<{ sessions: SessionSummary[] }>("/api/sessions", { folder }).then((result) => setPast(result.sessions));
  };
  const id = info?.id ?? "";
  const call = (what: string, body: unknown) => void post(`/api/sessions/${encodeURIComponent(id)}/${what}`, body);
  const set = (change: Partial<Settings>) => void put<Settings>("/api/settings", change).then((next) => update({ settings: next }));
  return <Menu trigger={<IconButton icon="ellipsis" label={t("chat.more")} onClick={load} />}>
    <MenuChoice label={t("chat.model")} items={models.map((item) => [`${item.provider}/${item.id}`, item.name])} value={info?.model}
      onChange={(value) => { const [provider = "", ...rest] = value.split("/"); call("model", { provider, id: rest.join("/") }); }} />
    {(info?.thinkingLevels?.length ?? 0) > 1 && <MenuChoice label={t("chat.thinking")} items={(info?.thinkingLevels ?? []).map((level) => [level, level])} value={info?.thinking} onChange={(level) => call("thinking", { level })} />}
    <MenuSep />
    <MenuToggle label={t("chat.confirmEdits")} checked={settings?.confirmEdits ?? false} onChange={(confirmEdits) => set({ confirmEdits })} />
    <MenuToggle label={t("chat.confirmCommands")} checked={settings?.confirmCommands ?? false} onChange={(confirmCommands) => set({ confirmCommands })} />
    <MenuSep />
    <MenuItem icon="message-square-plus" onClick={() => void openTalk(viewingFolder(current().route) ?? "", { fresh: true })}>{t("chat.new")}</MenuItem>
    {past.length > 0 && <p className="menu-label">{t("chat.history")}</p>}
    {past.slice(0, 12).map((item) => <MenuItem key={item.id} onClick={() => void openTalk(folder, { id: item.id })}>{item.title || t("chat.new")}</MenuItem>)}
  </Menu>;
}

function Composer({ id, running, card }: { id: string; running: boolean; card: string | undefined }) {
  const { quote, settings } = useApp();
  const [text, setText] = useState("");
  const [fault, setFault] = useState<string>();
  const send = () => {
    if (!text.trim()) return;
    const sent = { text, quote };
    setText("");
    setFault(undefined);
    update({ quote: undefined });
    // 发不出去时把字和引文放回去
    post(`/api/sessions/${encodeURIComponent(id)}/prompt`, { text: sent.text, ...(card ? { viewing: card } : {}), ...(sent.quote ? { quote: sent.quote } : {}) }).catch((error: unknown) => {
      setText(sent.text);
      update({ quote: sent.quote });
      setFault(t("chat.sendFailed", { error: error instanceof Error ? error.message : String(error) }));
    });
  };
  const stop = !text.trim() && running;
  return <div className="composer">
    {fault && <p className="fault">{fault}</p>}
    <div className="box">
      {quote && <div className="quote"><p>{quote}</p><IconButton icon="x" label={t("chat.dropQuote")} onClick={() => update({ quote: undefined })} /></div>}
      <AutoText placeholder={t("chat.ask")} aria-label={t("chat.ask")} value={text} onChange={(event) => setText(event.target.value)} enter={send} enterKey={keyOf(settings?.keys, "send")} />
      <div className="bar-row">
        <button type="button" className="send" data-on={text.trim() || stop ? "" : undefined} aria-label={t(stop ? "chat.stop" : "chat.send")} data-tip={t(stop ? "chat.stop" : "chat.send")}
          onClick={() => (stop ? void post(`/api/sessions/${encodeURIComponent(id)}/abort`) : send())}><Icon name={stop ? "square" : "arrow-up"} /></button>
      </div>
    </div>
  </div>;
}

/** 对话面板。alone 时是复习：对话独自居中，顶部写着复习的是哪一张。 */
export function Chat({ alone }: { alone: boolean }) {
  const { talk, route } = useApp();
  const conversation = useConversation(talk?.id, talk?.folder ?? "");
  const { session, items, pending, running } = conversation;
  const [used, setUsed] = useState<ContextInfo>();
  const [modes, setModes] = useState<string[]>([]);
  const log = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const viewing = viewingFolder(route);
  const folder = talk?.folder ?? "";
  // 还没有对话时：接着正在看的文件夹最近的一段，正在看今日或知识库时是知识库的根
  useEffect(() => {
    if (!talk) void openTalk(viewing ?? "");
  }, [talk, viewing]);
  // 一轮结束时，练习、卡片和今日都可能变了
  const ran = useRef(false);
  useEffect(() => {
    if (running) ran.current = true;
    else if (ran.current) refresh();
  }, [running]);
  useEffect(() => {
    if (talk && !running) void get<ContextInfo>(`/api/sessions/${encodeURIComponent(talk.id)}/context`).then(setUsed, () => undefined);
  }, [talk, running, items.length]);
  // 停在底部时跟着新内容往下走；往上翻看时不打扰
  useLayoutEffect(() => {
    if (pinned.current && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [items, pending]);
  if (!talk) return null;
  const root = t("nav.kb");
  const reviewName = talk.card ? talk.card.slice(talk.card.lastIndexOf("/") + 1).replace(/\.md$/u, "") : /复习「(.+)」/u.exec(items.find((item) => item.type === "user")?.text ?? "")?.[1];
  const mode = <Menu align="start" trigger={<button type="button" className="mode" onClick={() => void get<{ modes: string[] }>("/api/modes").then((result) => setModes(result.modes))}>{session?.mode}<Icon name="chevron-down" /></button>}>
    <MenuChoice items={modes.map((name) => [name, name])} value={session?.mode} onChange={(name) => void post(`/api/sessions/${encodeURIComponent(talk.id)}/mode`, { mode: name })} />
  </Menu>;
  const tools = <span className="tools"><Context id={talk.id} running={running} used={used} /><More folder={folder} info={session} />
    {!alone && <IconButton icon="panel-right" label={t("nav.chatClose")} expanded onClick={() => update({ chat: false })} />}</span>;
  const body = <>
    <header className="chat-head">
      {alone && reviewName ? <h1>{t("chat.reviewTitle")}<span className="nm">{reviewName}</span></h1> : null}
      <span className="where">{alone ? folderLabel(folder, root) : <b>{folderLabel(folder, root)}</b>}</span>
      {/* 复习过后回到一个文件夹，按钮接上那里原来的学习对话 */}
      {!alone && viewing !== undefined && (viewing !== folder || talk.kind === "review") && <button type="button" className="here" data-tip={t("chat.moveHere")} onClick={() => void openTalk(viewing)}><Icon name="folder" />{viewing.split("/").pop() || root}</button>}
      {mode}{tools}
    </header>
    <div className="log" ref={log} style={{ position: "relative" }} onScroll={(event) => { const box = event.currentTarget; pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40; }}>
      <Items items={items} pending={pending} running={running} folder={folder} review={talk.kind === "review"} />
      <SelectionAsk within={log} margin={false} />
    </div>
    <Composer id={talk.id} running={running} card={route.page === "card" ? route.path : undefined} />
  </>;
  return alone
    ? <section className="sheet" aria-label={t("today.review")}><div className="review">{body}</div></section>
    : <section className="sheet chat" aria-label={t("nav.talks")}>{body}</section>;
}
