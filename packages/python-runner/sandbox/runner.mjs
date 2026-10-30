// 在 launch.py 建立的限制里运行：加载 Pyodide、要求的包和 runner.py，然后逐行读取任务、返回结果。
// 测试（op: "test"）与浏览器 Worker 一样经 runner.py 的 program_test 运行，每个阶段开始前发一条 phase 消息，父进程据此判断超时停在哪里；
// 其余任务（verify）经 handle_job 运行。标准输出只写协议消息（每行一个 JSON）；Python 在任务之外打印的内容转到标准错误。
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
  await pyodide.loadPackage(config.load, { messageCallback: () => {}, errorCallback: log });
  pyodide.runPython(await readFile(config.runner, "utf8"), { filename: "runner.py" });
  const versions = JSON.parse(pyodide.globals.get("runtime_versions")(pyodide.toPy(config.load)));
  send({ type: "ready", versions: { pyodide: pyodide.version, ...versions } });
} catch (error) {
  send({ type: "fatal", message: String(error?.stack ?? error).slice(0, 4000) });
  process.exit(1);
}

const handle = pyodide.globals.get("handle_job");
const programTest = pyodide.globals.get("program_test");

/** 逐个阶段运行一个测试，返回 program_test 的结果。 */
function runTest(id, test) {
  const generator = programTest(JSON.stringify(test));
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
  const response = job.op === "test" ? runTest(job.id, job.test) : JSON.parse(handle(line));
  // 让任务排进事件循环的工作先跑一轮，它们的错误就记在这个任务上，而不是下一个。
  await new Promise((resolve) => setImmediate(resolve));
  send({ type: "result", id: job.id, response });
}
