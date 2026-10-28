import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { PythonTest } from "../src/protocol.js";
import { describeRuntime } from "../src/sandbox/runtime.js";
import { RUNTIME } from "./demo-course.js";
import { loadRunner, runTest, type LoadedRunner } from "./pyodide.js";

const SANDBOX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "sandbox");

const frontend = (async () => {
  let assets;
  try {
    assets = await describeRuntime(RUNTIME);
  } catch (error) {
    if (error instanceof Error && error.name === "RuntimeProblem") return error.message;
    throw error;
  }
  return loadRunner(assets, path.join(SANDBOX, "runner.py"));
})();

function run(start: LoadedRunner["test"], job: Partial<PythonTest> & { program: string }) {
  return runTest(start, { id: "t", prelude: "", setup: "", data: [], captures: [], doctest: [], ...job });
}

test("program_test 逐个阶段报告，结果与 program 任务相同；capture 的求值和序列化分成两步", async (t) => {
  const pyodide = await frontend;
  if (typeof pyodide === "string") return t.skip(pyodide);
  const job = {
    prelude: "LIMIT = 3",
    data: [
      { label: "nums", fixture: { kind: "python" as const, code: "nums = [1, 2, 3]", display: "三个数" } },
      { label: "sales", fixture: { kind: "dataframe" as const, name: "sales", caption: "销售额", columns: { amount: [1, 2] }, dtypes: { amount: "float" as const } } },
    ],
    setup: "offset = 1",
    program: "total = sum(nums) + offset\nprint(total)",
    captures: ["total", "missing", "sales['amount'].sum()"],
    doctest: ["total > LIMIT"],
  };
  const { phases, result } = run(pyodide.test, job);
  assert.deepEqual(phases, [
    "prepare", "program", "capture#0", "serialize#0", "capture#1", "capture#2", "serialize#2", "doctest#0", "cleanup",
  ]);
  const program = JSON.parse(pyodide.handleJob(JSON.stringify({
    op: "program", ...job, data: job.data.map(({ label, fixture }) => ({ ...fixture, label })),
  }))) as { ok: boolean; result: unknown };
  assert.deepEqual(result, { status: "completed", result: program.result });
  assert.deepEqual(program.result, {
    stdout: "7\n",
    error: null,
    captures: {
      total: { value: { t: "int", v: "7" } },
      missing: { error: { type: "NameError", message: "name 'missing' is not defined" } },
      "sales['amount'].sum()": { value: { t: "float", v: "3.0" } },
    },
    doctest: [{ out: "True\n", exception: null }],
  });
});

test("前导、夹具或 setup 出错时以 failed 结束，阶段是 prepare；学习者代码里的异常和 exit() 记在结果里", async (t) => {
  const pyodide = await frontend;
  if (typeof pyodide === "string") return t.skip(pyodide);
  assert.deepEqual(run(pyodide.test, { setup: "1 / 0", program: "x = 1" }).result, {
    status: "failed", phase: "prepare", error: { type: "RuntimeError", message: "测试的 setup 出错：ZeroDivisionError: division by zero" },
  });
  assert.deepEqual(run(pyodide.test, { data: [{ label: "bad", fixture: { kind: "python", code: "raise ValueError('x')" } }], program: "x = 1" }).result, {
    status: "failed", phase: "prepare", error: { type: "RuntimeError", message: "数据 bad 的准备代码出错：ValueError: x" },
  });

  const { result } = run(pyodide.test, { program: "def stop():\n    exit(3)", captures: ["stop()"], doctest: ["stop()"] });
  assert.deepEqual(result, {
    status: "completed",
    result: {
      stdout: "", error: null, captures: { "stop()": { error: { type: "SystemExit", message: "3" } } }, doctest: [{ out: "", exception: "SystemExit: 3" }],
    },
  });
});

test("每个测试结束时恢复解释器状态，下一个测试看不到上一个改动的选项", async (t) => {
  const pyodide = await frontend;
  if (typeof pyodide === "string") return t.skip(pyodide);
  run(pyodide.test, { program: "import pandas as pd\npd.set_option('display.max_rows', 3)" });
  const { result } = run(pyodide.test, { program: "import pandas as pd\nrows = pd.get_option('display.max_rows')", captures: ["rows"] });
  assert.deepEqual(result, { status: "completed", result: { stdout: "", error: null, captures: { rows: { value: { t: "int", v: "60" } } }, doctest: [] } });
});

/** 课程核对执行 program 任务的结果。 */
function program(handleJob: (line: string) => string, job: Partial<PythonTest> & { program: string }) {
  return JSON.parse(handleJob(JSON.stringify({ op: "program", prelude: "", setup: "", data: [], captures: [], doctest: [], ...job }))) as {
    ok: boolean; result?: { captures: Record<string, unknown>; doctest: unknown[] };
  };
}

test("课程核对与前端结果相同：capture 的值序列化后即释放，求值和序列化共用输出上限，被检查的调用 exit() 记在这一项上", async (t) => {
  const pyodide = await frontend;
  if (typeof pyodide === "string") return t.skip(pyodide);
  const released = {
    program: "x = 0\nclass V:\n    def __repr__(self):\n        return 'V'\n    def __del__(self):\n        global x\n        x = 5",
    captures: ["V()", "x"],
  };
  const noisy = {
    program: "class Loud:\n    def __repr__(self):\n        print('r' * 40000)\n        return 'Loud'\ndef make():\n    print('e' * 40000)\n    return Loud()",
    captures: ["make()"],
  };
  const exiting = { program: "def stop():\n    exit(3)", captures: ["stop()"], doctest: ["stop()"] };
  for (const job of [released, noisy, exiting]) {
    const checked = program(pyodide.handleJob, job);
    assert.equal(checked.ok, true);
    assert.deepEqual(run(pyodide.test, job).result, { status: "completed", result: checked.result });
  }
  assert.deepEqual(program(pyodide.handleJob, released).result?.captures.x, { value: { t: "int", v: "5" } });
  assert.deepEqual(program(pyodide.handleJob, noisy).result?.captures["make()"], { error: { type: "OutputTooLong", message: "输出超过 64 KiB" } });
  assert.deepEqual(program(pyodide.handleJob, exiting).result?.captures["stop()"], { error: { type: "SystemExit", message: "3" } });
});
