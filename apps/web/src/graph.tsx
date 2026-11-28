// 知识库的图：每张卡片还是那颗石头，每个顶层的文件夹是一块浅色的滩，子文件夹是滩上的一堆。
// 关系平时不画；指到一张卡片时只画它自己的：先修是带箭头的实线，从先学的指向后学的；链接是虚线；专题是菱形。
// 不缩放、不拖动，整张图排进一页的宽度，卡片多了往下长。线条、名字和小块的画法照画稿的 graph.js。
import { useState } from "react";

import type { CardSummary } from "./api";
import { Glyph, stoneOf } from "./glyph";
import { go } from "./store";
import { t, type TextKey } from "./strings";

const W = 1000;
const C = 16;
const SIZE = 22;
const GAP = 48;

type Kind = "pre" | "post" | "link" | "topic";
interface Node { card: CardSummary; pile: Pile; x: number; y: number }
interface Pile { folder: string; label: string; count: number; top: boolean; x: number; y: number; r: number; nodes: Node[] }

const COLLATE = (a: string, b: string) => a.localeCompare(b, "zh-CN", { numeric: true });
// 堆的大小按 8 张一档长，多一张卡片通常不改变各堆的位置
const radius = (n: number) => C * Math.sqrt(Math.ceil(n / 8) * 8) * 0.95 + 26;

/**
 * 排出全部石头。位置只由文件夹和卡片建立的先后决定，所以是稳定的：
 * 每一堆按建立的先后排在一条向外的螺线上，新卡片落在外沿，旧的不挪；
 * 一个顶层文件夹的几堆从左到右排成一行，上下错开，连成一块滩；各块滩像排字一样从左到右排，排满一行换行。
 * 堆的大小按档长，所以多几张卡片时别的堆不动；跨过一档时，后面的堆整体挪一点，堆里的相对位置仍不变。
 */
export function layout(cards: CardSummary[]): { piles: Pile[]; regions: Pile[][]; height: number } {
  const byFolder = new Map<string, CardSummary[]>();
  for (const card of cards) byFolder.set(card.folder, [...(byFolder.get(card.folder) ?? []), card]);
  const tops = new Map<string, Pile[]>();
  for (const folder of [...byFolder.keys()].sort(COLLATE)) {
    const own = (byFolder.get(folder) ?? []).sort((a, b) => (a.created ?? 0) - (b.created ?? 0) || COLLATE(a.path, b.path));
    const top = folder.split("/")[0] ?? "";
    const pile: Pile = { folder, label: folder.slice(folder.lastIndexOf("/") + 1) || t("nav.kb"), count: own.filter((card) => !card.moc).length, top: !folder.includes("/"), x: 0, y: 0, r: radius(own.length), nodes: [] };
    pile.nodes = own.map((card) => ({ card, pile, x: 0, y: 0 }));
    tops.set(top, [...(tops.get(top) ?? []), pile]);
  }
  const regions = [...tops.values()];
  let x0 = 0;
  let y0 = 0;
  let row = 0;
  regions.forEach((piles, ri) => {
    // 先在这块滩自己的坐标里排，再整体挪到这一行
    let x = 0;
    piles.forEach((pile, i) => {
      const before = piles[i - 1];
      x += before ? (before.r + pile.r) * 0.8 : 0;
      Object.assign(pile, { x, y: (i % 2 ? 0.3 : -0.3) * pile.r * (piles.length > 1 ? 1 : 0) });
    });
    const left = Math.min(...piles.map((pile) => pile.x - pile.r));
    const right = Math.max(...piles.map((pile) => pile.x + pile.r));
    const top = Math.min(...piles.map((pile) => pile.y - pile.r)) - 30;
    const bottom = Math.max(...piles.map((pile) => pile.y + pile.r));
    if (x0 > 0 && x0 + right - left > W) {
      y0 += row + GAP;
      x0 = 0;
      row = 0;
    }
    piles.forEach((pile, pi) => {
      pile.x += x0 - left;
      pile.y += y0 - top;
      pile.nodes.forEach((node, i) => {
        const r = C * Math.sqrt(i + 0.35);
        const a = i * 2.39996 + (ri * 3 + pi) * 1.3;
        Object.assign(node, { x: pile.x + r * Math.cos(a), y: pile.y + r * Math.sin(a) * 0.9 });
      });
    });
    x0 += right - left + GAP;
    row = Math.max(row, bottom - top);
  });
  return { piles: regions.flat(), regions, height: y0 + row + 44 };
}

/** 与一张卡片有关的卡片：它的先修、以它为先修的后续、两边任一方链到对方的链接，以及列出它的专题。 */
function relations(focus: CardSummary, cards: CardSummary[]): Map<string, Kind> {
  const rel = new Map<string, Kind>();
  const has = (list: CardSummary["links"], path: string) => (list ?? []).some((link) => link.path === path);
  for (const link of focus.requires ?? []) if (link.path) rel.set(link.path, "pre");
  for (const card of cards) {
    if (card.moc && has(card.links, focus.path)) rel.set(card.path, "topic");
    else if (has(card.requires, focus.path)) rel.set(card.path, "post");
    else if (!rel.has(card.path) && (has(card.links, focus.path) || has(focus.links, card.path))) rel.set(card.path, "link");
  }
  rel.delete(focus.path);
  return rel;
}

// 一条线：略带弧度，两头各让出石头的半径
function Edge({ from, to, kind }: { from: Node; to: Node; kind: "req" | "link" }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  const end = 13 + (kind === "req" ? 3 : 0);
  const [x1, y1, x2, y2] = [from.x + ux * 13, from.y + uy * 13, to.x - ux * end, to.y - uy * end];
  const bend = Math.min(26, len * 0.09);
  return <path className={`edge ${kind}`} d={`M${x1} ${y1}Q${(x1 + x2) / 2 - uy * bend} ${(y1 + y2) / 2 + ux * bend} ${x2} ${y2}`} markerEnd={kind === "req" ? "url(#arrow)" : undefined} />;
}

function Name({ node, strong = false }: { node: Node; strong?: boolean }) {
  const left = node.x < node.pile.x - 4;
  return <text className={`name${strong ? " strong" : ""}`} x={node.x + (left ? -15 : 15)} y={node.y + 5} textAnchor={left ? "end" : undefined}>{node.card.title}</text>;
}

/** 知识库的图。shown 是筛选以后留下的卡片，其余退淡。 */
export function Graph({ cards, shown }: { cards: CardSummary[]; shown: Set<string> }) {
  const [focusPath, setFocus] = useState<string>();
  const { piles, regions, height } = layout(cards);
  const nodes = piles.flatMap((pile) => pile.nodes);
  const at = (path: string) => nodes.find((node) => node.card.path === path);
  const focus = focusPath === undefined ? undefined : at(focusPath);
  const rel = focus ? relations(focus.card, cards) : new Map<string, Kind>();
  const named = (kind: Kind) => [...rel].filter(([, value]) => value === kind).map(([path]) => at(path)?.card.title).filter(Boolean).join("、");
  const boxY = focus ? focus.pile.y + focus.pile.r * 0.92 + 12 : 0;
  const boxX = focus ? Math.max(8, Math.min(W - 268, focus.pile.x - 130)) : 0;
  const h = Math.max(height, focus ? boxY + 200 : 0);
  return <div className="graph-wrap" onMouseLeave={() => setFocus(undefined)}>
    <svg className="graph" viewBox={`0 0 ${W} ${h}`} width={W} height={h} role="img" aria-label={t("kb.graph")}>
      <defs><marker id="arrow" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1L7 4L1 7" className="arrowhead" /></marker></defs>
      {regions.map((group) => {
        // 几堆合成一块滩：把各堆的中心连成多边形，用很粗、圆角的边描一圈
        const r = Math.min(...group.map((pile) => pile.r)) * 0.92;
        return <g key={group[0]?.folder} className="region">
          {group.length > 1 && <polygon points={group.map((pile) => `${pile.x},${pile.y}`).join(" ")} strokeWidth={2 * r} strokeLinejoin="round" />}
          {group.map((pile) => <ellipse key={pile.folder} cx={pile.x} cy={pile.y} rx={pile.r} ry={pile.r * 0.92} />)}
        </g>;
      })}
      {regions.map((group) => group.map((pile, i) => {
        // 顶层文件夹的名字和总张数写在它自己那一堆上；它自己没有卡片时，写在第一堆的上面
        const lift = i === 0 && !pile.top ? 20 : 0;
        const label = (big: boolean, dy: number, text: string, count: number) => <text key={`${pile.folder}${big}`} className={`pile${big ? " big" : ""}`} x={pile.x} y={pile.y - pile.r * 0.92 - 14 - dy} textAnchor="middle">
          {text}<tspan className="count" dx="8">{count}</tspan>
        </text>;
        const total = group.reduce((sum, other) => sum + other.count, 0);
        return [
          pile.top ? label(true, 0, pile.label, total) : label(false, 0, pile.label, pile.count),
          lift ? label(true, lift, pile.folder.split("/")[0] ?? "", total) : null,
        ];
      }))}
      {focus && [...rel].map(([path, kind]) => {
        const other = at(path);
        if (!other || Math.hypot(other.x - focus.x, other.y - focus.y) < 44) return null;
        if (kind === "pre") return <Edge key={path} from={other} to={focus} kind="req" />;
        return <Edge key={path} from={focus} to={other} kind={kind === "post" ? "req" : "link"} />;
      })}
      {nodes.map((node) => {
        const dim = focus ? node !== focus && !rel.has(node.card.path) : !shown.has(node.card.path);
        const cur = node === focus;
        return <g key={node.card.path} className={`node${dim ? " dim" : ""}`} transform={`translate(${node.x} ${node.y})${cur ? " scale(1.3)" : ""}`}
          role="link" tabIndex={0} aria-label={node.card.title} onMouseEnter={() => setFocus(node.card.path)} onFocus={() => setFocus(node.card.path)}
          onClick={() => go({ page: "card", path: node.card.path })} onKeyDown={(event) => { if (event.key === "Enter") go({ page: "card", path: node.card.path }); }}>
          {cur && <rect className="ring" x="-14" y="-13" width="28" height="26" rx="9" />}
          {node.card.moc
            ? <rect x="-6" y="-6" width="12" height="12" rx="3" transform="rotate(45)" className="topic" />
            : <g transform={`translate(${-SIZE / 2} ${-SIZE / 2})`}><Glyph stone={stoneOf(node.card)} size={SIZE} /></g>}
        </g>;
      })}
      {/* 名字：专题一直写；指到一张卡片时，写它自己和别的堆里与它有关的卡片 */}
      {nodes.filter((node) => (node.card.moc && (!focus || rel.has(node.card.path))) || (focus && node.pile !== focus.pile && rel.has(node.card.path) && !node.card.moc)).map((node) => <Name key={node.card.path} node={node} />)}
      {focus && <Name node={focus} strong />}
      {focus && <foreignObject x={boxX} y={boxY} width="260" height="200"><div className="g-info">
        <b>{focus.card.title}</b><span>{focus.card.summary}</span>
        {(["pre", "post", "link", "topic"] as const).map((kind) => named(kind) && <p key={kind}><i>{t(`graph.${kind}` as TextKey)}</i>{named(kind)}</p>)}
      </div></foreignObject>}
      <g className="legend" transform={`translate(12 ${h - 22})`}>
        <path className="edge req" d="M0 0H26" markerEnd="url(#arrow)" /><text x="36" y="4">{t("graph.pre")}</text>
        <path className="edge link" d="M84 0H112" /><text x="120" y="4">{t("graph.link")}</text>
        <rect x="168" y="-5" width="10" height="10" rx="2.5" transform="rotate(45 173 0)" className="topic" /><text x="186" y="4">{t("graph.topic")}</text>
      </g>
    </svg>
  </div>;
}
