import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { PythonTest } from "../src/protocol.js";
import type { RuntimeAssets } from "../src/sandbox/runtime.js";

interface Generator {
  next(): { done: boolean; value: unknown };
}

export interface LoadedRunner {
  /** 前端 Worker 调用的入口，一个测试一个生成器。 */
  test: (line: string) => Generator;
  /** 课程核对调用的入口，参数和返回值都是一行 JSON。 */
  handleJob: (line: string) => string;
}

/** 前端 Worker 加载 runner.py 的方式：这里直接在测试进程里加载 Pyodide，测试代码是可信的。 */
export async function loadRunner(assets: RuntimeAssets, runnerPath: string): Promise<LoadedRunner> {
  const { loadPyodide } = (await import(pathToFileURL(path.join(assets.pyodideDirectory, "pyodide.mjs")).href)) as {
    loadPyodide(options: object): Promise<{
      loadPackage(names: string[], options: object): Promise<void>;
      runPython(code: string, options: object): unknown;
      globals: { get(name: "program_test"): LoadedRunner["test"]; get(name: "handle_job"): LoadedRunner["handleJob"] };
    }>;
  };
  const pyodide = await loadPyodide({
    indexURL: `${assets.pyodideDirectory}/`, packageCacheDir: `${assets.packagesDirectory}/`, stdout: () => {}, stderr: () => {},
  });
  await pyodide.loadPackage(assets.load, { messageCallback: () => {} });
  pyodide.runPython(await readFile(runnerPath, "utf8"), { filename: "runner.py" });
  return { test: pyodide.globals.get("program_test"), handleJob: pyodide.globals.get("handle_job") };
}

/** 跑完一个测试，返回依次报告的阶段和最终结果。 */
export function runTest(start: LoadedRunner["test"], test: PythonTest) {
  const generator = start(JSON.stringify(test));
  const phases: string[] = [];
  for (;;) {
    const step = generator.next();
    if (step.done) return { phases, result: JSON.parse(String(step.value)) as Record<string, unknown> };
    const [phase, index] = (step.value as { toJs(): [string, number | undefined] }).toJs();
    phases.push(index === undefined ? phase : `${phase}#${index}`);
  }
}
