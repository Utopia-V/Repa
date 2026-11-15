import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { describeRuntime, SandboxRunner } from "@repa/python-runner";
import { PythonBatchInputSchema } from "@repa/python-runner/protocol";
import { parse } from "@repa/base/protocol";
import type { Host } from "@repa/base/plugin";
import { parse as parseYaml, stringify } from "yaml";

import { checkCourse, type CheckResult } from "../src/check/course.js";
import { frontendPython } from "../src/check/python.js";
import type { Diagnostic } from "../src/format/diagnostics.js";
import type { CodeSlot, OrderSlot, TableSlot, TextSlot, Topic } from "../src/format/schema.js";
import { demoCourse, runtimeUnavailable, writeCourse, type DemoCourse } from "./demo-course.js";
import { skipUnavailableEnvironment } from "./environment.js";

const PYTHON_COURSE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "courses", "python");
const EXAMPLE = fileURLToPath(new URL("../guides/example-course/", import.meta.url));

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
  if (reason) return skipUnavailableEnvironment(t, reason);
  const root = await writeCourse(t, demoCourse());
  const result = await checkCourse(root, { base: root });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.summary.ran, true);
  assert.equal(result.summary.runtime?.packages.pandas, "3.0.2");
  // 12 道题里，代码题和 Parsons 题由测试负责，其余 10 道都有 verify。
  assert.equal(result.summary.code.verifyJobs, 10);
  assert.ok(result.summary.code.testRuns > 0);
  assert.equal(result.summary.code.interpreterStarts, 1);
});

test("标准答案与程序独立算出的不一致、或有作答位没被核对时报出", async (t) => {
  const reason = await runtimeUnavailable();
  if (reason) return skipUnavailableEnvironment(t, reason);
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
  if (reason) return skipUnavailableEnvironment(t, reason);
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
  if (reason) return skipUnavailableEnvironment(t, reason);
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
  if (reason) return skipUnavailableEnvironment(t, reason);
  const demo = demoCourse();
  const question = demo.topics.t01?.kps[0]?.practice?.[0];
  assert.ok(question);
  question.verify = "while True:\n    pass";
  const root = await writeCourse(t, demo);
  const result = await checkCourse(root, { base: root, timeoutMs: 1_500 });
  assert.deepEqual(errors(result.diagnostics), ["verify_failed"]);
  assert.match(result.diagnostics[0]?.message ?? "", /运行超时/);
  assert.equal(result.summary.code.verifyJobs, 10);
  assert.equal(result.summary.code.interpreterStarts, 2);
});

test("课程清单要求的运行时与安装的不一致时报出，不运行核对", async (t) => {
  const reason = await runtimeUnavailable();
  if (reason) return skipUnavailableEnvironment(t, reason);
  const demo = demoCourse();
  demo.course.runtime.packages.pandas = "3.0.6";
  const root = await writeCourse(t, demo);
  const result = await checkCourse(root, { base: root });
  assert.deepEqual(errors(result.diagnostics), ["runtime_mismatch"]);
  assert.equal(result.summary.ran, false);
});

test("随包的 Python 课程在 Pyodide 里全部核对通过，只启动一个解释器，不在课程目录里留下产物", async (t) => {
  const reason = await runtimeUnavailable();
  if (reason) return skipUnavailableEnvironment(t, reason);
  const before = await readdir(PYTHON_COURSE);
  const result = await checkCourse(PYTHON_COURSE, { base: PYTHON_COURSE });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.summary.ran, true);
  assert.equal(result.summary.topics.complete + result.summary.topics.outline, 48);
  assert.ok(result.summary.code.verifiedSlots > 0);
  assert.ok(result.summary.code.testRuns > 0);
  assert.equal(result.summary.code.interpreterStarts, 1);
  assert.deepEqual(await readdir(PYTHON_COURSE), before);
});

test("verify 核对更严：多写的可接受值、忘了写 input 的答案列、按 repr 显示的字符串都会报出", async (t) => {
  const reason = await runtimeUnavailable();
  if (reason) return skipUnavailableEnvironment(t, reason);
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
  if (reason) return skipUnavailableEnvironment(t, reason);
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

test("后一份候选程序看不到前一份留下的变量、文件和环境变量；核对不写任何产物", async (t) => {
  const reason = await runtimeUnavailable();
  if (reason) {
    return skipUnavailableEnvironment(t, reason);
  }
  const demo = demoCourse();
  const slot = practiceSlot<CodeSlot>(demo, 1, 0);
  const original = slot.solution;
  slot.solution = `import os\nos.environ["C2_LEAK"] = "1"\nopen("c2_leak.txt", "w").write("x")\nc2_leak = True\n${original}`;
  slot.accepts = [
    `import os\nassert "C2_LEAK" not in os.environ and not os.path.exists("c2_leak.txt") and "c2_leak" not in globals()\n${original}`,
  ];
  const root = await writeCourse(t, demo);
  const result = await checkCourse(root);
  assert.deepEqual(errors(result.diagnostics), []);
  assert.deepEqual((await readdir(root)).sort(), ["course.yaml", "topics"]);
});

/** 前端的替身：python.run 交给另一个 Node 沙箱，按同一约定运行，与页面的 Worker 一样加载 runner.py 的 program_test。 */
async function sandboxFrontend(t: TestContext): Promise<Host["services"]> {
  const runner = new SandboxRunner({ assets: await describeRuntime() });
  t.after(() => runner.close());
  return {
    async call(service, input) {
      assert.equal(service, "python.run");
      return runner.runTests(parse(PythonBatchInputSchema, input).tests, 1_500);
    },
  };
}

/** 比较两条路的结论时不看启动解释器的次数：前端每批用一个新的。 */
const comparable = (result: CheckResult) => ({
  diagnostics: result.diagnostics,
  ran: result.summary.ran,
  runtime: result.summary.runtime,
  loaded: result.summary.loaded,
  counts: { ...result.summary.code, interpreterStarts: 0 },
});

/** 写课说明里的示例课，os01 的练习里加几道按 programs 核对的计算题（答案都是 4），清单不写 runtime。 */
async function verifyCourse(t: TestContext, programs: string[]): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-code-verify-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(EXAMPLE, root, { recursive: true });
  const file = path.join(root, "topics", "os01.yaml");
  const topic = parseYaml(await readFile(file, "utf8")) as Topic;
  const practice = topic.kps[0]?.practice;
  assert.ok(practice);
  for (const [index, program] of programs.entries()) {
    practice.push({
      id: `os01.k1.q${10 + index}`,
      body: "时间片是 20 ms，一个进程要运行 70 ms，它要被调度几次？",
      slots: [{ id: "n", type: "text", format: "integer", key: 4 }],
      explanation: "70 除以 20 向上取整是 4。",
      verify: program,
    });
  }
  await writeFile(file, stringify(topic));
  return root;
}

test("清单不写 runtime 的课在 Repa 的 Python 环境里核对，两条路结论一致：只用标准库的不加载包，引入 numpy 的只加载 numpy，引入没有带的包时写明是哪个包", async (t) => {
  const reason = await runtimeUnavailable();
  if (reason) return skipUnavailableEnvironment(t, reason);
  const services = await sandboxFrontend(t);
  const plain = "import math\nanswers = {'n': math.ceil(70 / 20)}";
  const numpy = "import numpy as np\nanswers = {'n': int(np.ceil(np.array([70]) / 20)[0])}";
  const cases: [string[], string[]][] = [[[plain], []], [[plain, numpy], ["numpy"]]];
  for (const [programs, loaded] of cases) {
    const root = await verifyCourse(t, programs);
    const sandbox = await checkCourse(root, { base: root, confirmations: "reported" });
    assert.deepEqual(sandbox.diagnostics, [], programs.join("；"));
    assert.equal(sandbox.summary.code.verifyJobs, programs.length);
    assert.deepEqual(sandbox.summary.loaded, loaded);
    assert.equal(sandbox.summary.code.interpreterStarts, 1);
    const frontend = await checkCourse(root, { base: root, confirmations: "reported", python: [frontendPython(services)] });
    assert.deepEqual(comparable(frontend), comparable(sandbox));
  }
  const root = await verifyCourse(t, ["import scipy\nanswers = {'n': 4}"]);
  const sandbox = await checkCourse(root, { base: root, confirmations: "reported" });
  assert.deepEqual(errors(sandbox.diagnostics), ["verify_failed"]);
  assert.match(sandbox.diagnostics[0]?.message ?? "", /ModuleNotFoundError: No module named 'scipy'。核对程序能用 Python 标准库和 Repa 带的 numpy、pandas/u);
  const frontend = await checkCourse(root, { base: root, confirmations: "reported", python: [frontendPython(services)] });
  assert.deepEqual(comparable(frontend), comparable(sandbox));
});

test("同一门课经 Linux 沙箱和经前端的 python.run 核对，结论一致：通过的都通过，不通过的报同样的错误码和说明", async (t) => {
  const reason = await runtimeUnavailable();
  if (reason) return skipUnavailableEnvironment(t, reason);
  const services = await sandboxFrontend(t);
  const variants: [string, (demo: DemoCourse) => void][] = [
    ["原样", () => {}],
    ["标准答案与算出的不一致、作答位没被核对", (demo) => {
      practiceSlot<TextSlot>(demo, 0, 0).key = 4;
      const question = demo.topics.t01?.kps[0]?.practice?.[1];
      assert.ok(question);
      question.verify = "answers = {}";
    }],
    ["verify 程序出错、超时", (demo) => {
      const questions = demo.topics.t01?.kps[0]?.practice;
      assert.ok(questions?.[0] && questions[1]);
      questions[0].verify = "while True:\n    pass";
      questions[1].verify = "answers = {'output': 1 / 0}";
    }],
    ["代码题的参考答案不过、错误写法通过", (demo) => {
      const code = practiceSlot<CodeSlot>(demo, 1, 0);
      code.solution = "def double(x):\n    return x * 3\n";
      code.rejects = [{ code: "def double(x):\n    return x + x\n", why: "其实是对的" }];
    }],
  ];
  for (const [name, change] of variants) {
    const demo = demoCourse();
    change(demo);
    const root = await writeCourse(t, demo);
    const sandbox = await checkCourse(root, { base: root, timeoutMs: 1_500 });
    const frontend = await checkCourse(root, { base: root, timeoutMs: 1_500, python: [frontendPython(services)] });
    assert.equal(sandbox.summary.where, "sandbox");
    assert.equal(frontend.summary.where, "frontend");
    assert.deepEqual(comparable(frontend), comparable(sandbox), name);
    if (name === "原样") assert.deepEqual(sandbox.diagnostics, []);
    else assert.ok(sandbox.diagnostics.length > 0, name);
  }
});
