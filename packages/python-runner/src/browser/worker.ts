/**
 * 运行学习者 Python 代码的 Worker。学习者的代码不可信，这里有两层限制：
 * - 宿主在这个脚本的响应头里给 CSP：default-src 'none'; script-src 'self' 'wasm-unsafe-eval'。
 *   Worker 不继承页面 meta 里的 CSP，没有这个响应头时，Python 一句 pyfetch 就能读到后端连接的 token。
 *   有了它，Worker 发不出任何网络请求，也不能字符串求值，只能编译 WebAssembly。启动前先确认它生效，否则拒绝运行。
 * - Python 的 js 模块只看得到一个空对象，与 Node 宿主的 sandbox/runner.mjs 相同。
 * Pyodide 和 wheel 由页面取好、核对 SHA-256 后交进来，fetch 一直用这些文件应答：带的包在测试引入时才加载，
 * 启动之后还要取 wheel。别的地址一律失败，与 CSP 拦下的结果相同。
 * 一个 Worker 只运行一批测试，用完由页面销毁，前一次调用的代码碰不到下一次。
 */
import type { loadPyodide as LoadPyodide } from "pyodide";

import type { PythonTest } from "../protocol.js";
import type { WorkerMessage, WorkerRequest } from "./messages.js";

type StartRequest = Extract<WorkerRequest, { type: "start" }>;

const originalFetch = globalThis.fetch;

interface Runner {
  /** 测试引入的带着的包。 */
  packages(line: string): string[];
  /** 加载这些包并让 runner.py 记下它们的初始状态；没加载上就抛错。 */
  load(packages: string[]): Promise<void>;
  test(line: string, onPhase: (phase: unknown) => void): unknown;
}
let runner: Runner | undefined;

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
  // 启动之后只还要取 wheel，解释器和标准库的文件不再留着。
  for (const name of [...files.keys()]) if (!name.endsWith(".whl")) files.delete(name);
  pyodide.runPython(request.runner, { filename: "runner.py" });
  const { PyCallable, PyIterator, PyProxy } = pyodide.ffi;
  const functions = ["program_test", "test_packages", "track_libraries", "configure", "runtime_versions"].map((name): unknown => pyodide.globals.get(name));
  const [programTest, testPackages, trackLibraries, configure, versions] = functions;
  if (!(programTest instanceof PyCallable) || !(testPackages instanceof PyCallable) || !(trackLibraries instanceof PyCallable)
    || !(configure instanceof PyCallable) || !(versions instanceof PyCallable)) {
    throw new Error("runner.py 没有定义 program_test、test_packages、track_libraries、configure、runtime_versions");
  }
  configure(JSON.stringify(request.imports));
  runner = {
    packages: (line) => {
      const names: unknown = JSON.parse(String(testPackages(line)));
      return Array.isArray(names) ? names.map(String) : [];
    },
    load: async (packages) => {
      if (packages.length === 0) return;
      // loadPackage 加载失败时只调用 errorCallback、不抛错；没加载上就以失败结束，与 sandbox/runner.mjs 相同。
      const errors: string[] = [];
      await pyodide.loadPackage(packages, { messageCallback: () => {}, errorCallback: (text) => errors.push(text) });
      const missing = packages.filter((name) => !(name in pyodide.loadedPackages));
      if (missing.length > 0) throw new Error(`加载 ${missing.join("、")} 失败：${errors.join("；")}`);
      trackLibraries();
    },
    test: (line, onPhase) => {
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
    },
  };
  await runner.load(request.preload);
  const runtime: unknown = JSON.parse(String(versions()));
  return { pyodide: pyodide.version, ...(typeof runtime === "object" ? runtime : {}) };
}

/** 这个测试之后能否接着用这个解释器：正常完成、并且恢复了解释器状态。与 @repa/python-runner/protocol 的 endsBatch 相同。 */
function continues(response: unknown): boolean {
  return typeof response === "object" && response !== null && "status" in response && response.status === "completed"
    && !("restoreError" in response);
}

/**
 * 依次运行一批测试：先加载测试引入的包（告诉页面是哪些），每个阶段开始前告诉页面；
 * 某个测试没有正常结束或恢复不了解释器状态就停下，剩下的由页面记为未执行。
 */
async function run(tests: PythonTest[], current: Runner): Promise<void> {
  for (const [index, job] of tests.entries()) {
    const line = JSON.stringify(job);
    const packages = current.packages(line);
    send({ type: "loading", test: index, packages });
    await current.load(packages);
    const response = current.test(line, (phase) => {
      const [name, at]: unknown[] = Array.isArray(phase) ? phase : [];
      send({ type: "phase", test: index, phase: String(name), index: typeof at === "number" ? at : null });
    });
    send({ type: "tested", test: index, response });
    if (!continues(response)) return;
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
  if (!runner) {
    send({ type: "failed", message: "Pyodide 还没有就绪" });
    return;
  }
  // program_test 自己接住测试里的异常和恢复失败；漏到这里说明运行器本身出了问题（例如包没加载上），页面把它记为 Worker 失败。
  run(request.tests, runner).catch((error: unknown) => {
    send({ type: "failed", message: error instanceof Error ? error.message : String(error) });
  });
});
