/**
 * 课程检查用的 Pyodide 运行时：npm 包 pyodide 提供解释器和标准库，pandas、NumPy 等 wheel
 * 另行准备到本包的 .cache 目录（或 REPA_PYODIDE_PACKAGES 指定的目录），每次使用前按发行 lockfile 的 SHA-256 核对。
 * 沙箱加载的是 precompiled/ 下加了 .pyc 的标准库和 wheel，它们按 sandbox/precompiled.json 记下的 SHA-256 核对。
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Runtime } from "../format/schema.js";

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const STDLIB_FILE = "python_stdlib.zip";
const PRECOMPILED_HASHES = path.join(PACKAGE_ROOT, "sandbox", "precompiled.json");

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

export interface Wheel {
  name: string;
  file: string;
  sha256: string;
}

export interface RuntimeAssets {
  pyodideVersion: string;
  pyodideDirectory: string;
  /** pyodide 在 Node 里加载时 import 的 ws 包所在目录。 */
  wsDirectory: string;
  packagesDirectory: string;
  /** 课程要求的包及其依赖。 */
  wheels: Wheel[];
  load: string[];
  /** 课程清单声明的运行前导，每个任务在自己的命名空间里先运行它；没有声明为空串。 */
  prelude: string;
  /** 沙箱加载的预编译标准库和 wheel 所在目录，文件名与原件相同。 */
  precompiledDirectory: string;
  /** 仓库为这个 Pyodide 版本记下的预编译产物摘要，按文件名；没有记录时为空对象。 */
  precompiled: Record<string, string>;
}

export class RuntimeProblem extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RuntimeProblem";
  }
}

export function defaultPackagesDirectory(version: string): string {
  return process.env.REPA_PYODIDE_PACKAGES ?? path.join(PACKAGE_ROOT, ".cache", "pyodide", version);
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

/** 找到安装的 pyodide，核对它与课程清单要求的 Pyodide、Python 和包版本一致，算出需要的 wheel。 */
export async function describeRuntime(runtime: Runtime, packagesDirectory?: string): Promise<RuntimeAssets> {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("pyodide/package.json");
  const pyodideDirectory = path.dirname(manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { version: string };
  if (manifest.version !== runtime.pyodide) {
    throw new RuntimeProblem("runtime_mismatch", `课程要求 Pyodide ${runtime.pyodide}，安装的是 ${manifest.version}`);
  }
  const wsDirectory = path.dirname(createRequire(manifestPath).resolve("ws/package.json"));
  const lock = JSON.parse(await readFile(path.join(pyodideDirectory, "pyodide-lock.json"), "utf8")) as Lockfile;
  if (lock.info.python !== runtime.python) {
    throw new RuntimeProblem("runtime_mismatch", `课程要求 Python ${runtime.python}，Pyodide ${manifest.version} 带的是 ${lock.info.python}`);
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
      throw new RuntimeProblem("runtime_mismatch", `课程要求 ${name} ${version}，Pyodide ${manifest.version} 带的是 ${entry.version}`);
    }
    add(name);
  }
  const pinned = JSON.parse(await readFile(PRECOMPILED_HASHES, "utf8")) as Record<string, Record<string, string>>;
  const directory = packagesDirectory ?? defaultPackagesDirectory(manifest.version);
  return {
    pyodideVersion: manifest.version,
    pyodideDirectory,
    wsDirectory,
    packagesDirectory: directory,
    wheels: [...wheels.values()].sort((left, right) => left.name.localeCompare(right.name)),
    load: Object.keys(runtime.packages),
    prelude: runtime.prelude ?? "",
    precompiledDirectory: path.join(directory, "precompiled"),
    precompiled: pinned[manifest.version] ?? {},
  };
}

/** 沙箱实际加载的文件：标准库加课程要求的 wheel。 */
export function precompiledFiles(assets: RuntimeAssets): string[] {
  return [STDLIB_FILE, ...assets.wheels.map((wheel) => wheel.file)];
}

/** 文件的 SHA-256；文件不存在时为 undefined。 */
export async function digestOf(file: string): Promise<string | undefined> {
  try {
    return await sha256(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

/** 核对准备好的 wheel 和预编译产物；缺失或摘要不符时说明怎样准备。 */
export async function verifyPackages(assets: RuntimeAssets): Promise<void> {
  const problems: string[] = [];
  for (const wheel of assets.wheels) {
    const digest = await digestOf(path.join(assets.packagesDirectory, wheel.file));
    if (digest === undefined) problems.push(`缺少 ${wheel.file}`);
    else if (digest !== wheel.sha256) problems.push(`${wheel.file} 的 SHA-256 与 Pyodide ${assets.pyodideVersion} 的 lockfile 不符`);
  }
  for (const file of precompiledFiles(assets)) {
    const expected = assets.precompiled[file];
    if (expected === undefined) {
      problems.push(`sandbox/precompiled.json 没有记录 Pyodide ${assets.pyodideVersion} 的 ${file}`);
      continue;
    }
    const digest = await digestOf(path.join(assets.precompiledDirectory, file));
    if (digest === undefined) problems.push(`缺少预编译的 ${file}`);
    else if (digest !== expected) problems.push(`预编译的 ${file} 与 sandbox/precompiled.json 记下的 SHA-256 不符`);
  }
  if (problems.length > 0) {
    throw new RuntimeProblem(
      "runtime_packages",
      `${assets.packagesDirectory} 里的 Pyodide 包不完整：${problems.join("；")}。先运行 npm run course:runtime 准备离线包`,
    );
  }
}

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
