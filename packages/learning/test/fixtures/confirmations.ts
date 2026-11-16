/**
 * 测试里的模型核对：按标准答案作答的离线“模型”，以及直接补上记录的 topic 文件（只用于搭不关心核对的场景）。
 */
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { parse } from "yaml";

import { confirmationSlots, lessonVersion, mergeConfirmations, questionRequest, type Aliases } from "../../src/check/confirm.js";
import { acceptedValues, scalarText, topicQuestions, type QuestionEntry } from "../../src/check/items.js";
import { Report } from "../../src/format/diagnostics.js";
import { loadCourse } from "../../src/format/load.js";
import type { Confirmation, Topic } from "../../src/format/schema.js";

const SCOPE = "question-lesson-v1";

/** 给一份 topic 文件补上每道要核对的题的当前记录，与 course_confirm 全部一致以后写下的相同。 */
export async function withRecords(text: string): Promise<string> {
  const topic = parse(text) as Topic;
  const records: Confirmation[] = [];
  for (const entry of topicQuestions(topic)) {
    const slots = confirmationSlots(entry, SCOPE);
    if (slots.length === 0) continue;
    records.push({ question: entry.question.id, version: await lessonVersion(entry, topic), scope: SCOPE, slots, model: "test/key", date: "2026-11-16" });
  }
  return records.length > 0 ? mergeConfirmations(text, "topic", records) : text;
}

/** 标准答案写成模型的作答：选项和排列块换成请求里的编号。只写测试课里有的选择、填空、排序。 */
function keyAnswers(entry: QuestionEntry, aliases: Aliases): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const id of confirmationSlots(entry, SCOPE)) {
    const slot = entry.question.slots.find((candidate) => candidate.id === id);
    const opaque = (value: string) => Object.entries(aliases[id] ?? {}).find(([, original]) => original === value)?.[0] ?? value;
    if (slot?.type === "choice") answers[id] = Array.isArray(slot.key) ? slot.key.map(opaque) : opaque(slot.key);
    else if (slot?.type === "text") answers[id] = scalarText(acceptedValues(slot)[0] ?? "");
    else if (slot?.type === "order") answers[id] = slot.key.map(opaque);
    else throw new Error(`测试的核对模型不会答 ${slot?.type ?? id}`);
  }
  return answers;
}

/** 模型这次请求里用户消息的文字，也就是核对请求的正文。 */
export function promptOf(context: TranscriptContext): string {
  const message = context.messages.find((entry) => entry.role === "user");
  if (message?.role !== "user") return "";
  return typeof message.content === "string" ? message.content : message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/**
 * 读课程目录里的课，算出每道题的核对请求，返回按标准答案作答的函数：收到其中一道题的请求，交回它的标准答案；
 * change 可以改写某道题的作答（题目 id → 作答 JSON 的文字）。不认得的请求交回 undefined。
 */
export async function keySolver(root: string, change: Record<string, (answers: Record<string, unknown>) => string> = {}) {
  const loaded = await loadCourse(root, new Report(), root);
  if (!loaded) throw new Error(`${root} 读不出课程`);
  const answers = new Map<string, string>();
  for (const { topic } of loaded.topics) {
    for (const entry of topicQuestions(topic)) {
      if (confirmationSlots(entry, SCOPE).length === 0) continue;
      const { request, aliases } = await questionRequest(entry, topic, SCOPE);
      const key = keyAnswers(entry, aliases);
      const rewrite = change[entry.question.id];
      answers.set(request.prompt, rewrite ? rewrite(key) : JSON.stringify({ answers: key }));
    }
  }
  return (prompt: string): string | undefined => answers.get(prompt);
}
