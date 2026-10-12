// 在 launch.py 建立的限制里运行：加载 Pyodide 和课程要求的包，然后逐行读取任务、返回结果。
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
  await pyodide.loadPackage(config.load, { messageCallback: () => {}, errorCallback: log });
  pyodide.runPython(await readFile(config.runner, "utf8"), { filename: "runner.py" });
  const versions = JSON.parse(pyodide.globals.get("runtime_versions")(pyodide.toPy(config.load)));
  send({ type: "ready", versions: { pyodide: pyodide.version, ...versions } });
} catch (error) {
  send({ type: "fatal", message: String(error?.stack ?? error).slice(0, 4000) });
  process.exit(1);
}

const handle = pyodide.globals.get("handle_job");
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (line.trim() === "") continue;
  let id;
  try {
    ({ id } = JSON.parse(line));
  } catch {
    send({ type: "fatal", message: "收到无法解析的任务" });
    continue;
  }
  const response = JSON.parse(handle(line));
  // 让任务排进事件循环的工作先跑一轮，它们的错误就记在这个任务上，而不是下一个。
  await new Promise((resolve) => setImmediate(resolve));
  send({ type: "result", id, response });
}
