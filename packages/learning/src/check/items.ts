import {
  contentVersion, requiredCapabilities,
  type Answer, type Content, type Item, type ItemDraft, type ItemResponse, type Slot,
} from "@repa/base/protocol";
import { toContent } from "../format/markdown.js";
import {
  type CellInputDef, type ContentInput, type Fixture, type Kp, type OrderSlot, type Question, type SlotDef,
  type TableSlot, type TextMatch, type TextSlot, type Topic,
} from "../format/schema.js";

export type Scalar = string | number | boolean;

/** 作答和显示里的布尔值沿用 Python 的写法。 */
export function scalarText(value: Scalar): string {
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

export function content(input: ContentInput | undefined): Content {
  return input === undefined ? [] : toContent(input).content;
}

/** 去掉值为 undefined 的属性，严格 schema 不接受显式的 undefined。 */
function defined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

export function textMatch(slot: Pick<TextSlot, "match" | "format">): TextMatch {
  if (slot.match) return slot.match;
  if (slot.format === "integer") return "integer";
  if (slot.format === "number") return "number";
  return "text";
}

export function acceptedValues(slot: Pick<TextSlot, "key">): Scalar[] {
  if (slot.key === undefined) return [];
  return Array.isArray(slot.key) ? slot.key : [slot.key];
}

export type CellMatch = TextMatch | "choice";

/** 表格输入格：交互词汇里 table 作答位单元格的 input。 */
type TableCell = Extract<Slot, { type: "table" }>["rows"][number]["cells"][string];
export type CellInput = Extract<TableCell, { input: unknown }>["input"];

export const BOOL_OPTIONS = [{ id: "True", label: "True" }, { id: "False", label: "False" }];

export function cellInput(definition: CellInputDef): { input: CellInput; match: CellMatch } {
  if (definition === "bool") return { input: { type: "choice", options: BOOL_OPTIONS }, match: "choice" };
  if (definition === "integer") return { input: { type: "text", format: "integer" }, match: "integer" };
  if (definition === "text") return { input: { type: "text" }, match: "text" };
  if (definition.type === "choice") return { input: { type: "choice", options: definition.options }, match: "choice" };
  const { match, ...input } = definition;
  return { input: defined(input), match: textMatch({ match, format: input.format }) };
}

export type NormalCell =
  | { kind: "fixed"; text: string }
  | { kind: "input"; input: CellInput; match: CellMatch; key: Scalar };

/** 按“有 input 的列里直接写的是答案”的约定，把一格还原成固定文字或输入格。 */
export function tableCell(slot: TableSlot, row: TableSlot["rows"][number], columnId: string): NormalCell | undefined {
  const cell = row.cells[columnId];
  const column = slot.columns.find((candidate) => candidate.id === columnId);
  if (cell === undefined || column === undefined) return undefined;
  if (typeof cell === "object") {
    if ("value" in cell) return { kind: "fixed", text: cell.value };
    return { kind: "input", ...cellInput(cell.input), key: cell.key };
  }
  if (column.input !== undefined) return { kind: "input", ...cellInput(column.input), key: cell };
  return { kind: "fixed", text: scalarText(cell) };
}

export function inputCells(slot: TableSlot): { row: string; column: string; cell: Extract<NormalCell, { kind: "input" }> }[] {
  const cells: { row: string; column: string; cell: Extract<NormalCell, { kind: "input" }> }[] = [];
  for (const row of slot.rows) {
    for (const column of slot.columns) {
      const cell = tableCell(slot, row, column.id);
      if (cell?.kind === "input") cells.push({ row: row.id, column: column.id, cell });
    }
  }
  return cells;
}

/** 排列题里一块的缩进层级；没写的按 0。 */
export function itemIndent(slot: OrderSlot, id: string): number {
  return slot.indents?.[id] ?? 0;
}

/** Parsons 块的代码：code 简写，或 content 里唯一的代码块。 */
export function orderItemCode(item: OrderSlot["items"][number]): string | undefined {
  if (item.code !== undefined) return item.code;
  const blocks = content(item.content).filter((block) => block.type === "code");
  return blocks.length === 1 && blocks[0]?.type === "code" ? blocks[0].text : undefined;
}

function escapeCell(text: string): string {
  return text.replace(/[\\`*_[\]<>|]/g, (character) => `\\${character}`).replace(/\n/g, " ");
}

/** 浮点列按 Python 的写法显示：整数值也带 .0。 */
function cellDisplay(value: string | number | boolean | null, float = false): string {
  if (value === null) return "NaN";
  if (float && typeof value === "number" && Number.isInteger(value)) return `${value}.0`;
  return escapeCell(scalarText(value));
}

/** 小表夹具在题面里的样子：可选的说明加一张 GFM 表格，第一列是行索引。 */
export function dataframeMarkdown(fixture: Extract<Fixture, { kind: "dataframe" }>): string {
  const names = Object.keys(fixture.columns);
  const length = fixture.index?.length ?? fixture.columns[names[0] ?? ""]?.length ?? 0;
  const index = fixture.index ?? Array.from({ length }, (_, position) => position);
  const numeric = (values: readonly unknown[]) => values.length > 0 && values.every((value) => typeof value === "number" || value === null);
  const showIndex = fixture.showIndex ?? true;
  const header = `| ${[...(showIndex ? [escapeCell(fixture.indexHeader ?? "")] : []), ...names.map(escapeCell)].join(" | ")} |`;
  const align = `| ${[...(showIndex ? [numeric(index) ? "---:" : "---"] : []), ...names.map((name) => (numeric(fixture.columns[name] ?? []) ? "---:" : "---"))].join(" | ")} |`;
  const rows = index.map((label, position) =>
    `| ${[...(showIndex ? [cellDisplay(label)] : []), ...names.map((name) => cellDisplay(fixture.columns[name]?.[position] ?? null, fixture.dtypes?.[name] === "float"))].join(" | ")} |`);
  const table = [header, align, ...rows].join("\n");
  return fixture.caption ? `${fixture.caption}\n\n${table}` : table;
}

export function fixtureDisplay(fixture: Fixture): Content {
  if (fixture.kind === "dataframe") return [{ type: "markdown", text: dataframeMarkdown(fixture) }];
  return content(fixture.display);
}

/** 按白名单投影成学生可见的作答位；答案、比较方式、反馈、测试都不带出去。 */
export function publicSlot(slot: SlotDef): Slot {
  const base = defined({ id: slot.id, prompt: slot.prompt === undefined ? undefined : content(slot.prompt), label: slot.label, optional: slot.optional });
  switch (slot.type) {
    case "choice":
      return defined({
        ...base, type: "choice" as const,
        options: slot.options.map((option) => defined({ id: option.id, content: content(option.content), label: option.label })),
        multiple: slot.multiple, minSelected: slot.minSelected, maxSelected: slot.maxSelected, layout: slot.layout,
      });
    case "text":
      return defined({
        ...base, type: "text" as const,
        lines: slot.lines, maxLength: slot.maxLength, format: slot.format, placeholder: slot.placeholder, suffix: slot.suffix, quick: slot.quick,
      });
    case "order":
      return defined({
        ...base, type: "order" as const,
        items: slot.items.map((item) => defined({
          id: item.id,
          content: item.code !== undefined ? [{ type: "code" as const, language: "python", text: item.code }] : content(item.content),
          label: item.label,
        })),
        partial: slot.partial, indent: slot.indent,
      });
    case "table":
      return {
        ...base, type: "table",
        columns: slot.columns.map((column) => ({ id: column.id, header: column.header })),
        rows: slot.rows.map((row) => defined({
          id: row.id,
          header: row.header,
          cells: Object.fromEntries(slot.columns.flatMap((column) => {
            const cell = tableCell(slot, row, column.id);
            if (!cell) return [];
            return [[column.id, cell.kind === "fixed" ? { value: cell.text } : { input: cell.input }]];
          })),
        })),
      };
    case "code":
      return defined({ ...base, type: "code" as const, language: slot.language, starter: slot.starter, maxLines: slot.maxLines });
  }
}

export function draftItem(question: Question, topic: Topic): ItemDraft {
  const fixtures = (question.data ?? []).flatMap((name) => {
    const fixture = topic.data?.[name];
    return fixture ? fixtureDisplay(fixture) : [];
  });
  return defined({
    id: question.id,
    title: question.title,
    body: [...fixtures, ...content(question.body)],
    slots: question.slots.map(publicSlot),
  });
}

/** 有测试的作答位（代码题、按测试判的 Parsons 题）。 */
export function slotTests(slot: SlotDef) {
  if (slot.type === "code") return slot.tests;
  if (slot.type === "order") return slot.tests ?? [];
  return [];
}

/** 题目用到的全部数据夹具名：题目自己的，加上测试用到的。 */
export function questionFixtures(question: Question): string[] {
  const names = new Set(question.data ?? []);
  for (const slot of question.slots) {
    for (const test of slotTests(slot)) for (const name of test.data ?? question.data ?? []) names.add(name);
  }
  return [...names].sort();
}

/** 解释性元数据，不进内容哈希。 */
const METADATA_FIELDS = ["kind", "measures", "uses"] as const;
/** 只为检查课程而写的部分：改它们不改变学生看到什么、怎样判，不进内容哈希。 */
const CHECK_ONLY_FIELDS = ["verify", "manual"] as const;
const CHECK_ONLY_CODE_FIELDS = ["accepts", "rejects"] as const;

function without(value: object, fields: readonly string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value };
  for (const field of fields) delete copy[field];
  return copy;
}

/**
 * 内容哈希的输入：学生看到什么、怎样判，也就是题面、作答位（含答案与判分规则）、解析和测试，
 * 再加上题目和测试用到的数据夹具。去掉解释性元数据和只为检查而写的部分，免得改一个标签或核对程序
 * 就把同一道题拆成新版本。输入是作者写下的定义，YAML 的排版不影响哈希。
 */
export function versionInput(question: Question, topic: Topic): unknown {
  const definition = without(question, [...METADATA_FIELDS, ...CHECK_ONLY_FIELDS]);
  definition.slots = question.slots.map((slot) => (slot.type === "code" ? without(slot, CHECK_ONLY_CODE_FIELDS) : slot));
  const data = Object.fromEntries(questionFixtures(question).map((name) => [name, topic.data?.[name] ?? null]));
  return { question: definition, data };
}

export async function questionVersion(question: Question, topic: Topic): Promise<string> {
  return contentVersion(versionInput(question, topic));
}

export async function publicItem(question: Question, topic: Topic): Promise<Item> {
  const draft = draftItem(question, topic);
  return { ...draft, version: await questionVersion(question, topic), requires: requiredCapabilities(draft) };
}

/** 由标准答案拼出的作答。开放作答和只要求非空的小问没有标准答案，用一段示例文字代替，只供结构检查。 */
export function referenceAnswer(slot: SlotDef): Answer {
  switch (slot.type) {
    case "choice":
      return { type: "choice", selected: Array.isArray(slot.key) ? slot.key : [slot.key] };
    case "text": {
      const first = acceptedValues(slot)[0];
      return { type: "text", text: first === undefined ? "示例" : scalarText(first) };
    }
    case "order":
      return defined({ type: "order" as const, items: slot.key, indents: slot.indent === undefined ? undefined : slot.key.map((id) => itemIndent(slot, id)) });
    case "table": {
      const cells: Record<string, Record<string, Extract<Answer, { type: "table" }>["cells"][string][string]>> = {};
      for (const { row, column, cell } of inputCells(slot)) {
        cells[row] ??= {};
        cells[row][column] = cell.match === "choice"
          ? { type: "choice", selected: [scalarText(cell.key)] }
          : { type: "text", text: scalarText(cell.key) };
      }
      return { type: "table", cells };
    }
    case "code":
      return { type: "code", code: slot.solution };
  }
}

export function referenceResponse(question: Question, item: Item): ItemResponse {
  const answers = Object.fromEntries(question.slots.map((slot) => [slot.id, referenceAnswer(slot)]));
  return { item: { id: item.id, version: item.version }, answers };
}

export type Pool = "example" | "practice" | "review" | "quiz";

export interface QuestionEntry {
  kp: Kp;
  kpIndex: number;
  pool: Pool;
  question: Question;
  /** 题目在 topic 文件里的位置。 */
  at: (string | number)[];
}

export function topicQuestions(topic: Topic): QuestionEntry[] {
  const entries: QuestionEntry[] = [];
  topic.kps.forEach((kp, kpIndex) => {
    if (kp.example) entries.push({ kp, kpIndex, pool: "example", question: kp.example, at: ["kps", kpIndex, "example"] });
    for (const pool of ["practice", "review", "quiz"] as const) {
      (kp[pool] ?? []).forEach((question, index) => entries.push({ kp, kpIndex, pool, question, at: ["kps", kpIndex, pool, index] }));
    }
  });
  return entries;
}
