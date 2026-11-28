import assert from "node:assert/strict";
import test from "node:test";

import type { GradeEntry, LogEntry, QuizEntry, Result } from "../src/log.js";
import { computeReview, dateOf, dayOf, practicesOf, type ReviewCard } from "../src/review.js";

let counter = 0;
function quiz(card: string | undefined, t: string): QuizEntry {
  counter += 1;
  return { v: 1, id: `q${counter}`, t, kind: "quiz", ...(card ? { card } : { folder: "CSAPP" }), questions: [{ text: "题" }], answers: ["答"] };
}
function grade(t: string, result: Result, target: { quiz?: string; card?: string }): GradeEntry {
  counter += 1;
  return { v: 1, id: `g${counter}`, t, kind: "grade", ...target, result, note: "讲评" };
}
/** 一次出题加它的判定。 */
function practiced(card: string, t: string, result: Result): LogEntry[] {
  const entry = quiz(card, t);
  return [entry, grade(t, result, { quiz: entry.id })];
}
const card = (id: string, extra: Partial<ReviewCard> = {}): ReviewCard => ({ path: `${id}.md`, id, keep: true, requires: [], ...extra });

test("凌晨 4 点换日，按时间串里写的本地时刻计算，不依赖运行时的时区", () => {
  assert.equal(dayOf("2026-11-26T23:00:00+08:00"), dayOf("2026-11-26"));
  assert.equal(dayOf("2026-11-27T03:59:00+08:00"), dayOf("2026-11-26"));
  assert.equal(dayOf("2026-11-27T04:00:00+08:00"), dayOf("2026-11-27"));
  assert.equal(dayOf("2026-11-27T04:00:00-05:00"), dayOf("2026-11-27"));
});

test("改记以最后一条判定为准；不经题目卡片的判定自成一次练习；判定可以给没指定卡片的出题补上卡片", () => {
  const first = quiz("a", "2026-11-26T10:00:00+08:00");
  const loose = quiz(undefined, "2026-11-26T11:00:00+08:00");
  const direct = grade("2026-11-26T12:00:00+08:00", "fail", { card: "b" });
  const practices = practicesOf([
    first, grade(first.t, "fail", { quiz: first.id }), grade(first.t, "pass", { quiz: first.id }),
    loose, grade(loose.t, "partial", { quiz: loose.id, card: "c" }),
    direct, grade(direct.t, "pass", { quiz: direct.id }),
  ]);
  assert.deepEqual(practices.map((practice) => [practice.card, practice.grade?.result]), [["a", "pass"], ["c", "partial"], ["b", "pass"]]);
  assert.equal(practices[1]?.folder, "CSAPP");
});

test("复习时答错、听完讲解当天再答对：同一天取最差的结果，这张卡片第二天仍在建议里，今天不再列出", () => {
  const log = [
    ...practiced("a", "2026-11-20T10:00:00+08:00", "pass"),
    ...practiced("a", "2026-11-21T10:00:00+08:00", "pass"),
    ...practiced("a", "2026-11-23T21:00:00+08:00", "fail"),
    ...practiced("a", "2026-11-23T21:10:00+08:00", "pass"),
  ];
  const sameDay = computeReview([card("a")], log, dayOf("2026-11-23"), 10);
  assert.deepEqual(sameDay.suggestions.due, []);
  assert.equal(sameDay.cards.get("a.md")?.practicedToday, true);
  const nextDay = computeReview([card("a")], log, dayOf("2026-11-24"), 10);
  assert.deepEqual(nextDay.suggestions.due, ["a.md"]);
  // 只记下了答对时，第二天还不到期。
  const passOnly = computeReview([card("a")], log.filter((entry) => !(entry.kind === "grade" && entry.result === "fail")), dayOf("2026-11-24"), 10);
  assert.deepEqual(passOnly.suggestions.due, []);
});

test("手定的复习日期对没有纳入复习的卡片也有效；这一天或之后有一次判定过的练习就算完成，之前的练习不算", () => {
  const cards = [card("a", { keep: false, review: "2026-11-25" })];
  const early = practiced("a", "2026-11-24T10:00:00+08:00", "pass");
  assert.deepEqual(computeReview(cards, early, dayOf("2026-11-24"), 10).suggestions.due, []);
  assert.deepEqual(computeReview(cards, early, dayOf("2026-11-26"), 10).suggestions.due, ["a.md"]);
  assert.equal(computeReview(cards, early, dayOf("2026-11-27"), 10).cards.get("a.md")?.overdueDays, 2);
  const done = [...early, ...practiced("a", "2026-11-26T10:00:00+08:00", "partial")];
  assert.deepEqual(computeReview(cards, done, dayOf("2026-11-27"), 10).suggestions.due, []);
  // 没有纳入复习的卡片答错了也不进程序算的复习。
  assert.equal(computeReview(cards, done, dayOf("2026-11-27"), 10).cards.get("a.md")?.due, false);
});

test("一天建议 10 张时：手定日期已到的在最前，然后是到期的、记忆低的在前，最后是未答对的；两组都给总数", () => {
  const log: LogEntry[] = [];
  const cards: ReviewCard[] = [];
  // 8 张到期：第 0 天学完，间隔 1 天；越早学完的记忆越低。
  for (let index = 0; index < 8; index += 1) {
    cards.push(card(`due${index}`));
    log.push(...practiced(`due${index}`, `2026-11-${String(10 + index).padStart(2, "0")}T10:00:00+08:00`, "pass"));
  }
  for (let index = 0; index < 5; index += 1) cards.push(card(`fresh${index}`));
  log.push(...practiced("fresh0", "2026-11-20T10:00:00+08:00", "fail"));
  cards.push(card("manual", { keep: false, review: "2026-11-25" }));
  cards.push(card("other", { keep: false }));
  const { suggestions } = computeReview(cards, log, dayOf("2026-11-26"), 10);
  assert.deepEqual(suggestions.due, ["manual.md", ...[0, 1, 2, 3, 4, 5, 6, 7].map((index) => `due${index}.md`)]);
  assert.equal(suggestions.dueTotal, 9);
  assert.deepEqual(suggestions.fresh, ["fresh0.md"]);
  assert.equal(suggestions.freshTotal, 5);
});

test("下次到期：纳入复习的卡片按计算，手定的日期没完成时取两者早的；没纳入复习的只看手定的日期；练过的日子按凌晨 4 点换日", () => {
  const log = [...practiced("a", "2026-11-20T23:30:00+08:00", "pass"), ...practiced("b", "2026-11-20T03:30:00+08:00", "pass")];
  const cards = [card("a"), card("b", { review: "2026-11-30" }), card("c", { keep: false, review: "2026-12-01" })];
  const states = computeReview(cards, log, dayOf("2026-11-20"), 10).cards;
  assert.equal(states.get("a.md")?.nextDue, dayOf("2026-11-21"));
  assert.equal(states.get("b.md")?.nextDue, dayOf("2026-11-20"));
  assert.deepEqual(states.get("b.md")?.practicedDays, [dayOf("2026-11-19")]);
  assert.equal(states.get("c.md")?.nextDue, dayOf("2026-12-01"));
  assert.equal(dateOf(dayOf("2026-12-01")), "2026-12-01");
});

test("今天练过的卡片占掉每天的名额，名额用完就不再列出；不设上限时全部列出", () => {
  const cards = ["a", "b", "c", "d", "e"].map((id) => card(id));
  const log = [...practiced("a", "2026-11-26T09:00:00+08:00", "pass"), ...practiced("b", "2026-11-26T09:10:00+08:00", "fail")];
  const limited = computeReview(cards, log, dayOf("2026-11-26"), 3).suggestions;
  assert.deepEqual({ practiced: limited.practiced, shown: limited.fresh.length, total: limited.freshTotal }, { practiced: 2, shown: 1, total: 3 });
  assert.deepEqual(computeReview(cards, log, dayOf("2026-11-26"), 2).suggestions.fresh, []);
  assert.equal(computeReview(cards, log, dayOf("2026-11-26"), null).suggestions.fresh.length, 3);
});

test("只有做掉的建议占每天的名额：学习对话里考过的新卡片、还没到期就又练了的卡片不算", () => {
  const cards = [card("due"), card("fresh"), card("notKept", { keep: false }), card("notYet"), card("manual", { keep: false, review: "2026-11-26" }), card("waiting")];
  const log = [
    ...practiced("due", "2026-11-24T10:00:00+08:00", "pass"),
    // 第 20、21、23 天按时答对，间隔到了 4 天多，第 26 天还没到期。
    ...["20", "21", "23"].flatMap((day) => practiced("notYet", `2026-11-${day}T10:00:00+08:00`, "pass")),
    ...["due", "fresh", "notKept", "notYet", "manual"].flatMap((id) => practiced(id, "2026-11-26T10:00:00+08:00", "pass")),
  ];
  const { cards: states, suggestions } = computeReview(cards, log, dayOf("2026-11-26"), 10);
  assert.deepEqual(["due", "fresh", "notKept", "notYet", "manual"].map((id) => states.get(`${id}.md`)?.countedToday), [true, true, false, false, true]);
  assert.equal(suggestions.practiced, 3);
  assert.deepEqual(suggestions.fresh, ["waiting.md"]);
});
