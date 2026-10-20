import { readFile } from "node:fs/promises";
import { Type, type Static } from "typebox";
import { RepaFault } from "@repa/base";
import type { Host } from "@repa/base/plugin";
import { contentVersion, object, parse } from "@repa/base/protocol";
import { FixtureSchema, RuntimeSchema, type Question, type Topic, type Runtime, type CodeTest } from "./format/schema.js";
import { versionInput } from "./check/items.js";
import { sameValue, showValue } from "./check/values.js";
import { parseDoctest, sameDoctestOutput } from "./check/doctest.js";

// #51 补齐有序批次、实际版本及阶段归因后，在此薄适配层改用协议导出；公开 protocol.ts 不重复定义。
export const PYTHON_BATCH = "repa-python-batch-v1";
const error = object({ type: Type.String(), message: Type.String() });
export const ProgramResultSchema = object({
  stdout: Type.String(), error: Type.Union([object({ ...error.properties, line: Type.Optional(Type.Union([Type.Integer(), Type.Null()])) }), Type.Null()]),
  captures: Type.Record(Type.String(), Type.Union([object({ value: Type.Unknown() }), object({ error })])),
  doctest: Type.Array(object({ out: Type.String(), exception: Type.Union([Type.String(), Type.Null()]) })),
});
const execution = object({
  id: Type.String(), program: Type.String(), prelude: Type.String(), setup: Type.String(),
  data: Type.Array(object({ label: Type.String(), fixture: FixtureSchema })),
  captures: Type.Array(Type.String()), doctest: Type.Array(Type.String()),
});
export const BatchInputSchema = object({ protocol: Type.Literal(PYTHON_BATCH), kind: Type.Literal("execute"), submissionId: Type.String(), gradeRevision: Type.Integer({ minimum: 1 }), runtime: RuntimeSchema, runner: Type.String(), tests: Type.Array(execution) });
const phase = Type.Enum(["prepare", "program", "capture", "doctest", "cleanup"]);
export const BatchResultSchema = object({
  protocol: Type.Literal(PYTHON_BATCH), submissionId: Type.String(), gradeRevision: Type.Integer({ minimum: 1 }), runtime: RuntimeSchema, runner: Type.String(), freshInterpreter: Type.Literal(true),
  tests: Type.Array(Type.Union([
    object({ id: Type.String(), status: Type.Literal("completed"), result: ProgramResultSchema }),
    object({ id: Type.String(), status: Type.Enum(["timeout", "failed"]), phase, error: Type.Optional(error) }),
    object({ id: Type.String(), status: Type.Literal("not_run") }),
  ])),
});
export const ExpectedSchema = object({ binding: Type.String(), values: Type.Record(Type.String(), Type.Array(Type.Record(Type.String(), Type.Unknown()))) });
export type Expected = Static<typeof ExpectedSchema>;
export type BatchInput = Static<typeof BatchInputSchema>;
export type ProgramResult = Static<typeof ProgramResultSchema>;
export const runnerVersion = () => readFile(new URL("../sandbox/runner.py", import.meta.url), "utf8").then(contentVersion);
export async function expectedBinding(question: Question, topic: Topic, runtime: Runtime, runner: string): Promise<string> {
  return contentVersion({ question: versionInput(question, topic), runtime, runner });
}
export async function pythonAvailable(host: Host, runtime: Runtime, runner: string): Promise<boolean> {
  try {
    const result = await host.services.call("python.run", { protocol: PYTHON_BATCH, kind: "capabilities" });
    const capability = parse(object({ protocol: Type.Literal(PYTHON_BATCH), runtime: RuntimeSchema, runner: Type.String(), freshInterpreter: Type.Literal(true) }), result);
    return await contentVersion(capability.runtime) === await contentVersion(runtime) && capability.runner === runner;
  } catch {
    return false;
  }
}
export function programProblem(test: CodeTest, expected: Record<string, unknown>, result: ProgramResult): string | undefined {
  const examples = parseDoctest(test.doctest ?? "").examples;
  if (Object.keys(result.captures).length !== Object.keys(expected).length || !Object.keys(expected).every((key) => key in result.captures) || examples.length !== result.doctest.length) throw new RepaFault("service_failed", "执行结果缺项");
  const tooLarge = (value: unknown): boolean => value !== null && typeof value === "object"
    && (("t" in value && value.t === "too_large") || Object.values(value).some(tooLarge));
  if (tooLarge(result.captures)) throw new RepaFault("service_failed", "执行值过大，无法可靠比较");
  if (result.error) return `运行出错：${result.error.type}: ${result.error.message}`;
  for (const [expression, value] of Object.entries(expected)) {
    const capture = result.captures[expression];
    if (capture && "error" in capture) return `${expression} 求值出错：${capture.error.type}: ${capture.error.message}`;
    const actual = capture && "value" in capture ? capture.value : undefined;
    if (!sameValue(actual, value)) return `${expression} 应为 ${showValue(value)}，实际是 ${showValue(actual)}`;
  }
  if (test.stdout !== undefined && !sameDoctestOutput(test.stdout, result.stdout)) return `打印内容应为 ${JSON.stringify(test.stdout)}，实际是 ${JSON.stringify(result.stdout)}`;
  for (const [index, example] of examples.entries()) {
    const got = result.doctest[index];
    if (!got) throw new RepaFault("service_failed", "doctest 结果缺项");
    if (example.want.startsWith("Traceback (most recent call last):")) {
      const expectedException = example.want.trim().split("\n").at(-1)?.trim();
      if (got.exception?.trim() !== expectedException) return `>>> ${example.source} 应抛出 ${expectedException}，实际是 ${got.exception ?? got.out}`;
    } else if (got.exception || !sameDoctestOutput(example.want, got.out)) {
      return `>>> ${example.source} 应显示 ${JSON.stringify(example.want)}，实际是 ${got.exception ?? JSON.stringify(got.out.replace(/\n$/, ""))}`;
    }
  }
  return undefined;
}
export const compareProgram = (test: CodeTest, expected: Record<string, unknown>, result: ProgramResult) => programProblem(test, expected, result) === undefined;
export async function executePython(host: Host, input: BatchInput) {
  const result = parse(BatchResultSchema, await host.services.call("python.run", input));
  if (result.submissionId !== input.submissionId || result.gradeRevision !== input.gradeRevision || result.runner !== input.runner || await contentVersion(result.runtime) !== await contentVersion(input.runtime)
    || result.tests.length !== input.tests.length || result.tests.some((test, index) => test.id !== input.tests[index]?.id)) throw new RepaFault("service_failed", "执行版本或测试顺序不匹配");
  let terminated = false;
  for (const test of result.tests) {
    if ((terminated && test.status !== "not_run") || (!terminated && test.status === "not_run")) throw new RepaFault("service_failed", "批次终止状态不一致");
    if (test.status === "failed") throw new RepaFault("service_failed", "执行环境失败");
    if (test.status === "timeout") {
      if (!["program", "capture", "doctest"].includes(test.phase)) throw new RepaFault("service_failed", "执行环境阶段失败");
      terminated = true;
    }
  }
  return result;
}
