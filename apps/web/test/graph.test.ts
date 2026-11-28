import { expect, test } from "vitest";

import type { CardSummary } from "../src/api";
import { layout } from "../src/graph";

const card = (path: string, created: number): CardSummary => ({
  path, title: path, folder: path.slice(0, path.lastIndexOf("/")), summary: "", moc: false, keep: false, due: false, overdueDays: 0, created,
});
const places = (cards: CardSummary[]) => new Map(layout(cards).piles.flatMap((pile) => pile.nodes).map((node) => [node.card.path, [node.x, node.y]]));

test("知识库的图里，新建一张卡片，旧卡片的石头原地不动，新的落在螺线外沿", () => {
  const before = [card("甲/一.md", 1), card("甲/二.md", 2), card("甲/三.md", 3)];
  const old = places(before);
  const now = places([...before, card("甲/四.md", 4)]);
  for (const [path, at] of old) expect(now.get(path)).toEqual(at);
  const pile = layout([...before, card("甲/四.md", 4)]).piles[0];
  const far = (path: string) => { const [x = 0, y = 0] = now.get(path) ?? []; return Math.hypot(x - (pile?.x ?? 0), (y - (pile?.y ?? 0)) / 0.9); };
  expect(Math.max(...[...old.keys()].map(far))).toBeLessThan(far("甲/四.md"));
  // 读入的先后不影响位置：按建立时间排
  expect(places([...before].reverse())).toEqual(old);
});

test("一个顶层文件夹有十二个子文件夹时，这块滩在一页宽里蛇形折行，相邻的堆始终挨着", () => {
  const cards = Array.from({ length: 12 }, (_, chapter) => Array.from({ length: 6 + chapter }, (_, i) => card(`CSAPP/第${chapter + 1}章/卡${i}.md`, i))).flat();
  const { piles } = layout(cards);
  expect(piles).toHaveLength(12);
  for (const pile of piles) expect([pile.x - pile.r >= 0, pile.x + pile.r <= 1000]).toEqual([true, true]);
  for (let i = 1; i < piles.length; i += 1) {
    const [a, b] = [piles[i - 1], piles[i]];
    if (!a || !b) continue;
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThanOrEqual(a.r + b.r + 24);
  }
  expect(new Set(piles.map((pile) => Math.round(pile.y / 100))).size).toBeGreaterThan(1);
});
