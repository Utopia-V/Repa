/**
 * 运行学习者 Python 代码的 Worker。学习者的代码不可信，这里有两层限制：
 * - 宿主在这个脚本的响应头里给 CSP：default-src 'none'; script-src 'self' 'wasm-unsafe-eval'。
 *   Worker 不继承页面 meta 里的 CSP，没有这个响应头时，Python 一句 pyfetch 就能读到后端连接的 token。
 *   有了它，Worker 发不出任何网络请求，也不能字符串求值，只能编译 WebAssembly。启动前先确认它生效，否则拒绝运行。
 * - Python 的 js 模块只看得到一个空对象，与 Node 宿主的 sandbox/runner.mjs 相同。
 * Pyodide 和 wheel 由页面取好、核对 SHA-256 后交进来；启动期间 fetch 用这些文件应答，启动后换回原来的 fetch。
 * 一个 Worker 只运行一批测试，用完由页面销毁，前一次提交的代码碰不到下一次。
 */
import type { loadPyodide as LoadPyodide } from "pyodide";

import type { PythonTest } from "../protocol.js";
import type { WorkerMessage, WorkerRequest } from "./messages.js";

type StartRequest = Extract<WorkerRequest, { type: "start" }>;

const originalFetch = globalThis.fetch;
let runTest: ((line: string, onPhase: (phase: unknown) => void) => unknown) | undefined;

function send(message: WorkerMessage): void {
  postMessage(message);
}

/** CSP 生效时，字符串求值和网络请求都会失败。两样都要失败才算隔离。 */
async function isolated(): Promise<boolean> {
  try {
    new Function("");
    return false;
  } catch {
    // 预期的结果：CSP 没有放行 'unsafe-eval'。
  }
  try {
    await originalFetch(location.href, { cache: "no-store" });
    return false;
  } catch {
    // 预期的结果：default-src 'none' 拦下了请求（控制台会记一条 CSP 违规）。
    return true;
  }
}

async function start(request: StartRequest): Promise<object> {
  if (!(await isolated())) {
    throw new Error("Python 运行环境没有隔离：Worker 脚本的响应头里缺少 CSP，不运行代码。");
  }
  const files = new Map(Object.entries(request.files));
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    const name = decodeURIComponent(new URL(url, location.href).pathname.split("/").pop() ?? "");
    const body = files.get(name);
    if (body === undefined) throw new Error(`Pyodide 要的 ${name} 没有交进来`);
    const type = name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
    return new Response(body, { headers: { "Content-Type": type } });
  };
  try {
    const url = new URL("pyodide.mjs", request.indexURL).href;
    const { loadPyodide } = (await import(/* @vite-ignore */ url)) as { loadPyodide: typeof LoadPyodide };
    const pyodide = await loadPyodide({
      indexURL: request.indexURL,
      packageBaseUrl: request.packageBaseUrl,
      lockFileContents: request.lock,
      jsglobals: Object.create(null) as object,
      // 任务的输出由 runner.py 自己捕获；任务之外 Python 打印的内容没有人看。
      stdout: () => {},
      stderr: () => {},
    });
    await pyodide.loadPackage(request.packages, { messageCallback: () => {} });
    pyodide.runPython(request.runner, { filename: "runner.py" });
    const { PyCallable, PyIterator, PyProxy } = pyodide.ffi;
    const programTest: unknown = pyodide.globals.get("program_test");
    const versions: unknown = pyodide.globals.get("runtime_versions");
    if (!(programTest instanceof PyCallable) || !(versions instanceof PyCallable)) {
      throw new Error("runner.py 没有定义 program_test、runtime_versions");
    }
    runTest = (line, onPhase) => {
      const generator: unknown = programTest(line);
      if (!(generator instanceof PyIterator)) throw new Error("program_test 没有返回生成器");
      try {
        for (;;) {
          const step = generator.next();
          if (step.done === true) return JSON.parse(String(step.value)) as unknown;
          // 产出的是 (阶段, 序号) 元组，转成 JS 数组后释放代理。
          if (step.value instanceof PyProxy) {
            onPhase(step.value.toJs());
            step.value.destroy();
          }
        }
      } finally {
        generator.destroy();
      }
    };
    const runtime: unknown = JSON.parse(String(versions(pyodide.toPy(request.packages))));
    return { pyodide: pyodide.version, ...(typeof runtime === "object" ? runtime : {}) };
  } finally {
    globalThis.fetch = originalFetch;
    files.clear();
  }
}

/** 依次运行一批测试，每个阶段开始前告诉页面；某个测试没有正常结束就停下，剩下的由页面记为未执行。 */
function run(tests: PythonTest[], test: NonNullable<typeof runTest>): void {
  for (const [index, job] of tests.entries()) {
    const response = test(JSON.stringify(job), (phase) => {
      const [name, at]: unknown[] = Array.isArray(phase) ? phase : [];
      send({ type: "phase", test: index, phase: String(name), index: typeof at === "number" ? at : null });
    });
    send({ type: "tested", test: index, response });
    if (typeof response !== "object" || response === null || !("status" in response) || response.status !== "completed") return;
  }
}

addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type === "start") {
    start(request).then(
      (runtime) => send({ type: "ready", runtime }),
      (error: unknown) => send({ type: "failed", message: error instanceof Error ? error.message : String(error) }),
    );
    return;
  }
  if (!runTest) {
    send({ type: "failed", message: "Pyodide 还没有就绪" });
    return;
  }
  try {
    run(request.tests, runTest);
  } catch (error) {
    // program_test 自己接住测试里的异常；漏到这里说明解释器状态没能恢复，页面把它记为 Worker 失败。
    send({ type: "failed", message: error instanceof Error ? error.message : String(error) });
  }
});
