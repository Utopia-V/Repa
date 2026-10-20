import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { parse } from "@repa/base/protocol";
import { ExpectedSchema, expectedBinding, runnerVersion } from "../src/python-execution.js";

import { checkCourse } from "../src/check/course.js";
import type { Diagnostic } from "../src/format/diagnostics.js";
import type { CodeSlot, OrderSlot, TableSlot, TextSlot } from "../src/format/schema.js";
import { demoCourse, runtimeUnavailable, writeCourse, type DemoCourse } from "./demo-course.js";

const PYTHON_COURSE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "courses", "python");

function errors(diagnostics: Diagnostic[]): string[] {
  return diagnostics.filter((diagnostic) => diagnostic.severity === "error").map((diagnostic) => diagnostic.code).sort();
}

function practiceSlot<T>(demo: DemoCourse, kpIndex: number, questionIndex: number): T {
  const slot = demo.topics.t01?.kps[kpIndex]?.practice?.[questionIndex]?.slots[0];
  assert.ok(slot);
  return slot as T;
}

test("示例课程在 Pyodide 里全部核对通过", async (t) => {
  const reason = await runtimeUnavailable();
  if (reason) return t.skip(reason);
  const root = await writeCourse(t, demoCourse());
  const result = await checkCourse(root, { base: root });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.summary.ran, true);
  assert.equal(result.summary.runtime?.packages.pandas, "3.0.2");
  // 12 道题里，代码题和 Parsons 题由测试负责，其余 10 道都有 verify。
  assert.equal(result.summary.code.verifyJobs, 10);
  assert.ok(result.summary.code.testRuns > 0);
});

test("标准答案与程序独立算出的不一致、或有作答位没被核对时报出", async (t) => {
  const reason = await runtimeUnavailable();
  if (reason) return t.skip(reason);
  const demo = demoCourse();
  practiceSlot<TextSlot>(demo, 0, 0).key = 4;
  const question = demo.topics.t01?.kps[0]?.practice?.[1];
  assert.ok(question);
  question.verify = "answers = {}";
  const wwpd = practiceSlot<TableSlot>(demo, 1, 2);
  const row = wwpd.rows[3];
  assert.ok(row);
  row.cells.shown = "[1, 2]";
  const root = await writeCourse(t, demo);
  const result = await checkCourse(root, { base: root });
  assert.deepEqual(errors(result.diagnostics), ["answer_mismatch", "answer_mismatch", "unverified_slot"]);
  const messages = result.diagnostics.map((diagnostic) => diagnostic.message).join("\n");
  assert.match(messages, /程序算出 "3"，标准答案是 "4"/);
  assert.match(messages, /l4\/shown 程序算出 \[1, 2, 3\]，标准答案是 \[1, 2\]/);
});

test("代码题：参考答案不过测试、错误写法反而通过、等价写法没通过都会报出", async (t) => {
  const reason = await runtimeUnavailable();
  if (reason) return t.skip(reason);
  const demo = demoCourse();
  const code = practiceSlot<CodeSlot>(demo, 1, 0);
  code.solution = "def double(x):\n    return x * 3\n";
  code.accepts = ["def double(x):\n    return 4\n"];
  code.rejects = [{ code: "def double(x):\n    return x + x\n", why: "其实是对的" }];
  const root = await writeCourse(t, demo);
  const result = await checkCourse(root, { base: root });
  assert.deepEqual(errors(result.diagnostics), ["accept_failed", "reject_passed", "solution_failed"]);
  const solution = result.diagnostics.find((diagnostic) => diagnostic.code === "solution_failed");
  assert.match(solution?.message ?? "", /“公开例子”：>>> double\(2\) 应显示 "4"，实际是 "6"/);
});

test("Parsons 题按测试判：标准排列的缩进错了会报出，期望值算不出的测试也会报出", async (t) => {
  const reason = await runtimeUnavailable();
  if (reason) return t.skip(reason);
  const wrongIndent = demoCourse();
  const parsons = practiceSlot<OrderSlot>(wrongIndent, 1, 1);
  parsons.indents = { ...parsons.indents, b5: 2 };
  const root = await writeCourse(t, wrongIndent);
  assert.deepEqual(errors((await checkCourse(root, { base: root })).diagnostics), ["solution_failed"]);

  const badExpectation = demoCourse();
  const tests = practiceSlot<OrderSlot>(badExpectation, 1, 1).tests;
  assert.ok(tests?.[1]);
  tests[1].expect = { "count_high([], 3)": "zero" };
  const other = await writeCourse(t, badExpectation);
  assert.deepEqual(errors((await checkCourse(other, { base: other })).diagnostics), ["test_expect_failed"]);
});

test("核对程序超时时报出，其余题目照常核对", async (t) => {
  const reason = await runtimeUnavailable();
  if (reason) return t.skip(reason);
  const demo = demoCourse();
  const question = demo.topics.t01?.kps[0]?.practice?.[0];
  assert.ok(question);
  question.verify = "while True:\n    pass";
  const root = await writeCourse(t, demo);
  const result = await checkCourse(root, { base: root, timeoutMs: 1_500 });
  assert.deepEqual(errors(result.diagnostics), ["verify_failed"]);
  assert.match(result.diagnostics[0]?.message ?? "", /运行超时/);
  assert.equal(result.summary.code.verifyJobs, 10);
});

test("课程清单要求的运行时与安装的不一致时报出，不运行核对", async (t) => {
  const demo = demoCourse();
  demo.course.runtime.packages.pandas = "3.0.6";
  const root = await writeCourse(t, demo);
  const result = await checkCourse(root, { base: root });
  assert.deepEqual(errors(result.diagnostics), ["runtime_mismatch"]);
  assert.equal(result.summary.ran, false);
});

test("随包的 Python 课程在 Pyodide 里全部核对通过", async (t) => {
  const reason = await runtimeUnavailable();
  if (reason) return t.skip(reason);
  const result = await checkCourse(PYTHON_COURSE);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.summary.ran, true);
  assert.equal(result.summary.topics.complete + result.summary.topics.outline, 48);
  assert.ok(result.summary.code.verifiedSlots > 0);
  assert.ok(result.summary.code.testRuns > 0);
});

test("verify 核对更严：多写的可接受值、忘了写 input 的答案列、按 repr 显示的字符串都会报出", async (t) => {
  const reason = await runtimeUnavailable();
  if (reason) return t.skip(reason);
  const demo = demoCourse();
  practiceSlot<TextSlot>(demo, 0, 0).key = [3, 4];
  const wwpd = practiceSlot<TableSlot>(demo, 1, 2);
  const shown = wwpd.columns[1];
  assert.ok(shown);
  delete shown.input;
  const review = demo.topics.t01?.kps[0]?.review?.[0];
  assert.ok(review);
  review.body = "交互解释器里依次输入：\n\n```python\nx = '4' + '2'\nx\n```";
  review.slots = [{ id: "output", type: "text", match: "output", key: "42" }];
  review.verify = 'answers = {"output": run()["x"]}';
  const root = await writeCourse(t, demo);
  const result = await checkCourse(root, { base: root });
  assert.deepEqual(errors(result.diagnostics), ["answer_mismatch", "answer_mismatch", "table_without_input", "verify_unknown_cell"]);
  const messages = result.diagnostics.map((diagnostic) => diagnostic.message).join("\n");
  assert.match(messages, /标准答案里的 "4" 与程序算出的 "3" 不一致/);
  assert.match(messages, /程序算出 "'42'"，标准答案是 "42"/);
});

test("代码题的初始代码已经能通过测试、verify 遇到有多种正确排列的题时报出", async (t) => {
  const reason = await runtimeUnavailable();
  if (reason) return t.skip(reason);
  const demo = demoCourse();
  const code = practiceSlot<CodeSlot>(demo, 1, 0);
  code.starter = code.solution;
  const rows = demo.topics.t01?.kps[1]?.review?.[0]?.slots[0];
  assert.ok(rows?.type === "order");
  rows.alternatives = [["c", "b"]];
  const root = await writeCourse(t, demo);
  const result = await checkCourse(root, { base: root });
  assert.deepEqual(errors(result.diagnostics), ["starter_passes", "verify_alternatives"]);
});


test("每份候选程序从干净解释器开始，发布期望值绑定内容、运行前导和 runner", async (t) => {
  const reason = await runtimeUnavailable();
  if (reason) return t.skip(reason);
  const demo = demoCourse();
  const entry = Object.values(demo.topics).flatMap((topic) => topic.kps.flatMap((kp) => kp.practice ?? [])).find((question) => question.slots.some((slot) => slot.type === "code"));
  assert.ok(entry);
  const slot = entry.slots.find((slot): slot is CodeSlot => slot.type === "code");
  assert.ok(slot);
  const original = slot.solution;
  slot.solution = `import math\nmath.c2_leak = True\n${original}`;
  slot.accepts = [`import math\nassert not hasattr(math, "c2_leak")\n${original}`];
  const root = await writeCourse(t, demo);
  const result = await checkCourse(root);
  assert.deepEqual(errors(result.diagnostics), []);
  const expected = parse(Type.Record(Type.String(), ExpectedSchema), JSON.parse(await readFile(path.join(root, "expected.json"), "utf8")));
  assert.equal(expected[entry.id]?.values[slot.id]?.length, slot.tests.length);
  const topic = Object.values(demo.topics).find((topic) => topic.kps.some((kp) => kp.practice?.includes(entry)));
  assert.ok(topic);
  const runner = await runnerVersion();
  const binding = await expectedBinding(entry, topic, demo.course.runtime, runner);
  assert.equal(expected[entry.id]?.binding, binding);
  assert.notEqual(await expectedBinding(entry, topic, { ...demo.course.runtime, prelude: "different" }, runner), binding);
  assert.notEqual(await expectedBinding(entry, topic, demo.course.runtime, "different-runner"), binding);
});
