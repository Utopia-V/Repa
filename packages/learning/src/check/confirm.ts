/**
 * manual 作答位的模型核对：程序算不出答案的作答位（列在 manual 里），用一次隔离的模型调用独立再解。
 * 只把题目的公开部分交给模型，不给答案、解析和课程里的其他内容；模型按作答位的格式作答，
 * 再用作答位自己的判分规则与标准答案比对。全部一致时在 topic 文件的 verified 段记一条记录，
 * 不一致的列出来交给人看，不记录。
 */

import { readFile, rename, writeFile } from "node:fs/promises";

import { checkResponse, contentVersion, type Answer, type Block, type Content, type Item, type Slot } from "@repa/base/protocol";
import { Document, isMap, isSeq } from "yaml";

import { checkSchema, parseYamlFile, Report, SourceFile, type Diagnostic } from "../format/diagnostics.js";
import { loadCourse } from "../format/load.js";
import { TopicSchema, type Confirmation, type Question, type Runtime, type SlotDef, type Topic } from "../format/schema.js";
import { gradeSlot } from "./grade.js";
import { acceptedValues, inputCells, versionInput, publicItem, referenceAnswer, scalarText, topicQuestions, type QuestionEntry } from "./items.js";

/** 复习和测验题池里列了 manual 的题必须有模型核对记录；例题和练习不强制。 */
export function needsConfirmation(entry: QuestionEntry): boolean {
  return (entry.pool === "review" || entry.pool === "quiz") && (entry.question.manual?.length ?? 0) > 0;
}

/** f374d34e2 的旧证明只在这份课程运行基线下复用；不能从当前清单推定旧环境。 */
const LEGACY_RUNTIME: Runtime = {
  pyodide: "314.0.7",
  python: "3.14.2",
  packages: { numpy: "2.4.6", pandas: "3.0.2" },
  prelude: "import pandas as pd\nimport numpy as np\n",
};

/** 核对题面与判分定义，不把信用归属混入独立解题证明；请求或判分语义改变时升级 scope。 */
export async function confirmationVersion(question: Question, topic: Topic, runtime: Runtime): Promise<string> {
  return contentVersion({ definition: versionInput(question, topic), runtime: { ...runtime, prelude: runtime.prelude ?? "" } });
}

export async function currentConfirmation(topic: Topic, question: Question, runtime: Runtime): Promise<Confirmation | undefined> {
  const version = await confirmationVersion(question, topic, runtime);
  const legacy = await contentVersion(versionInput(question, topic));
  const baseline = await contentVersion(runtime) === await contentVersion(LEGACY_RUNTIME);
  const manual = question.manual ?? [];
  return (topic.verified ?? []).find((record) =>
    record.question === question.id
    && (record.scope === "question-runtime-v1" ? record.version === version : baseline && record.version === legacy)
    && manual.every((slot) => record.slots.includes(slot)));
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
  /** 一道题的结果定下来时调用，request 是这道题发给模型的请求（没有生成请求时为空）。 */
  onOutcome?: (outcome: ConfirmOutcome, request: ModelRequest | undefined) => void | Promise<void>;
}

export interface SlotDifference {
  slot: string;
  model: unknown;
  key: unknown;
}

export interface ConfirmOutcome {
  topic: string;
  question: string;
  /** 当前 question-runtime-v1 范围的核对哈希，与学习证据引用的题目版本分开。 */
  version: string;
  slots: string[];
  /** confirmed：全部一致并已记录；disagreed：有不一致，交给人看；unusable：模型的输出不合格式；skipped：没有发请求。 */
  status: "confirmed" | "disagreed" | "unusable" | "skipped";
  requests: number;
  /** 模型的原始回答，里面的选项 id 是发给模型的不透明编号。 */
  answers?: Record<string, unknown>;
  /** 编号对应的课程里的 id，见 Aliases。 */
  aliases?: Aliases;
  differences?: SlotDifference[];
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
// 把公开题面写成给模型的文字
// ---------------------------------------------------------------------------

/** 代码块带 startLine 时，每行前面写上行号，题面里说“第 3 行”才对得上。 */
function numberedCode(block: Extract<Block, { type: "code" }>): string {
  const text = block.text.replace(/\n$/, "");
  if (block.startLine === undefined) return text;
  const lines = text.split("\n");
  const start = block.startLine;
  const width = String(start + lines.length - 1).length;
  return lines.map((line, index) => `${String(start + index).padStart(width)} | ${line}`).join("\n");
}

function renderContent(content: Content | undefined): string {
  return (content ?? []).map((block) => {
    if (block.type === "markdown") return block.text;
    if (block.type === "code") return `\`\`\`${block.language}\n${numberedCode(block)}\n\`\`\``;
    return `[图：${block.alt}]`;
  }).join("\n\n");
}

/** 选项或排列块：一行文字写在编号后面；多行内容（例如多行代码）原样缩进排在编号下面。 */
function renderEntry(entry: { id: string; content: Content; label?: string }): string {
  const head = `- \`${entry.id}\`${entry.label ? `（${entry.label}）` : ""}：`;
  const text = renderContent(entry.content);
  if (!text.includes("\n")) return `${head}${text}`;
  return `${head}\n${text.split("\n").map((line) => (line === "" ? "" : `  ${line}`)).join("\n")}`;
}

/** 表格里有输入格的列；只有一列要填时，作答可以写得短一些：{行 id: 值}。 */
function inputColumns(slot: Extract<Slot, { type: "table" }>): string[] {
  const columns = new Set<string>();
  for (const row of slot.rows) for (const [column, cell] of Object.entries(row.cells)) if ("input" in cell) columns.add(column);
  return [...columns];
}

function renderSlot(slot: Slot): string {
  const lines = [`### 作答位 ${slot.id}${slot.label ? `（${slot.label}）` : ""}`];
  const prompt = renderContent(slot.prompt);
  if (prompt) lines.push(prompt);
  switch (slot.type) {
    case "choice":
      lines.push(slot.multiple
        ? "多选：答案写成选项编号的列表，可以为空列表。"
        : "单选：答案写成一个选项编号。");
      for (const option of slot.options) lines.push(renderEntry(option));
      break;
    case "text":
      lines.push(slot.format === "integer" ? "填写：答案写成一个整数。" : slot.format === "number" ? "填写：答案写成一个数。" : "填写：答案写成一段文字。");
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

const SYSTEM = [
  "你在独立解一道练习题，用来核对题目的标准答案是否正确。",
  "只根据题面作答，题目里的约定（阈值、表格内容）以题面为准。选项和排列块用给出的编号（a、b、c……）作答，编号本身没有含义。",
  "代码块左边如果有“行号 |”，行号不是代码的一部分，只用来说明“第几行”。",
  "只输出一个 JSON 对象，形如 {\"answers\": {\"作答位 id\": 答案}}，不要输出其他文字。",
].join("\n");

/** 给模型的请求：题面和全部作答位作为上下文，只要求回答需要核对的作答位。item 里的 id 要已经换成不透明的编号。 */
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
  const text = await readFile(file, "utf8");
  const report = new Report();
  const source = new SourceFile(file, file, text);
  const value = parseYamlFile(source, report);
  if (value === undefined || !checkSchema(TopicSchema, value, source, report)) throw new Error(`${file} 读不出，没有写入核对记录`);
  const records = new Map(((value as Topic).verified ?? []).map((record) => [record.question, record]));
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
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${kept.join("\n")}\n${block}`);
  await rename(temporary, file);
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
  const requested = new Map<ConfirmOutcome, ModelRequest>();

  /** 核对一道题。返回要写进 verified 的记录；没有一致的结果时返回 undefined。 */
  const confirmQuestion = async (topic: Topic, entry: QuestionEntry, outcome: ConfirmOutcome, item: Item): Promise<Confirmation | undefined> => {
    const { question } = entry;
    const slots = question.manual ?? [];
    if (!options.force && await currentConfirmation(topic, question, loaded.course.runtime)) {
      outcome.detail = "已有当前核对范围的证明";
      return undefined;
    }
    const aliased = aliasItem(item);
    outcome.aliases = aliased.aliases;
    const request = confirmationRequest(aliased.item, slots);
    options.onRequest?.(question.id, request);
    requested.set(outcome, request);
    if (options.dryRun) {
      outcome.detail = "只生成了请求";
      return undefined;
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
      judgement = judge(question, item, slots, text, aliased.aliases) ?? { answers: {}, differences: [], problems: ["输出不是要求的 JSON"] };
      outcome.answers = modelAnswers(text) ?? { 原始输出: text.slice(0, 2_000) };
    }
    if (!judgement) return undefined;
    if (judgement.problems.length > 0) {
      outcome.status = "unusable";
      outcome.detail = judgement.problems.join("；");
    } else if (judgement.differences.length > 0) {
      outcome.status = "disagreed";
      outcome.differences = judgement.differences;
    } else {
      outcome.status = "confirmed";
      return {
        question: question.id,
        version: await confirmationVersion(question, topic, loaded.course.runtime),
        scope: "question-runtime-v1",
        slots,
        model: options.model,
        date,
      };
    }
    return undefined;
  };

  for (const { topic, file } of loaded.topics) {
    if (options.topics && !options.topics.includes(topic.id)) continue;
    const changed: Confirmation[] = [];
    for (const entry of topicQuestions(topic).filter(needsConfirmation)) {
      const item = await publicItem(entry.question, topic);
      const outcome: ConfirmOutcome = {
        topic: topic.id,
        question: entry.question.id,
        version: await confirmationVersion(entry.question, topic, loaded.course.runtime),
        slots: entry.question.manual ?? [],
        status: "skipped",
        requests: 0,
      };
      outcomes.push(outcome);
      const record = await confirmQuestion(topic, entry, outcome, item);
      if (record) changed.push(record);
      await options.onOutcome?.(outcome, requested.get(outcome));
    }
    if (changed.length > 0 && !options.dryRun) await writeConfirmations(file.file, changed);
  }
  return { diagnostics: report.diagnostics, outcomes, requests };
}
