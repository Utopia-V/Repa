import { expect, it } from "vitest";

import { crossedMark, formatClock, nextRemaining, remainingMs } from "../src/lib/countdown";

/** 固定种子的伪随机数：每次运行生成同样的用例，失败时能复现。 */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}
const between = (next: () => number, low: number, high: number) => Math.floor(low + next() * (high - low));

const CASES = 500;

/** 一次读取：服务端在 serverNow 时交回状态，本机在 readAt 时收到；skew 是本机比服务端快多少，latency 是路上的时间。 */
function reading(next: () => number, serverClock: number, skew: number) {
  const latency = between(next, 0, 2_000);
  return { serverNow: serverClock, readAt: serverClock + skew + latency };
}

it("性质：同一次读取下，本机时间往前走，显示的剩余时间就是 max(0, 截止 − 换算后的现在)，只减不增，到 0 后一直是 0", () => {
  const next = random(1);
  for (let index = 0; index < CASES; index++) {
    const started = between(next, 0, 10 ** 12);
    const deadlineAt = started + between(next, 1_000, 30 * 60_000);
    const skew = between(next, -3_600_000, 3_600_000);
    const { serverNow, readAt } = reading(next, started + between(next, 0, 60_000), skew);
    let now = readAt;
    let shown: number | undefined;
    let reachedZero = false;
    for (let step = 0; step < 40; step++) {
      now += between(next, 0, 90_000);
      const before = shown;
      shown = nextRemaining(shown, remainingMs(deadlineAt, serverNow, readAt, now));
      expect(shown).toBe(Math.max(0, deadlineAt - (serverNow + (now - readAt))));
      if (before !== undefined) expect(shown).toBeLessThanOrEqual(before);
      if (reachedZero) expect(shown).toBe(0);
      if (shown === 0) reachedZero = true;
    }
  }
});

it("性质：重新读取（延迟各不相同）、本机时钟往回拨时，显示的剩余时间仍只减不增，也不比换算出的值大", () => {
  const next = random(2);
  for (let index = 0; index < CASES; index++) {
    const started = between(next, 0, 10 ** 12);
    const deadlineAt = started + between(next, 1_000, 30 * 60_000);
    const skew = between(next, -3_600_000, 3_600_000);
    let server = started;
    let current = reading(next, server, skew);
    let now = current.readAt;
    let shown: number | undefined;
    for (let step = 0; step < 40; step++) {
      // 真实时间往前走；本机读到的时间偶尔被往回拨。
      const elapsed = between(next, 0, 90_000);
      server += elapsed;
      now += next() < 0.15 ? -between(next, 0, 120_000) : elapsed;
      if (next() < 0.3) current = reading(next, server, skew);
      const computed = remainingMs(deadlineAt, current.serverNow, current.readAt, now);
      const before = shown;
      shown = nextRemaining(shown, computed);
      expect(shown).toBeGreaterThanOrEqual(0);
      expect(shown).toBeLessThanOrEqual(computed);
      if (before !== undefined) expect(shown).toBeLessThanOrEqual(before);
    }
  }
});

it("剩余时间写成分:秒，秒向上取整：只有真的到了才显示 0:00", () => {
  expect(formatClock(15 * 60_000)).toBe("15:00");
  expect(formatClock(14 * 60_000 + 59_001)).toBe("15:00");
  expect(formatClock(61_000)).toBe("1:01");
  expect(formatClock(1)).toBe("0:01");
  expect(formatClock(0)).toBe("0:00");
  expect(formatClock(-5_000)).toBe("0:00");
  const next = random(3);
  for (let index = 0; index < CASES; index++) {
    const ms = between(next, 1, 60 * 60_000);
    const [minutes, seconds] = formatClock(ms).split(":").map(Number);
    expect((minutes ?? 0) * 60 + (seconds ?? 0)).toBe(Math.ceil(ms / 1000));
  }
});

it("播报点：跨过时说一次，没跨过、刚打开时不说；一次跨过两个取小的那个", () => {
  const marks = [5 * 60_000, 60_000];
  expect(crossedMark(undefined, 4 * 60_000, marks)).toBeUndefined();
  expect(crossedMark(5 * 60_000 + 1, 5 * 60_000, marks)).toBe(5 * 60_000);
  expect(crossedMark(5 * 60_000, 4 * 60_000, marks)).toBeUndefined();
  expect(crossedMark(61_000, 59_000, marks)).toBe(60_000);
  expect(crossedMark(6 * 60_000, 30_000, marks)).toBe(60_000);
  expect(crossedMark(30_000, 0, marks)).toBeUndefined();
});
