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
