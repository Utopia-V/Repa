/**
 * Pyodide 运行时与离线包：npm 包 pyodide 提供解释器和标准库，pandas、NumPy 等 wheel
 * 另行准备到本包的 .cache 目录（或 REPA_PYODIDE_PACKAGES 指定的目录），每次使用前按发行 lockfile 的 SHA-256 核对。
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 本包的根目录：dist/ 和 src/ 下的模块都在它下面一层。 */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** runner.py 的绝对路径，Node 宿主从这里加载它。 */
export const RUNNER_FILE = path.join(PACKAGE_ROOT, "runner.py");

/**
 * 调用方要求的运行环境：Pyodide、Python 和要加载的包（包名到版本）。
 * prelude 是每个任务在自己的命名空间里先运行的代码，例如 import pandas as pd。
 */
export interface PythonEnvironment {
  pyodide: string;
  python: string;
  packages: Record<string, string>;
  prelude?: string;
}

interface LockPackage {
  name: string;
  version: string;
  file_name: string;
  sha256: string;
  depends: string[];
}

interface Lockfile {
  info: { python: string };
  packages: Record<string, LockPackage>;
}

/** 一个离线 wheel：包名、文件名和 lockfile 里的 SHA-256。 */
export interface Wheel {
  name: string;
  file: string;
  sha256: string;
}

/** 运行一个环境要用的全部文件：Pyodide 的目录、离线 wheel 的目录和要加载的包。 */
export interface RuntimeAssets {
  pyodideVersion: string;
  pyodideDirectory: string;
  /** pyodide 在 Node 里加载时 import 的 ws 包所在目录。 */
  wsDirectory: string;
  packagesDirectory: string;
  /** 要求的包及其依赖。 */
  wheels: Wheel[];
  load: string[];
  /** 运行环境声明的前导，每个任务在自己的命名空间里先运行它；没有声明为空串。 */
  prelude: string;
}

/** 运行时用不了：安装的版本与要求不符、缺少离线包或下载失败。code 说明是哪一种。 */
export class RuntimeProblem extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RuntimeProblem";
  }
}

/** 离线 wheel 的默认目录：本包的 .cache/pyodide/<版本>/，可用 REPA_PYODIDE_PACKAGES 改到别处。 */
export function defaultPackagesDirectory(version: string): string {
  return process.env.REPA_PYODIDE_PACKAGES ?? path.join(PACKAGE_ROOT, ".cache", "pyodide", version);
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

/** 找到安装的 pyodide，核对它与要求的 Pyodide、Python 和包版本一致，算出需要的 wheel。 */
export async function describeRuntime(runtime: PythonEnvironment, packagesDirectory?: string): Promise<RuntimeAssets> {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("pyodide/package.json");
  const pyodideDirectory = path.dirname(manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { version: string };
  if (manifest.version !== runtime.pyodide) {
    throw new RuntimeProblem("runtime_mismatch", `要求 Pyodide ${runtime.pyodide}，安装的是 ${manifest.version}`);
  }
  const wsDirectory = path.dirname(createRequire(manifestPath).resolve("ws/package.json"));
  const lock = JSON.parse(await readFile(path.join(pyodideDirectory, "pyodide-lock.json"), "utf8")) as Lockfile;
  if (lock.info.python !== runtime.python) {
    throw new RuntimeProblem("runtime_mismatch", `要求 Python ${runtime.python}，Pyodide ${manifest.version} 带的是 ${lock.info.python}`);
  }
  const wheels = new Map<string, Wheel>();
  const add = (name: string): void => {
    if (wheels.has(name)) return;
    const entry = lock.packages[name];
    if (!entry) throw new RuntimeProblem("runtime_mismatch", `Pyodide ${manifest.version} 没有 ${name} 包`);
    wheels.set(name, { name, file: entry.file_name, sha256: entry.sha256 });
    for (const dependency of entry.depends) add(dependency);
  };
  for (const [name, version] of Object.entries(runtime.packages)) {
    const entry = lock.packages[name];
    if (entry && entry.version !== version) {
      throw new RuntimeProblem("runtime_mismatch", `要求 ${name} ${version}，Pyodide ${manifest.version} 带的是 ${entry.version}`);
    }
    add(name);
  }
  return {
    pyodideVersion: manifest.version,
    pyodideDirectory,
    wsDirectory,
    packagesDirectory: packagesDirectory ?? defaultPackagesDirectory(manifest.version),
    wheels: [...wheels.values()].sort((left, right) => left.name.localeCompare(right.name)),
    load: Object.keys(runtime.packages),
    prelude: runtime.prelude ?? "",
  };
}

/** 核对准备好的 wheel；缺失或摘要不符时说明怎样准备。 */
export async function verifyPackages(assets: RuntimeAssets): Promise<void> {
  const problems: string[] = [];
  for (const wheel of assets.wheels) {
    const file = path.join(assets.packagesDirectory, wheel.file);
    let digest: string;
    try {
      digest = await sha256(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      problems.push(`缺少 ${wheel.file}`);
      continue;
    }
    if (digest !== wheel.sha256) problems.push(`${wheel.file} 的 SHA-256 与 Pyodide ${assets.pyodideVersion} 的 lockfile 不符`);
  }
  if (problems.length > 0) {
    throw new RuntimeProblem(
      "runtime_packages",
      `${assets.packagesDirectory} 里的 Pyodide 包不完整：${problems.join("；")}。先运行 npm run course:runtime 准备离线包`,
    );
  }
}

/** 准备离线 wheel 的选项。 */
export interface PrepareOptions {
  /** 从已有目录复制，例如另一份离线资源；不给时从 jsDelivr 下载。 */
  from?: string;
  log?: (message: string) => void;
}

/** 准备离线 wheel：已存在且摘要正确的跳过；新取得的文件核对摘要后才放进目录。只有这一步可能联网。 */
export async function preparePackages(assets: RuntimeAssets, options: PrepareOptions = {}): Promise<void> {
  const log = options.log ?? (() => {});
  await mkdir(assets.packagesDirectory, { recursive: true });
  for (const wheel of assets.wheels) {
    const target = path.join(assets.packagesDirectory, wheel.file);
    try {
      if ((await sha256(target)) === wheel.sha256) {
        log(`已就绪 ${wheel.file}`);
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = `${target}.${process.pid}.partial`;
    if (options.from) {
      await copyFile(path.join(options.from, wheel.file), temporary);
    } else {
      const url = `https://cdn.jsdelivr.net/pyodide/v${assets.pyodideVersion}/full/${wheel.file}`;
      const response = await fetch(url);
      if (!response.ok) throw new RuntimeProblem("runtime_download", `下载 ${url} 失败：HTTP ${response.status}`);
      await writeFile(temporary, new Uint8Array(await response.arrayBuffer()));
    }
    if ((await sha256(temporary)) !== wheel.sha256) {
      throw new RuntimeProblem("runtime_packages", `${wheel.file} 的 SHA-256 与 lockfile 不符，没有放进 ${assets.packagesDirectory}`);
    }
    await rename(temporary, target);
    log(`已准备 ${wheel.file}`);
  }
}
