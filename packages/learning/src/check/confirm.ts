/**
 * 模型核对：用一次隔离的模型调用独立再解一道题。只把学习者看得到的部分交给模型，不给答案、解析、核对程序和别的题；
 * 模型按作答位的格式作答，再用作答位自己的判分规则与标准答案比对。全部一致时在 topic 文件的 verified 段记一条记录，
 * 不一致的列出来交回，不记录。核对范围有两种，记录里的 scope 写明是哪一种证明：
 * - question-runtime-v1：随包课程，经命令行核对复习和测验题里列在 manual 的作答位，请求里只有题面；
 * - question-lesson-v1：空间里自制的课，四个题池里全部由程序判分的作答位（代码题、按测试判的排列题和开放作答除外），
 *   请求里还有题目所属知识点的讲解：自制的课考的是课件的说法，不给讲解，模型会按通行的说法作答。
 */

import { readFile, writeFile } from "node:fs/promises";

import { move } from "@repa/base";
import { checkResponse, contentVersion, errorText, type Answer, type Content, type Item, type Slot } from "@repa/base/protocol";
import { Document, isMap, isSeq } from "yaml";

import { checkSchema, parseYamlFile, Report, SourceFile, type Diagnostic } from "../format/diagnostics.js";
import { loadCourse, type LoadedTopic } from "../format/load.js";
import { TopicSchema, type Confirmation, type ConfirmationScope, type Question, type Runtime, type SlotDef, type Topic } from "../format/schema.js";
import { contentText, entryText } from "../model-text.js";
import { gradeSlot } from "./grade.js";
import { acceptedValues, content, inputCells, versionInput, publicItem, referenceAnswer, scalarText, topicQuestions, type QuestionEntry } from "./items.js";
import { slotNeedsVerification } from "./rules.js";

/**
 * 一道题要核对的作答位；不要核对时为空。question-runtime-v1 只看复习和测验题列在 manual 里的；
 * question-lesson-v1 看四个题池里全部由程序判分的作答位，数值的（有 verify）也在内：程序算的正是写题者的读法，看不出题面的毛病。
 */
export function confirmationSlots(entry: QuestionEntry, scope: ConfirmationScope): string[] {
  if (scope === "question-lesson-v1") return entry.question.slots.filter(slotNeedsVerification).map((slot) => slot.id);
  return entry.pool === "review" || entry.pool === "quiz" ? entry.question.manual ?? [] : [];
}

/** 复习和测验题池里列了 manual 的题必须有 question-runtime-v1 的记录；例题和练习不强制。 */
export function needsConfirmation(entry: QuestionEntry): boolean {
  return confirmationSlots(entry, "question-runtime-v1").length > 0;
}

/** f374d34e2 的旧证明只在这份课程运行基线下复用；不能从当前清单推定旧环境。 */
const LEGACY_RUNTIME: Runtime = {
  pyodide: "314.0.7",
  python: "3.14.2",
  packages: { numpy: "2.4.6", pandas: "3.0.2" },
  prelude: "import pandas as pd\nimport numpy as np\n",
};

/** 核对题面与判分定义，不把信用归属混入独立解题证明；请求或判分语义改变时升级 scope。不用 Python 的课没有 runtime，按 null 计入。 */
export async function confirmationVersion(question: Question, topic: Topic, runtime: Runtime | undefined): Promise<string> {
  return contentVersion({ definition: versionInput(question, topic), runtime: runtime ? { ...runtime, prelude: runtime.prelude ?? "" } : null });
}

export async function currentConfirmation(topic: Topic, question: Question, runtime: Runtime | undefined): Promise<Confirmation | undefined> {
  const version = await confirmationVersion(question, topic, runtime);
  const legacy = await contentVersion(versionInput(question, topic));
  const baseline = runtime !== undefined && await contentVersion(runtime) === await contentVersion(LEGACY_RUNTIME);
  const manual = question.manual ?? [];
  return (topic.verified ?? []).find((record) =>
    record.question === question.id
    && (record.scope === "question-runtime-v1" ? record.version === version : baseline && record.version === legacy)
    && manual.every((slot) => record.slots.includes(slot)));
}

/**
 * question-lesson-v1 的核对哈希：请求里给模型看的全部（题面、数据、作答位、所属知识点的讲解）加上判分定义。
 * 解析不在请求里、也不影响判分，不计入，改解析不必重新核对。runtime 也不计入：请求里没有它，这几种作答位判分也不运行 Python。
 */
export async function lessonVersion(entry: QuestionEntry, topic: Topic): Promise<string> {
  const { question, data } = versionInput(entry.question, topic);
  delete question.explanation;
  return contentVersion({ question, data, lesson: entry.kp.lesson ?? null });
}

/** 这道题的核对哈希，按范围算。 */
export function scopedVersion(entry: QuestionEntry, topic: Topic, runtime: Runtime | undefined, scope: ConfirmationScope): Promise<string> {
  return scope === "question-lesson-v1" ? lessonVersion(entry, topic) : confirmationVersion(entry.question, topic, runtime);
}

/** 这道题在给定范围下的当前记录：范围、哈希都对得上，并覆盖要核对的全部作答位。 */
export async function currentRecord(topic: Topic, entry: QuestionEntry, runtime: Runtime | undefined, scope: ConfirmationScope): Promise<Confirmation | undefined> {
  if (scope === "question-runtime-v1") return currentConfirmation(topic, entry.question, runtime);
  const version = await lessonVersion(entry, topic);
  const slots = confirmationSlots(entry, scope);
  return (topic.verified ?? []).find((record) =>
    record.question === entry.question.id && record.scope === scope && record.version === version
    && slots.every((slot) => record.slots.includes(slot)));
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
  /** 核对范围，缺省 question-runtime-v1。 */
  scope?: ConfirmationScope;
  /** 同时最多有几道题在等模型的回答，缺省 1。请求之间互不相干，可以并发。 */
  concurrency?: number;
  topics?: string[];
  /** 已有当前版本的记录也重新核对。 */
  force?: boolean;
  /** 只生成要发的请求，不调用模型、不写文件。 */
  dryRun?: boolean;
  /** 记录里的日期，缺省为今天。 */
  date?: string;
  base?: string;
  onRequest?: (question: string, request: ModelRequest) => void;
  /** 一道题的结果定下来时调用，request 是这道题发给模型的请求（没有生成请求时为空）。 */
  onOutcome?: (outcome: ConfirmOutcome, request: ModelRequest | undefined) => void | Promise<void>;
  /** 一个 topic 的题都有了结果后，把这次新得到的记录写回；缺省并进课程目录里的 topic 文件（writeConfirmations）。 */
  save?: (topic: LoadedTopic, records: Confirmation[]) => Promise<void>;
}

export interface SlotDifference {
  slot: string;
  model: unknown;
  key: unknown;
}

export interface ConfirmOutcome {
  topic: string;
  question: string;
  /** 这次核对范围下的核对哈希，与学习证据引用的题目版本分开。 */
  version: string;
  slots: string[];
  /**
   * confirmed：全部一致、模型没有指出问题，已记录；noted：作答一致，但模型在 note 里指出题目有问题，不记录；
   * disagreed：有不一致；unusable：模型两次的输出都不合格式；
   * failed：请求没有得到回答（网络、额度、取消），detail 是原因；current：已有当前记录，没有发请求；
   * skipped：没有发请求，detail 写明原因（只生成请求、已到请求上限）。
   */
  status: "confirmed" | "noted" | "disagreed" | "unusable" | "failed" | "current" | "skipped";
  requests: number;
  /** 模型的原始回答，里面的选项 id 是发给模型的不透明编号。 */
  answers?: Record<string, unknown>;
  /** 编号对应的课程里的 id，见 Aliases。 */
  aliases?: Aliases;
  differences?: SlotDifference[];
  /** 模型认为题目缺条件、有歧义或不止一个答案成立时的一句说明（只有 question-lesson-v1 的请求要它写）。 */
  note?: string;
  detail?: string;
}

export interface ConfirmResult {
  diagnostics: Diagnostic[];
  outcomes: ConfirmOutcome[];
  requests: number;
}

// ---------------------------------------------------------------------------
// 选项 id 换成不透明的编号
// ---------------------------------------------------------------------------

/**
 * 发给模型的编号对应的课程 id：键是作答位 id（表格选择格是“作答位 id#行 id/列 id”），
 * 值是 {编号: 课程里的 id}。课程里的 id 可以带含义（例如 faithful），原样发给模型等于告诉它答案。
 */
export type Aliases = Record<string, Record<string, string>>;

/** a、b、…、z、aa、ab、… */
function opaqueId(index: number): string {
  let text = "";
  for (let rest = index; rest >= 0; rest = Math.floor(rest / 26) - 1) text = String.fromCharCode(97 + (rest % 26)) + text;
  return text;
}

function renamed<T extends { id: string }>(entries: T[], key: string, aliases: Aliases): T[] {
  const mapping: Record<string, string> = {};
  const result = entries.map((entry, index) => {
    const id = opaqueId(index);
    mapping[id] = entry.id;
    return { ...entry, id };
  });
  aliases[key] = mapping;
  return result;
}

/** 给模型看的题目：单选多选的选项、排列块和表格选择格的选项，id 换成按出现顺序的 a、b、c……，其余不动。 */
export function aliasItem(item: Item): { item: Item; aliases: Aliases } {
  const aliases: Aliases = {};
  const slots = item.slots.map((slot): Slot => {
    if (slot.type === "choice") return { ...slot, options: renamed(slot.options, slot.id, aliases) };
    if (slot.type === "order") return { ...slot, items: renamed(slot.items, slot.id, aliases) };
    if (slot.type !== "table") return slot;
    return {
      ...slot,
      rows: slot.rows.map((row) => ({
        ...row,
        cells: Object.fromEntries(Object.entries(row.cells).map(([column, cell]) => {
          if (!("input" in cell) || cell.input.type !== "choice") return [column, cell];
          const options = renamed(cell.input.options, `${slot.id}#${row.id}/${column}`, aliases);
          return [column, { input: { ...cell.input, options } }];
        })),
      })),
    };
  });
  return { item: { ...item, slots }, aliases };
}

/** 模型答的编号换回课程里的 id；不是编号的（模型答错了）原样留着，交给结构检查去报。 */
function original(aliases: Aliases, key: string, value: unknown): unknown {
  const mapping = aliases[key];
  return typeof value === "string" && mapping !== undefined && Object.hasOwn(mapping, value) ? mapping[value] : value;
}

// ---------------------------------------------------------------------------
// 把公开题面写成给模型的文字（内容块的写法与辅导共用，见 model-text.ts）
// ---------------------------------------------------------------------------

/** 选项或排列块：一行文字写在编号后面；多行内容（例如多行代码）原样缩进排在编号下面。 */
function renderEntry(entry: { id: string; content: Content; label?: string }): string {
  return entryText(`- \`${entry.id}\`${entry.label ? `（${entry.label}）` : ""}：`, contentText(entry.content));
}

/** 表格里有输入格的列；只有一列要填时，作答可以写得短一些：{行 id: 值}。 */
function inputColumns(slot: Extract<Slot, { type: "table" }>): string[] {
  const columns = new Set<string>();
  for (const row of slot.rows) for (const [column, cell] of Object.entries(row.cells)) if ("input" in cell) columns.add(column);
  return [...columns];
}

/** 一个作答位写成给模型的文字；lesson 时（question-lesson-v1）填空按学习者的界面说明怎样写。 */
function renderSlot(slot: Slot, lesson: boolean): string {
  const lines = [`### 作答位 ${slot.id}${slot.label ? `（${slot.label}）` : ""}`];
  const prompt = contentText(slot.prompt);
  if (prompt) lines.push(prompt);
  switch (slot.type) {
    case "choice":
      lines.push(slot.multiple
        ? "多选：答案写成选项编号的列表，可以为空列表。"
        : "单选：答案写成一个选项编号。");
      for (const option of slot.options) lines.push(renderEntry(option));
      break;
    case "text":
      lines.push(lesson ? lessonTextRule(slot) : slot.format === "integer" ? "填写：答案写成一个整数。" : slot.format === "number" ? "填写：答案写成一个数。" : "填写：答案写成一段文字。");
      if (lesson && slot.placeholder) lines.push(`输入框里的提示文字：${slot.placeholder}`);
      if (lesson && slot.suffix) lines.push(`输入框后面写着：${slot.suffix}`);
      if (slot.quick) lines.push(`可以直接填的固定文字：${slot.quick.join("、")}`);
      break;
    case "order":
      lines.push(`排列：${slot.partial ? "挑出需要的块" : "用上全部的块"}，按顺序写成块编号的列表${slot.indent === undefined ? "" : `；另给出与之等长的缩进层级列表（0 到 ${slot.indent}），写成 {"items": [...], "indents": [...]}`}。`);
      for (const item of slot.items) lines.push(renderEntry(item));
      break;
    case "table": {
      const columns = inputColumns(slot);
      lines.push(columns.length === 1
        ? `表格：只有一列要填，答案写成 {行 id: 值}，只写标着“待填”的格；选择格写选项编号。`
        : "表格：答案写成 {行 id: {列 id: 值}}，只写标着“待填”的格；选择格写选项编号。");
      lines.push(`| 行 id | ${slot.columns.map((column) => column.header).join(" | ")} |`);
      lines.push(`| --- | ${slot.columns.map(() => "---").join(" | ")} |`);
      for (const row of slot.rows) {
        const cells = slot.columns.map((column) => {
          const cell = row.cells[column.id];
          if (!cell) return "";
          if ("value" in cell) return cell.value;
          const options = cell.input.type === "choice" ? `，可选 ${cell.input.options.map((option) => `${option.id}（${option.label}）`).join("、")}` : "";
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

/**
 * question-lesson-v1 的填空说明，照学习者的界面写：学习者面前是一个短输入框，数值的给小数键盘（item-form.tsx 的 inputMode），
 * 单位写在框后面。真实模型的重放里，独立作答的一方把填空写成整句、把非整数写成分数或不舍入的长小数，与标准答案对不上，
 * 而学习者照界面不会这样写。
 */
function lessonTextRule(slot: Extract<Slot, { type: "text" }>): string {
  if (slot.format === "integer") return "填写：答案写成一个整数。";
  if (slot.format === "number") {
    return "填写：输入框给的是数字小数键盘，答案写成一个小数或整数，不写分数、百分号、单位和算式；题目说了保留几位小数就照做。";
  }
  return "填写：输入框很短，只写答案本身，用题目允许的最短写法，不写成句子，不加解释。";
}

const SYSTEM = [
  "你在独立解一道练习题，用来核对题目的标准答案是否正确。",
  "只根据题面作答，题目里的约定（阈值、表格内容）以题面为准。选项和排列块用给出的编号（a、b、c……）作答，编号本身没有含义。",
  "代码块左边如果有“行号 |”，行号不是代码的一部分，只用来说明“第几行”。",
  "只输出一个 JSON 对象，形如 {\"answers\": {\"作答位 id\": 答案}}，不要输出其他文字。",
].join("\n");

/** 带讲解的请求（question-lesson-v1）：讲解是学习者做题前读过的；另要模型在题目本身有问题时说一句，交回给写题的一方作线索。 */
const LESSON_SYSTEM = [
  "你在独立解一道练习题，用来核对题目的标准答案是否正确。",
  "前面附有这道题所属知识点的讲解，学习者做题前读过它。题目考的是讲解里的说法：讲解的定义、记号与通行说法不同时，以讲解为准。",
  "只根据讲解和题面作答，题目里的约定（阈值、表格内容）以题面为准。选项和排列块用给出的编号（a、b、c……）作答，编号本身没有含义。",
  "代码块左边如果有“行号 |”，行号不是代码的一部分，只用来说明“第几行”。",
  "只输出一个 JSON 对象，形如 {\"answers\": {\"作答位 id\": 答案}}，不要输出其他文字。",
  "题目缺条件、有歧义或不止一个答案成立时，照样按你认为最合理的读法作答，并加一个键 \"note\"，用一句话说明问题在哪里。",
].join("\n");

/**
 * 给模型的请求：题面和全部作答位作为上下文，只要求回答需要核对的作答位。item 里的 id 要已经换成不透明的编号。
 * 给了讲解时（question-lesson-v1）放在题目前面。
 */
export function confirmationRequest(item: Item, slots: string[], lesson?: Content): ModelRequest {
  const body = contentText(item.body);
  const question = [
    "## 题目",
    item.title ? `**${item.title}**\n\n${body}` : body,
    "## 作答位",
    ...item.slots.map((slot) => renderSlot(slot, lesson !== undefined)),
    "## 要回答的作答位",
    `只回答这些作答位：${slots.join("、")}。`,
  ];
  if (lesson === undefined) return { system: SYSTEM, prompt: question.join("\n\n") };
  return { system: LESSON_SYSTEM, prompt: ["## 讲解", contentText(lesson), ...question].join("\n\n") };
}

// ---------------------------------------------------------------------------
// 把模型的输出读成作答
// ---------------------------------------------------------------------------

function modelOutput(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, ""));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function modelAnswers(text: string): Record<string, unknown> | undefined {
  const answers = modelOutput(text)?.answers;
  return typeof answers === "object" && answers !== null && !Array.isArray(answers) ? answers as Record<string, unknown> : undefined;
}

/** 模型对题目本身的说明；没写或写成空串时为 undefined。 */
function modelNote(text: string): string | undefined {
  const note = modelOutput(text)?.note;
  return typeof note === "string" && note.trim() !== "" ? note.trim() : undefined;
}

const asText = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 按作答位的形状把模型给的值写成作答，选项编号换回课程里的 id；形状不对时返回 undefined。 */
function toAnswer(slot: SlotDef, value: unknown, aliases: Aliases): Answer | undefined {
  switch (slot.type) {
    case "choice":
      if (slot.multiple) return Array.isArray(value) ? { type: "choice", selected: value.map((item) => asText(original(aliases, slot.id, item))) } : undefined;
      return typeof value === "string" ? { type: "choice", selected: [asText(original(aliases, slot.id, value))] } : undefined;
    case "text":
      return typeof value === "string" || typeof value === "number" ? { type: "text", text: String(value) } : undefined;
    case "order": {
      const items = Array.isArray(value) ? value : (value as { items?: unknown } | null)?.items;
      if (!Array.isArray(items)) return undefined;
      const indents = (value as { indents?: unknown } | null)?.indents;
      return {
        type: "order", items: items.map((item) => asText(original(aliases, slot.id, item))),
        ...(slot.indent !== undefined && Array.isArray(indents) ? { indents: indents.map(Number) } : {}),
      };
    }
    case "table": {
      if (!isRecord(value)) return undefined;
      const inputs = inputCells(slot);
      const columns = [...new Set(inputs.map(({ column }) => column))];
      // 只有一列要填时，{行: 值} 也接受。
      const only = columns.length === 1 ? columns[0] : undefined;
      const cells: Extract<Answer, { type: "table" }>["cells"] = {};
      for (const { row, column, cell } of inputs) {
        const rowValue = value[row];
        const given = isRecord(rowValue) ? rowValue[column] : column === only ? rowValue : undefined;
        if (given === undefined) continue;
        cells[row] ??= {};
        cells[row][column] = cell.match === "choice"
          ? { type: "choice", selected: [asText(original(aliases, `${slot.id}#${row}/${column}`, given))] }
          : { type: "text", text: asText(given) };
      }
      return { type: "table", cells };
    }
    case "code":
      return typeof value === "string" ? { type: "code", code: value } : undefined;
  }
}

/** 模型的作答写成报告里看的样子（课程里的 id）。 */
function describeAnswer(slot: SlotDef, answer: Answer): unknown {
  switch (answer.type) {
    case "choice":
      return slot.type === "choice" && slot.multiple ? answer.selected : answer.selected[0];
    case "text":
      return answer.text;
    case "order":
      return answer.indents ? { items: answer.items, indents: answer.indents } : answer.items;
    case "table":
      return Object.fromEntries(Object.entries(answer.cells).map(([row, columns]) => [
        row, Object.fromEntries(Object.entries(columns).map(([column, cell]) => [column, cell.type === "choice" ? cell.selected[0] : cell.type === "text" ? cell.text : ""])),
      ]));
    case "code":
      return answer.code;
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
function judge(question: Question, item: Item, slots: string[], text: string, aliases: Aliases): Judgement | undefined {
  const raw = modelAnswers(text);
  if (!raw) return undefined;
  const answers: Record<string, Answer> = {};
  const problems: string[] = [];
  for (const id of slots) {
    const slot = question.slots.find((candidate) => candidate.id === id);
    const answer = slot ? toAnswer(slot, raw[id], aliases) : undefined;
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
    const answer = answers[id];
    if (!answer) continue;
    if (gradeSlot(slot, answer).verdict !== "correct") differences.push({ slot: id, model: describeAnswer(slot, answer), key: keyOf(slot) });
  }
  return { answers, differences, problems: [] };
}

// ---------------------------------------------------------------------------
// 写回 topic 文件
// ---------------------------------------------------------------------------

/**
 * 把这次新得到的记录并进 topic 文件末尾的 verified 段，文件其余部分逐字不动。
 * 并入的是写文件那一刻磁盘上的记录，不是本次开始时读到的：几个核对同时进行时，别人刚写进去的记录不会被覆盖。
 * 先写临时文件再改名，别的进程不会读到写了一半的文件。
 */
export async function writeConfirmations(file: string, changed: Confirmation[]): Promise<void> {
  const text = mergeConfirmations(await readFile(file, "utf8"), file, changed);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, text);
  await move(temporary, file);
}

/**
 * topic 文件的全文并入新记录以后的全文：同一道题的记录换成新的，文件里已经没有的题的记录去掉，
 * verified 段按题目 id 排在文件末尾，其余部分逐字不动。file 只用于报错。
 */
export function mergeConfirmations(text: string, file: string, changed: Confirmation[]): string {
  const report = new Report();
  const source = new SourceFile(file, file, text);
  const value = parseYamlFile(source, report);
  if (value === undefined || !checkSchema(TopicSchema, value, source, report)) throw new Error(`${file} 读不出，没有写入核对记录`);
  const topic = value as Topic;
  // 已经删掉的题的记录顺手去掉：题反复改不过时 Agent 会删题，不必再去改 verified 段。
  const questions = new Set(topicQuestions(topic).map((entry) => entry.question.id));
  const records = new Map((topic.verified ?? []).filter((record) => questions.has(record.question)).map((record) => [record.question, record]));
  for (const record of changed) records.set(record.question, record);

  const lines = text.replace(/\n+$/, "").split("\n");
  const start = lines.findIndex((line) => /^verified:/.test(line));
  let kept = lines;
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && !/^[^\s#]/.test(lines[end] ?? "")) end++;
    kept = [...lines.slice(0, start), ...lines.slice(end)];
  }
  while (kept.length > 0 && kept.at(-1)?.trim() === "") kept.pop();
  const sorted = [...records.values()].sort((left, right) => left.question.localeCompare(right.question));
  const document = new Document({ verified: sorted });
  // 作答位列表写成一行，记录读起来紧凑一些。
  const list = document.get("verified");
  if (isSeq(list)) for (const record of list.items) if (isMap(record)) { const slots = record.get("slots", true); if (isSeq(slots)) slots.flow = true; }
  const block = sorted.length > 0 ? `\n${document.toString({ lineWidth: 0, flowCollectionPadding: false })}` : "\n";
  return `${kept.join("\n")}\n${block}`;
}

/** 记录里的日期：time（Unix 毫秒，缺省为现在）在本地时区的 YYYY-MM-DD。 */
export function localDate(time = Date.now()): string {
  const now = new Date(time);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * 一道题发给模型的请求：学习者看到的题面（item，课程里的 id），换成不透明编号以后写成的请求，以及编号与课程 id 的对应。
 * question-lesson-v1 的请求带上所属知识点的讲解。
 */
export async function questionRequest(
  entry: QuestionEntry, topic: Topic, scope: ConfirmationScope,
): Promise<{ item: Item; aliases: Aliases; request: ModelRequest }> {
  const item = await publicItem(entry.question, topic);
  const aliased = aliasItem(item);
  const lesson = scope === "question-lesson-v1" ? content(entry.kp.lesson) : undefined;
  return { item, aliases: aliased.aliases, request: confirmationRequest(aliased.item, confirmationSlots(entry, scope), lesson) };
}

/** 对每一项运行 work，同时最多 limit 项。 */
async function eachLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < items.length; index = next++) {
      const item = items[index];
      if (item !== undefined) await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, worker));
}

/**
 * 对课程里需要模型核对的题逐个核对，已有当前记录的不再发请求。一个 topic 里的题并发核对（options.concurrency），
 * 都有了结果再把一致的写回（options.save，缺省写进课程目录里的 topic 文件）。某道题的请求失败只记在它自己的结果里，
 * 别的题照常核对和记录，整批不重试。
 */
export async function confirmCourse(root: string, options: ConfirmOptions): Promise<ConfirmResult> {
  const report = new Report();
  const loaded = await loadCourse(root, report, options.base);
  const outcomes: ConfirmOutcome[] = [];
  let requests = 0;
  if (!loaded) return { diagnostics: report.diagnostics, outcomes, requests };
  const date = options.date ?? localDate();
  const scope = options.scope ?? "question-runtime-v1";
  const runtime = loaded.course.runtime;
  const save = options.save ?? ((topic: LoadedTopic, records: Confirmation[]) => writeConfirmations(topic.file.file, records));

  /** 核对一道题。返回要写进 verified 的记录（没有一致的结果时没有）和发给模型的请求（已有当前记录时没有）。 */
  const confirmQuestion = async (topic: Topic, entry: QuestionEntry, outcome: ConfirmOutcome): Promise<{ record?: Confirmation; request?: ModelRequest }> => {
    const { question } = entry;
    const { slots } = outcome;
    if (!options.force && await currentRecord(topic, entry, runtime, scope)) {
      outcome.status = "current";
      return {};
    }
    const { item, aliases, request } = await questionRequest(entry, topic, scope);
    outcome.aliases = aliases;
    options.onRequest?.(question.id, request);
    if (options.dryRun) {
      outcome.detail = "只生成了请求";
      return { request };
    }
    let judgement: Judgement | undefined;
    // 输出不合格式时重试一次；两次都不行就交回。
    for (let attempt = 0; attempt < 2 && (judgement === undefined || judgement.problems.length > 0); attempt++) {
      if (requests >= options.maxRequests) {
        outcome.detail = "已到这次的请求上限";
        break;
      }
      requests++;
      outcome.requests++;
      const prompt = attempt === 0 ? request.prompt : `${request.prompt}\n\n上一次的输出不符合要求，请只输出 {"answers": {...}} 形式的 JSON。`;
      let text: string;
      try {
        text = await options.complete({ system: request.system, prompt });
      } catch (error) {
        outcome.status = "failed";
        outcome.detail = errorText(error);
        return { request };
      }
      judgement = judge(question, item, slots, text, aliases) ??{ answers: {}, differences: [], problems: ["输出不是要求的 JSON"] };
      outcome.answers = modelAnswers(text) ?? { 原始输出: text.slice(0, 2_000) };
      const note = modelNote(text);
      if (note === undefined) delete outcome.note;
      else outcome.note = note;
    }
    // 没有 judgement：一次也没有发，已到请求上限。
    if (!judgement) return { request };
    if (judgement.problems.length > 0) {
      outcome.status = "unusable";
      outcome.detail = judgement.problems.join("；");
      return { request };
    }
    if (judgement.differences.length > 0) {
      outcome.status = "disagreed";
      outcome.differences = judgement.differences;
      return { request };
    }
    // 答案一致而对方指出题目有问题时不记录：真实模型的重放里，这样的说明指出的都是真毛病（单选题两个选项都成立、
    // 题面要求的字数与答案不符），一致只是碰巧选中了标准答案。
    if (outcome.note !== undefined) {
      outcome.status = "noted";
      return { request };
    }
    outcome.status = "confirmed";
    return { record: { question: question.id, version: outcome.version, scope, slots, model: options.model, date }, request };
  };

  for (const loadedTopic of loaded.topics) {
    const { topic } = loadedTopic;
    if (options.topics && !options.topics.includes(topic.id)) continue;
    const jobs: { entry: QuestionEntry; outcome: ConfirmOutcome }[] = [];
    for (const entry of topicQuestions(topic)) {
      const slots = confirmationSlots(entry, scope);
      if (slots.length === 0) continue;
      const outcome: ConfirmOutcome = {
        topic: topic.id,
        question: entry.question.id,
        version: await scopedVersion(entry, topic, runtime, scope),
        slots,
        status: "skipped",
        requests: 0,
      };
      outcomes.push(outcome);
      jobs.push({ entry, outcome });
    }
    const changed: Confirmation[] = [];
    await eachLimited(jobs, options.concurrency ?? 1, async ({ entry, outcome }) => {
      const { record, request } = await confirmQuestion(topic, entry, outcome);
      if (record) changed.push(record);
      await options.onOutcome?.(outcome, request);
    });
    if (changed.length > 0) await save(loadedTopic, changed);
  }
  return { diagnostics: report.diagnostics, outcomes, requests };
}
