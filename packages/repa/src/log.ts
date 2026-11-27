// 练习记录 .repa/log.jsonl：一行一个事实，只追加，不改写。改记一次结果就追加一条新的 grade，同一次练习以最后一条为准。
import { randomBytes } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { Type, type Static } from "typebox";

import { readOptional } from "./kb.js";

/** 格式版本。格式改变时提高它，旧记录给出明白的拒绝说明。 */
export const LOG_VERSION = 1;

/** 一道小题：开放作答，或给出选项的单选。 */
export const QuestionSchema = Type.Object({
  text: Type.String({ description: "题干，可以用 Markdown 和公式" }),
  options: Type.Optional(Type.Array(Type.String(), { description: "单选题的选项；不给就是开放作答" })),
}, { additionalProperties: false });
/** 一道小题。 */
export type Question = Static<typeof QuestionSchema>;

/** 练习的结果：对、部分对、错。 */
export const ResultSchema = Type.Union([Type.Literal("pass"), Type.Literal("partial"), Type.Literal("fail")]);
/** 练习的结果。 */
export type Result = Static<typeof ResultSchema>;

/** 一次出题与作答。card 是卡片的 id；没有指定卡片时记下出题时所在的层。answers 为 null 表示没有作答。 */
export interface QuizEntry {
  v: 1;
  id: string;
  t: string;
  kind: "quiz";
  card?: string;
  folder?: string;
  questions: Question[];
  answers: string[] | null;
}

/** 一次判定。quiz 指向它判定的那次出题，或被改记的那条不经题目卡片的 grade；不经题目卡片的练习直接给出 card。 */
export interface GradeEntry {
  v: 1;
  id: string;
  t: string;
  kind: "grade";
  quiz?: string;
  card?: string;
  result: Result;
  note: string;
  external?: string;
}

/** 练习记录里的一行。 */
export type LogEntry = QuizEntry | GradeEntry;

/** 追加时由程序补上的字段之外的部分。 */
export type NewEntry = Omit<QuizEntry, "v" | "id" | "t"> | Omit<GradeEntry, "v" | "id" | "t">;

function logFile(root: string): string {
  return path.join(root, ".repa", "log.jsonl");
}

/** 毫秒时间的 36 进制加 4 位随机字符。几台设备各自生成，以后合并记录时按 id 去重。 */
export function newId(): string {
  return Date.now().toString(36) + [...randomBytes(4)].map((byte) => (byte % 36).toString(36)).join("");
}

/** 带本地时区偏移的时间，例如 2026-11-26T15:02:11+08:00。 */
export function localTime(date = new Date()): string {
  const offset = -date.getTimezoneOffset();
  const shifted = new Date(date.getTime() + offset * 60_000).toISOString().slice(0, 19);
  const sign = offset >= 0 ? "+" : "-";
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const minutes = String(Math.abs(offset) % 60).padStart(2, "0");
  return `${shifted}${sign}${hours}:${minutes}`;
}

/** 读出全部记录。不存在就是空的；版本不是这一版的，直接拒绝。 */
export async function readLog(root: string): Promise<LogEntry[]> {
  const text = await readOptional(logFile(root));
  if (text === undefined) return [];
  const entries: LogEntry[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as LogEntry;
    if (entry.v !== LOG_VERSION) {
      throw new Error(`练习记录 .repa/log.jsonl 第 ${index + 1} 行的格式版本是 ${String(entry.v)}，这一版的 Repa 只读版本 ${LOG_VERSION}。`);
    }
    entries.push(entry);
  }
  return entries;
}

/** 追加一行，返回写入的完整记录。 */
export async function appendLog(root: string, entry: NewEntry): Promise<LogEntry> {
  const full = { v: LOG_VERSION, id: newId(), t: localTime(), ...entry } as LogEntry;
  await mkdir(path.dirname(logFile(root)), { recursive: true });
  await appendFile(logFile(root), `${JSON.stringify(full)}\n`);
  return full;
}
