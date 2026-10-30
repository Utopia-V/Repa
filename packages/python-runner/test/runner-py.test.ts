import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import type { PythonTest } from "../src/protocol.js";
import { describeRuntime, RUNNER_FILE } from "../src/runtime.js";
import { packagesUnavailable, RUNTIME, skipUnavailableEnvironment } from "./environment.js";

interface Generator {
  next(): { done: boolean; value: unknown };
}

/** 任务之外 Python 打印到解释器标准输出的内容；runner.py 自己收集的输出不会出现在这里。 */
const escaped: string[] = [];

/** 前端 Worker 调用 program_test 的方式：这里直接在测试进程里加载 Pyodide，测试代码是可信的。 */
const frontend = (async () => {
  const reason = await packagesUnavailable();
  if (reason) return reason;
  const assets = await describeRuntime(RUNTIME);
  const { loadPyodide } = (await import(pathToFileURL(path.join(assets.pyodideDirectory, "pyodide.mjs")).href)) as {
    loadPyodide(options: object): Promise<{
      loadPackage(names: string[], options: object): Promise<void>;
      runPython(code: string, options: object): unknown;
      globals: { get(name: "program_test"): (line: string) => Generator };
    }>;
  };
  const pyodide = await loadPyodide({
    indexURL: `${assets.pyodideDirectory}/`, packageCacheDir: `${assets.packagesDirectory}/`,
    stdout: (text: string) => escaped.push(text), stderr: () => {},
  });
  await pyodide.loadPackage(assets.load, { messageCallback: () => {} });
  pyodide.runPython(await readFile(RUNNER_FILE, "utf8"), { filename: "runner.py" });
  return { test: pyodide.globals.get("program_test") };
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

test("program_test 逐个阶段报告；capture 的求值和序列化分成两步", async (t) => {
  const pyodide = await frontend;
  if (typeof pyodide === "string") return skipUnavailableEnvironment(t, pyodide);
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
  assert.equal(result.status, "completed");
  assert.deepEqual(result.result, {
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
  if (typeof pyodide === "string") return skipUnavailableEnvironment(t, pyodide);
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
  if (typeof pyodide === "string") return skipUnavailableEnvironment(t, pyodide);
  run(pyodide.test, { program: "import pandas as pd\npd.set_option('display.max_rows', 3)" });
  const { result } = run(pyodide.test, { program: "import pandas as pd\nrows = pd.get_option('display.max_rows')", captures: ["rows"] });
  assert.deepEqual(result, { status: "completed", result: { stdout: "", error: null, captures: { rows: { value: { t: "int", v: "60" } } }, doctest: [] } });
});

/** 只看运行结果：completed 的 result。 */
function outcome(start: (line: string) => Generator, job: Partial<PythonTest> & { program: string }) {
  const { result } = run(start, job);
  assert.equal(result.status, "completed");
  return result.result as { captures: Record<string, unknown>; doctest: unknown[] };
}

test("capture 的值序列化后即释放，求值和序列化共用输出上限，被检查的调用 exit() 记在这一项上", async (t) => {
  const pyodide = await frontend;
  if (typeof pyodide === "string") return skipUnavailableEnvironment(t, pyodide);
  const released = {
    program: "x = 0\nclass V:\n    def __repr__(self):\n        return 'V'\n    def __del__(self):\n        global x\n        x = 5",
    captures: ["V()", "x"],
  };
  const noisy = {
    program: "class Loud:\n    def __repr__(self):\n        print('r' * 40000)\n        return 'Loud'\ndef make():\n    print('e' * 40000)\n    return Loud()",
    captures: ["make()"],
  };
  const exiting = { program: "def stop():\n    exit(3)", captures: ["stop()"], doctest: ["stop()"] };
  assert.deepEqual(outcome(pyodide.test, released).captures.x, { value: { t: "int", v: "5" } });
  assert.deepEqual(outcome(pyodide.test, noisy).captures["make()"], { error: { type: "OutputTooLong", message: "输出超过 64 KiB" } });
  assert.deepEqual(outcome(pyodide.test, exiting).captures["stop()"], { error: { type: "SystemExit", message: "3" } });
});

test("capture 的值在释放时打印的内容也收进这一项的输出、算进上限，不漏到任务之外", async (t) => {
  const pyodide = await frontend;
  if (typeof pyodide === "string") return skipUnavailableEnvironment(t, pyodide);
  const job = {
    program: "class Noisy:\n    def __repr__(self):\n        return 'Noisy'\n    def __del__(self):\n        print('d' * 70000)",
    captures: ["Noisy()"],
  };
  escaped.length = 0;
  const captures = outcome(pyodide.test, job).captures;
  assert.deepEqual(escaped.map((text) => text.length), []);
  assert.deepEqual(captures, { "Noisy()": { value: { t: "repr", type: "Noisy", v: "Noisy" } } });
});

test("program 为空串时只在准备好的命名空间里对 captures 求值：期望表达式就这样算", async (t) => {
  const pyodide = await frontend;
  if (typeof pyodide === "string") return skipUnavailableEnvironment(t, pyodide);
  const job = {
    prelude: "import pandas as pd",
    data: [{ label: "T", fixture: { kind: "dataframe" as const, name: "df", columns: { n: [3, 1] } } }],
    setup: "limit = 2",
    program: "",
    captures: ["df.loc[df['n'] > limit, ['n']]", "limit"],
  };
  const { phases, result } = run(pyodide.test, job);
  assert.deepEqual(phases, ["prepare", "program", "capture#0", "serialize#0", "capture#1", "serialize#1", "cleanup"]);
  assert.deepEqual(result, {
    status: "completed",
    result: {
      stdout: "",
      error: null,
      captures: {
        "df.loc[df['n'] > limit, ['n']]": {
          value: { t: "DataFrame", index: [{ t: "int", v: "0" }], columns: [{ t: "str", v: "n" }], kinds: ["i"], values: [[{ t: "int", v: "3" }]] },
        },
        limit: { value: { t: "int", v: "2" } },
      },
      doctest: [],
    },
  });
});
