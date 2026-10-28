import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { precompilePackages } from "../src/sandbox/precompile.js";
import { describeRuntime, RuntimeProblem, STDLIB_FILE, verifyPackages, type RuntimeAssets } from "../src/sandbox/runtime.js";
import { RUNTIME } from "./demo-course.js";

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-learning-precompile-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** 只含标准库的运行时：不需要另外准备 wheel，标准库来自 npm 包。 */
async function stdlibOnly(t: TestContext, precompiled?: Record<string, string>): Promise<RuntimeAssets> {
  const assets = await describeRuntime(RUNTIME, await temporaryDirectory(t));
  return { ...assets, wheels: [], precompiled: precompiled ?? assets.precompiled };
}

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

test("预编译的文件缺失、内容与仓库记录不符或没有记录时，核对不通过", async (t) => {
  const assets = await stdlibOnly(t, { [STDLIB_FILE]: digest("预编译产物") });
  const file = path.join(assets.precompiledDirectory, STDLIB_FILE);
  const rejects = (assets: RuntimeAssets, pattern: RegExp) =>
    assert.rejects(verifyPackages(assets), (error: unknown) => error instanceof RuntimeProblem && pattern.test(error.message));

  await rejects(assets, /缺少预编译的 python_stdlib\.zip/);
  await mkdir(assets.precompiledDirectory, { recursive: true });
  await writeFile(file, "预编译产物");
  await verifyPackages(assets);
  await writeFile(file, "被改过的产物");
  await rejects(assets, /预编译的 python_stdlib\.zip 与 sandbox\/precompiled\.json 记下的 SHA-256 不符/);
  await rejects({ ...assets, precompiled: {} }, /没有记录 Pyodide 314\.0\.7 的 python_stdlib\.zip/);
});

test("生成的标准库与仓库记下的摘要一致；摘要不符时不放进目录", async (t) => {
  const recorded = await stdlibOnly(t);
  await precompilePackages(recorded);
  await verifyPackages(recorded);

  const wrong = await stdlibOnly(t, { [STDLIB_FILE]: digest("别的产物") });
  await assert.rejects(precompilePackages(wrong), (error: unknown) => error instanceof RuntimeProblem && error.code === "runtime_precompile");
  assert.deepEqual(await readdir(wrong.precompiledDirectory), []);
});
