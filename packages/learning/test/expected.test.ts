import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { object, parse } from "@repa/base/protocol";

import { assembleParsons } from "../src/check/code.js";
import { slotTests, topicQuestions } from "../src/check/items.js";
import { sameValue, showValue } from "../src/check/values.js";
import { Report } from "../src/format/diagnostics.js";
import { loadCourse } from "../src/format/load.js";
import { PythonProgramResultSchema } from "../src/protocol.js";
import { ExpectedSchema, programProblem, slotPythonTests } from "../src/python-execution.js";
import { describeRuntime, verifyPackages } from "../src/sandbox/runtime.js";
import { loadRunner, runTest } from "./pyodide.js";

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PYTHON_COURSE = path.join(PACKAGE, "courses", "python");

const CaptureResultsSchema = Type.Record(
  Type.String(),
  Type.Union([object({ value: Type.Unknown() }), object({ error: object({ type: Type.String(), message: Type.String() }) })]),
);

// expected.json 的标签不含 runner.py，改了 runner.py 不会让期望值失效；这里用当前 runner.py 把期望值重新算一遍来兜底。
// 两条路径都要跑：存档值来自作者写的期望表达式，判分时比的是学习者程序的 capture，求值方式变了只有参考解会对不上。
// 全程共用一个解释器，结果与每题换新解释器相同，只要几秒。
test("当前 runner.py 算出的期望值和参考解结果，都与 Python 课程的 expected.json 一致", async () => {
  const report = new Report();
  const loaded = await loadCourse(PYTHON_COURSE, report);
  assert.ok(loaded, JSON.stringify(report.diagnostics));
  const expected = parse(
    Type.Record(Type.String(), ExpectedSchema),
    JSON.parse(await readFile(path.join(PYTHON_COURSE, "expected.json"), "utf8")),
  );
  const runtime = loaded.course.runtime;
  const assets = await describeRuntime(runtime);
  await verifyPackages(assets);
  const runner = await loadRunner(assets, path.join(PACKAGE, "sandbox", "runner.py"));

  const problems: string[] = [];
  let checked = 0;
  for (const { topic } of loaded.topics) {
    for (const { question } of topicQuestions(topic)) {
      for (const slot of question.slots) {
        const codeTests = slotTests(slot);
        if (codeTests.length === 0 || (slot.type !== "code" && slot.type !== "order")) continue;
        checked += 1;
        const where = `${question.id}/${slot.id}`;
        const stored = expected[question.id]?.values[slot.id];
        if (!stored) {
          problems.push(`${where}：expected.json 没有这个作答位`);
          continue;
        }
        const reference = slot.type === "code" ? slot.solution : assembleParsons(slot, slot.key);
        for (const [index, input] of slotPythonTests(slot, question, topic, runtime, reference).entries()) {
          const codeTest = codeTests[index];
          const want = stored[index] ?? {};
          if (!codeTest) continue;
          if (codeTest.expect && Object.keys(codeTest.expect).length > 0) {
            const reply = JSON.parse(runner.handleJob(JSON.stringify({
              op: "expect", prelude: input.prelude, setup: input.setup, exprs: codeTest.expect,
              data: input.data.map((item) => ({ ...item.fixture, label: item.label })),
            }))) as { ok: boolean; result?: unknown; error?: unknown };
            if (!reply.ok) {
              problems.push(`${where} 第 ${index} 个测试：期望值算不出来：${JSON.stringify(reply.error)}`);
            } else {
              const results = parse(CaptureResultsSchema, reply.result);
              for (const expression of new Set([...Object.keys(results), ...Object.keys(want)])) {
                const result = results[expression];
                if (result && "error" in result) {
                  problems.push(`${where} 第 ${index} 个测试：期望表达式 ${expression} 出错：${result.error.type}: ${result.error.message}`);
                } else if (!sameValue(result?.value, want[expression])) {
                  problems.push(`${where} 第 ${index} 个测试：${expression} 现在算出 ${showValue(result?.value)}，存档是 ${showValue(want[expression])}`);
                }
              }
            }
          }
          const ran = runTest(runner.test, input).result;
          if (ran.status !== "completed") {
            problems.push(`${where} 第 ${index} 个测试：参考解没有正常结束：${JSON.stringify(ran)}`);
            continue;
          }
          let problem: string | undefined;
          try {
            problem = programProblem(codeTest, want, parse(PythonProgramResultSchema, ran.result));
          } catch (error) {
            problem = error instanceof Error ? error.message : String(error);
          }
          if (problem !== undefined) problems.push(`${where} 第 ${index} 个测试：参考解没有通过：${problem}`);
        }
      }
    }
  }
  assert.ok(checked > 0, "课程里没有带代码测试的作答位");
  assert.deepEqual(
    problems,
    [],
    `${problems.join("\n")}\n\n当前 runner.py 下的结果与 expected.json 不一致。改动确实改变了答案时，在 Linux 容器里运行 npm run course:check 重新生成 expected.json。`,
  );
});
