/**
 * 在与学习者相同版本的 Pyodide 里核对题目：
 * - verify：运行作者写的核对程序，独立算出各作答位的答案，按作答位的判分规则必须判对，
 *   而且标准答案里写的每个可接受值都要与算出的答案一致；
 * - 代码题与按测试判的 Parsons 题：用判分的入口（code-tests.ts 的 runCodeTests）判参考答案和 accepts，必须全部通过；
 *   rejects 和作答框里的初始代码必须至少错一个测试，否则测试还分不出这些错误。
 * 运行在沙箱里进行，结果的比较在沙箱外。整门课共用一个解释器：每个任务从全新的命名空间开始，
 * 任务后由 runner.py 恢复常被改动的全局状态，恢复失败或超时才换新的解释器。
 */

import type { Answer } from "@repa/base/protocol";
import type { JobOutcome, SandboxRunner } from "@repa/python-runner";
import { answerProgram, runCodeTests, runnerFixture, slotTestPlan, type ProgramOutcome, type RunTests } from "../code-tests.js";
import type { Report, ValuePath } from "../format/diagnostics.js";
import type { LoadedTopic } from "../format/load.js";
import type { Question, SlotDef, Topic } from "../format/schema.js";
import { gradeSlot, matchesCell, matchesText } from "./grade.js";
import {
  acceptedValues, content, inputCells, itemIndent, referenceAnswer, scalarText, slotTests, tableCell, textMatch, topicQuestions, type QuestionEntry,
} from "./items.js";
import { slotNeedsVerification } from "./rules.js";

export interface CodeStats {
  verifyJobs: number;
  verifiedSlots: number;
  /** 运行过的测试数，包括算期望值的任务。 */
  testRuns: number;
  /** 启动过的解释器数：应是 1，加上每次超时、崩溃或恢复失败之后换的新解释器。 */
  interpreterStarts: number;
}

interface Context {
  runner: SandboxRunner;
  /** 测试的执行方：同一个沙箱，按 python.run 的约定运行。 */
  run: RunTests;
  report: Report;
  loaded: LoadedTopic;
  stats: CodeStats;
  prelude: string;
  timeoutMs?: number;
}

type RunnerData = Record<string, unknown>[];

/** 题目或测试用到的数据夹具，转成运行器的格式；有夹具没定义时返回 undefined（规则检查已报告）。 */
function runnerData(names: readonly string[], topic: Topic): RunnerData | undefined {
  const data: RunnerData = [];
  for (const name of names) {
    const fixture = topic.data?.[name];
    if (!fixture) return undefined;
    data.push({ ...runnerFixture(fixture), label: name });
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

/** 表格里固定显示的文字：{作答位: {行: {列: 文字}}}，供核对程序读到 WWPD 题写在固定格里的输入。 */
function fixedCells(question: Question): Record<string, Record<string, Record<string, string>>> {
  const cells: Record<string, Record<string, Record<string, string>>> = {};
  for (const slot of question.slots) {
    if (slot.type !== "table") continue;
    const rows: Record<string, Record<string, string>> = {};
    for (const row of slot.rows) {
      for (const column of slot.columns) {
        const cell = tableCell(slot, row, column.id);
        if (cell?.kind !== "fixed") continue;
        const columns = (rows[row.id] ??= {});
        columns[column.id] = cell.text;
      }
    }
    cells[slot.id] = rows;
  }
  return cells;
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
    op: "verify", data, code: blocks.join("\n"), blocks, options: optionCode(question), cells: fixedCells(question), script: question.verify, shape,
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

/** 一份要核对的候选程序：作答、在课程文件里的位置，以及判分应得的结论。 */
interface Candidate {
  answer: Answer;
  where: ValuePath;
  /** pass：须全部通过；fail：须至少错一个测试。 */
  expect: "pass" | "fail";
  /** 报告里怎样称呼它。 */
  label: string;
}

function candidates(slot: SlotDef): Candidate[] {
  if (slot.type === "code") {
    return [
      { answer: referenceAnswer(slot), where: ["solution"], expect: "pass", label: "参考答案" },
      ...(slot.accepts ?? []).map((code, index): Candidate => ({ answer: { type: "code", code }, where: ["accepts", index], expect: "pass", label: "应当通过的写法" })),
      // 作答框里的初始代码是要学生改的；它若已经通过全部测试，测试就分不出学生有没有改对。
      { answer: { type: "code", code: slot.starter }, where: ["starter"], expect: "fail", label: "作答框里的初始代码" },
      ...(slot.rejects ?? []).map((rejected, index): Candidate => ({
        answer: { type: "code", code: rejected.code }, where: ["rejects", index], expect: "fail", label: `错误写法（${rejected.why}）`,
      })),
    ];
  }
  if (slot.type !== "order") return [];
  const arrangement = (items: string[]): Answer => ({
    type: "order", items, ...(slot.indent === undefined ? {} : { indents: items.map((id) => itemIndent(slot, id)) }),
  });
  return [
    { answer: referenceAnswer(slot), where: ["key"], expect: "pass", label: "标准排列" },
    ...(slot.alternatives ?? []).map((items, index): Candidate => ({ answer: arrangement(items), where: ["alternatives", index], expect: "pass", label: "其他正确排列" })),
  ];
}

function reasons(slot: SlotDef, outcome: ProgramOutcome, statuses: string[]): string {
  return slotTests(slot).flatMap((test, index) => {
    const result = outcome.tests[index];
    return result && statuses.includes(result.status) && "reason" in result ? [`“${test.name}”：${result.reason}`] : [];
  }).join("；");
}

/** 核对一个按测试判的作答位：用判分的入口判每份候选程序，结论必须与候选程序该得的一致。 */
async function runSlotTests(question: Question, slot: SlotDef, at: ValuePath, context: Context): Promise<void> {
  const { report, loaded } = context;
  const plan = slotTestPlan(question, slot, loaded.topic, context.prelude);
  if (!plan) return;
  const list = candidates(slot);
  const programs = list.map((candidate) => answerProgram(slot, candidate.answer) ?? "");
  const run = await runCodeTests(context.run, plan, programs);
  for (const batch of run.batches) context.stats.testRuns += batch.tests.filter((test) => test.status !== "not_run").length;
  if (run.expectationProblems.length > 0) {
    for (const problem of run.expectationProblems) {
      const test = plan.tests[problem.test];
      const message = problem.expression === undefined
        ? `测试“${test?.name ?? ""}”的期望值算不出来：${problem.reason}`
        : `测试“${test?.name ?? ""}”的期望表达式 ${problem.expression} 出错：${problem.reason}`;
      report.error("test_expect_failed", message, loaded.file, [...at, "tests", problem.test, ...(problem.expression === undefined ? [] : ["expect"])]);
    }
    return;
  }
  for (const [index, candidate] of list.entries()) {
    const outcome = run.programs[index];
    if (!outcome) continue;
    const where = [...at, ...candidate.where];
    if (outcome.verdict === "unresolved") {
      report.error("test_unavailable", `${candidate.label}有测试无法运行：${reasons(slot, outcome, ["unavailable"])}`, loaded.file, where);
    } else if (candidate.expect === "pass" && outcome.verdict === "incorrect") {
      const failed = reasons(slot, outcome, ["failed", "timeout"]);
      if (candidate.where[0] === "accepts" || candidate.where[0] === "alternatives") report.error("accept_failed", `应当通过的写法没有通过：${failed}`, loaded.file, where);
      else report.error("solution_failed", `参考答案没有通过测试：${failed}`, loaded.file, where);
    } else if (candidate.expect === "fail" && outcome.verdict === "correct") {
      if (candidate.where[0] === "starter") report.error("starter_passes", "作答框里的初始代码已经通过了全部测试", loaded.file, where);
      else report.error("reject_passed", `${candidate.label}通过了全部测试，测试还不能区分这个错误`, loaded.file, where);
    }
  }
}

// ---------------------------------------------------------------------------

/** 核对一个 topic 的全部题目：先 verify，再逐个作答位运行测试。run 是测试的执行方，与 runner 是同一个沙箱。 */
export async function checkTopicCode(
  loaded: LoadedTopic,
  runner: SandboxRunner,
  run: RunTests,
  report: Report,
  stats: CodeStats,
  prelude: string,
  timeoutMs?: number,
): Promise<void> {
  const context: Context = { runner, run, report, loaded, stats, prelude, ...(timeoutMs ? { timeoutMs } : {}) };
  for (const entry of topicQuestions(loaded.topic)) {
    await runVerify(entry, entry.at, context);
    for (const [index, slot] of entry.question.slots.entries()) {
      await runSlotTests(entry.question, slot, [...entry.at, "slots", index], context);
    }
  }
}
