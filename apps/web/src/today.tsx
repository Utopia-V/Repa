// 今日：领头的一张建议、“到期”与“未答对”两组；右侧一栏是按顶层文件夹排开的石头和一个月历。
// 点一行就开始复习那张卡片，这一页不摊开任何卡片的正文。
import { useState } from "react";

import { mmdd, openTalk, startReview } from "./actions";
import { get, post, type CardSummary, type Today } from "./api";
import { Glyph, Icon, stoneOf, type Stone } from "./glyph";
import { addExtra, extraToday, folderLabel, go, refresh, useApp, useData } from "./store";
import { t } from "./strings";
import { IconButton } from "./ui";

/** 右侧一栏的次序：月历在上、石头在下（维护者看过第六轮画稿后定下）；调换只改这一行。 */
const RAIL: Array<"stones" | "calendar"> = ["calendar", "stones"];
/** 点“再来几张”一次多给的张数。 */
const MORE = 5;

const lateOf = (card: CardSummary & { manual?: boolean }) => {
  if (card.manual && card.review) return t("today.manual", { date: mmdd(card.review) });
  if (card.memory === undefined) return t("today.fresh");
  return card.overdueDays ? t("today.overdue", { n: card.overdueDays }) : t("today.dueToday");
};
const tipOf = (card: CardSummary) => (card.lastPracticed ? t("today.tipLast", { state: lateOf(card), date: mmdd(card.lastPracticed) }) : lateOf(card));
const topOf = (folder: string) => folder.split("/")[0] ?? "";
const pad = (n: number) => String(n).padStart(2, "0");
// 按本地日历写日期；toISOString 是 UTC，东八区的零点会落到前一天。
const ymd = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const rank = (stone: Stone) => (stone.k === "kept" ? stone.m : 2);

function Row({ card }: { card: CardSummary }) {
  return <li><a href="#" data-tip={tipOf(card)} onClick={(event) => { event.preventDefault(); void startReview(card.path); }}>
    <span className="gl"><Glyph stone={stoneOf(card)} size={22} label={tipOf(card)} /></span>
    <span className="nm">{card.title}</span>
    <span className="ly">{folderLabel(card.folder, t("nav.kb"))}</span>
  </a></li>;
}

/** 一片小石头：每张卡片一颗，按记得多少从少到多排。 */
export function Pebbles({ cards, size, cols, lead }: { cards: CardSummary[]; size: number; cols: number; lead?: string }) {
  const sorted = cards.map((card) => ({ card, stone: stoneOf(card) })).sort((a, b) => rank(a.stone) - rank(b.stone) || (a.stone.k === "loose" ? 1 : 0) - (b.stone.k === "loose" ? 1 : 0));
  return <span className="pebbles" style={{ "--cols": cols, "--pb": `${size}px` } as React.CSSProperties}>
    {sorted.map(({ card, stone }) => <span key={card.path} className="pb" data-cur={card.path === lead ? "" : undefined}><Glyph stone={stone} size={size} label={card.title} /></span>)}
  </span>;
}

function Calendar() {
  const [month, setMonth] = useState<string>();
  const [day, setDay] = useState<string>();
  const { data } = useData(async () => {
    const base = await get<{ month: string; today: string; days: Array<{ date: string; due: number; practiced: number }> }>("/api/calendar", { month });
    // 前后两个月补齐首尾的几天
    const [y = 0, m = 1] = base.month.split("-").map(Number);
    const near = (offset: number) => ymd(new Date(y, m - 1 + offset, 1)).slice(0, 7);
    const others = await Promise.all([near(-1), near(1)].map((item) => get<typeof base>("/api/calendar", { month: item })));
    return { ...base, days: new Map([...others.flatMap((other) => other.days), ...base.days].map((item) => [item.date, item])) };
  }, [month]);
  const { data: list } = useData(async () => (day ? get<{ due: CardSummary[]; practiced: CardSummary[] }>("/api/calendar", { date: day }) : undefined), [day]);
  if (!data) return null;
  const [y = 0, m = 1] = data.month.split("-").map(Number);
  // 从这个月第一天所在的周一，排到最后一天所在的周日
  const first = new Date(y, m - 1, 1);
  const last = new Date(y, m, 0);
  const end = new Date(y, m, 7 - ((last.getDay() + 6) % 7) - 1);
  const cells = [];
  for (let date = new Date(y, m - 1, 1 - ((first.getDay() + 6) % 7)); date <= end; date = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1)) {
    const key = ymd(date);
    const item = data.days.get(key);
    const past = key < data.today || (key === data.today && !item?.due);
    const n = past ? item?.practiced : item?.due;
    const label = n ? t(past ? "today.dayPracticed" : "today.dayDue", { d: date.getDate(), n }) : String(date.getDate());
    cells.push(<button key={key} type="button" className={`cal-d${date.getMonth() === m - 1 ? "" : " out"}${key === data.today ? " is-today" : ""}`} aria-pressed={key === day} aria-label={label} onClick={() => setDay(key)}>
      <span className="cal-num num">{date.getDate()}</span>
      {n ? <span className="cal-n"><Glyph stone={{ k: "kept", m: past ? 0.92 : 0.34 }} size={10} /><span className="num">{n}</span></span> : null}
    </button>);
  }
  const shown = list ? [...list.due, ...list.practiced.filter((card) => !list.due.some((other) => other.path === card.path))] : [];
  const shift = (offset: number) => setMonth(ymd(new Date(y, m - 1 + offset, 1)).slice(0, 7));
  return <section className="cal" aria-label={t("today.calendar")}>
    <p className="cal-h num">{t("today.month", { y, m })}<span>
      <IconButton icon="arrow-left" label={t("today.prevMonth")} onClick={() => shift(-1)} />
      <IconButton icon="arrow-right" label={t("today.nextMonth")} onClick={() => shift(1)} />
    </span></p>
    <div className="cal-w">{[...t("today.weekdays")].map((name) => <span key={name}>{name}</span>)}</div>
    <div className="cal-g">{cells}</div>
    {day && <div className="cal-day"><p className="num">{mmdd(day)}</p><ul>
      {shown.map((card) => <li key={card.path}><a href="#" onClick={(event) => { event.preventDefault(); go({ page: "card", path: card.path }); }}><Glyph stone={stoneOf(card)} size={14} />{card.title}</a></li>)}
    </ul></div>}
  </section>;
}

function Empty() {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const create = async () => {
    if (!name.trim()) return;
    await post("/api/folder", { path: name.trim() });
    refresh();
    go({ page: "folder", path: name.trim() });
  };
  return <main className="empty-kb"><div className="empty-acts">
    <button type="button" className="btn btn-solid" onClick={() => void openTalk("", { fresh: true })}><Icon name="message-square-plus" />{t("today.startTalk")}</button>
    {naming
      ? <input className="name-in" autoFocus aria-label={t("today.folderName")} placeholder={t("today.folderName")} value={name} onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) void create(); if (event.key === "Escape") setNaming(false); }} />
      : <button type="button" className="btn btn-line" onClick={() => setNaming(true)}><Icon name="folder-plus" />{t("today.newFolder")}</button>}
  </div></main>;
}

/** 今日。 */
export function TodayPage() {
  const { cards, tree } = useApp();
  const extra = extraToday();
  const { data } = useData(() => get<Today>("/api/today", { extra: extra || undefined }), [extra]);
  if (tree && cards && tree.folders.length <= 1 && cards.length === 0) return <Empty />;
  if (!data || !cards) return null;
  const lead = data.done ? undefined : data.due[0] ?? data.fresh[0];
  const due = data.due.filter((card) => card !== lead);
  const fresh = data.fresh.filter((card) => card !== lead);
  const count = (shown: number, total: number) => (shown < total ? t("today.count", { shown, total }) : String(total));
  const kept = cards.filter((card) => card.keep && !card.moc);
  const tops = [...new Set(kept.map((card) => topOf(card.folder)))].sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
  const stones = <div key="stones">
    <div className="kept">{tops.map((top) => [
      <span key={`n${top}`} className="kept-name">{top || t("nav.kb")}</span>,
      <Pebbles key={top} cards={kept.filter((card) => topOf(card.folder) === top)} size={14} cols={10} {...(lead ? { lead: lead.path } : {})} />,
    ])}</div>
    <p className="kept-note">{t("today.kept", { kept: kept.length, due: data.dueTotal }).split(/(\d+)/u).map((part, index) => (index % 2 ? <b key={index}>{part}</b> : part))}</p>
  </div>;
  return <main className="today">
    {lead
      ? <section className="lead">
        <p className="why"><b>{lateOf(lead)}</b><span>{folderLabel(lead.folder, t("nav.kb"))}</span></p>
        <h1>{lead.title}</h1>
        <p className="go"><button type="button" className="btn btn-solid" onClick={() => void startReview(lead.path)}>{t("today.review")}</button>{lead.lastPracticed && <span className="num">{t("today.last", { date: mmdd(lead.lastPracticed) })}</span>}</p>
      </section>
      : <section className="lead done">
        <h1 className="done-h">{t("today.done")}</h1>
        {data.done && <p className="go"><button type="button" className="btn btn-text btn-more" onClick={() => addExtra(MORE)}>{t("today.more")}</button></p>}
      </section>}
    <div className="lists">
      <section className="group">
        <h2 className="group-head"><Glyph stone={{ k: "kept", m: 0.36, od: 4 }} size={18} /><b>{t("today.due")}</b><span className="num">{count(data.due.length, data.dueTotal)}</span></h2>
        {!data.done && <ul className="rows">{due.map((card) => <Row key={card.path} card={card} />)}</ul>}
      </section>
      <section className="group">
        <h2 className="group-head"><Glyph stone={{ k: "never" }} size={18} /><b>{t("today.fresh")}</b><span className="num">{count(data.fresh.length, data.freshTotal)}</span></h2>
        {!data.done && <ul className="rows">{fresh.map((card) => <Row key={card.path} card={card} />)}</ul>}
      </section>
    </div>
    <aside className="field-wrap" aria-label={t("today.keptLabel")}>{RAIL.map((part) => (part === "stones" ? stones : <Calendar key="calendar" />))}</aside>
  </main>;
}
