import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Value } from "typebox/value";

import { checkResponse } from "@repa/base/protocol";
import { publicItem, referenceResponse } from "../src/check/items.js";
import {
  checkSubmission, FeedbackSchema, PYTHON_BATCH, PythonBatchResultSchema, PythonCapabilitiesSchema, PythonRunInputSchema, readFeedback,
  readSubmitResult, SubmitResultSchema, type Feedback, type PythonBatchInput, type PythonBatchResult,
} from "../src/protocol.js";
import { demoCourse } from "./demo-course.js";

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

async function sampleItem() {
  const topic = demoCourse().topics.t01;
  const question = topic?.kps[0]?.practice?.[2];
  assert.ok(topic && question);
  const item = await publicItem(question, topic);
  return { item, reference: referenceResponse(question, item) };
}

test("平常的作答照底座检查；说“不会”时不带作答，只查题目和版本", async () => {
  const { item, reference } = await sampleItem();
  assert.deepEqual(checkSubmission(item, reference), checkResponse(item, reference));
  assert.equal(checkSubmission(item, { ...reference, answers: {} }).ok, false);

  const dontKnow = { item: reference.item, answers: {}, dontKnow: true as const };
  assert.deepEqual(checkSubmission(item, dontKnow), { ok: true });
  assert.deepEqual(checkSubmission(item, { ...reference, dontKnow: true }), { ok: false, problems: [{ message: "说“不会”时不带作答" }] });
  const stale = checkSubmission(item, { ...dontKnow, item: { id: item.id, version: `sha256:${"0".repeat(64)}` } });
  assert.equal(stale.ok, false);
  assert.equal(checkSubmission(item, { ...dontKnow, dontKnow: false } as never).ok, false);
});

test("反馈和提交结果按约定严格校验，多余字段和不认识的取值被拒", async () => {
  const { item } = await sampleItem();
  const feedback: Feedback = {
    item: { id: item.id, version: item.version },
    verdict: "partial",
    judge: "rule",
    score: { earned: 1, max: 2 },
    message: [{ type: "markdown", text: "第二问再看看。" }],
    slots: {
      line: { verdict: "incorrect", expected: { type: "choice", selected: ["minus"] }, marks: { plus: "incorrect", minus: "missed" } },
      code: { verdict: "correct", tests: [{ name: "公开例子", result: "passed" }, { name: "更多输入", result: "failed", hidden: true }] },
      why: { verdict: "pending", criteria: [{ label: "说出原因", met: "unsure" }] },
    },
  };
  assert.ok(Value.Check(FeedbackSchema, feedback));
  assert.ok(Value.Check(SubmitResultSchema, { status: "recorded", feedback }));
  assert.ok(Value.Check(SubmitResultSchema, { status: "recorded" }));
  assert.ok(Value.Check(SubmitResultSchema, { status: "rejected", problems: [{ slot: "line", message: "请选择一项" }] }));

  assert.equal(Value.Check(FeedbackSchema, { ...feedback, verdict: "excellent" }), false);
  assert.equal(Value.Check(FeedbackSchema, { ...feedback, answer: "minus" }), false);
  assert.equal(Value.Check(SubmitResultSchema, { status: "rejected", problems: [] }), false);
  assert.equal(Value.Check(SubmitResultSchema, { status: "accepted" }), false);
});

test("前端宽松读取反馈：不认识的 verdict 读作 ungraded，不认识的 judge、标记、测试结果和评分要点逐条丢掉", () => {
  const version = `sha256:${"1".repeat(64)}`;
  const newer: unknown = {
    item: { id: "t01.k1.q3", version },
    verdict: "almost",
    judge: "peer",
    attempt: 3,
    message: [{ type: "markdown", text: "再看看第二问。", tone: "gentle" }, { type: "video", asset: "hint" }],
    slots: {
      line: { verdict: "incorrect", marks: { plus: "incorrect", minus: "missed", other: "half" }, hint: "看减号" },
      code: { verdict: "timeout_partial", tests: [{ name: "公开例子", result: "passed" }, { name: "更多输入", result: "skipped", hidden: true }] },
      why: { verdict: "pending", criteria: [{ label: "说出原因", met: "unsure" }, { label: "举出例子", met: "partly" }] },
    },
  };
  const feedback: Feedback = {
    item: { id: "t01.k1.q3", version },
    verdict: "ungraded",
    message: [{ type: "markdown", text: "再看看第二问。" }],
    slots: {
      line: { verdict: "incorrect", marks: { plus: "incorrect", minus: "missed" } },
      code: { verdict: "ungraded", tests: [{ name: "公开例子", result: "passed" }] },
      why: { verdict: "pending", criteria: [{ label: "说出原因", met: "unsure" }] },
    },
  };
  assert.deepEqual(readFeedback(newer), { ok: true, value: feedback });
  assert.deepEqual(readSubmitResult({ status: "recorded", feedback: newer, next: "t01.k1.q4" }), { ok: true, value: { status: "recorded", feedback } });
  assert.deepEqual(readSubmitResult({ status: "rejected", problems: [{ slot: "line", message: "请选择一项", code: "empty" }] }), {
    ok: true, value: { status: "rejected", problems: [{ slot: "line", message: "请选择一项" }] },
  });

  // 认识的字段类型不对时读取失败并指出位置；认不出的提交结果读不了。
  assert.deepEqual(readFeedback({ ...(newer as object), verdict: 1 }), { ok: false, path: "/verdict" });
  assert.deepEqual(readFeedback({ ...(newer as object), score: { earned: "1", max: 2 } }), { ok: false, path: "/score/earned" });
  assert.deepEqual(readSubmitResult({ status: "queued" }), { ok: false, path: "" });
});

test("python.run 的输入是探测或一批测试，测试里没有期望值；结果带提交身份、实际环境和每个测试的状态", () => {
  const runtime = { pyodide: "314.0.7", python: "3.14.2", packages: { numpy: "2.4.6", pandas: "3.0.2" } };
  const input: PythonBatchInput = {
    protocol: PYTHON_BATCH,
    kind: "execute",
    submissionId: "sub-1",
    gradeRevision: 1,
    runtime: { ...runtime, prelude: "import pandas as pd" },
    runner: "sha256:runner",
    tests: [{
      id: "answer:0",
      program: "total = sales['amount'].sum()\nprint(total)",
      prelude: "import pandas as pd",
      setup: "",
      data: [
        { label: "sales", fixture: { kind: "dataframe", name: "sales", columns: { city: ["北京", "上海"], amount: [1.5, null] }, dtypes: { amount: "float" } } },
        { label: "limit", fixture: { kind: "python", code: "limit = 10" } },
      ],
      captures: ["total"],
      doctest: ["total > limit"],
    }],
  };
  const [test] = input.tests;
  assert.ok(Value.Check(PythonRunInputSchema, input));
  assert.ok(Value.Check(PythonRunInputSchema, { protocol: PYTHON_BATCH, kind: "capabilities" }));
  assert.equal(Value.Check(PythonRunInputSchema, { ...input, protocol: "repa-python-batch-v0" }), false);
  assert.equal(Value.Check(PythonRunInputSchema, { ...input, tests: [{ ...test, verify: "assert total == 1.5" }] }), false);
  assert.equal(Value.Check(PythonRunInputSchema, { ...input, tests: [{ ...test, expect: { total: "1.5" } }] }), false);

  assert.ok(Value.Check(PythonCapabilitiesSchema, { protocol: PYTHON_BATCH, runtime, runner: "sha256:runner", freshInterpreter: true }));
  const result: PythonBatchResult = {
    protocol: PYTHON_BATCH,
    submissionId: "sub-1",
    gradeRevision: 1,
    runtime,
    runner: "sha256:runner",
    freshInterpreter: true,
    tests: [
      {
        id: "answer:0",
        status: "completed",
        result: {
          stdout: "1.5\n",
          error: { type: "NameError", message: "name 'x' is not defined", line: 2 },
          captures: { total: { value: 1.5 }, missing: { error: { type: "NameError", message: "name 'missing' is not defined" } } },
          doctest: [{ out: "False\n", exception: null }],
        },
      },
      { id: "answer:1", status: "timeout", phase: "doctest" },
      { id: "answer:2", status: "failed", phase: "capture", error: { type: "TimeoutError", message: "序列化超时" } },
      { id: "answer:3", status: "not_run" },
    ],
  };
  assert.ok(Value.Check(PythonBatchResultSchema, result));
  assert.equal(Value.Check(PythonBatchResultSchema, { ...result, tests: [{ id: "answer:1", status: "timeout", phase: "setup" }] }), false);
  assert.equal(Value.Check(PythonBatchResultSchema, { ...result, tests: [{ id: "answer:1", status: "timeout", phase: "doctest", index: 0 }] }), false);
  assert.equal(Value.Check(PythonBatchResultSchema, { ...result, freshInterpreter: false }), false);
});

/** 收集一个模块在运行时会加载的说明符；只有 import type 的语句在编译后消失，不算。 */
function runtimeImports(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/^\s*(?:import|export)\s+(type\s+)?(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm)) {
    if (match[1] === undefined && match[2] !== undefined) specifiers.push(match[2]);
  }
  for (const match of source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) if (match[1] !== undefined) specifiers.push(match[1]);
  return specifiers;
}

/** 从入口出发走遍相对导入，返回全部外部说明符。 */
async function externalImports(entry: string, toFile: (from: string, specifier: string) => string): Promise<Set<string>> {
  const external = new Set<string>();
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of runtimeImports(await readFile(file, "utf8"))) {
      if (specifier.startsWith(".")) queue.push(toFile(file, specifier));
      else external.add(specifier);
    }
  }
  return external;
}

test("@repa/learning/protocol 在浏览器里也能用：只依赖 typebox 和底座的交互词汇，底座那边也不加载 Node 模块", async () => {
  const learning = await externalImports(path.join(SOURCE, "protocol.ts"), (from, specifier) =>
    path.resolve(path.dirname(from), specifier.replace(/\.js$/, ".ts")));
  assert.deepEqual([...learning].sort(), ["@repa/base/protocol", "typebox", "typebox/value"]);

  const base = fileURLToPath(import.meta.resolve("@repa/base/protocol"));
  const reached = await externalImports(base, (from, specifier) => path.resolve(path.dirname(from), specifier));
  assert.deepEqual([...reached].filter((specifier) => specifier.startsWith("node:") || !specifier.startsWith("typebox")), []);
});
