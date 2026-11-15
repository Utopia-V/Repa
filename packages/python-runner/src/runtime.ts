/**
 * Pyodide 运行时与离线包：npm 包 pyodide 提供解释器和标准库，Repa 的 Python 环境带的 pandas、NumPy 等 wheel
 * 另行准备到本包的 .cache 目录（或 REPA_PYODIDE_PACKAGES 指定的目录），每次使用前按发行 lockfile 的 SHA-256 核对。
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PYTHON_PACKAGES } from "./protocol.js";

/** 本包的根目录：dist/ 和 src/ 下的模块都在它下面一层。 */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** runner.py 的绝对路径，Node 宿主从这里加载它。 */
export const RUNNER_FILE = path.join(PACKAGE_ROOT, "runner.py");

interface LockPackage {
  name: string;
  version: string;
  file_name: string;
  sha256: string;
  imports: string[];
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

/** Repa 的 Python 环境要用的全部文件：Pyodide 的目录、离线 wheel 的目录，以及带的包能加载的版本。 */
export interface RuntimeAssets {
  pyodideVersion: string;
  pyodideDirectory: string;
  /** pyodide 在 Node 里加载时 import 的 ws 包所在目录。 */
  wsDirectory: string;
  packagesDirectory: string;
  /** PYTHON_PACKAGES 及其依赖的 wheel。 */
  wheels: Wheel[];
  /** PYTHON_PACKAGES 的版本，即结果里 runtime.packages 的内容。 */
  versions: Record<string, string>;
  /** 带的包（含依赖）的 import 名到包名，交给 runner.py 判断测试引入了哪些包。 */
  imports: Record<string, string>;
}

/** 运行时用不了：缺少离线包、摘要不符或下载失败。code 说明是哪一种。 */
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

/** 找到安装的 pyodide，按它的 lockfile 算出 Repa 的 Python 环境带的包（PYTHON_PACKAGES）及其依赖要用的 wheel。 */
export async function describeRuntime(packagesDirectory?: string): Promise<RuntimeAssets> {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("pyodide/package.json");
  const pyodideDirectory = path.dirname(manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { version: string };
  const wsDirectory = path.dirname(createRequire(manifestPath).resolve("ws/package.json"));
  const lock = JSON.parse(await readFile(path.join(pyodideDirectory, "pyodide-lock.json"), "utf8")) as Lockfile;
  const wheels = new Map<string, Wheel>();
  const imports: Record<string, string> = {};
  const add = (name: string): void => {
    if (wheels.has(name)) return;
    const entry = lock.packages[name];
    if (!entry) throw new Error(`Pyodide ${manifest.version} 的 lockfile 里没有 ${name}`);
    wheels.set(name, { name, file: entry.file_name, sha256: entry.sha256 });
    for (const module of entry.imports) imports[module] = name;
    for (const dependency of entry.depends) add(dependency);
  };
  const versions: Record<string, string> = {};
  for (const name of PYTHON_PACKAGES) {
    add(name);
    versions[name] = lock.packages[name]?.version ?? "";
  }
  return {
    pyodideVersion: manifest.version,
    pyodideDirectory,
    wsDirectory,
    packagesDirectory: packagesDirectory ?? defaultPackagesDirectory(manifest.version),
    wheels: [...wheels.values()].sort((left, right) => left.name.localeCompare(right.name)),
    versions,
    imports,
  };
}

/**
 * 核对准备好的 wheel；缺失或摘要不符时说明怎样补齐。npm run course:runtime 只在源码仓库里有，只对仓库里的缓存目录这样说；
 * 别的目录是安装包带的（应用经 REPA_PYODIDE_PACKAGES 指过来）或使用者自己指定的，学习者的机器上没有 npm。
 */
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
    const remedy = assets.packagesDirectory === path.join(PACKAGE_ROOT, ".cache", "pyodide", assets.pyodideVersion)
      ? "先运行 npm run course:runtime 准备离线包"
      : "这个目录是安装包带的或 REPA_PYODIDE_PACKAGES 指定的；装好的应用里出现这一条，说明 Repa 的安装不完整，要重新安装";
    throw new RuntimeProblem("runtime_packages", `${assets.packagesDirectory} 里的 Pyodide 包不完整：${problems.join("；")}。${remedy}`);
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
