/**
 * 代码题的测试：检查工具和判分共用的入口。一个按测试判的作答位（代码题或带测试的 Parsons 题）的每个测试，
 * 先由执行方算出期望值，再运行候选程序，按同一套规则比较并得出结论。
 *
 * 执行方（RunTests）按 @repa/python-runner/protocol 的约定运行一批测试：判分时是前端的 python.run，
 * 页面每次调用用一个新的 Worker；课程核对时是 Node 沙箱，整门课一个解释器。以后学习者用自己装的 Python 时再加一种。
 * 第一次调用先运行全部期望任务，再运行第一份程序：期望值与程序在同一个执行方里、并在程序之前算出，
 * 程序改不到已经算出的期望值。判分只有一份程序，所以一次提交只调用一次执行方。核对时其余的候选程序各调用一次，
 * 沿用第一次算出的期望值；这要求课程的期望表达式、夹具和 setup 结果确定、不改动运行环境（见学习插件说明）。
 */
import { RepaFault } from "@repa/base";
import type { Host } from "@repa/base/plugin";
import type { Answer } from "@repa/base/protocol";
import {
  endsBatch, PYTHON_BATCH, PYTHON_RUN, PythonBatchResultSchema,
  type Fixture as RunnerFixture, type PythonProgramResult, type PythonTest, type PythonTestResult, type Runtime,
} from "@repa/python-runner/protocol";
import { Value } from "typebox/value";

import { parseDoctest, sameDoctestOutput } from "./check/doctest.js";
import { orderItemCode, slotTests } from "./check/items.js";
import { sameValue, showValue } from "./check/values.js";
import type { CodeTest, Fixture, Question, SlotDef, Topic } from "./format/schema.js";

/** 执行方交回的一批结果；runtime 是实际的运行环境，只随判分来源记下。 */
export interface TestBatch {
  runtime?: Runtime;
  tests: PythonTestResult[];
}

/** 执行方：按 python.run 的约定在同一个执行环境里依次运行这些测试，结果与输入一一对应。 */
export type RunTests = (tests: PythonTest[]) => Promise<TestBatch>;

/** 一个作答位的测试，以及每个测试运行时要用的前导、夹具和 setup。 */
export interface SlotTestPlan {
  tests: readonly CodeTest[];
  inputs: Pick<PythonTest, "prelude" | "setup" | "data">[];
}

/** 一份程序在一个测试上的结论。unavailable 是执行环境或课程出了问题，不算程序对错；not_run 是前面的测试让这一批停下了。 */
export type TestOutcome =
  | { status: "passed" }
  | { status: "failed" | "timeout"; reason: string }
  | { status: "unavailable"; reason: string }
  | { status: "not_run" };

/** 一份程序的结论：有测试失败或超时就是 incorrect，全部通过才是 correct，其余没有结论。 */
export interface ProgramOutcome {
  verdict: "correct" | "incorrect" | "unresolved";
  tests: TestOutcome[];
}

/** 一个期望任务没能给出可比较的期望值：课程的问题。 */
export interface ExpectationProblem {
  test: number;
  reason: string;
  /** 出错的期望表达式；整个任务没有运行完时省略。 */
  expression?: string;
}

/** runCodeTests 的结果。 */
export interface CodeTestRun {
  expectationProblems: ExpectationProblem[];
  /** 与传入的程序一一对应。 */
  programs: ProgramOutcome[];
  /** 执行方交回的原始结果，判分时原样记进来源。 */
  batches: TestBatch[];
}

/** 课程里的数据夹具去掉只用于题面显示的字段，就是运行器要的夹具。 */
export function runnerFixture(fixture: Fixture): RunnerFixture {
  if (fixture.kind === "python") return { kind: "python", code: fixture.code };
  return {
    kind: "dataframe",
    name: fixture.name,
    columns: fixture.columns,
    ...(fixture.index ? { index: fixture.index } : {}),
    ...(fixture.dtypes ? { dtypes: fixture.dtypes } : {}),
  };
}

/** 一个作答位的测试计划；没有测试，或者有测试用到的夹具没有定义（课程检查会报出）时返回 undefined。 */
export function slotTestPlan(question: Question, slot: SlotDef, topic: Topic, prelude: string): SlotTestPlan | undefined {
  const tests = slotTests(slot);
  if (tests.length === 0) return undefined;
  const inputs: SlotTestPlan["inputs"] = [];
  for (const test of tests) {
    const data: PythonTest["data"] = [];
    for (const label of test.data ?? question.data ?? []) {
      const fixture = topic.data?.[label];
      if (!fixture) return undefined;
      data.push({ label, fixture: runnerFixture(fixture) });
    }
    inputs.push({ prelude, setup: test.setup ?? "", data });
  }
  return { tests, inputs };
}

/** 作答拼成的程序：代码题就是作答的代码，Parsons 题把排好的块按作答的缩进拼起来，每层四个空格。 */
export function answerProgram(slot: SlotDef, answer: Answer): string | undefined {
  if (slot.type === "code" && answer.type === "code") return answer.code;
  if (slot.type !== "order" || answer.type !== "order") return undefined;
  return answer.items.map((id, position) => {
    const block = slot.items.find((item) => item.id === id);
    return `${"    ".repeat(answer.indents?.[position] ?? 0)}${block ? orderItemCode(block) ?? "" : ""}`;
  }).join("\n");
}

/** 一个测试的期望表达式，去掉重复：同一个测试里相同的期望表达式只求值一次。 */
function expectedExpressions(test: CodeTest): string[] {
  return [...new Set(Object.values(test.expect ?? {}))];
}

/**
 * 期望任务：program 为空串，在只有前导、夹具和 setup 的命名空间里依次对期望表达式求值。
 * 期望表达式只读取，不改动命名空间，所以同一个测试的表达式共用一个命名空间。
 */
function input(plan: SlotTestPlan, index: number): SlotTestPlan["inputs"][number] {
  const found = plan.inputs[index];
  if (!found) throw new Error("测试计划缺项");
  return found;
}

function expectationJob(plan: SlotTestPlan, test: CodeTest, index: number): PythonTest {
  return { id: `expected:${index}`, ...input(plan, index), program: "", captures: expectedExpressions(test), doctest: [] };
}

function programJobs(plan: SlotTestPlan, program: string): PythonTest[] {
  return plan.tests.map((test, index) => ({
    id: `test:${index}`,
    ...input(plan, index),
    program,
    captures: Object.keys(test.expect ?? {}),
    doctest: parseDoctest(test.doctest ?? "").examples.map((example) => example.source),
  }));
}

/** 调用执行方，并核对它守约：结果与输入一一对应、顺序相同，停下之后只有 not_run，停下之前没有 not_run。 */
async function runBatch(run: RunTests, jobs: PythonTest[]): Promise<TestBatch> {
  const batch = await run(jobs);
  let stopped = false;
  let kept = batch.tests.length === jobs.length;
  for (const [index, result] of batch.tests.entries()) {
    if (result.id !== jobs[index]?.id || stopped !== (result.status === "not_run")) kept = false;
    if (endsBatch(result)) stopped = true;
  }
  if (!kept) throw new RepaFault("service_failed", "执行结果与请求不符");
  return batch;
}

function hasTooLarge(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if ("t" in value && value.t === "too_large") return true;
  return Object.values(value).some(hasTooLarge);
}

/** 期望任务的结果：每个带 expect 的测试的期望值（期望表达式到序列化的值），或算不出的原因。 */
type Expectations = Map<number, { values: Record<string, unknown> } | { problem: ExpectationProblem }>;

function readExpectations(plan: SlotTestPlan, indexes: number[], results: PythonTestResult[]): Expectations {
  const expectations: Expectations = new Map();
  for (const [position, index] of indexes.entries()) {
    const result = results[position];
    const test = plan.tests[index];
    if (!test) continue;
    if (result?.status !== "completed") {
      const reason = result?.status === "timeout" ? `运行超时（${result.phase} 阶段）`
        : result?.status === "failed" ? `${result.error?.type ?? "Error"}: ${result.error?.message ?? `${result.phase} 阶段失败`}`
          : "前面的测试中断了运行";
      expectations.set(index, { problem: { test: index, reason } });
      continue;
    }
    const values: Record<string, unknown> = {};
    let problem: ExpectationProblem | undefined;
    for (const expression of expectedExpressions(test)) {
      const capture = result.result.captures[expression];
      if (!capture) problem ??= { test: index, expression, reason: "执行结果缺项" };
      else if ("error" in capture) problem ??= { test: index, expression, reason: `${capture.error.type}: ${capture.error.message}` };
      else if (hasTooLarge(capture.value)) problem ??= { test: index, expression, reason: `值太大，无法比较：${showValue(capture.value)}` };
      else values[expression] = capture.value;
    }
    expectations.set(index, problem ? { problem } : { values });
  }
  return expectations;
}

/** 比较一个测试的运行结果；expected 是 capture 表达式到期望值。 */
function compare(test: CodeTest, expected: Record<string, unknown>, result: PythonProgramResult): TestOutcome {
  const examples = parseDoctest(test.doctest ?? "").examples;
  const keys = Object.keys(test.expect ?? {});
  if (Object.keys(result.captures).length !== keys.length || keys.some((key) => !(key in result.captures)) || result.doctest.length !== examples.length) {
    return { status: "unavailable", reason: "执行结果缺项" };
  }
  // 学习者的值超过序列化上限时无从比较，不判对错。
  if (hasTooLarge(result.captures)) return { status: "unavailable", reason: "执行值过大，无法可靠比较" };
  if (result.error) return { status: "failed", reason: `运行出错：${result.error.type}: ${result.error.message}` };
  for (const key of keys) {
    const capture = result.captures[key];
    if (capture && "error" in capture) return { status: "failed", reason: `${key} 求值出错：${capture.error.type}: ${capture.error.message}` };
    const actual = capture && "value" in capture ? capture.value : undefined;
    if (!sameValue(actual, expected[key])) return { status: "failed", reason: `${key} 应为 ${showValue(expected[key])}，实际是 ${showValue(actual)}` };
  }
  if (test.stdout !== undefined && !sameDoctestOutput(test.stdout, result.stdout)) {
    return { status: "failed", reason: `打印内容应为 ${JSON.stringify(test.stdout)}，实际是 ${JSON.stringify(result.stdout)}` };
  }
  for (const [index, example] of examples.entries()) {
    const got = result.doctest[index];
    if (!got) return { status: "unavailable", reason: "执行结果缺项" };
    if (example.want.startsWith("Traceback (most recent call last):")) {
      const exception = example.want.trim().split("\n").at(-1)?.trim();
      if (got.exception?.trim() !== exception) return { status: "failed", reason: `>>> ${example.source} 应抛出 ${exception}，实际是 ${got.exception ?? got.out}` };
    } else if (got.exception || !sameDoctestOutput(example.want, got.out)) {
      return { status: "failed", reason: `>>> ${example.source} 应显示 ${JSON.stringify(example.want)}，实际是 ${got.exception ?? JSON.stringify(got.out.replace(/\n$/, ""))}` };
    }
  }
  return { status: "passed" };
}

function judgeTest(test: CodeTest, index: number, expectations: Expectations, result: PythonTestResult | undefined): TestOutcome {
  if (!result || result.status === "not_run") return { status: "not_run" };
  if (result.status !== "completed") {
    // 被测的代码在运行、求值或 doctest 时超时，是程序的问题；准备和收尾超时、任何阶段的失败是执行环境的问题。
    if (result.status === "timeout") {
      return ["program", "capture", "doctest"].includes(result.phase)
        ? { status: "timeout", reason: "运行超时" }
        : { status: "unavailable", reason: `${result.phase} 阶段超时` };
    }
    return { status: "unavailable", reason: `${result.error?.type ?? "Error"}: ${result.error?.message ?? `${result.phase} 阶段失败`}` };
  }
  let expected: Record<string, unknown> = {};
  if (test.expect) {
    const computed = expectations.get(index);
    if (!computed || "problem" in computed) return { status: "unavailable", reason: "期望值算不出来" };
    expected = Object.fromEntries(Object.entries(test.expect).map(([capture, expression]) => [capture, computed.values[expression]]));
  }
  try {
    return compare(test, expected, result.result);
  } catch {
    // 序列化的值不合约定时比较会出错，按执行结果无法识别处理，不算程序对错。
    return { status: "unavailable", reason: "执行结果无法识别" };
  }
}

function judgeProgram(plan: SlotTestPlan, expectations: Expectations, results: PythonTestResult[]): ProgramOutcome {
  const tests = plan.tests.map((test, index) => judgeTest(test, index, expectations, results[index]));
  const verdict = tests.some((test) => test.status === "failed" || test.status === "timeout") ? "incorrect"
    : tests.every((test) => test.status === "passed") ? "correct" : "unresolved";
  return { verdict, tests };
}

/**
 * 用一个执行方判若干份程序：第一次调用依次运行全部期望任务和第一份程序的测试，之后每份程序各调用一次，沿用算出的期望值。
 * 判分时只有学习者的一份程序；核对时依次是参考答案、等价写法、初始代码和错误写法。
 */
export async function runCodeTests(run: RunTests, plan: SlotTestPlan, programs: readonly string[]): Promise<CodeTestRun> {
  const [first, ...others] = programs;
  if (first === undefined) return { expectationProblems: [], programs: [], batches: [] };
  const indexes = plan.tests.flatMap((test, index) => (test.expect ? [index] : []));
  const expectations = plan.tests.flatMap((test, index) => (test.expect ? [expectationJob(plan, test, index)] : []));
  const batch = await runBatch(run, [...expectations, ...programJobs(plan, first)]);
  const computed = readExpectations(plan, indexes, batch.tests.slice(0, indexes.length));
  const outcomes = [judgeProgram(plan, computed, batch.tests.slice(indexes.length))];
  const batches = [batch];
  for (const program of others) {
    const next = await runBatch(run, programJobs(plan, program));
    batches.push(next);
    outcomes.push(judgeProgram(plan, computed, next.tests));
  }
  const expectationProblems = [...computed.values()].flatMap((entry) => ("problem" in entry ? [entry.problem] : []));
  return { expectationProblems, programs: outcomes, batches };
}

/** 判分用的执行方：经前端的 python.run 运行，前端每次调用用一个新的 Worker。结果不合约定按服务失败处理。 */
export function frontendTests(host: Host): RunTests {
  return async (tests) => {
    const reply = await host.services.call(PYTHON_RUN, { protocol: PYTHON_BATCH, tests });
    if (!Value.Check(PythonBatchResultSchema, reply)) throw new RepaFault("service_failed", "python.run 的结果不符合约定");
    return { runtime: reply.runtime, tests: reply.tests };
  };
}
