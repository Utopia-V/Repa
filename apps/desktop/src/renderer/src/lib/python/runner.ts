import runnerSource from "@repa/python-runner/runner.py?raw";
import { loadRuntimeFiles, PythonRunner } from "@repa/python-runner/browser";

/** 开发时由开发服务器、生产时由主进程的 repa 协议在这里提供 Pyodide 文件和 wheel。 */
const ASSETS_URL = new URL("/__repa/pyodide/", location.href).href;

/** 页面用的运行器。Worker 脚本是同目录的 worker.ts，宿主给它的响应头加 CSP。 */
export function createPythonRunner(): PythonRunner {
  return new PythonRunner({
    assetsUrl: ASSETS_URL,
    runnerSource,
    createWorker: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
    loadFiles: () => loadRuntimeFiles(ASSETS_URL),
  });
}
