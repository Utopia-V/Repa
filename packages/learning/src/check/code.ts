/**
 * 在与学习者相同版本的 Pyodide 里核对题目：
 * - verify：运行作者写的核对程序，独立算出各作答位的答案，按作答位的判分规则必须判对，
 *   而且标准答案里写的每个可接受值都要与算出的答案一致；
 * - 代码题与按测试判的 Parsons 题：参考答案和 accepts 必须通过全部测试；rejects 和作答框里的初始代码
 *   必须至少错一个，否则测试还分不出这些错误。
 * 运行在沙箱里进行，结果的比较在沙箱外。
 */

import type { Answer } from "../interaction.js";
import type { Report, ValuePath } from "../format/diagnostics.js";
import type { LoadedTopic } from "../format/load.js";
import type { CodeTest, Question, SlotDef, Topic } from "../format/schema.js";
import { parseDoctest, sameDoctestOutput } from "./doctest.js";
import { gradeSlot, matchesCell, matchesText } from "./grade.js";
import {
  acceptedValues, content, inputCells, itemIndent, orderItemCode, scalarText, textMatch, topicQuestions, type QuestionEntry,
} from "./items.js";
import { slotNeedsVerification } from "./rules.js";
import { sameValue, showValue } from "./values.js";
import type { JobOutcome, SandboxRunner } from "../sandbox/session.js";

export interface CodeStats {
  verifyJobs: number;
  verifiedSlots: number;
  testRuns: number;
}

interface Context {
  runner: SandboxRunner;
  report: Report;
  loaded: LoadedTopic;
  stats: CodeStats;
  timeoutMs?: number;
}

type RunnerData = Record<string, unknown>[];

/** 题目或测试用到的数据夹具，转成运行器的格式；有夹具没定义时返回 undefined（规则检查已报告）。 */
function runnerData(names: readonly string[], topic: Topic): RunnerData | undefined {
  const data: RunnerData = [];
  for (const name of names) {
    const fixture = topic.data?.[name];
    if (!fixture) return undefined;
    data.push(fixture.kind === "dataframe"
      ? {
        kind: "dataframe", label: name, name: fixture.name, columns: fixture.columns,
        ...(fixture.index ? { index: fixture.index } : {}), ...(fixture.dtypes ? { dtypes: fixture.dtypes } : {}),
      }
      : { kind: "python", label: name, code: fixture.code });
  }
  return data;
}

function failure(outcome: JobOutcome): string | undefined {
  if (outcome.status === "timeout") return "运行超时";
  if (outcome.status === "crashed") return `运行器异常结束：${outcome.detail.slice(0, 500)}`;
  if (!outcome.ok) return `${outcome.error.type}: ${outcome.error.message}`;
  return undefined;
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

/** 运行器把算出的值写成作答的方式，见 runner.py 的 convert_answer。 */
type Shape = "text" | "display" | "id" | "ids" | { kind: "table"; cells: Record<string, "text" | "display"> };

function shapeOf(slot: SlotDef): Shape | undefined {
  if (!slotNeedsVerification(slot)) return undefined;
  switch (slot.type) {
    case "text":
      return textMatch(slot) === "output" ? "display" : "text";
    case "choice":
      return slot.multiple ? "ids" : "id";
    case "order":
      return "ids";
    case "table":
      return {
        kind: "table",
        cells: Object.fromEntries(inputCells(slot).map(({ row, column, cell }) => [`${row}/${column}`, cell.match === "output" ? "display" : "text"])),
      };
    default:
      return undefined;
  }
}

/** 把程序算出的值写成这个作答位的作答；表格缺的格和多出的格分别返回。 */
function computedAnswer(slot: SlotDef, value: unknown): { answer: Answer; missing: string[]; extra: string[] } {
  if (slot.type === "choice") {
    return { answer: { type: "choice", selected: Array.isArray(value) ? value.map(String) : [String(value)] }, missing: [], extra: [] };
  }
  if (slot.type === "order") {
    const items = Array.isArray(value) ? value.map(String) : [];
    const indents = slot.indent === undefined ? {} : { indents: items.map((id) => itemIndent(slot, id)) };
    return { answer: { type: "order", items, ...indents }, missing: [], extra: [] };
  }
  if (slot.type === "table") {
    const rows = (value ?? {}) as Record<string, Record<string, string>>;
    const cells: Extract<Answer, { type: "table" }>["cells"] = {};
    const expected = inputCells(slot);
    const missing: string[] = [];
    for (const { row, column, cell } of expected) {
      const text = rows[row]?.[column];
      if (text === undefined) {
        missing.push(`${row}/${column}`);
        continue;
      }
      cells[row] ??= {};
      cells[row][column] = cell.match === "choice" ? { type: "choice", selected: [text] } : { type: "text", text };
    }
    const inputs = new Set(expected.map(({ row, column }) => `${row}/${column}`));
    const extra = Object.entries(rows).flatMap(([row, columns]) => Object.keys(columns).map((column) => `${row}/${column}`)).filter((cell) => !inputs.has(cell));
    return { answer: { type: "table", cells }, missing, extra };
  }
  return { answer: { type: "text", text: String(value) }, missing: [], extra: [] };
}

function describeMismatch(slot: SlotDef, answer: Answer): string {
  switch (slot.type) {
    case "text":
      return `程序算出 ${answer.type === "text" ? JSON.stringify(answer.text) : "?"}，标准答案是 ${acceptedValues(slot).map((value) => JSON.stringify(scalarText(value))).join(" 或 ")}`;
    case "choice":
      return `程序算出 ${answer.type === "choice" ? answer.selected.join("、") || "（不选）" : "?"}，标准答案是 ${(Array.isArray(slot.key) ? slot.key : [slot.key]).join("、") || "（不选）"}`;
    case "order":
      return `程序算出 ${answer.type === "order" ? answer.items.join(", ") : "?"}，标准答案是 ${slot.key.join(", ")}`;
    case "table": {
      const cells = answer.type === "table" ? answer.cells : {};
      return inputCells(slot).flatMap(({ row, column, cell }) => {
        const got = cells[row]?.[column];
        if (matchesCell(cell.match, cell.key, got)) return [];
        const text = got?.type === "choice" ? got.selected[0] : got?.type === "text" ? got.text : undefined;
        return [`${row}/${column} 程序算出 ${text ?? "（缺）"}，标准答案是 ${scalarText(cell.key)}`];
      }).join("；");
    }
    default:
      return "";
  }
}

/**
 * 标准答案里程序没有证实的可接受值。程序只算出一个答案，key 里另写的值（例如多写了一个 4）
 * 要与它在同一种比较方式下相等，才算核对过。
 */
function unconfirmedValues(slot: Extract<SlotDef, { type: "text" }>, computed: string): string[] {
  const match = textMatch(slot);
  if (match === "nonempty") return [];
  return acceptedValues(slot)
    .map((value) => scalarText(value))
    .filter((value) => !matchesText(match, [asKey(match, computed)], value, slot.tolerance ?? 0));
}

/** 把算出的文字当作标准答案时的写法：数值比较方式下能读成数的，按数比较。 */
function asKey(match: string, computed: string): string | number {
  const trimmed = computed.trim();
  if (match === "integer" && /^[+-]?[0-9]+$/.test(trimmed)) return Number(trimmed);
  if (match === "number" && trimmed !== "" && Number.isFinite(Number(trimmed))) return Number(trimmed);
  return computed;
}

/** 选择题选项里的代码：{作答位: {选项: 代码}}，供核对程序逐个运行选项。 */
function optionCode(question: Question): Record<string, Record<string, string>> {
  const options: Record<string, Record<string, string>> = {};
  for (const slot of question.slots) {
    if (slot.type !== "choice") continue;
    const codes: Record<string, string> = {};
    for (const option of slot.options) {
      const code = content(option.content).find((block) => block.type === "code" && block.language === "python");
      if (code?.type === "code") codes[option.id] = code.text;
    }
    if (Object.keys(codes).length > 0) options[slot.id] = codes;
  }
  return options;
}

async function runVerify(entry: QuestionEntry, at: ValuePath, context: Context): Promise<void> {
  const { question } = entry;
  const { report, loaded } = context;
  if (question.verify === undefined) return;
  const data = runnerData(question.data ?? [], loaded.topic);
  if (!data) return;
  const verifiable = question.slots.filter((slot) => shapeOf(slot) !== undefined);
  const manual = new Set(question.manual ?? []);
  const blocks = content(question.body).flatMap((block) => (block.type === "code" && block.language === "python" ? [block.text] : []));
  const shape = Object.fromEntries(verifiable.map((slot) => [slot.id, shapeOf(slot)]));
  context.stats.verifyJobs += 1;
  const outcome = await context.runner.run({
    op: "verify", data, code: blocks.join("\n"), blocks, options: optionCode(question), script: question.verify, shape,
  }, context.timeoutMs);
  const problem = failure(outcome);
  if (problem || outcome.status !== "done" || !outcome.ok) {
    report.error("verify_failed", `verify 程序运行失败：${problem ?? ""}`, loaded.file, [...at, "verify"]);
    return;
  }
  const result = outcome.result as { answers: Record<string, unknown>; unknown: string[] };
  for (const slot of result.unknown) {
    report.error("verify_unknown_slot", `answers 里的 ${slot} 不是需要核对的作答位`, loaded.file, [...at, "verify"]);
  }
  for (const slot of verifiable) {
    const where = [...at, "slots", question.slots.indexOf(slot)];
    if (!(slot.id in result.answers)) {
      if (!manual.has(slot.id)) report.error("unverified_slot", `作答位 ${slot.id} 既没有被 verify 算出，也没有列进 manual`, loaded.file, where);
      continue;
    }
    if (manual.has(slot.id)) report.error("manual_and_verified", `${slot.id} 已经由 verify 核对，从 manual 里去掉`, loaded.file, [...at, "manual"]);
    if (slot.type === "order" && slot.alternatives) {
      report.error("verify_alternatives", `verify 只能核对一种排列；${slot.id} 有其他正确排列时，改用 tests 或列进 manual`, loaded.file, where);
      continue;
    }
    const { answer, missing, extra } = computedAnswer(slot, result.answers[slot.id]);
    if (missing.length > 0) {
      report.error("verify_incomplete", `verify 没有算出表格 ${slot.id} 的这些格：${missing.join("、")}`, loaded.file, where);
      continue;
    }
    if (extra.length > 0) {
      report.error("verify_unknown_cell", `verify 算出了表格 ${slot.id} 里不需要作答的格 ${extra.join("、")}；答案列是不是忘了写 input？`, loaded.file, where);
      continue;
    }
    const grade = gradeSlot(slot, answer);
    if (grade.verdict !== "correct") {
      report.error("answer_mismatch", `${slot.id}：${describeMismatch(slot, answer)}`, loaded.file, where);
      continue;
    }
    const unconfirmed = slot.type === "text" && answer.type === "text" ? unconfirmedValues(slot, answer.text) : [];
    if (unconfirmed.length > 0) {
      report.error("answer_mismatch", `${slot.id}：标准答案里的 ${unconfirmed.map((value) => JSON.stringify(value)).join("、")} 与程序算出的 ${JSON.stringify(answer.type === "text" ? answer.text : "")} 不一致`, loaded.file, where);
      continue;
    }
    context.stats.verifiedSlots += 1;
  }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

interface PreparedTest {
  test: CodeTest;
  data: RunnerData;
  /** expect 的期望值，由期望表达式算出。 */
  expected: Record<string, unknown>;
}

/** 先算出每个测试的期望值；期望表达式本身出错的测试不能用，返回 undefined。 */
async function prepareTests(question: Question, tests: CodeTest[], at: ValuePath, context: Context): Promise<PreparedTest[] | undefined> {
  const prepared: PreparedTest[] = [];
  let usable = true;
  for (const [index, test] of tests.entries()) {
    const data = runnerData(test.data ?? question.data ?? [], context.loaded.topic);
    if (!data) return undefined;
    const expected: Record<string, unknown> = {};
    if (test.expect) {
      const outcome = await context.runner.run({ op: "expect", data, setup: test.setup ?? "", exprs: test.expect }, context.timeoutMs);
      const problem = failure(outcome);
      if (problem || outcome.status !== "done" || !outcome.ok) {
        context.report.error("test_expect_failed", `测试“${test.name}”的期望值算不出来：${problem ?? ""}`, context.loaded.file, [...at, "tests", index]);
        usable = false;
        continue;
      }
      for (const [expression, value] of Object.entries(outcome.result as Record<string, { value?: unknown; error?: { type: string; message: string } }>)) {
        if (value.error) {
          context.report.error("test_expect_failed", `测试“${test.name}”的期望表达式 ${expression} 出错：${value.error.type}: ${value.error.message}`, context.loaded.file, [...at, "tests", index, "expect"]);
          usable = false;
        }
        expected[expression] = value.value;
      }
    }
    prepared.push({ test, data, expected });
  }
  return usable ? prepared : undefined;
}

/** 在一个测试上运行一段作答代码；通过返回 undefined，否则返回原因。 */
async function runTest(program: string, prepared: PreparedTest, context: Context): Promise<string | undefined> {
  const { test } = prepared;
  const examples = test.doctest === undefined ? [] : parseDoctest(test.doctest).examples;
  context.stats.testRuns += 1;
  const outcome = await context.runner.run({
    op: "program", data: prepared.data, setup: test.setup ?? "", program,
    captures: Object.keys(test.expect ?? {}), doctest: examples.map((example) => example.source),
  }, context.timeoutMs);
  const problem = failure(outcome);
  if (problem || outcome.status !== "done" || !outcome.ok) return problem ?? "运行失败";
  const result = outcome.result as {
    stdout: string;
    error: { type: string; message: string } | null;
    captures: Record<string, { value?: unknown; error?: { type: string; message: string } }>;
    doctest: { out: string; exception: string | null }[];
  };
  if (result.error) return `运行出错：${result.error.type}: ${result.error.message}`;
  for (const [expression, expected] of Object.entries(prepared.expected)) {
    const got = result.captures[expression];
    if (got?.error) return `${expression} 求值出错：${got.error.type}: ${got.error.message}`;
    if (!sameValue(got?.value, expected)) return `${expression} 应为 ${showValue(expected)}，实际是 ${showValue(got?.value)}`;
  }
  if (test.stdout !== undefined && !sameDoctestOutput(test.stdout, result.stdout)) {
    return `打印内容应为 ${JSON.stringify(test.stdout)}，实际是 ${JSON.stringify(result.stdout)}`;
  }
  for (const [index, example] of examples.entries()) {
    const got = result.doctest[index];
    if (!got) return "doctest 没有全部运行";
    if (example.want.startsWith("Traceback (most recent call last):")) {
      const expectedException = example.want.trim().split("\n").at(-1) ?? "";
      if (got.exception?.trim() !== expectedException.trim()) return `>>> ${example.source} 应抛出 ${expectedException}，实际是 ${got.exception ?? got.out.trim()}`;
    } else if (got.exception) {
      return `>>> ${example.source} 出错：${got.exception}`;
    } else if (!sameDoctestOutput(example.want, got.out)) {
      return `>>> ${example.source} 应显示 ${JSON.stringify(example.want)}，实际是 ${JSON.stringify(got.out.replace(/\n$/, ""))}`;
    }
  }
  return undefined;
}

async function failingTests(program: string, tests: PreparedTest[], context: Context): Promise<string[]> {
  const failed: string[] = [];
  for (const prepared of tests) {
    const reason = await runTest(program, prepared, context);
    if (reason) failed.push(`“${prepared.test.name}”：${reason}`);
  }
  return failed;
}

/** 把排好的块按各自的缩进拼成程序，每层四个空格。 */
export function assembleParsons(slot: Extract<SlotDef, { type: "order" }>, items: readonly string[]): string {
  return items.map((id) => {
    const block = slot.items.find((item) => item.id === id);
    const code = block ? orderItemCode(block) ?? "" : "";
    return `${"    ".repeat(itemIndent(slot, id))}${code}`;
  }).join("\n");
}

async function runSlotTests(question: Question, slot: SlotDef, at: ValuePath, context: Context): Promise<void> {
  const { report, loaded } = context;
  if (slot.type !== "code" && !(slot.type === "order" && slot.tests)) return;
  const tests = slot.type === "code" ? slot.tests : slot.tests ?? [];
  const prepared = await prepareTests(question, tests, at, context);
  if (!prepared) return;
  const reference = slot.type === "code" ? slot.solution : assembleParsons(slot, slot.key);
  const referenceFailures = await failingTests(reference, prepared, context);
  if (referenceFailures.length > 0) {
    report.error("solution_failed", `参考答案没有通过测试：${referenceFailures.join("；")}`, loaded.file, [...at, slot.type === "code" ? "solution" : "key"]);
  }
  const accepts = slot.type === "code"
    ? (slot.accepts ?? []).map((code, index) => ({ code, where: ["accepts", index] }))
    : (slot.alternatives ?? []).map((items, index) => ({ code: assembleParsons(slot, items), where: ["alternatives", index] }));
  for (const accepted of accepts) {
    const failed = await failingTests(accepted.code, prepared, context);
    if (failed.length > 0) report.error("accept_failed", `应当通过的写法没有通过：${failed.join("；")}`, loaded.file, [...at, ...accepted.where]);
  }
  if (slot.type !== "code") return;
  // 作答框里的初始代码是要学生改的；它若已经通过全部测试，测试就分不出学生有没有改对。
  if ((await failingTests(slot.starter, prepared, context)).length === 0) {
    report.error("starter_passes", "作答框里的初始代码已经通过了全部测试", loaded.file, [...at, "starter"]);
  }
  for (const [index, rejected] of (slot.rejects ?? []).entries()) {
    const failed = await failingTests(rejected.code, prepared, context);
    if (failed.length === 0) {
      report.error("reject_passed", `错误写法（${rejected.why}）通过了全部测试，测试还不能区分这个错误`, loaded.file, [...at, "rejects", index]);
    }
  }
}

// ---------------------------------------------------------------------------

export async function checkTopicCode(loaded: LoadedTopic, runner: SandboxRunner, report: Report, stats: CodeStats, timeoutMs?: number): Promise<void> {
  const context: Context = { runner, report, loaded, stats, ...(timeoutMs ? { timeoutMs } : {}) };
  for (const entry of topicQuestions(loaded.topic)) {
    await runVerify(entry, entry.at, context);
    for (const [index, slot] of entry.question.slots.entries()) {
      await runSlotTests(entry.question, slot, [...entry.at, "slots", index], context);
    }
  }
}
