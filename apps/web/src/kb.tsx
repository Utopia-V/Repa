// 知识库与文件夹页：同一张表。知识库顶上是筛选框和每个顶层文件夹一小片石头；文件夹页是按这个文件夹筛过的表，下面列出资料。
import { useEffect, useRef, useState } from "react";

import { mmdd, newCard } from "./actions";
import { get, type CardSummary, type FolderInfo } from "./api";
import { Editor } from "./card";
import { Glyph, Icon, stoneOf } from "./glyph";
import { Graph } from "./graph";
import { folderLabel, go, useApp, useData } from "./store";
import { t } from "./strings";
import { comboOf, IconButton, keyOf } from "./ui";
import { Pebbles } from "./today";

type Column = "memory" | "name" | "folder" | "last";
type Show = "all" | "kept" | "due";

const SORTS: Record<Column, (a: CardSummary, b: CardSummary) => number> = {
  memory: (a, b) => (a.memory ?? (a.keep ? 2 : 3)) - (b.memory ?? (b.keep ? 2 : 3)),
  name: (a, b) => a.title.localeCompare(b.title, "zh-CN", { numeric: true }),
  folder: (a, b) => a.folder.localeCompare(b.folder, "zh-CN", { numeric: true }),
  last: (a, b) => (a.lastPracticed ?? "").localeCompare(b.lastPracticed ?? ""),
};

function Filters({ cards, show, onShow, children }: { cards: CardSummary[]; show: Show; onShow: (show: Show) => void; children?: React.ReactNode }) {
  const plain = cards.filter((card) => !card.moc);
  const counts: Record<Show, number> = { all: plain.length, kept: plain.filter((card) => card.keep).length, due: plain.filter((card) => card.due).length };
  return <nav className="filters num" aria-label={t("kb.filter")}>
    {(["all", "kept", "due"] as const).map((key) => <button key={key} type="button" aria-pressed={show === key} onClick={() => onShow(key)}>
      {t(key === "all" ? "kb.all" : key === "kept" ? "kb.kept" : "kb.dueOnly")}<span className="n">{counts[key]}</span>
    </button>)}
    {children}
  </nav>;
}

/** 卡片的表。点表头排序，默认按上次练习从近到远。 */
function Table({ cards, withFolder }: { cards: CardSummary[]; withFolder: boolean }) {
  const [sort, setSort] = useState<{ by: Column; down: boolean }>({ by: "last", down: true });
  const rows = [...cards].sort((a, b) => (sort.down ? -1 : 1) * SORTS[sort.by](a, b));
  const head = (by: Column, label: string, right = false) => <th aria-sort={sort.by === by ? (sort.down ? "descending" : "ascending") : undefined} className={right ? "r" : undefined}>
    <button type="button" className="sort" onClick={() => setSort({ by, down: sort.by === by ? !sort.down : by === "last" })}>
      {label}<Icon name={sort.by !== by ? "chevrons-up-down" : sort.down ? "arrow-down" : "arrow-up"} />
    </button>
  </th>;
  return <table className="dict">
    <colgroup><col style={{ width: 72 }} /><col style={{ width: 200 }} /><col />{withFolder && <col style={{ width: 150 }} />}<col style={{ width: 96 }} /></colgroup>
    <thead><tr>{head("memory", t("kb.memory"))}{head("name", t("kb.name"))}<th className="plain">{t("kb.summary")}</th>{withFolder && head("folder", t("kb.folder"))}{head("last", t("kb.last"), true)}</tr></thead>
    <tbody>{rows.map((card) => <tr key={card.path} onClick={() => go({ page: "card", path: card.path })}>
      <td>{!card.moc && <Glyph stone={stoneOf(card)} size={22} />}</td>
      <td className="nm"><a href={`/c/${card.path}`} onClick={(event) => event.preventDefault()}>{card.title}</a>{card.moc && <span className="tag">{t("kb.moc")}</span>}</td>
      <td>{card.summary}</td>
      {withFolder && <td>{folderLabel(card.folder, t("nav.kb"))}</td>}
      <td>{mmdd(card.lastPracticed) || "—"}</td>
    </tr>)}</tbody>
  </table>;
}

const pick = (cards: CardSummary[], show: Show) => cards.filter((card) => show === "all" || (!card.moc && (show === "kept" ? card.keep : card.due)));

/** 知识库：筛选框按 / 聚焦，边打边按标题与概括筛。 */
export function KbPage() {
  const { cards = [], settings } = useApp();
  const [query, setQuery] = useState("");
  const [show, setShow] = useState<Show>("all");
  const [top, setTop] = useState<string>();
  const [view, setView] = useState(() => localStorage.getItem("repa.view") ?? "table");
  const pickView = (next: string) => {
    localStorage.setItem("repa.view", next);
    setView(next);
  };
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && event.target.closest("input, textarea, [contenteditable]");
      if (typing || comboOf(event) !== keyOf(settings?.keys, "filter")) return;
      event.preventDefault();
      search.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settings]);
  const tops = [...new Set(cards.map((card) => card.folder.split("/")[0] ?? ""))].sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
  const inTop = top === undefined ? cards : cards.filter((card) => (card.folder.split("/")[0] ?? "") === top);
  const words = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const found = inTop.filter((card) => words.every((word) => `${card.title} ${card.summary}`.toLowerCase().includes(word)));
  return <main className="kb"><h1 className="sr">{t("nav.kb")}</h1>
    <div className="search"><Icon name="search" /><input ref={search} aria-label={t("kb.filter")} value={query} onChange={(event) => setQuery(event.target.value)} /><kbd>{keyOf(settings?.keys, "filter")}</kbd></div>
    <Filters cards={found} show={show} onShow={setShow}>
      <span className="views" role="group" aria-label={t("kb.views")}>
        {(["table", "graph"] as const).map((key) => <button key={key} type="button" className="ibtn" aria-pressed={view === key} aria-label={t(key === "table" ? "kb.table" : "kb.graphView")} data-tip={t(key === "table" ? "kb.table" : "kb.graphView")} onClick={() => pickView(key)}>
          <Icon name={key === "table" ? "list" : "waypoints"} />
        </button>)}
      </span>
    </Filters>
    {view === "graph" ? <Graph cards={cards} shown={new Set(pick(found, show).map((card) => card.path))} /> : <>
    <div className="strip">{tops.map((name) => {
      const own = cards.filter((card) => (card.folder.split("/")[0] ?? "") === name && !card.moc);
      return <button key={name} type="button" className="chip" aria-pressed={top === name} onClick={() => setTop(top === name ? undefined : name)}>
        <span className="chip-name"><b>{name || t("nav.kb")}</b><span>{own.length}</span></span>
        <Pebbles cards={own} size={12} cols={Math.max(1, Math.ceil(own.length / 3))} />
      </button>;
    })}</div>
    <Table cards={pick(found, show)} withFolder />
    </>}
  </main>;
}

function NameInput({ onDone }: { onDone: (name: string | undefined) => void }) {
  const [name, setName] = useState("");
  return <input className="name-in" autoFocus aria-label={t("kb.cardName")} placeholder={t("kb.cardName")} value={name} onChange={(event) => setName(event.target.value)} onBlur={() => onDone(undefined)}
    onKeyDown={(event) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Enter") onDone(name.trim() || undefined);
      if (event.key === "Escape") onDone(undefined);
    }} />;
}

/** 文件夹页：文件夹名、对这个文件夹的要求、新建卡片，表的下面列出资料。agents 为真时中间是这个文件夹的 AGENTS.md。 */
export function FolderPage({ path, agents }: { path: string; agents: boolean }) {
  const { cards = [] } = useApp();
  const [show, setShow] = useState<Show>("all");
  const [naming, setNaming] = useState(false);
  const { data, reload } = useData(() => get<FolderInfo>("/api/folder", { path }), [path]);
  const parts = path.split("/");
  const name = parts.pop() || t("nav.kb");
  const own = cards.filter((card) => card.folder === path || card.folder.startsWith(`${path}/`) || path === "");
  const crumb = parts.length ? `${parts.join(" / ")} /` : "";
  if (agents) {
    return <main className="cardpage"><div className="card-grid"><article>
      <header className="card-head"><p className="sum">{folderLabel(path, t("nav.kb"))}</p></header>
      {data && <Editor key={path} path={`${path ? `${path}/` : ""}AGENTS.md`} title="AGENTS.md" text={data.agents?.text ?? ""} body={data.agents?.text ?? ""} mtime={data.agents?.mtime} folder={path} onSaved={reload} empty={t("card.agentsEmpty")} plain />}
    </article></div></main>;
  }
  return <main className="kb folder">
    <div className="folder-head">
      <h1>{crumb && <span className="crumb">{crumb}</span>}{name}</h1>
      <IconButton icon="scroll-text" label={t("kb.rules")} onClick={() => go({ page: "folder", path, agents: true })} />
      {naming
        ? <NameInput onDone={(title) => { setNaming(false); if (title) void newCard(path, title); }} />
        : <IconButton icon="file-plus" label={t("kb.newCard")} onClick={() => setNaming(true)} />}
    </div>
    <Filters cards={own} show={show} onShow={setShow} />
    <Table cards={pick(own, show)} withFolder={false} />
    {data && data.materials.length > 0 && <ul className="mats" aria-label={t("kb.materials")}>
      {data.materials.map((item) => <li key={item.path}><Icon name={item.kind === "file" ? "file-text" : "folder"} />{item.path.slice(item.path.lastIndexOf("/") + 1)}</li>)}
    </ul>}
  </main>;
}
