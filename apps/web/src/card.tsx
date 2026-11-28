// 卡片页：标题、概括、一行属性，渲染后的正文，练习记录；右缘的贴纸拉出成可以挪动、可以拉大拉小的便签。
// 点铅笔，正文原地换成 Markdown 原文；没保存就离开，草稿留在本机，回来还在。
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { mmdd, useLinks } from "./actions";
import { ApiError, get, post, put, type CardDetail, type Practice } from "./api";
import { Glyph, Icon, stoneOf } from "./glyph";
import { Markdown } from "./markdown";
import { addMark, findMarks, MarksList, removeMark, setNote, type Mark } from "./marks";
import { go, refresh, update, useApp, useData } from "./store";
import { t } from "./strings";
import { AutoText, IconButton, Pop } from "./ui";

const FRONT_MATTER = /^---\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/u;
const headOf = (text: string) => FRONT_MATTER.exec(text)?.[0] ?? "";

/** 正在编辑的草稿：文字，以及开始编辑时的文件头和修改时间。三者一起存在本机，保存时拿它们去核对，不随卡片重新读取而变。 */
interface Draft {
  text: string;
  head: string;
  mtime: number | undefined;
}

/**
 * 编辑一份 Markdown：编辑的是文件头以下的原文，保存时接回开始编辑时的文件头，带开始编辑时的修改时间；
 * 文件在这之后被别处或 Agent 改过，先给出最新内容，不悄悄覆盖。plain 的文件（AGENTS.md）没有文件头。
 */
export function Editor({ path, title, text, body, mtime, folder, onSaved, empty, marks = false, plain = false, children }: {
  path: string; title: ReactNode; text: string; body: string; mtime: number | undefined; folder: string; onSaved: () => void; empty?: string; marks?: boolean; plain?: boolean; children?: ReactNode;
}) {
  const key = `repa.draft.${path}`;
  const [draft, setDraft] = useState<Draft | null>(() => JSON.parse(localStorage.getItem(key) ?? "null") as Draft | null);
  const [latest, setLatest] = useState<string>();
  const links = useLinks(folder);
  const change = (value: Draft | null) => {
    setDraft(value);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  };
  // 文件头和它下面的空行不放进文本框，保存时原样接回
  const start = () => {
    const own = body.replace(/^(\r?\n)*/u, "");
    change({ text: own, head: text.slice(0, text.length - own.length), mtime });
  };
  const save = async () => {
    if (draft === null) return;
    try {
      await put("/api/card", { path, text: draft.head + draft.text, ...(draft.mtime === undefined ? {} : { mtime: draft.mtime }) });
      change(null);
      setLatest(undefined);
      refresh();
      onSaved();
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409 || error.details?.text === undefined) throw error;
      // 再点“完成”就以你的文字覆盖：文件头和修改时间换成最新的
      const head = plain ? "" : headOf(error.details.text);
      setLatest(error.details.text.slice(head.length));
      change({ ...draft, head, mtime: error.details.mtime });
    }
  };
  return <>
    <div className="title-row"><h1>{title}</h1>{draft === null
      ? <IconButton icon="pencil" label={t("card.edit")} onClick={start} />
      : <span className="edit-acts">
        <button type="button" className="btn btn-solid btn-s" onClick={() => void save()}>{t("card.done")}</button>
        <button type="button" className="btn btn-text" onClick={() => { change(null); setLatest(undefined); }}>{t("card.cancel")}</button>
      </span>}</div>
    {children}
    {latest !== undefined && <div className="notice" role="alert">{t("card.conflict")}<pre>{latest}</pre></div>}
    {draft === null
      ? (body.trim() ? <Markdown className="md" text={body} links={links} marks={marks} /> : empty && <p className="md sum">{empty}</p>)
      : <AutoText className="raw" aria-label={path} value={draft.text} autoFocus onChange={(event) => change({ ...draft, text: event.target.value })} />}
  </>;
}

/** 选中的一段话：只取第一块（段落、列表项、表格的格、标题、引用）里的部分；index 是它在这一块里同样文字中的第几处，rendered 是一共几处，block 是这一块在原文里的起止位置。 */
export interface Pick {
  text: string;
  index: number;
  rendered: number;
  block: [number, number];
}

// 链接、代码、公式、勾画、上标和图片里的字不算：原文那边同样遮住了它们，两边按同样的规矩数
const HIDDEN = "a, code, pre, .katex, mark, sup, img";
const visible = (part: Node) => {
  const copy = part.cloneNode(true) as Element | DocumentFragment;
  copy.querySelectorAll(HIDDEN).forEach((node) => node.remove());
  return copy.textContent ?? "";
};

/** 把选区换成勾画要的东西；选区不在正文的一块里、或者起止落在链接、代码这些地方时返回 undefined。 */
export function pickOf(range: Range, box: HTMLElement): Pick | undefined {
  const at = (node: Node) => (node instanceof Element ? node : node.parentElement);
  const block = at(range.startContainer)?.closest("[data-start]");
  if (!block || !box.contains(block) || !block.closest(".md") || at(range.startContainer)?.closest(HIDDEN)) return undefined;
  // 跨了块只取第一块；终点落在链接、代码这些地方也不勾
  const own = range.cloneRange();
  if (!block.contains(range.endContainer)) own.setEnd(block, block.childNodes.length);
  else if (at(range.endContainer)?.closest(HIDDEN)) return undefined;
  const text = own.toString().trim();
  if (!text) return undefined;
  const before = document.createRange();
  before.setStart(block, 0);
  before.setEnd(own.startContainer, own.startOffset);
  const offset = visible(before.cloneContents()).length + (own.toString().length - own.toString().trimStart().length);
  const all = visible(block);
  let index = 0;
  let rendered = 0;
  for (let found = all.indexOf(text); found >= 0; found = all.indexOf(text, found + 1)) {
    rendered += 1;
    if (found < offset) index += 1;
  }
  return { text, index, rendered, block: [Number(block.getAttribute("data-start")), Number(block.getAttribute("data-end"))] };
}

/**
 * 在正文或回复里选中一段话，旁边浮出“就此提问”；点了这段话成为引文，对话面板关着就打开。margin 为真时按钮放在左边的页边里。
 * 给了 onMark 时另有“勾画”，只在选区对得回原文时出现。
 */
export function SelectionAsk({ within, margin, onMark }: { within: RefObject<HTMLElement | null>; margin: boolean; onMark?: (pick: Pick) => (() => void) | undefined }) {
  const [at, setAt] = useState<{ top: number; left: number; text: string; mark?: () => void }>();
  useEffect(() => {
    const onUp = () => setTimeout(() => {
      const selection = window.getSelection();
      const box = within.current;
      const text = selection?.toString().trim() ?? "";
      if (!selection || !box || !text || !selection.rangeCount || !box.contains(selection.anchorNode)) return setAt(undefined);
      const range = selection.getRangeAt(0);
      const rects = range.getClientRects();
      const first = rects[0];
      const last = rects[rects.length - 1];
      const outer = box.getBoundingClientRect();
      if (!first || !last) return;
      const pick = onMark && pickOf(range, box);
      const mark = pick ? onMark(pick) : undefined;
      setAt(margin
        ? { top: first.top - outer.top + first.height / 2 - 18, left: -46, text, ...(mark ? { mark } : {}) }
        : { top: last.bottom - outer.top + box.scrollTop + 4, left: Math.min(last.right - outer.left, outer.width - 40), text });
    });
    document.addEventListener("mouseup", onUp);
    document.addEventListener("keyup", onUp);
    return () => {
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("keyup", onUp);
    };
  }, [within, margin, onMark]);
  if (!at) return null;
  const done = () => {
    window.getSelection()?.removeAllRanges();
    setAt(undefined);
  };
  return <div className="float" style={{ top: at.top, left: at.left }} onMouseUp={(event) => event.stopPropagation()}>
    <IconButton icon="message-square-quote" label={t("card.ask")} onClick={() => { update({ quote: at.text, chat: true }); done(); }} />
    {at.mark && <IconButton icon="highlighter" label={t("card.mark")} onClick={() => { at.mark?.(); done(); }} />}
  </div>;
}

// ── 便签 ────────────────────────────────────────────

type NoteId = "memo" | "errs" | "links" | "marks";
const TILT: Record<NoteId, string> = { memo: "-.5deg", errs: ".4deg", links: "-.3deg", marks: ".3deg" };
type Box = { left: number; top: number; width: number; height?: number };
// 拉出的便签和挪过、拉过的位置与大小只在这次打开应用期间记住
const opened = new Set<NoteId>();
const placed = new Map<NoteId, Box>();
const EDGES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

/** 一张便签：顶部的把手拖动，四边四角拉大拉小，右上角的小叉收回。盖住正文没关系，挪开就是。 */
function Note({ id, title, onClose, page, children }: { id: NoteId; title: string; onClose: () => void; page: RefObject<HTMLElement | null>; children: ReactNode }) {
  const [, redraw] = useState(0);
  const self = useRef<HTMLElement>(null);
  const place = placed.get(id);
  // edges 为空是挪动；位置相对卡片页，第一次动它时从它现在的位置和大小算起
  const drag = (event: React.PointerEvent, edges: string) => {
    const box = self.current?.getBoundingClientRect();
    const outer = page.current?.getBoundingClientRect();
    if (!box || !outer) return;
    event.preventDefault();
    const from = { left: box.left - outer.left, top: box.top - outer.top, width: box.width, height: box.height };
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => {
      const dx = next.clientX - event.clientX;
      const dy = next.clientY - event.clientY;
      const to: Box = { ...from };
      if (!edges) Object.assign(to, { left: from.left + dx, top: from.top + dy, height: place?.height });
      if (edges.includes("e")) to.width = Math.max(200, from.width + dx);
      if (edges.includes("w")) Object.assign(to, { width: Math.max(200, from.width - dx), left: from.left + Math.min(dx, from.width - 200) });
      if (edges.includes("s")) to.height = Math.max(80, from.height + dy);
      if (edges.includes("n")) Object.assign(to, { height: Math.max(80, from.height - dy), top: from.top + Math.min(dy, from.height - 80) });
      placed.set(id, to);
      redraw((value) => value + 1);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };
  const style = { "--tilt": TILT[id], ...(place ?? { position: "relative" }) } as unknown as React.CSSProperties;
  return <section ref={self} className="note" style={style} aria-label={title} onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
    <span className="grip" aria-hidden="true" onPointerDown={(event) => drag(event, "")} />
    {EDGES.map((edge) => <span key={edge} className="rz" data-e={edge} aria-hidden="true" onPointerDown={(event) => drag(event, edge)} />)}
    <IconButton icon="x" label={t("card.close")} className="note-x" onClick={onClose} />
    <h2>{title}</h2>
    {children}
  </section>;
}

const lostOf = (practice: Practice) => practice.result === "fail" || practice.result === "partial";

/** 勾画便签要的东西：全部勾画、正在写批注的是哪一处，以及改写原文的几个动作。 */
interface MarkTools {
  marks: Mark[];
  editing: number | undefined;
  onHot: (index: number | undefined) => void;
  onEdit: (index: number | undefined) => void;
  onNote: (mark: Mark, note: string) => void;
  onRemove: (mark: Mark) => void;
}

function Notes({ card, page, tools }: { card: CardDetail; page: RefObject<HTMLElement | null>; tools: MarkTools }) {
  const { cards = [] } = useApp();
  const [, redraw] = useState(0);
  const toggle = (id: NoteId) => {
    if (opened.has(id)) opened.delete(id);
    else opened.add(id);
    redraw((value) => value + 1);
  };
  // 刚勾画完，勾画便签拉出来，好接着写批注
  if (tools.editing !== undefined) opened.add("marks");
  const errs = card.practices.filter(lostOf);
  const next = card.review ?? card.nextDue;
  const tabs: Array<[NoteId, ReactNode, string, string]> = [];
  if (card.keep) tabs.push(["memo", <Glyph key="g" stone={stoneOf(card)} size={16} />, mmdd(next), t("card.memo")]);
  if (errs.length) tabs.push(["errs", <Icon key="i" name="list-x" />, String(errs.length), t("card.errors")]);
  tabs.push(["links", <Icon key="i" name="link-2" />, String(card.backlinks.length), t("card.backlinks")]);
  if (tools.marks.length) tabs.push(["marks", <Icon key="i" name="highlighter" />, String(tools.marks.length), t("marks.title")]);
  const body: Record<NoteId, ReactNode> = {
    memo: <div className="memory"><Glyph stone={stoneOf(card)} size={64} half />
      <dl className="num"><dt>{t("card.lastLabel")}</dt><dd>{mmdd(card.lastPracticed) || "—"}</dd><dt>{t("card.nextLabel")}</dt><dd>{mmdd(next) || "—"}</dd></dl></div>,
    errs: <ul className="errs">{errs.map((item) => <li key={item.id}><i className="bar" data-v={item.result} /><div><time>{mmdd(item.t)}</time><p>{item.note}</p></div></li>)}</ul>,
    links: <ul className="blinks">{card.backlinks.map((link) => {
      const other = cards.find((item) => item.path === link.path);
      return <li key={link.path}><a href={`/c/${link.path}`} onClick={(event) => { event.preventDefault(); go({ page: "card", path: link.path }); }}>{other && <Glyph stone={stoneOf(other)} size={16} />}{link.title}</a></li>;
    })}</ul>,
    marks: <MarksList {...tools} />,
  };
  const shown = tabs.filter(([id]) => opened.has(id));
  const note = ([id, , , title]: (typeof tabs)[number]) => <Note key={id} id={id} title={title} page={page} onClose={() => toggle(id)}>{body[id]}</Note>;
  return <>
    <div className="tabs">{tabs.map(([id, icon, value, title]) => <button key={id} type="button" className="tab" aria-expanded={opened.has(id)} aria-label={title} data-tip={title} onClick={() => toggle(id)}>{icon}<span className="num">{value}</span></button>)}</div>
    <div className="notes">{shown.filter(([id]) => !placed.has(id)).map(note)}</div>
    {shown.filter(([id]) => placed.has(id)).map(note)}
  </>;
}

// ── 属性与练习 ─────────────────────────────────────

function Props({ card, onChange }: { card: CardDetail; onChange: () => void }) {
  const [dating, setDating] = useState(false);
  const meta = async (change: { keep?: boolean; review?: string | null }) => {
    await post("/api/card/meta", { path: card.path, ...change });
    refresh();
    onChange();
  };
  const date = card.review ?? card.nextDue;
  const commit = (value: string) => {
    setDating(false);
    if (value && value !== card.review) void meta({ review: value });
  };
  return <p className="props num">
    <a href="#" className="prop only" data-tip={card.keep ? t("card.keep") : t("card.keepOff")} aria-label={card.keep ? t("card.keep") : t("card.keepOff")}
      onClick={(event) => { event.preventDefault(); void meta({ keep: !card.keep }); }}>
      <Glyph stone={card.keep ? stoneOf(card) : { k: "off" }} size={18} />
    </a>
    {card.requires.map((link) => <a key={link.target} href="#" className="prop" data-tip={t("card.requires")} onClick={(event) => { event.preventDefault(); if (link.path) go({ page: "card", path: link.path }); }}>
      <Icon name="corner-left-up" /><b className={link.path ? undefined : "broken"}>{link.target}</b>
    </a>)}
    {(date || card.keep) && <Pop open={dating} onOpenChange={setDating} trigger={<a href="#" className="prop" data-tip={card.review ? t("card.setDate") : t("card.next")} onClick={(event) => event.preventDefault()}><Icon name="calendar-clock" /><b>{mmdd(date) || "—"}</b></a>}>
      {/* 键盘逐段输入时每成一个合法的日期就有一次 change，所以只在回车或离开输入框时写入 */}
      <label className="pop-row"><span>{t("card.setDate")}</span><input type="date" className="date-in" defaultValue={card.review ?? ""} onBlur={(event) => commit(event.currentTarget.value)}
        onKeyDown={(event) => { if (event.key === "Enter") commit(event.currentTarget.value); }} /></label>
      {card.review && <button type="button" className="btn btn-text" onClick={() => { setDating(false); void meta({ review: null }); }}>{t("card.clearDate")}</button>}
    </Pop>}
  </p>;
}

function Practices({ practices }: { practices: Practice[] }) {
  if (!practices.length) return null;
  return <>
    <h2 className="sub">{t("card.practice")}</h2>
    <ul className="done">{practices.map((item) => <li key={item.id}><details>
      <summary><i className="bar" data-v={item.result} aria-label={item.result ? t(`quiz.${item.result}`) : undefined} /><span>{item.questions.map((question) => question.text).join(" / ") || item.note}</span><time>{mmdd(item.t)}</time></summary>
      {item.questions.map((question, index) => <p key={index} className="said">{question.text}<br />→ {item.answers ? item.answers[index] || "—" : t("card.noAnswer")}</p>)}
      {item.note && <p className="said">{item.result && <b>{t(`quiz.${item.result}`)}　</b>}{item.note}</p>}
      {item.external && <pre className="act-out">{item.external}</pre>}
    </details></li>)}</ul>
  </>;
}

/** 一张卡片。 */
export function CardPage({ path }: { path: string }) {
  const { data, error, reload } = useData(() => get<CardDetail>("/api/card", { path }), [path]);
  const page = useRef<HTMLElement>(null);
  const article = useRef<HTMLElement>(null);
  const [hot, setHot] = useState<number>();
  const [editing, setEditing] = useState<number>();
  // 停在勾画便签的一条上时，正文里那句话加深
  useEffect(() => {
    article.current?.querySelectorAll("mark.hl").forEach((mark, index) => mark.classList.toggle("hot", index === hot));
  }, [hot, data]);
  const head = data ? data.text.slice(0, data.text.length - data.body.length) : "";
  // 改写原文都带着打开时的修改时间；文件已被别处改过就不写，重新读一遍
  const [fault, setFault] = useState<string>();
  const write = useCallback(async (body: string) => {
    if (!data) return;
    setFault(undefined);
    await put("/api/card", { path, text: head + body, mtime: data.mtime })
      .catch((error: unknown) => setFault(t("card.markFailed", { error: error instanceof Error ? error.message : String(error) })));
    refresh();
    reload();
  }, [data, head, path, reload]);
  const onMark = useCallback((pick: Pick) => {
    const next = data && addMark(data.body, pick.text, pick.index, pick.rendered, pick.block);
    if (!next) return undefined;
    return () => {
      setEditing(findMarks(next.body).findIndex((mark) => mark.start === next.start));
      void write(next.body);
    };
  }, [data, write]);
  if (error && !data) return <main className="cardpage"><p className="fault">{error}</p></main>;
  if (!data) return null;
  const marks = findMarks(data.body);
  const tools: MarkTools = {
    marks, editing, onHot: setHot, onEdit: setEditing,
    onNote: (mark, note) => { setEditing(undefined); if (note.trim() !== (mark.note ?? "")) void write(setNote(data.body, mark, note)); },
    onRemove: (mark) => void write(removeMark(data.body, mark)),
  };
  return <main className="cardpage" ref={page}>
    <Notes card={data} page={page} tools={tools} />
    <div className="card-grid">
      <article ref={article}>
        <header className="card-head">
          <Editor key={path} path={path} title={<>{data.title}{data.moc && <span className="tag">{t("kb.moc")}</span>}</>} text={data.text} body={data.body} mtime={data.mtime} folder={data.folder} onSaved={reload} marks>
            {data.summary && <p className="sum">{data.summary}</p>}
            {!data.moc && <Props card={data} onChange={reload} />}
            {data.error && <p className="fault">{t("card.headError", { error: data.error })}</p>}
          </Editor>
        </header>
        {fault && <p className="fault" role="alert">{fault}</p>}
        <SelectionAsk within={article} margin onMark={onMark} />
        <Practices practices={data.practices} />
        <p className="card-foot"><code>{data.path}</code></p>
      </article>
    </div>
  </main>;
}
