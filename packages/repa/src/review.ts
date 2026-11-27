// 复习的计算：可替换的纯函数。输入卡片、练习记录和今天，输出每张卡片的记忆估计和今天的建议；换算法就是换这个文件，记录不动。
import { DEFAULT_MODEL_CONFIG, applyRepetition, isDue, memoryAt, type KnowledgeGraph, type Student } from "@repa/learning-model";

import type { GradeEntry, LogEntry, QuizEntry, Result } from "./log.js";

/** 复习计算要用的卡片字段。keep 已经算上了 MOC 带来的保持。requires 现在只用于地图，不沿它传递复习信用。 */
export interface ReviewCard {
  path: string;
  id?: string;
  keep: boolean;
  requires: string[];
  review?: string;
}

/** 一次练习：一次出题连同它最后一条判定，或一条不经题目卡片的判定。没有判定的出题 grade 为空。 */
export interface Practice {
  id: string;
  t: string;
  day: number;
  card?: string;
  folder?: string;
  quiz?: QuizEntry;
  grade?: GradeEntry;
}

/** 一张卡片今天的状态。memory 只对答对过的卡片有值；manualDue 是手定的日期已到且还没有完成。 */
export interface CardReview {
  memory?: number;
  due: boolean;
  overdueDays: number;
  manualDue: boolean;
  practicedToday: boolean;
}

/** 首页的建议：due 是手定日期已到的和到期的，fresh 是标了保持却还没有答对过的；两组都带总数。 */
export interface Suggestions {
  due: string[];
  dueTotal: number;
  fresh: string[];
  freshTotal: number;
}

const DAY_MS = 86_400_000;
const ROLLOVER_MS = 4 * 3_600_000;
const SUGGESTION_LIMIT = 10;
const SEVERITY: Record<Result, number> = { fail: 0, partial: 1, pass: 2 };

/**
 * 时间所在的本地日历日，凌晨 4 点换日，返回连续的天数。时间串里写着当时的本地时刻和偏移，直接取它的本地时刻，
 * 所以计算不依赖运行时的时区。只写日期的（手定的 review）就是那一天。
 */
export function dayOf(time: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/u.exec(time);
  if (!match) throw new Error(`读不出日期：${time}`);
  const [, year, month, day, hour = "4", minute = "0"] = match;
  return Math.floor((Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)) - ROLLOVER_MS) / DAY_MS);
}

/** 把记录合成一次次练习：出题接上最后一条判定；判定没有卡片时沿用出题的，反过来也一样。 */
export function practicesOf(log: readonly LogEntry[]): Practice[] {
  const practices = new Map<string, Practice>();
  for (const entry of log) {
    if (entry.kind === "quiz") {
      practices.set(entry.id, { id: entry.id, t: entry.t, day: dayOf(entry.t), quiz: entry, ...pick(entry) });
      continue;
    }
    const earlier = entry.quiz === undefined ? undefined : practices.get(entry.quiz);
    if (entry.quiz !== undefined && !earlier) continue;
    const practice = earlier ?? { id: entry.id, t: entry.t, day: dayOf(entry.t) };
    practice.grade = entry;
    practice.card ??= entry.card;
    practices.set(practice.id, practice);
  }
  return [...practices.values()];
}

function pick(entry: QuizEntry): { card?: string; folder?: string } {
  return { ...(entry.card === undefined ? {} : { card: entry.card }), ...(entry.folder === undefined ? {} : { folder: entry.folder }) };
}

/**
 * 计算每张卡片的状态和今天的建议。对就是一次通过，部分对是一半的失败，错是满额的失败；同一天里同一张卡片只算一次，
 * 取最差的结果。手定的日期在这一天或之后有一次判定过的练习就算完成。今天练过的卡片今天不再列出。
 */
export function computeReview(cards: readonly ReviewCard[], log: readonly LogEntry[], today: number): { cards: Map<string, CardReview>; suggestions: Suggestions } {
  const judged = new Map<string, Map<number, Result>>();
  for (const practice of practicesOf(log)) {
    if (!practice.card || !practice.grade) continue;
    const days = judged.get(practice.card) ?? new Map<number, Result>();
    const previous = days.get(practice.day);
    if (previous === undefined || SEVERITY[practice.grade.result] < SEVERITY[previous]) days.set(practice.day, practice.grade.result);
    judged.set(practice.card, days);
  }
  const states = new Map<string, CardReview>();
  for (const card of cards) {
    const days = card.id === undefined ? undefined : judged.get(card.id);
    const student = replay(days);
    const state = student.c;
    const reviewDay = card.review === undefined ? undefined : dayOf(card.review);
    const practicedDays = [...(days?.keys() ?? [])];
    const result: CardReview = {
      due: false,
      overdueDays: 0,
      manualDue: reviewDay !== undefined && reviewDay <= today && !practicedDays.some((day) => day >= reviewDay),
      practicedToday: practicedDays.includes(today),
    };
    if (state) {
      result.memory = memoryAt(state, today);
      result.due = card.keep && isDue(state, today);
      // memory 落到到期线的那一天；失败以后已在线下，从第二天算起。
      const crossing = state.lastRepetitionDay + state.interval * Math.log2(Math.max(state.memory, 1e-9) / DEFAULT_MODEL_CONFIG.dueMemory);
      result.overdueDays = Math.max(0, Math.floor(today - Math.max(crossing, state.lastRepetitionDay + 1)));
    }
    if (result.manualDue && reviewDay !== undefined) result.overdueDays = today - reviewDay;
    states.set(card.path, result);
  }
  return { cards: states, suggestions: suggest(cards, states) };
}

const GRAPH: KnowledgeGraph = { topics: ["c"], prerequisites: [], encompassings: [] };

function replay(days: Map<number, Result> | undefined): Student {
  let student: Student = {};
  for (const [day, result] of [...(days ?? new Map<number, Result>())].sort(([a], [b]) => a - b)) {
    const outcome = result === "pass" ? "pass" : "fail";
    student = applyRepetition(GRAPH, student, { topicId: "c", day, outcome, quality: result === "partial" ? 0.5 : 1 });
  }
  return student;
}

function suggest(cards: readonly ReviewCard[], states: Map<string, CardReview>): Suggestions {
  const open = cards.filter((card) => !states.get(card.path)?.practicedToday);
  const manual = open.filter((card) => states.get(card.path)?.manualDue);
  const due = open
    .filter((card) => !states.get(card.path)?.manualDue && states.get(card.path)?.due)
    .sort((a, b) => (states.get(a.path)?.memory ?? 0) - (states.get(b.path)?.memory ?? 0));
  const fresh = open.filter((card) => card.keep && !states.get(card.path)?.manualDue && states.get(card.path)?.memory === undefined);
  const dueList = [...manual, ...due].map((card) => card.path);
  const shownDue = dueList.slice(0, SUGGESTION_LIMIT);
  return {
    due: shownDue,
    dueTotal: dueList.length,
    fresh: fresh.map((card) => card.path).slice(0, SUGGESTION_LIMIT - shownDue.length),
    freshTotal: fresh.length,
  };
}
