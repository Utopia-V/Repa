// 每张卡片的记号：一颗石头，水位是记得多少，逾期的长草。形状、笔触和草的坐标照画稿的 glyphs.js 原样搬来。
import { useId } from "react";

import { LUCIDE, type IconName } from "./icons";

/** 记号的状态：kept 纳入复习且答对过，m 是记得多少（0–1），od 是逾期天数；never 纳入复习而未答对；loose 未纳入复习；off 未纳入复习、可以点了纳入；moc 专题，不画。 */
export type Stone = { k: "kept"; m: number; od?: number } | { k: "never" } | { k: "loose" } | { k: "off" } | { k: "moc" };

/** 列表里的一张卡片带的复习状态，接口里的形状。 */
export interface CardState {
  moc?: boolean;
  keep?: boolean;
  memory?: number;
  overdueDays?: number;
}

/** 由接口给出的状态得出记号。 */
export function stoneOf(card: CardState): Stone {
  if (card.moc) return { k: "moc" };
  if (!card.keep) return { k: "loose" };
  if (card.memory === undefined) return { k: "never" };
  return { k: "kept", m: card.memory, od: card.overdueDays ?? 0 };
}

const PEBBLE = "M2.6 13.7C2.2 8.7 6.4 4.6 12.2 4.4C18 4.2 21.9 7.9 21.5 12.9C21.1 17.7 17.2 20.2 11.9 20.2C6.9 20.2 3 18.3 2.6 13.7Z";
const TOP = 4.3;
const BOT = 20.2;
// 草：每根从石头的轮廓上长出，先向上，到顶弯向一侧；三档是一两天、三到六天、一周以上。
const GRASS: Array<Array<[number, number, number, number]>> = [[],
  [[12.9, 4.45, 3.1, 1.35], [12.5, 4.45, 2.1, -1.15]],
  [[13.6, 4.5, 3.6, 1.4], [13.2, 4.5, 2.6, -1.2], [13.4, 4.5, 1.7, 0.5], [8.3, 5.2, 2.4, -1.15], [8.6, 5.15, 1.6, 0.85]],
  [[12.4, 4.4, 3.9, 0.55], [12.1, 4.4, 3.0, -1.45], [12.8, 4.4, 2.9, 1.5], [6.9, 6.0, 2.5, -1.2], [7.2, 5.9, 1.8, 0.8], [17.0, 5.25, 2.6, 1.25], [16.7, 5.2, 1.8, -0.7]]];

const tier = (days: number) => (!days ? 0 : days <= 2 ? 1 : days <= 6 ? 2 : 3);
const blade = ([x, y, h, lean]: [number, number, number, number], k: number) => `M${x} ${y}c0 ${(-0.5 * h * k).toFixed(2)} ${(0.4 * lean * k).toFixed(2)} ${(-1.02 * h * k).toFixed(2)} ${(lean * k).toFixed(2)} ${(-0.78 * h * k).toFixed(2)}`;

/** 一颗石头。size 是像素边长；half 在大号上画出半满的到期线。 */
export function Glyph({ stone, size, label, half = false }: { stone: Stone; size: number; label?: string; half?: boolean }) {
  const clip = useId();
  const width = size >= 40 ? 1.5 : size >= 18 ? 1.1 : 1;
  const common = { className: "glyph", width: size, height: size, viewBox: "0 0 24 24", role: "img", "aria-label": label };
  const rim = (color: string) => <path d={PEBBLE} fill="none" stroke={color} strokeWidth={width} vectorEffect="non-scaling-stroke" />;
  if (stone.k === "moc") return <svg {...common} />;
  if (stone.k === "loose") return <svg {...common}><circle cx="12" cy="12.5" r="2.2" fill="var(--stone-dot)" /></svg>;
  if (stone.k === "never") return <svg {...common}>{rim("var(--stone-faint)")}</svg>;
  if (stone.k === "off") {
    return <svg {...common}>{rim("var(--stone-faint)")}<path d="M12 9.2v6.6M8.7 12.5h6.6" stroke="var(--stone-plus)" strokeWidth={width} strokeLinecap="round" vectorEffect="non-scaling-stroke" /></svg>;
  }
  const level = BOT - (BOT - TOP) * Math.max(0, Math.min(1, stone.m));
  const grass = tier(stone.od ?? 0);
  // 小尺寸下草画得大一些，否则只剩一个点
  const k = size <= 16 ? 1.3 : size <= 28 ? 1.45 : size <= 56 ? 1.15 : 1;
  return <svg {...common}>
    <defs><clipPath id={clip}><path d={PEBBLE} /></clipPath></defs>
    <path d={PEBBLE} fill="var(--stone-wash)" />
    <rect x="0" y={level.toFixed(2)} width="24" height="24" fill="var(--stone-fill)" clipPath={`url(#${clip})`} />
    {half && <path d={`M2 ${(TOP + BOT) / 2}H22`} stroke="var(--stone-rim)" strokeWidth="1" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" clipPath={`url(#${clip})`} opacity=".7" />}
    {rim("var(--stone-rim)")}
    {grass > 0 && <path d={(GRASS[grass] ?? []).map((item) => blade(item, k)).join("")} fill="none" stroke="var(--grass)" strokeWidth={Math.max(width, size <= 28 ? 1.2 : width)} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
  </svg>;
}

/** 左栏的标识：带水位的石头，水位线略带起伏。 */
export function Mark() {
  const clip = useId();
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    <defs><clipPath id={clip}><path d={PEBBLE} /></clipPath></defs>
    <path d={PEBBLE} fill="var(--stone-wash)" />
    <path d="M0 12.6C5 11.6 9 13.2 13 12.3C17 11.5 20 12.4 24 12V24H0Z" fill="var(--stone-fill)" clipPath={`url(#${clip})`} />
    <path d={PEBBLE} fill="none" stroke="var(--accent)" strokeWidth="2" />
  </svg>;
}

/** Lucide 图标，按 1.5 px 线宽画，不随尺寸变粗变细。 */
export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  return <svg className={`icon ${className}`} viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: LUCIDE[name] }} />;
}
