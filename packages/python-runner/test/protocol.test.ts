import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Value } from "typebox/value";

import {
  endsBatch, PYTHON_BATCH, PythonBatchInputSchema, PythonBatchResultSchema,
  type PythonBatchInput, type PythonBatchResult,
} from "../src/protocol.js";

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

test("python.run 的输入只有一批测试，不带调用方的标识，比较用的期望也不在测试里；结果带实际环境和每个测试的状态", () => {
  const runtime = { pyodide: "314.0.7", python: "3.14.2", packages: { numpy: "2.4.6", pandas: "3.0.2" } };
  const input: PythonBatchInput = {
    protocol: PYTHON_BATCH,
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
  assert.ok(Value.Check(PythonBatchInputSchema, input));
  assert.equal(Value.Check(PythonBatchInputSchema, { ...input, protocol: "repa-python-batch-v1" }), false);
  for (const extra of [{ kind: "execute" }, { submissionId: "sub-1" }, { gradeRevision: 1 }, { runner: "sha256:runner" }, { runtime }]) {
    assert.equal(Value.Check(PythonBatchInputSchema, { ...input, ...extra }), false);
  }
  assert.equal(Value.Check(PythonBatchInputSchema, { ...input, tests: [{ ...test, verify: "assert total == 1.5" }] }), false);
  assert.equal(Value.Check(PythonBatchInputSchema, { ...input, tests: [{ ...test, expect: { total: "1.5" } }] }), false);
  // 夹具只带运行要用的字段，题面显示用的说明不发给运行器。
  const shown = { kind: "python", code: "limit = 10", display: "上限是 10" };
  assert.equal(Value.Check(PythonBatchInputSchema, { ...input, tests: [{ ...test, data: [{ label: "limit", fixture: shown }] }] }), false);

  const completed = {
    stdout: "1.5\n",
    error: { type: "NameError", message: "name 'x' is not defined", line: 2 },
    captures: { total: { value: 1.5 }, missing: { error: { type: "NameError", message: "name 'missing' is not defined" } } },
    doctest: [{ out: "False\n", exception: null }],
  };
  const result: PythonBatchResult = {
    protocol: PYTHON_BATCH,
    runtime,
    tests: [
      { id: "answer:0", status: "completed", result: completed },
      { id: "answer:1", status: "completed", result: completed, restoreError: { type: "SystemExit", message: "无法恢复解释器状态" } },
      { id: "answer:2", status: "not_run" },
    ],
  };
  assert.ok(Value.Check(PythonBatchResultSchema, result));
  assert.ok(Value.Check(PythonBatchResultSchema, { ...result, tests: [{ id: "answer:1", status: "timeout", phase: "doctest" }] }));
  assert.ok(Value.Check(PythonBatchResultSchema, { ...result, tests: [{ id: "answer:2", status: "failed", phase: "capture", error: { type: "TimeoutError", message: "序列化超时" } }] }));
  assert.equal(Value.Check(PythonBatchResultSchema, { ...result, tests: [{ id: "answer:1", status: "timeout", phase: "setup" }] }), false);
  assert.equal(Value.Check(PythonBatchResultSchema, { ...result, tests: [{ id: "answer:1", status: "timeout", phase: "doctest", index: 0 }] }), false);
  assert.equal(Value.Check(PythonBatchResultSchema, { ...result, freshInterpreter: true }), false);
  assert.equal(Value.Check(PythonBatchResultSchema, { ...result, submissionId: "sub-1" }), false);

  // 超时和失败让这一批停下；恢复失败的结果有效，余下的测试换一个解释器接着运行，这一批不停。
  assert.deepEqual(result.tests.map(endsBatch), [false, false, true]);
  assert.equal(endsBatch({ id: "a", status: "timeout", phase: "program" }), true);
  assert.equal(endsBatch({ id: "a", status: "failed", phase: "prepare" }), true);
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
async function externalImports(entry: string): Promise<Set<string>> {
  const external = new Set<string>();
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of runtimeImports(await readFile(file, "utf8"))) {
      if (specifier.startsWith(".")) queue.push(path.resolve(path.dirname(file), specifier.replace(/\.js$/, ".ts")));
      else external.add(specifier);
    }
  }
  return external;
}

test("页面用到的入口在浏览器里也能用：protocol 和 browser 只依赖 typebox 与底座的交互词汇，不加载 Node 模块", async () => {
  assert.deepEqual([...await externalImports(path.join(SOURCE, "protocol.ts"))].sort(), ["@repa/base/protocol", "typebox"]);
  assert.deepEqual(
    [...await externalImports(path.join(SOURCE, "browser", "index.ts"))].sort(),
    ["@repa/base/protocol", "typebox", "typebox/value"],
  );
  assert.deepEqual([...await externalImports(path.join(SOURCE, "browser", "worker.ts"))], []);
});
