/**
 * renderer 运行学习者 Python 代码要的宿主部分：Pyodide 文件与 wheel 放在哪、放行哪些，以及 Worker 脚本的 CSP。
 * 生产时由主进程的 repa 协议提供，开发时由 electron-vite 的开发服务器提供，两边共用这里的规则。
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

/** Worker 不继承页面 meta 里的 CSP，只能由响应头给；为什么这样限制见 renderer 的 lib/python/worker.ts。 */
export const PYTHON_WORKER_CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'";
/** 页面取 Pyodide 文件的路径，与 renderer 的 lib/python/runner.ts 一致；wheel 在其下的 packages/。 */
export const PYODIDE_PATH = "/__repa/pyodide/";

const PYODIDE_FILES = new Map([
  ["pyodide.mjs", "text/javascript; charset=utf-8"],
  ["pyodide.asm.mjs", "text/javascript; charset=utf-8"],
  ["pyodide.asm.wasm", "application/wasm"],
  ["python_stdlib.zip", "application/zip"],
  ["pyodide-lock.json", "application/json"],
]);
const WHEEL_NAME = /^[A-Za-z0-9_.+-]+\.whl$/;

export interface PythonRuntimeDirectories {
  /** npm 包 pyodide 的目录，或安装包里复制出的同样文件。 */
  pyodide: string;
  /** npm run course:runtime 准备的 wheel 目录，见 @repa/python-runner 的 defaultPackagesDirectory。 */
  packages: string;
}

export interface PythonAsset {
  file: string;
  type: string;
}

/** 按 PYODIDE_PATH 之后的部分找文件，例如 pyodide.mjs、packages/numpy-….whl；不放行的返回 undefined。 */
export type PythonAssetLookup = (name: string) => PythonAsset | undefined;

/** pyodide-lock.json 里列出的 wheel 文件名。lockfile 随 Pyodide 发行，文件名仍按白名单字符检查，避免拼出目录外的路径。 */
function lockedWheels(lock: unknown): Set<string> {
  const packages = typeof lock === "object" && lock !== null && "packages" in lock ? lock.packages : undefined;
  if (typeof packages !== "object" || packages === null) throw new Error("pyodide-lock.json 的格式无法识别");
  const wheels = new Set<string>();
  for (const entry of Object.values(packages)) {
    const file: unknown = typeof entry === "object" && entry !== null && "file_name" in entry ? entry.file_name : undefined;
    if (typeof file !== "string") throw new Error("pyodide-lock.json 的格式无法识别");
    if (WHEEL_NAME.test(file)) wheels.add(file);
  }
  return wheels;
}

/** 只放行 Pyodide 自己的几个文件和 pyodide-lock.json 里有的 wheel。wheel 的摘要由页面按 lockfile 核对。 */
export async function pythonAssets(directories: PythonRuntimeDirectories): Promise<PythonAssetLookup> {
  const wheels = lockedWheels(JSON.parse(await readFile(path.join(directories.pyodide, "pyodide-lock.json"), "utf8")));
  return (name) => {
    const type = PYODIDE_FILES.get(name);
    if (type !== undefined) return { file: path.join(directories.pyodide, name), type };
    const wheel = name.startsWith("packages/") ? name.slice("packages/".length) : undefined;
    if (wheel === undefined || !wheels.has(wheel)) return undefined;
    return { file: path.join(directories.packages, wheel), type: "application/zip" };
  };
}

/** 工作区里的位置：Pyodide 取安装的 npm 包，wheel 取 npm run course:runtime 准备的目录，与课程核对共用。 */
export async function workspacePythonDirectories(): Promise<PythonRuntimeDirectories> {
  const manifestPath = createRequire(import.meta.url).resolve("pyodide/package.json");
  const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  const version = typeof manifest === "object" && manifest !== null && "version" in manifest ? manifest.version : undefined;
  if (typeof version !== "string") throw new Error(`${manifestPath} 里没有版本号`);
  // 安装包里没有 @repa/python-runner，只在工作区里按需加载。它的 Node 入口不经底座带进 signal-exit：
  // signal-exit 在进程里没有别的信号监听时会移除自己并重发信号，绕过 Electron 的退出流程，后端就收不到关闭请求。
  const { defaultPackagesDirectory } = await import("@repa/python-runner");
  return { pyodide: path.dirname(manifestPath), packages: defaultPackagesDirectory(version) };
}
