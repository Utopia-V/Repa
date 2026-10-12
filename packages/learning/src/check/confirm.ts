/**
 * manual 作答位的模型核对：程序算不出答案的作答位（列在 manual 里），用一次隔离的模型调用独立再解。
 * 只把题目的公开部分交给模型，不给答案、解析和课程里的其他内容；模型按作答位的格式作答，
 * 再用作答位自己的判分规则与标准答案比对。全部一致时在 topic 文件的 verified 段记一条记录，
 * 不一致的列出来交给人看，不记录。
 */

import { readFile, writeFile } from "node:fs/promises";

import { checkResponse, type Answer, type Content, type Item, type Slot } from "@repa/base/protocol";
import { Document, isMap, isSeq } from "yaml";

import { Report, type Diagnostic } from "../format/diagnostics.js";
import { loadCourse } from "../format/load.js";
import type { Confirmation, Question, SlotDef, Topic } from "../format/schema.js";
import { gradeSlot } from "./grade.js";
import { acceptedValues, inputCells, publicItem, referenceAnswer, scalarText, topicQuestions, type QuestionEntry } from "./items.js";

/** 复习和测验题池里列了 manual 的题必须有模型核对记录；例题和练习不强制。 */
export function needsConfirmation(entry: QuestionEntry): boolean {
  return (entry.pool === "review" || entry.pool === "quiz") && (entry.question.manual?.length ?? 0) > 0;
}

/** 这道题当前版本、覆盖全部 manual 作答位的核对记录。 */
export function currentConfirmation(topic: Topic, question: Question, version: string): Confirmation | undefined {
  const manual = question.manual ?? [];
  return (topic.verified ?? []).find((record) =>
    record.question === question.id && record.version === version && manual.every((slot) => record.slots.includes(slot)));
}

export interface ModelRequest {
  system: string;
  prompt: string;
}

export interface ConfirmOptions {
  /** 发一次隔离的模型请求，返回模型的文字输出。 */
  complete: (request: ModelRequest) => Promise<string>;
  /** 记进核对记录的模型，写成 provider/id。 */
  model: string;
  /** 这次最多发多少次请求（含格式不对时的重试）。 */
  maxRequests: number;
  topics?: string[];
  /** 已有当前版本的记录也重新核对。 */
  force?: boolean;
  /** 只生成要发的请求，不调用模型、不写文件。 */
  dryRun?: boolean;
  /** 记录里的日期，缺省为今天。 */
  date?: string;
  base?: string;
  onRequest?: (question: string, request: ModelRequest) => void;
}

export interface SlotDifference {
  slot: string;
  model: unknown;
  key: unknown;
}

export interface ConfirmOutcome {
  topic: string;
  question: string;
  version: string;
  slots: string[];
  /** confirmed：全部一致并已记录；disagreed：有不一致，交给人看；unusable：模型的输出不合格式；skipped：没有发请求。 */
  status: "confirmed" | "disagreed" | "unusable" | "skipped";
  requests: number;
  answers?: Record<string, unknown>;
  differences?: SlotDifference[];
  detail?: string;
}

export interface ConfirmResult {
  diagnostics: Diagnostic[];
  outcomes: ConfirmOutcome[];
  requests: number;
}

// ---------------------------------------------------------------------------
// 把公开题面写成给模型的文字
// ---------------------------------------------------------------------------

function renderContent(content: Content | undefined): string {
  return (content ?? []).map((block) => {
    if (block.type === "markdown") return block.text;
    if (block.type === "code") return `\`\`\`${block.language}\n${block.text}\n\`\`\``;
    return `[图：${block.alt}]`;
  }).join("\n\n");
}

function inline(content: Content): string {
  return renderContent(content).replace(/\n+/g, " ");
}

function renderSlot(slot: Slot): string {
  const lines = [`### 作答位 ${slot.id}${slot.label ? `（${slot.label}）` : ""}`];
  const prompt = renderContent(slot.prompt);
  if (prompt) lines.push(prompt);
  switch (slot.type) {
    case "choice":
      lines.push(slot.multiple
        ? "多选：答案写成选项 id 的列表，可以为空列表。"
        : "单选：答案写成一个选项 id。");
      for (const option of slot.options) lines.push(`- \`${option.id}\`：${inline(option.content)}`);
      break;
    case "text":
      lines.push(slot.format === "integer" ? "填写：答案写成一个整数。" : slot.format === "number" ? "填写：答案写成一个数。" : "填写：答案写成一段文字。");
      if (slot.quick) lines.push(`可以直接填的固定文字：${slot.quick.join("、")}`);
      break;
    case "order":
      lines.push(`排列：${slot.partial ? "挑出需要的块" : "用上全部的块"}，按顺序写成块 id 的列表${slot.indent === undefined ? "" : `；另给出与之等长的缩进层级列表（0 到 ${slot.indent}），写成 {"items": [...], "indents": [...]}`}。`);
      for (const item of slot.items) lines.push(`- \`${item.id}\`：${inline(item.content)}`);
      break;
    case "table": {
      lines.push("表格：答案写成 {行 id: {列 id: 值}}，只写标着“待填”的格；选择格写选项 id。");
      lines.push(`| 行 id | ${slot.columns.map((column) => column.header).join(" | ")} |`);
      lines.push(`| --- | ${slot.columns.map(() => "---").join(" | ")} |`);
      for (const row of slot.rows) {
        const cells = slot.columns.map((column) => {
          const cell = row.cells[column.id];
          if (!cell) return "";
          if ("value" in cell) return cell.value;
          const options = cell.input.type === "choice" ? `，可选 ${cell.input.options.map((option) => option.id).join("/")}` : "";
          return `待填 ${row.id}/${column.id}${options}`;
        });
        lines.push(`| ${row.id} | ${cells.join(" | ")} |`);
      }
      break;
    }
    case "code":
      lines.push("代码：答案写成完整的代码字符串。");
      lines.push(`\`\`\`${slot.language}\n${slot.starter}\n\`\`\``);
      break;
  }
  return lines.join("\n");
}

const SYSTEM = [
  "你在独立解一道练习题，用来核对题目的标准答案是否正确。",
  "只根据题面作答，题目里的约定（阈值、表格内容）以题面为准。",
  "只输出一个 JSON 对象，形如 {\"answers\": {\"作答位 id\": 答案}}，不要输出其他文字。",
].join("\n");

/** 给模型的请求：题面和全部作答位作为上下文，只要求回答需要核对的作答位。 */
export function confirmationRequest(item: Item, slots: string[]): ModelRequest {
  const body = renderContent(item.body);
  const prompt = [
    "## 题目",
    item.title ? `**${item.title}**\n\n${body}` : body,
    "## 作答位",
    ...item.slots.map(renderSlot),
    "## 要回答的作答位",
    `只回答这些作答位：${slots.join("、")}。`,
  ].join("\n\n");
  return { system: SYSTEM, prompt };
}

// ---------------------------------------------------------------------------
// 把模型的输出读成作答
// ---------------------------------------------------------------------------

function modelAnswers(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, ""));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const answers = (value as Record<string, unknown>).answers;
    return typeof answers === "object" && answers !== null && !Array.isArray(answers) ? answers as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

const asText = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

/** 按作答位的形状把模型给的值写成作答；形状不对时返回 undefined。 */
function toAnswer(slot: SlotDef, value: unknown): Answer | undefined {
  switch (slot.type) {
    case "choice":
      if (slot.multiple) return Array.isArray(value) ? { type: "choice", selected: value.map(asText) } : undefined;
      return typeof value === "string" ? { type: "choice", selected: [value] } : undefined;
    case "text":
      return typeof value === "string" || typeof value === "number" ? { type: "text", text: String(value) } : undefined;
    case "order": {
      const items = Array.isArray(value) ? value : (value as { items?: unknown } | null)?.items;
      if (!Array.isArray(items)) return undefined;
      const indents = (value as { indents?: unknown } | null)?.indents;
      return {
        type: "order", items: items.map(asText),
        ...(slot.indent !== undefined && Array.isArray(indents) ? { indents: indents.map(Number) } : {}),
      };
    }
    case "table": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
      const rows = value as Record<string, Record<string, unknown> | undefined>;
      const cells: Extract<Answer, { type: "table" }>["cells"] = {};
      for (const { row, column, cell } of inputCells(slot)) {
        const given = rows[row]?.[column];
        if (given === undefined) continue;
        cells[row] ??= {};
        cells[row][column] = cell.match === "choice" ? { type: "choice", selected: [asText(given)] } : { type: "text", text: asText(given) };
      }
      return { type: "table", cells };
    }
    case "code":
      return typeof value === "string" ? { type: "code", code: value } : undefined;
  }
}

function keyOf(slot: SlotDef): unknown {
  switch (slot.type) {
    case "choice":
      return slot.key;
    case "text":
      return acceptedValues(slot).map(scalarText);
    case "order":
      return slot.key;
    case "table":
      return Object.fromEntries(inputCells(slot).map(({ row, column, cell }) => [`${row}/${column}`, scalarText(cell.key)]));
    case "code":
      return slot.solution;
  }
}

interface Judgement {
  answers: Record<string, Answer>;
  differences: SlotDifference[];
  problems: string[];
}

/** 读出模型的作答，做结构检查，再逐个 manual 作答位按判分规则比对。 */
function judge(question: Question, item: Item, slots: string[], text: string): Judgement | undefined {
  const raw = modelAnswers(text);
  if (!raw) return undefined;
  const answers: Record<string, Answer> = {};
  const problems: string[] = [];
  for (const id of slots) {
    const slot = question.slots.find((candidate) => candidate.id === id);
    const answer = slot ? toAnswer(slot, raw[id]) : undefined;
    if (answer) answers[id] = answer;
    else problems.push(`${id} 没有按格式作答`);
  }
  if (problems.length > 0) return { answers, differences: [], problems };
  // 其他作答位用标准答案补齐，只为让结构检查看完整份作答；比对只看需要核对的作答位。
  const response = {
    item: { id: item.id, version: item.version },
    answers: { ...Object.fromEntries(question.slots.map((slot) => [slot.id, referenceAnswer(slot)])), ...answers },
  };
  const structure = checkResponse(item, response);
  if (!structure.ok) {
    const relevant = structure.problems.filter((problem) => problem.slot === undefined || slots.includes(problem.slot));
    if (relevant.length > 0) return { answers, differences: [], problems: relevant.map((problem) => `${problem.slot ?? "题目"}：${problem.message}`) };
  }
  const differences: SlotDifference[] = [];
  for (const id of slots) {
    const slot = question.slots.find((candidate) => candidate.id === id);
    if (!slot) continue;
    const grade = gradeSlot(slot, answers[id]);
    if (grade.verdict !== "correct") differences.push({ slot: id, model: raw[id], key: keyOf(slot) });
  }
  return { answers, differences, problems: [] };
}

// ---------------------------------------------------------------------------
// 写回 topic 文件
// ---------------------------------------------------------------------------

/** 用新记录替换 topic 文件末尾的 verified 段；文件其余部分逐字不动。 */
export async function writeConfirmations(file: string, records: Confirmation[]): Promise<void> {
  const text = await readFile(file, "utf8");
  const lines = text.replace(/\n+$/, "").split("\n");
  const start = lines.findIndex((line) => /^verified:/.test(line));
  let kept = lines;
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && !/^[^\s#]/.test(lines[end] ?? "")) end++;
    kept = [...lines.slice(0, start), ...lines.slice(end)];
  }
  while (kept.length > 0 && kept.at(-1)?.trim() === "") kept.pop();
  const sorted = [...records].sort((left, right) => left.question.localeCompare(right.question));
  const document = new Document({ verified: sorted });
  // 作答位列表写成一行，记录读起来紧凑一些。
  const list = document.get("verified");
  if (isSeq(list)) for (const record of list.items) if (isMap(record)) { const slots = record.get("slots", true); if (isSeq(slots)) slots.flow = true; }
  const block = sorted.length > 0 ? `\n${document.toString({ lineWidth: 0, flowCollectionPadding: false })}` : "\n";
  await writeFile(file, `${kept.join("\n")}\n${block}`);
}

function today(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 对课程里需要模型核对的题逐个核对；一致的写进各自 topic 文件的 verified 段。 */
export async function confirmCourse(root: string, options: ConfirmOptions): Promise<ConfirmResult> {
  const report = new Report();
  const loaded = await loadCourse(root, report, options.base);
  const outcomes: ConfirmOutcome[] = [];
  let requests = 0;
  if (!loaded) return { diagnostics: report.diagnostics, outcomes, requests };
  const date = options.date ?? today();
  for (const { topic, file } of loaded.topics) {
    if (options.topics && !options.topics.includes(topic.id)) continue;
    const records = new Map((topic.verified ?? []).map((record) => [record.question, record]));
    let changed = false;
    for (const entry of topicQuestions(topic).filter(needsConfirmation)) {
      const { question } = entry;
      const item = await publicItem(question, topic);
      const slots = question.manual ?? [];
      const outcome: ConfirmOutcome = { topic: topic.id, question: question.id, version: item.version, slots, status: "skipped", requests: 0 };
      outcomes.push(outcome);
      if (!options.force && currentConfirmation(topic, question, item.version)) {
        outcome.detail = "已有当前版本的核对记录";
        continue;
      }
      const request = confirmationRequest(item, slots);
      options.onRequest?.(question.id, request);
      if (options.dryRun) {
        outcome.detail = "只生成了请求";
        continue;
      }
      let judgement: Judgement | undefined;
      // 输出不合格式时重试一次；两次都不行就交给人看。
      for (let attempt = 0; attempt < 2 && (judgement === undefined || judgement.problems.length > 0); attempt++) {
        if (requests >= options.maxRequests) {
          outcome.detail = "已到这次的请求上限";
          break;
        }
        requests++;
        outcome.requests++;
        const prompt = attempt === 0 ? request.prompt : `${request.prompt}\n\n上一次的输出不符合要求，请只输出 {"answers": {...}} 形式的 JSON。`;
        const text = await options.complete({ system: request.system, prompt });
        judgement = judge(question, item, slots, text) ?? { answers: {}, differences: [], problems: ["输出不是要求的 JSON"] };
        outcome.answers = modelAnswers(text) ?? { 原始输出: text.slice(0, 2_000) };
      }
      if (!judgement) continue;
      if (judgement.problems.length > 0) {
        outcome.status = "unusable";
        outcome.detail = judgement.problems.join("；");
      } else if (judgement.differences.length > 0) {
        outcome.status = "disagreed";
        outcome.differences = judgement.differences;
      } else {
        outcome.status = "confirmed";
        records.set(question.id, { question: question.id, version: item.version, slots, model: options.model, date });
        changed = true;
      }
    }
    if (changed && !options.dryRun) await writeConfirmations(file.file, [...records.values()]);
  }
  return { diagnostics: report.diagnostics, outcomes, requests };
}
