import { readFile } from "node:fs/promises";
import { Type, type Static } from "typebox";
import { RepaFault } from "@repa/base";
import type { Host } from "@repa/base/plugin";
import { contentVersion, object, parse } from "@repa/base/protocol";
import type { Question, Topic, Runtime, CodeTest } from "./format/schema.js";
import {
  PYTHON_BATCH,
  PythonBatchResultSchema,
  PythonCapabilitiesSchema,
  type PythonBatchInput,
  type PythonProgramResult,
} from "./protocol.js";
import { versionInput } from "./check/items.js";
import { sameValue, showValue } from "./check/values.js";
import { parseDoctest, sameDoctestOutput } from "./check/doctest.js";

export const ExpectedSchema = object({
  binding: Type.String(),
  values: Type.Record(Type.String(), Type.Array(Type.Record(Type.String(), Type.Unknown()))),
});
export type Expected = Static<typeof ExpectedSchema>;
export const runnerVersion = () =>
  readFile(new URL("../sandbox/runner.py", import.meta.url), "utf8").then(contentVersion);
export async function expectedBinding(
  question: Question,
  topic: Topic,
  runtime: Runtime,
  runner: string,
): Promise<string> {
  return contentVersion({ question: versionInput(question, topic), runtime, runner });
}
export async function pythonAvailable(host: Host, runtime: Runtime, runner: string): Promise<boolean> {
  try {
    const result = await host.services.call("python.run", { protocol: PYTHON_BATCH, kind: "capabilities" });
    const capability = parse(PythonCapabilitiesSchema, result);
    return (
      (await contentVersion(capability.runtime)) === (await contentVersion(runtime)) && capability.runner === runner
    );
  } catch {
    return false;
  }
}
export function programProblem(
  test: CodeTest,
  expected: Record<string, unknown>,
  result: PythonProgramResult,
): string | undefined {
  const examples = parseDoctest(test.doctest ?? "").examples;
  const missingResults =
    Object.keys(result.captures).length !== Object.keys(expected).length ||
    !Object.keys(expected).every((key) => key in result.captures) ||
    examples.length !== result.doctest.length;
  if (missingResults) {
    throw new RepaFault("service_failed", "执行结果缺项");
  }
  const tooLarge = (value: unknown): boolean =>
    value !== null &&
    typeof value === "object" &&
    (("t" in value && value.t === "too_large") || Object.values(value).some(tooLarge));
  if (tooLarge(result.captures)) {
    throw new RepaFault("service_failed", "执行值过大，无法可靠比较");
  }
  if (result.error) {
    return `运行出错：${result.error.type}: ${result.error.message}`;
  }
  for (const [expression, value] of Object.entries(expected)) {
    const capture = result.captures[expression];
    if (capture && "error" in capture) {
      return `${expression} 求值出错：${capture.error.type}: ${capture.error.message}`;
    }
    const actual = capture && "value" in capture ? capture.value : undefined;
    if (!sameValue(actual, value)) {
      return `${expression} 应为 ${showValue(value)}，实际是 ${showValue(actual)}`;
    }
  }
  if (test.stdout !== undefined && !sameDoctestOutput(test.stdout, result.stdout)) {
    return `打印内容应为 ${JSON.stringify(test.stdout)}，实际是 ${JSON.stringify(result.stdout)}`;
  }
  for (const [index, example] of examples.entries()) {
    const got = result.doctest[index];
    if (!got) {
      throw new RepaFault("service_failed", "doctest 结果缺项");
    }
    if (example.want.startsWith("Traceback (most recent call last):")) {
      const expectedException = example.want.trim().split("\n").at(-1)?.trim();
      if (got.exception?.trim() !== expectedException) {
        return `>>> ${example.source} 应抛出 ${expectedException}，实际是 ${got.exception ?? got.out}`;
      }
    } else if (got.exception || !sameDoctestOutput(example.want, got.out)) {
      return `>>> ${example.source} 应显示 ${JSON.stringify(example.want)}，实际是 ${
        got.exception ?? JSON.stringify(got.out.replace(/\n$/, ""))
      }`;
    }
  }
  return undefined;
}
export const compareProgram = (test: CodeTest, expected: Record<string, unknown>, result: PythonProgramResult) =>
  programProblem(test, expected, result) === undefined;
export async function executePython(host: Host, input: PythonBatchInput) {
  const result = parse(PythonBatchResultSchema, await host.services.call("python.run", input));
  const mismatchedExecution =
    result.submissionId !== input.submissionId ||
    result.gradeRevision !== input.gradeRevision ||
    result.runner !== input.runner ||
    (await contentVersion(result.runtime)) !== (await contentVersion(input.runtime)) ||
    result.tests.length !== input.tests.length ||
    result.tests.some((test, index) => test.id !== input.tests[index]?.id);
  if (mismatchedExecution) {
    throw new RepaFault("service_failed", "执行版本或测试顺序不匹配");
  }
  let terminated = false;
  for (const test of result.tests) {
    if ((terminated && test.status !== "not_run") || (!terminated && test.status === "not_run")) {
      throw new RepaFault("service_failed", "批次终止状态不一致");
    }
    if (test.status === "failed") {
      throw new RepaFault("service_failed", "执行环境失败");
    }
    if (test.status === "timeout") {
      if (!["program", "capture", "doctest"].includes(test.phase)) {
        throw new RepaFault("service_failed", "执行环境阶段失败");
      }
      terminated = true;
    }
  }
  return result;
}
