import assert from "node:assert/strict";
import test from "node:test";

import { RepaFault } from "@repa/base";
import type { Host } from "@repa/base/plugin";
import { PYTHON_BATCH, type PythonProgramResult, type PythonTest, type PythonTestResult } from "@repa/python-runner/protocol";

import { answerProgram, frontendTests, runCodeTests, slotTestPlan, type RunTests, type SlotTestPlan } from "../src/code-tests.js";
import type { CodeSlot, CodeTest, OrderSlot, Question, Topic } from "../src/format/schema.js";

const int = (value: number) => ({ t: "int", v: String(value) });
const ran = (captures: Record<string, unknown>, extra: Partial<PythonProgramResult> = {}): PythonProgramResult => ({
  stdout: "", error: null, doctest: [], ...extra,
  captures: Object.fromEntries(Object.entries(captures).map(([key, value]) => [key, { value }])),
});

/** 一道代码题：两个测试，第二个的期望表达式与 capture 不同名、且有重复的期望表达式。 */
function codeQuestion(tests: CodeTest[]): { question: Question; slot: CodeSlot; topic: Topic } {
  const slot: CodeSlot = { id: "code", type: "code", language: "python", starter: "x = 0", solution: "x = 2", tests };
  const question: Question = { id: "t01.k1.q1", body: "题面", explanation: "解析", slots: [slot] };
  const topic: Topic = {
    id: "t01", title: "t01", status: "complete", minutes: 5, prerequisites: [], sources: [],
    data: { T: { kind: "dataframe", name: "df", columns: { n: [1, 2] }, caption: "小表" } },
    kps: [{ id: "t01.k1", title: "k1", lesson: "讲解", practice: [question] }],
  };
  return { question, slot, topic };
}

const TESTS: CodeTest[] = [
  { name: "公开", data: ["T"], setup: "limit = 1", expect: { x: "1 + 1", "df": "df" } },
  { name: "隐藏", hidden: true, expect: { y: "2", z: "2" }, doctest: ">>> x\n2" },
];

function plan(tests = TESTS): SlotTestPlan {
  const { question, slot, topic } = codeQuestion(tests);
  const result = slotTestPlan(question, slot, topic, "import pandas as pd");
  assert.ok(result);
  return result;
}

/** 按 answer 应答的执行方替身，记下每次调用收到的测试。 */
function executor(answer: (test: PythonTest, index: number) => PythonTestResult) {
  const calls: PythonTest[][] = [];
  const run: RunTests = async (tests) => {
    calls.push(tests);
    const results: PythonTestResult[] = [];
    let stopped = false;
    for (const [index, item] of tests.entries()) {
      if (stopped) {
        results.push({ id: item.id, status: "not_run" });
        continue;
      }
      const result = answer(item, index);
      results.push(result);
      stopped = result.status !== "completed";
    }
    return { tests: results };
  };
  return { run, calls };
}

/** 期望任务给出期望值，学习者的程序算出 x、y、z。 */
function honest(x: number, extra: Partial<PythonProgramResult> = {}) {
  return (item: PythonTest): PythonTestResult => {
    if (item.id.startsWith("expected:")) {
      const values: Record<string, unknown> = { "1 + 1": int(2), df: { t: "DataFrame", values: [] }, "2": int(2) };
      return { id: item.id, status: "completed", result: ran(Object.fromEntries(item.captures.map((capture) => [capture, values[capture]]))) };
    }
    const values: Record<string, unknown> = { x: int(x), df: { t: "DataFrame", values: [] }, y: int(2), z: int(2) };
    return {
      id: item.id, status: "completed",
      result: ran(Object.fromEntries(item.captures.map((capture) => [capture, values[capture]])), { doctest: item.doctest.map(() => ({ out: `${x}\n`, exception: null })), ...extra }),
    };
  };
}

test("期望任务排在第一份程序之前、同一次调用里运行：program 为空串，只对去重后的期望表达式求值，夹具、setup 和前导与测试相同", async () => {
  const { run, calls } = executor(honest(2));
  const result = await runCodeTests(run, plan(), ["x = 2\ny = z = 2"]);
  assert.equal(calls.length, 1);
  const [batch] = calls;
  assert.deepEqual(batch?.map((item) => item.id), ["expected:0", "expected:1", "test:0", "test:1"]);
  assert.deepEqual(batch?.[0], {
    id: "expected:0", prelude: "import pandas as pd", setup: "limit = 1",
    data: [{ label: "T", fixture: { kind: "dataframe", name: "df", columns: { n: [1, 2] } } }],
    program: "", captures: ["1 + 1", "df"], doctest: [],
  });
  assert.deepEqual(batch?.[1]?.captures, ["2"]);
  assert.deepEqual(batch?.[3], {
    id: "test:1", prelude: "import pandas as pd", setup: "", data: [], program: "x = 2\ny = z = 2", captures: ["y", "z"], doctest: ["x"],
  });
  assert.deepEqual(result.expectationProblems, []);
  assert.deepEqual(result.programs, [{ verdict: "correct", tests: [{ status: "passed" }, { status: "passed" }] }]);
});

test("核对时每份候选程序各调用一次执行方，沿用第一次算出的期望值；有测试失败或超时就是 incorrect", async () => {
  const outcome = (program: string) => (item: PythonTest): PythonTestResult => {
    if (program === "slow" && item.id === "test:0") return { id: item.id, status: "timeout", phase: "program" };
    return honest(program === "wrong" ? 3 : 2)(item);
  };
  let current = "right";
  const { run, calls } = executor((item) => outcome(item.program === "" ? "right" : current)(item));
  const programs = ["right", "wrong", "slow"];
  const wrapped: RunTests = (tests) => {
    current = tests.find((item) => item.program !== "")?.program ?? current;
    return run(tests);
  };
  const result = await runCodeTests(wrapped, plan(), programs);
  assert.deepEqual(calls.map((batch) => batch.map((item) => item.id)), [
    ["expected:0", "expected:1", "test:0", "test:1"], ["test:0", "test:1"], ["test:0", "test:1"],
  ]);
  assert.deepEqual(result.programs.map((program) => program.verdict), ["correct", "incorrect", "incorrect"]);
  assert.deepEqual(result.programs[1]?.tests[0], { status: "failed", reason: "x 应为 2，实际是 3" });
  assert.deepEqual(result.programs[1]?.tests[1], { status: "failed", reason: '>>> x 应显示 "2"，实际是 "3"' });
  assert.deepEqual(result.programs[2]?.tests, [{ status: "timeout", reason: "运行超时" }, { status: "not_run" }]);
});

test("准备和收尾超时、执行环境失败不算程序对错；但另一个测试已经失败时照样是 incorrect", async () => {
  const environment = (status: "timeout" | "failed", phase: "prepare" | "cleanup" | "program") => (item: PythonTest): PythonTestResult =>
    item.id === "test:1" ? { id: item.id, status, phase, ...(status === "failed" ? { error: { type: "WorkerError", message: "Worker 崩溃" } } : {}) } : honest(2)(item);
  for (const [status, phase, reason] of [
    ["timeout", "prepare", "prepare 阶段超时"], ["timeout", "cleanup", "cleanup 阶段超时"], ["failed", "program", "WorkerError: Worker 崩溃"],
  ] as const) {
    const result = await runCodeTests(executor(environment(status, phase)).run, plan(), ["x = 2"]);
    assert.deepEqual(result.programs[0], { verdict: "unresolved", tests: [{ status: "passed" }, { status: "unavailable", reason }] });
  }
  const failedFirst = (item: PythonTest) => (item.id === "test:1" ? environment("failed", "program")(item) : honest(3)(item));
  const result = await runCodeTests(executor(failedFirst).run, plan(), ["x = 3"]);
  assert.equal(result.programs[0]?.verdict, "incorrect");
});

test("期望值算不出来是课程的问题：表达式出错、值太大（嵌套的也算）、期望任务超时都报出，相应的测试没有结论", async () => {
  const broken = (fault: "error" | "large" | "timeout") => (item: PythonTest): PythonTestResult => {
    if (item.id !== "expected:1") return honest(2)(item);
    if (fault === "timeout") return { id: item.id, status: "timeout", phase: "capture" };
    const value = fault === "error"
      ? { error: { type: "NameError", message: "name 'zz' is not defined" } }
      : { value: { t: "list", v: [{ t: "too_large", type: "DataFrame", size: 20000 }] } };
    return { id: item.id, status: "completed", result: { stdout: "", error: null, doctest: [], captures: { "2": value } } };
  };
  const errored = await runCodeTests(executor(broken("error")).run, plan(), ["x = 2"]);
  assert.deepEqual(errored.expectationProblems, [{ test: 1, expression: "2", reason: "NameError: name 'zz' is not defined" }]);
  assert.deepEqual(errored.programs[0], { verdict: "unresolved", tests: [{ status: "passed" }, { status: "unavailable", reason: "期望值算不出来" }] });
  const large = await runCodeTests(executor(broken("large")).run, plan(), ["x = 2"]);
  assert.match(large.expectationProblems[0]?.reason ?? "", /值太大，无法比较/);
  const timedOut = await runCodeTests(executor(broken("timeout")).run, plan(), ["x = 2"]);
  // 期望任务超时后整批停下，学习者的程序没有运行；在 capture 阶段超时也是期望任务的问题，不是程序答错。
  assert.deepEqual(timedOut.expectationProblems, [{ test: 1, reason: "运行超时（capture 阶段）" }]);
  assert.deepEqual(timedOut.programs[0], { verdict: "unresolved", tests: [{ status: "not_run" }, { status: "not_run" }] });
});

test("学习者的值太大、结果缺项或序列化的值不合约定时没有结论，学习者的程序抛异常时判错", async () => {
  const learner = (result: (item: PythonTest) => PythonProgramResult) => (item: PythonTest): PythonTestResult =>
    item.id.startsWith("expected:") ? honest(2)(item) : { id: item.id, status: "completed", result: result(item) };
  const cases: [(item: PythonTest) => PythonProgramResult, { status: string; reason?: string }][] = [
    [() => ran({ x: { t: "too_large", type: "list", size: 20000 }, df: {} }), { status: "unavailable", reason: "执行值过大，无法可靠比较" }],
    [() => ran({ x: int(2) }), { status: "unavailable", reason: "执行结果缺项" }],
    [() => ran({ x: { t: "dict", v: "不是数组" }, df: { t: "dict", v: "不是数组" } }), { status: "unavailable", reason: "执行结果无法识别" }],
    [() => ran({ x: int(2), df: {} }, { error: { type: "ValueError", message: "bad", line: 1 } }), { status: "failed", reason: "运行出错：ValueError: bad" }],
  ];
  for (const [result, expected] of cases) {
    const run = await runCodeTests(executor(learner(result)).run, plan([TESTS[0] as CodeTest]), ["x = 2"]);
    assert.deepEqual(run.programs[0]?.tests[0], expected);
  }
});

test("执行方不守约（缺项、顺序或 id 不对、停下后还有结果、停下前出现未执行）时按服务失败处理", async () => {
  const valid = (tests: PythonTest[]) => tests.map((item) => honest(2)(item));
  const variants: ((tests: PythonTest[]) => PythonTestResult[])[] = [
    (tests) => valid(tests).slice(1),
    (tests) => valid(tests).reverse(),
    (tests) => valid(tests).map((result, index) => (index === 0 ? { ...result, id: "other" } : result)),
    (tests) => valid(tests).map((result, index) => (index === 1 ? { id: result.id, status: "timeout", phase: "program" } : result)),
    (tests) => valid(tests).map((result, index) => (index === 1 ? { id: result.id, status: "not_run" } : result)),
  ];
  for (const variant of variants) {
    await assert.rejects(
      runCodeTests(async (tests) => ({ tests: variant(tests) }), plan(), ["x = 2"]),
      (error: unknown) => error instanceof RepaFault && error.code === "service_failed",
    );
  }
});

test("恢复失败的结果照样有效：执行方换了解释器接着运行，入口不另起调用", async () => {
  const restoreError = { type: "FileNotFoundError", message: "no such file" };
  const { run, calls } = executor((item) => {
    const result = honest(2)(item);
    return item.id === "test:0" && result.status === "completed" ? { ...result, restoreError } : result;
  });
  const result = await runCodeTests(run, plan(), ["x = 2"]);
  assert.equal(calls.length, 1);
  assert.equal(result.programs[0]?.verdict, "correct");
});

test("判分的执行方经 python.run 调用前端：请求只有协议名和测试，结果不合约定时按服务失败处理", async () => {
  const requests: unknown[] = [];
  let reply: unknown;
  const host = { services: { call: async (service: string, input: unknown) => { requests.push([service, input]); return reply; } } } as unknown as Host;
  const tests: PythonTest[] = [{ id: "test:0", prelude: "", setup: "", data: [], program: "x = 1", captures: ["x"], doctest: [] }];
  const runtime = { pyodide: "314.0.7", python: "3.14.2", packages: { numpy: "2.4.6", pandas: "3.0.2" } };
  reply = { protocol: PYTHON_BATCH, runtime, tests: [{ id: "test:0", status: "completed", result: ran({ x: int(1) }) }] };
  assert.deepEqual(await frontendTests(host)(tests), { runtime, tests: [{ id: "test:0", status: "completed", result: ran({ x: int(1) }) }] });
  assert.deepEqual(requests, [["python.run", { protocol: PYTHON_BATCH, tests }]]);
  for (const invalid of [{ ...(reply as object), protocol: "repa-python-batch-v1" }, { ...(reply as object), submissionId: "s" }, { tests: [] }]) {
    reply = invalid;
    await assert.rejects(frontendTests(host)(tests), (error: unknown) => error instanceof RepaFault && error.code === "service_failed");
  }
});

test("作答拼成程序：代码题取作答的代码，Parsons 题按作答的缩进把块拼起来", () => {
  const { slot } = codeQuestion(TESTS);
  assert.equal(answerProgram(slot, { type: "code", code: "x = 1" }), "x = 1");
  const order: OrderSlot = {
    id: "lines", type: "order", indent: 2, items: [{ id: "a", code: "def f():" }, { id: "b", code: "return 1" }], key: ["a", "b"],
    tests: [{ name: "t", expect: { "f()": "1" } }],
  };
  assert.equal(answerProgram(order, { type: "order", items: ["a", "b"], indents: [0, 1] }), "def f():\n    return 1");
  assert.equal(answerProgram(order, { type: "order", items: ["b", "a"] }), "return 1\ndef f():");
  assert.equal(answerProgram(order, { type: "code", code: "x" }), undefined);
});
