import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { PythonRunTest } from "../src/protocol.js";
import { describeRuntime } from "../src/sandbox/runtime.js";
import { RUNTIME } from "./demo-course.js";

const RUNNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "sandbox", "runner.py");

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
      globals: { get(name: string): (line: string) => Generator };
    }>;
  };
  const pyodide = await loadPyodide({
    indexURL: `${assets.pyodideDirectory}/`, packageCacheDir: `${assets.packagesDirectory}/`, stdout: () => {}, stderr: () => {},
  });
  await pyodide.loadPackage(assets.load, { messageCallback: () => {} });
  pyodide.runPython(await readFile(RUNNER, "utf8"), { filename: "runner.py" });
  return pyodide.globals.get("frontend_test");
})();

/** 跑完一个测试，返回依次报告的阶段和最终结果。 */
function run(start: (line: string) => Generator, job: Partial<PythonRunTest> & { program: string; prelude?: string }) {
  const generator = start(JSON.stringify({ data: [], captures: [], doctest: [], ...job }));
  const phases: string[] = [];
  for (;;) {
    const step = generator.next();
    if (step.done) return { phases, result: JSON.parse(String(step.value)) as Record<string, unknown> };
    const [phase, index] = (step.value as { toJs(): [string, number | undefined] }).toJs();
    phases.push(index === undefined ? phase : `${phase}#${index}`);
  }
}

test("frontend_test 逐个阶段报告，结果与 program 任务相同；capture 的求值和序列化分成两步", async (t) => {
  const start = await frontend;
  if (typeof start === "string") return t.skip(start);
  const { phases, result } = run(start, {
    prelude: "LIMIT = 3",
    data: [{ kind: "python", label: "nums", code: "nums = [1, 2, 3]" }],
    setup: "offset = 1",
    program: "total = sum(nums) + offset\nprint(total)",
    captures: ["total", "missing"],
    doctest: ["total > LIMIT"],
  });
  assert.deepEqual(phases, [
    "prelude", "data", "setup", "program", "captures#0", "serialize#0", "captures#1", "doctest#0", "teardown",
  ]);
  assert.deepEqual(result, {
    status: "done",
    stdout: "7\n",
    error: null,
    captures: { total: { value: { t: "int", v: "7" } }, missing: { error: { type: "NameError", message: "name 'missing' is not defined" } } },
    doctest: [{ out: "True\n", exception: null }],
  });
});

test("前导、数据或 setup 出错时以 failed 结束并指出阶段；学习者代码里的异常和 exit() 记在结果里", async (t) => {
  const start = await frontend;
  if (typeof start === "string") return t.skip(start);
  assert.deepEqual(run(start, { setup: "1 / 0", program: "x = 1" }).result, {
    status: "failed", phase: "setup", error: { type: "RuntimeError", message: "测试的 setup 出错：ZeroDivisionError: division by zero" },
  });
  assert.deepEqual(run(start, { data: [{ kind: "python", label: "bad", code: "raise ValueError('x')" }], program: "x = 1" }).result, {
    status: "failed", phase: "data", error: { type: "RuntimeError", message: "数据 bad 的准备代码出错：ValueError: x" },
  });

  const { result } = run(start, { program: "def stop():\n    exit(3)", captures: ["stop()"], doctest: ["stop()"] });
  assert.deepEqual(result.captures, { "stop()": { error: { type: "SystemExit", message: "3" } } });
  assert.deepEqual(result.doctest, [{ out: "", exception: "SystemExit: 3" }]);
});

test("每个测试结束时恢复解释器状态，下一个测试看不到上一个改动的选项", async (t) => {
  const start = await frontend;
  if (typeof start === "string") return t.skip(start);
  run(start, { program: "import pandas as pd\npd.set_option('display.max_rows', 3)" });
  const { result } = run(start, { program: "import pandas as pd\nrows = pd.get_option('display.max_rows')", captures: ["rows"] });
  assert.deepEqual(result.captures, { rows: { value: { t: "int", v: "60" } } });
});
