/**
 * 给沙箱准备预编译的标准库和 wheel。不预编译时，每个沙箱启动都要把 numpy、pandas 和标准库的源码重新编译一遍，
 * 占启动时间的大半；课程核对每份候选程序都开新的沙箱，这部分重复得最多。
 * 生成在宿主上的 Pyodide 里进行，不经过沙箱：输入是核对过的 wheel 和 npm 包自带的标准库，代码是本包自己的 precompile.py。
 * 产物可复现，所以按仓库记下的摘要核对，不符就不放进目录。
 */

import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import { loadPyodide } from "pyodide";

import { digestOf, PACKAGE_ROOT, precompiledFiles, RuntimeProblem, STDLIB_FILE, type RuntimeAssets } from "./runtime.js";

const GENERATOR = path.join(PACKAGE_ROOT, "sandbox", "precompile.py");

export interface PrecompileOptions {
  log?: (message: string) => void;
}

/** 生成缺少或不符的预编译文件；摘要与 sandbox/precompiled.json 一致才放进目录。需要先运行 preparePackages。 */
export async function precompilePackages(assets: RuntimeAssets, options: PrecompileOptions = {}): Promise<void> {
  const log = options.log ?? (() => {});
  const pending: string[] = [];
  for (const file of precompiledFiles(assets)) {
    const expected = assets.precompiled[file];
    if (expected !== undefined && (await digestOf(path.join(assets.precompiledDirectory, file))) === expected) {
      log(`已预编译 ${file}`);
    } else {
      pending.push(file);
    }
  }
  if (pending.length === 0) return;

  const staging = path.join(assets.precompiledDirectory, `.${process.pid}.partial`);
  await mkdir(staging, { recursive: true });
  try {
    const pyodide = await loadPyodide({
      indexURL: `${assets.pyodideDirectory}/`,
      packageCacheDir: `${assets.packagesDirectory}/`,
      stdout: log,
      stderr: log,
    });
    pyodide.mountNodeFS("/repa/pyodide", assets.pyodideDirectory);
    pyodide.mountNodeFS("/repa/packages", assets.packagesDirectory);
    pyodide.mountNodeFS("/repa/staging", staging);
    pyodide.runPython(await readFile(GENERATOR, "utf8"), { filename: "precompile.py" });
    const stdlib = pyodide.globals.get("precompile_stdlib");
    const wheel = pyodide.globals.get("precompile_wheel");
    for (const file of pending) {
      if (file === STDLIB_FILE) stdlib(`/repa/pyodide/${file}`, `/repa/staging/${file}`);
      else wheel(`/repa/packages/${file}`, `/repa/staging/${file}`);
    }

    const unrecorded: Record<string, string> = {};
    const mismatched: string[] = [];
    for (const file of pending) {
      const digest = await digestOf(path.join(staging, file));
      const expected = assets.precompiled[file];
      if (digest === undefined) throw new RuntimeProblem("runtime_precompile", `预编译没有生成 ${file}`);
      if (expected === undefined) unrecorded[file] = digest;
      else if (digest !== expected) mismatched.push(`${file}：生成 ${digest}，记录 ${expected}`);
    }
    if (mismatched.length > 0) {
      throw new RuntimeProblem(
        "runtime_precompile",
        `预编译产物与 sandbox/precompiled.json 记下的 SHA-256 不符，没有放进 ${assets.precompiledDirectory}：${mismatched.join("；")}`,
      );
    }
    if (Object.keys(unrecorded).length > 0) {
      // 换 Pyodide 版本或改了 precompile.py 时会走到这里：摘要要由人确认后提交，不能由生成的一方自己写进仓库。
      throw new RuntimeProblem(
        "runtime_precompile",
        `sandbox/precompiled.json 没有记录 Pyodide ${assets.pyodideVersion} 的这些文件，确认后把它们加到 "${assets.pyodideVersion}" 下：${JSON.stringify(unrecorded, null, 2)}`,
      );
    }
    for (const file of pending) {
      await rename(path.join(staging, file), path.join(assets.precompiledDirectory, file));
      log(`已预编译 ${file}`);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
