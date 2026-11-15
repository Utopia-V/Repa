// 在 launch.py 建立的限制里运行：加载 Pyodide 和 runner.py，然后逐行读取任务、返回结果。
// 测试（课程核对的 verify 任务也是测试）与浏览器 Worker 一样经 runner.py 的 program_test 运行：先按 runner.py 的 test_packages
// 加载测试引入的带着的包（发一条 loading 消息），每个阶段开始前再发一条 phase 消息，父进程据此判断超时停在哪里。
// 标准输出只写协议消息（每行一个 JSON）；Python 在任务之外打印的内容转到标准错误。
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const config = JSON.parse(process.argv[2]);
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const log = (text) => process.stderr.write(`${text}\n`);

// 任务留下的异步错误会让 Node 退出；先报告再退出，父进程把它记在当前任务上并换一个新运行器。
process.on("uncaughtException", (error) => {
  send({ type: "fatal", message: String(error?.stack ?? error).slice(0, 4000) });
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  send({ type: "fatal", message: String(error?.stack ?? error).slice(0, 4000) });
  process.exit(1);
});

let pyodide;
try {
  const { loadPyodide } = await import(pathToFileURL(path.join(config.pyodide, "pyodide.mjs")).href);
  pyodide = await loadPyodide({
    indexURL: `${config.pyodide}/`,
    // 包从准备好的目录读取；文件缺失时 Pyodide 会尝试下载，在沙箱里网络不可用，于是直接失败。
    packageCacheDir: `${config.packages}/`,
    // Python 的 js 模块只看得到这个空对象，碰不到 process、require、fetch 和计时器；
    // 没有原型，也就拿不到 Function 构造器（Node 另以 --disallow-code-generation-from-strings 禁止字符串求值）。
    jsglobals: Object.create(null),
    stdout: log,
    stderr: log,
  });
  pyodide.runPython(await readFile(config.runner, "utf8"), { filename: "runner.py" });
  pyodide.globals.get("configure")(JSON.stringify(config.imports));
  const versions = JSON.parse(pyodide.globals.get("runtime_versions")());
  send({ type: "ready", versions: { pyodide: pyodide.version, ...versions } });
} catch (error) {
  send({ type: "fatal", message: String(error?.stack ?? error).slice(0, 4000) });
  process.exit(1);
}

const programTest = pyodide.globals.get("program_test");
const testPackages = pyodide.globals.get("test_packages");
const trackLibraries = pyodide.globals.get("track_libraries");

/** 加载测试引入的带着的包，再逐个阶段运行它，返回 program_test 的结果。包从准备好的目录读取，在沙箱里读不到就直接失败。 */
async function runTest(id, test) {
  const line = JSON.stringify(test);
  const packages = JSON.parse(testPackages(line));
  send({ type: "loading", id, packages });
  if (packages.length > 0) {
    // loadPackage 加载失败时只调用 errorCallback、不抛错；没加载上就以失败结束，不让测试带着缺的包运行。
    const errors = [];
    await pyodide.loadPackage(packages, { messageCallback: () => {}, errorCallback: (text) => errors.push(text) });
    const missing = packages.filter((name) => !(name in pyodide.loadedPackages));
    if (missing.length > 0) throw new Error(`加载 ${missing.join("、")} 失败：${errors.join("；")}`);
    // 导入刚加载的 NumPy、pandas 并记下初始状态也算在加载里，不占测试准备阶段的时限。
    trackLibraries();
  }
  const generator = programTest(line);
  try {
    for (;;) {
      const step = generator.next();
      if (step.done) return JSON.parse(String(step.value));
      // 产出的是 (阶段, 序号) 元组，转成 JS 数组后释放代理。
      const [phase, index] = step.value.toJs();
      step.value.destroy();
      send({ type: "phase", id, phase: String(phase), index: typeof index === "number" ? index : null });
    }
  } finally {
    generator.destroy();
  }
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (line.trim() === "") continue;
  let job;
  try {
    job = JSON.parse(line);
  } catch {
    send({ type: "fatal", message: "收到无法解析的任务" });
    continue;
  }
  let response;
  try {
    response = await runTest(job.id, job.test);
  } catch (error) {
    // 运行器自己的错误（例如包没加载上）：报告后退出，父进程把它记为当前阶段的执行失败，换一个新的沙箱。
    send({ type: "fatal", message: String(error?.message ?? error).slice(0, 4000) });
    process.exit(1);
  }
  // 让任务排进事件循环的工作先跑一轮，它们的错误就记在这个任务上，而不是下一个。
  await new Promise((resolve) => setImmediate(resolve));
  send({ type: "result", id: job.id, response });
}
