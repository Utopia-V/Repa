import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { PYTHON_PACKAGES, type PythonTest } from "../src/protocol.js";
import { describeRuntime, RUNNER_FILE } from "../src/runtime.js";
import { packagesUnavailable, skipUnavailableEnvironment } from "./environment.js";

interface Generator {
  next(): { done: boolean; value: unknown };
}

/** 任务之外 Python 打印到解释器标准输出的内容；runner.py 自己收集的输出不会出现在这里。 */
const escaped: string[] = [];

/**
 * 前端 Worker 调用 program_test 的方式：这里直接在测试进程里加载 Pyodide，测试代码是可信的。
 * 带的包一开始就全部加载，与预热了这些包的 Worker 相同；按需加载由两个宿主负责，见 sandbox.test.ts。
 */
const frontend = (async () => {
  const reason = await packagesUnavailable();
  if (reason) return reason;
  const assets = await describeRuntime();
  const { loadPyodide } = (await import(pathToFileURL(path.join(assets.pyodideDirectory, "pyodide.mjs")).href)) as {
    loadPyodide(options: object): Promise<{
      loadPackage(names: readonly string[], options: object): Promise<void>;
      runPython(code: string, options: object): unknown;
      globals: { get(name: string): (...args: string[]) => unknown };
    }>;
  };
  const pyodide = await loadPyodide({
    indexURL: `${assets.pyodideDirectory}/`, packageCacheDir: `${assets.packagesDirectory}/`,
    stdout: (text: string) => escaped.push(text), stderr: () => {},
  });
  await pyodide.loadPackage(PYTHON_PACKAGES, { messageCallback: () => {} });
  pyodide.runPython(await readFile(RUNNER_FILE, "utf8"), { filename: "runner.py" });
  pyodide.globals.get("configure")(JSON.stringify(assets.imports));
  pyodide.globals.get("track_libraries")();
  const packages = pyodide.globals.get("test_packages");
  return {
    test: pyodide.globals.get("program_test") as (line: string) => Generator,
    packages: (job: Partial<PythonTest>) => JSON.parse(String(packages(JSON.stringify({ prelude: "", setup: "", program: "", data: [], doctest: [], ...job })))) as unknown,
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

test("宿主按 test_packages 加载包：只看 import 语句引入的带着的包，前导、夹具、setup、doctest 和 verify 的题面代码都算，DataFrame 夹具要 pandas", async (t) => {
  const pyodide = await frontend;
  if (typeof pyodide === "string") return skipUnavailableEnvironment(t, pyodide);
  assert.deepEqual(pyodide.packages({ program: "import math, fractions\nfrom statistics import mean\nimport scipy" }), []);
  assert.deepEqual(pyodide.packages({ program: "import numpy.linalg as la" }), ["numpy"]);
  assert.deepEqual(pyodide.packages({ program: "def f():\n    from numpy import array\n    return array([1])" }), ["numpy"]);
  assert.deepEqual(pyodide.packages({ prelude: "import pandas as pd" }), ["pandas"]);
  assert.deepEqual(pyodide.packages({ setup: "import dateutil" }), ["python-dateutil"]);
  assert.deepEqual(pyodide.packages({ doctest: ["import numpy"] }), ["numpy"]);
  assert.deepEqual(pyodide.packages({ data: [{ label: "f", fixture: { kind: "python", code: "import numpy" } }] }), ["numpy"]);
  assert.deepEqual(pyodide.packages({ data: [{ label: "T", fixture: { kind: "dataframe", name: "df", columns: { n: [1] } } }] }), ["pandas"]);
  const verify = { code: "import pandas", blocks: [], options: { c: { a: "import numpy" } }, cells: {}, shape: {} };
  assert.deepEqual(pyodide.packages({ program: "answers = {}", verify }), ["numpy", "pandas"]);
  // 写在字符串里的代码和语法错误的代码不算：前者运行时才知道，后者运行时自己报错。
  assert.deepEqual(pyodide.packages({ program: "run('import numpy')\nexec('import pandas')" }), []);
  assert.deepEqual(pyodide.packages({ program: "import numpy\nx = (" }), []);
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
  return result.result as { captures: Record<string, unknown>; doctest: unknown[]; error: unknown; verified?: unknown };
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

test("verify 任务经 program_test 运行，核对程序的辅助函数：出错行号、实际执行的行、函数收到的参数、显示内容的标记和固定格", async (t) => {
  const pyodide = await frontend;
  if (typeof pyodide === "string") return skipUnavailableEnvironment(t, pyodide);
  const script = [
    "plain = run(\"x = 1\\ny = 2\\nz = y / 0\\nprint('after')\")",
    "inner = run(\"def f():\\n    return 1 / 0\\n\\nprint('a')\\nf()\")",
    "broken = run(\"print('a')\\nx = (\\n\")",
    "fine = run(\"x = 1\")",
    "ran = executed_lines(\"a = 1\\nif a > 5:\\n    b = 2\\nelse:\\n    b = 3\")",
    "seen = calls(\"def label(signal, limit=10):\\n    gap = signal - limit\\n    return gap > 0\\n\\nlabel(12)\\nlabel(3, limit=5)\", name='label')",
    "answers = {",
    "  'plain': plain.error_line, 'inner': inner.error_line, 'broken': broken.error_line, 'fine': fine.error_line,",
    "  'ran': ran,",
    "  'args': [call.args for call in seen], 'first': seen[0].locals, 'returned': [call.returned for call in seen],",
    "  'nothing': show(None), 'function': show(len), 'value': show([1, 'a']),",
    "  'error': ERROR, 'marked': as_shown('abc'), 'bare': 'abc',",
    "  'cell': CELLS['grid']['r1']['input'],",
    "}",
  ].join("\n");
  const shape = {
    plain: "text", inner: "text", broken: "text", fine: "text", ran: "text", args: "text", first: "text", returned: "text",
    nothing: "display", function: "display", value: "display", error: "display", marked: "display", bare: "display", cell: "text",
  };
  const verify = { code: "", blocks: [], options: {}, cells: { grid: { r1: { input: "len('ab')" } } }, shape };
  const { phases, result } = run(pyodide.test, { program: script, verify });
  assert.deepEqual(phases, ["prepare", "program", "cleanup"]);
  assert.equal(result.status, "completed");
  assert.deepEqual((result.result as { verified: unknown }).verified, {
    answers: {
      plain: "3", inner: "2", broken: "2", fine: "None", ran: "[1, 2, 5]",
      args: "[{'signal': 12, 'limit': 10}, {'signal': 3, 'limit': 5}]",
      first: "{'signal': 12, 'limit': 10, 'gap': 2}", returned: "[True, False]",
      nothing: "NOTHING", function: "FUNCTION", value: "[1, 'a']", error: "ERROR", marked: "abc", bare: "'abc'",
      cell: "len('ab')",
    },
    unknown: [],
  });
});

test("verify 程序出错、answers 不是字典时结果里没有算出的答案，错误写明类型和行号；不需要核对的作答位列进 unknown", async (t) => {
  const pyodide = await frontend;
  if (typeof pyodide === "string") return skipUnavailableEnvironment(t, pyodide);
  const verify = { code: "", blocks: [], options: {}, cells: {}, shape: { value: "text" } };
  const raised = outcome(pyodide.test, { program: "x = 1\nanswers = {'value': 1 / 0}", verify });
  assert.deepEqual(raised.error, { type: "ZeroDivisionError", message: "division by zero", line: 2 });
  assert.equal(raised.verified, undefined);
  const wrong = outcome(pyodide.test, { program: "answers = [1]", verify });
  assert.equal((wrong.error as { type: string }).type, "TypeError");
  assert.equal(wrong.verified, undefined);
  const extra = outcome(pyodide.test, { program: "answers = {'value': 2, 'other': 3}", verify });
  assert.deepEqual(extra.verified, { answers: { value: "2" }, unknown: ["other"] });
});
