import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { PythonTest } from "../src/protocol.js";
import { describeRuntime } from "../src/sandbox/runtime.js";
import { RUNTIME } from "./demo-course.js";

const SANDBOX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "sandbox");

interface Generator {
  next(): { done: boolean; value: unknown };
}

/** 前端 Worker 调用 frontend_test 的方式：这里直接在测试进程里加载 Pyodide，测试代码是可信的。 */
const frontend = (async () => {
  let assets;
  try {
    assets = await describeRuntime(RUNTIME);
  } catch (error) {
    if (error instanceof Error && error.name === "RuntimeProblem") return error.message;
    throw error;
  }
  const { loadPyodide } = (await import(pathToFileURL(path.join(assets.pyodideDirectory, "pyodide.mjs")).href)) as {
    loadPyodide(options: object): Promise<{
      loadPackage(names: string[], options: object): Promise<void>;
      runPython(code: string, options: object): unknown;
      globals: { get(name: "frontend_test"): (line: string) => Generator; get(name: "handle_job"): (line: string) => string };
    }>;
  };
  const pyodide = await loadPyodide({
    indexURL: `${assets.pyodideDirectory}/`, packageCacheDir: `${assets.packagesDirectory}/`, stdout: () => {}, stderr: () => {},
  });
  await pyodide.loadPackage(assets.load, { messageCallback: () => {} });
  pyodide.runPython(await readFile(path.join(SANDBOX, "runner.py"), "utf8"), { filename: "runner.py" });
  pyodide.runPython(await readFile(path.join(SANDBOX, "frontend.py"), "utf8"), { filename: "frontend.py" });
  return {
    test: pyodide.globals.get("frontend_test"),
    handleJob: pyodide.globals.get("handle_job"),
  };
})();

/** 跑完一个测试，返回依次报告的阶段和最终结果。 */
function run(start: (line: string) => Generator, job: Partial<PythonTest> & { program: string }) {
  const generator = start(JSON.stringify({ id: "t", prelude: "", setup: "", data: [], captures: [], doctest: [], ...job }));
  const phases: string[] = [];
  for (;;) {
    const step = generator.next();
    if (step.done) return { phases, result: JSON.parse(String(step.value)) as Record<string, unknown> };
    const [phase, index] = (step.value as { toJs(): [string, number | undefined] }).toJs();
    phases.push(index === undefined ? phase : `${phase}#${index}`);
  }
}

test("frontend_test 逐个阶段报告，结果与 program 任务相同；capture 的求值和序列化分成两步", async (t) => {
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
