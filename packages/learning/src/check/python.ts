/**
 * 课程核对在哪里运行 Python。课程里的 Python（verify 是模型写的代码，课件里可能有诱导模型的文字）只在两处运行：
 * Linux 沙箱（Landlock 与 seccomp），以及前端页面的 Worker（CSP 隔离，经前端服务 python.run）。两处都没有时不运行，
 * 不改用不受限的 Node 进程。两处都按 @repa/python-runner/protocol 的约定交回结果，比较全在这边，所以结论一致。
 */

import { isDeepStrictEqual } from "node:util";

import { RepaFault } from "@repa/base";
import type { Host } from "@repa/base/plugin";
import { describeRuntime, SandboxRunner, SandboxUnavailable, verifyPackages } from "@repa/python-runner";
import { replyDeadlineMs, type PythonTest, type Runtime as RunningRuntime } from "@repa/python-runner/protocol";

import { callPythonRun, type RunTests } from "../code-tests.js";
import type { Runtime } from "../format/schema.js";

/** 开始核对以后的一处 Python：实际加载的版本、执行方和代价计数。 */
export interface CheckRun {
  /** sandbox：Linux 沙箱；frontend：前端页面的 Worker。 */
  where: "sandbox" | "frontend";
  /** 实际加载的 Pyodide、Python 和包的版本，与课程清单逐项比较。 */
  runtime: RunningRuntime;
  run: RunTests;
  /** 到目前为止启动过的解释器数。前端每次调用至少用一个新的 Worker，按调用次数计。 */
  starts(): number;
  close(): Promise<void>;
}

/** 一处 Python 的启动参数：离线包目录（Linux 沙箱用）和测试每一段的时限。 */
export interface CheckRunOptions {
  packagesDirectory?: string;
  timeoutMs?: number;
}

/**
 * 能运行课程核对的一处。这一处用不了（不是 Linux、建不了隔离、没有前端提供 python.run）时抛 PythonUnavailable，
 * 检查接着试下一处；离线包缺失、版本不符等课程或安装的问题抛 RuntimeProblem，照常报告。
 */
export type CheckPython = (expected: Runtime, options: CheckRunOptions) => Promise<CheckRun>;

/** 这一处不能运行 Python；message 写明原因，会原样出现在检查结果里。 */
export class PythonUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PythonUnavailable";
  }
}

/** Linux 沙箱：整门课共用一个解释器，测试之间由 runner.py 恢复状态，恢复失败或超时才换新的。 */
export const sandboxPython: CheckPython = async (expected, options) => {
  let runner: SandboxRunner;
  let runtime: RunningRuntime;
  try {
    const assets = await describeRuntime(expected, options.packagesDirectory);
    await verifyPackages(assets);
    runner = new SandboxRunner({ assets });
    runtime = await runner.start();
  } catch (error) {
    if (!(error instanceof SandboxUnavailable)) throw error;
    const remedy = process.platform === "linux"
      ? "（隔离环境建不起来时，是这台机器缺少 Linux 的 Landlock（ABI 4 以上）与 libseccomp；Pyodide 启动失败时，把清单的 runtime 照写课说明改成与随包课程一致的版本和包）"
      : "";
    throw new PythonUnavailable(`Linux 沙箱用不了：${error.message}${remedy}`);
  }
  return {
    where: "sandbox",
    runtime,
    run: async (tests) => ({ runtime, tests: await runner.runTests(tests, options.timeoutMs) }),
    starts: () => runner.starts,
    close: () => runner.close(),
  };
};

/** 前端服务失败的原因，写成检查结果里的一句话。 */
function serviceProblem(error: unknown, waitedMs: number): string | undefined {
  if (!(error instanceof RepaFault) || !error.code.startsWith("service_")) return undefined;
  if (error.code === "service_unavailable") return "没有打开的应用页面能运行 Python（没有连接提供 python.run），应用窗口开着时才能在页面里核对";
  const reason = (error.details as { reason?: unknown } | undefined)?.reason;
  if (error.code === "service_cancelled" && reason === "aborted") return `应用页面在 ${waitedMs / 1000} 秒内没有交回 Python 的运行结果`;
  return `应用页面运行 Python 失败：${error.message}`;
}

/**
 * 前端页面的 Worker：经 python.run 运行，每次调用用一个新的 Worker。先发一批空的测试取得页面实际加载的版本，
 * 之后每批的版本都要与它相同。页面没有在期限内回应、连接断开或运行失败时，以 PythonUnavailable 结束这次核对；
 * 期限见 replyDeadlineMs，页面自己按同样的时限结束卡住的测试，这个期限只防页面本身没有回应。
 */
export function frontendPython(services: Host["services"]): CheckPython {
  return async (_expected, options) => {
    let calls = 0;
    const call = async (tests: PythonTest[]) => {
      calls += 1;
      const deadline = replyDeadlineMs(tests.length, options.timeoutMs);
      try {
        return await callPythonRun(services, tests, AbortSignal.timeout(deadline));
      } catch (error) {
        const problem = serviceProblem(error, deadline);
        throw problem === undefined ? error : new PythonUnavailable(problem);
      }
    };
    const { runtime } = await call([]);
    return {
      where: "frontend",
      runtime,
      async run(tests) {
        const reply = await call(tests);
        if (!isDeepStrictEqual(reply.runtime, runtime)) throw new PythonUnavailable("应用页面的 Python 运行环境在核对中途变了");
        return { runtime, tests: reply.tests };
      },
      starts: () => calls,
      close: async () => {},
    };
  };
}

/** 实际加载的运行时与课程清单不一致的地方；两处 Python 用同一份比较。清单没写而实际加载了的包也算不一致。 */
export function runtimeMismatches(expected: Runtime, actual: RunningRuntime): string[] {
  const names = [...new Set([...Object.keys(expected.packages), ...Object.keys(actual.packages)])];
  return [
    actual.pyodide !== expected.pyodide ? `Pyodide ${actual.pyodide}` : "",
    actual.python !== expected.python ? `Python ${actual.python}` : "",
    ...names.map((name) => {
      const want = expected.packages[name];
      const got = actual.packages[name];
      if (want === got) return "";
      return want === undefined ? `${name} ${got ?? ""}（清单里没有写）` : `${name} ${got ?? "未加载"}`;
    }),
  ].filter(Boolean);
}
