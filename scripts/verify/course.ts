/**
 * 走查用的课（scripts/verify/course/）：给假模型的“做课”剧本提供文件内容，给课程核对算出标准答案，
 * 给界面上作答提供每道题的答案。
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse } from "yaml";

import { REPO } from "./app.js";

export const COURSE = fileURLToPath(new URL("./course", import.meta.url));

interface Option {
  id: string;
  content: string;
}

export interface SlotDefinition {
  id: string;
  type: string;
  options?: Option[];
  multiple?: boolean;
  key?: unknown;
  rubric?: unknown[];
}

export interface QuestionDefinition {
  id: string;
  body: string;
  slots: SlotDefinition[];
}

/** 课的文件：相对 course/ 的路径和内容。 */
export async function courseFiles(): Promise<{ path: string; content: string }[]> {
  const files = [{ path: "course.yaml", content: await readFile(path.join(COURSE, "course.yaml"), "utf8") }];
  for (const name of (await readdir(path.join(COURSE, "topics"))).sort()) {
    files.push({ path: `topics/${name}`, content: await readFile(path.join(COURSE, "topics", name), "utf8") });
  }
  return files;
}

interface Topic {
  id: string;
  kps: { example?: QuestionDefinition; practice?: QuestionDefinition[]; review?: QuestionDefinition[]; quiz?: QuestionDefinition[] }[];
}

/** 全部题目，按 id 查。 */
export async function courseQuestions(): Promise<Map<string, QuestionDefinition>> {
  const questions = new Map<string, QuestionDefinition>();
  for (const file of await courseFiles()) {
    if (!file.path.startsWith("topics/")) continue;
    const topic = parse(file.content) as Topic;
    for (const kp of topic.kps) {
      for (const question of [kp.example, ...(kp.practice ?? []), ...(kp.review ?? []), ...(kp.quiz ?? [])]) {
        if (question) questions.set(question.id, question);
      }
    }
  }
  return questions;
}

/**
 * 课程核对时发给模型的题面与应答：用学习插件自己的 loadCourse 和 questionRequest 生成与 course_confirm 完全相同的请求文字，
 * 答案按标准答案写，选项换成请求里的不透明编号。root 是课的目录，缺省是走查的课；改过答案以后传改后的目录。
 */
export async function confirmationAnswers(root = COURSE): Promise<Map<string, string>> {
  const dist = path.join(REPO, "packages/learning/dist");
  const confirm = await import(pathToFileURL(path.join(dist, "check/confirm.js")).href) as typeof import("../../packages/learning/dist/check/confirm.js");
  const items = await import(pathToFileURL(path.join(dist, "check/items.js")).href) as typeof import("../../packages/learning/dist/check/items.js");
  const load = await import(pathToFileURL(path.join(dist, "format/load.js")).href) as typeof import("../../packages/learning/dist/format/load.js");
  const diagnostics = await import(pathToFileURL(path.join(dist, "format/diagnostics.js")).href) as typeof import("../../packages/learning/dist/format/diagnostics.js");
  const report = new diagnostics.Report();
  const loaded = await load.loadCourse(root, report);
  if (!loaded) throw new Error(`读不出走查的课：${report.diagnostics.map((entry) => entry.message).join("；")}`);
  const answers = new Map<string, string>();
  for (const { topic } of loaded.topics) {
    for (const entry of items.topicQuestions(topic)) {
      const slots = confirm.confirmationSlots(entry, "question-lesson-v1");
      if (slots.length === 0) continue;
      const { request, aliases } = await confirm.questionRequest(entry, topic, "question-lesson-v1");
      const result: Record<string, unknown> = {};
      for (const id of slots) {
        const slot = entry.question.slots.find((candidate) => candidate.id === id);
        if (!slot) continue;
        // aliases[作答位] 是 编号 → 课程 id，这里反过来查。
        const alias = Object.fromEntries(Object.entries(aliases[id] ?? {}).map(([opaque, original]) => [original, opaque]));
        const key: unknown = "key" in slot ? slot.key : undefined;
        if (slot.type === "choice") result[id] = Array.isArray(key) ? key.map((value) => alias[String(value)]) : alias[String(key)];
        else result[id] = Array.isArray(key) ? key[0] : key;
      }
      answers.set(request.prompt, JSON.stringify({ answers: result }));
    }
  }
  return answers;
}
