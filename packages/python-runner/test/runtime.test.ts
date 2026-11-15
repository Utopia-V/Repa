import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { describeRuntime, PACKAGE_ROOT, verifyPackages } from "../src/runtime.js";
import { RUNTIME } from "./environment.js";

// 学习者的机器上没有 npm：只有源码仓库里的缓存目录缺包时才叫人运行 npm run course:runtime。
test("缺少离线包时，只对源码仓库里的缓存目录说运行 npm，安装包带的目录说安装不完整", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-python-runner-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const installed = await describeRuntime(RUNTIME, path.join(directory, "resources", "app", "pyodide", "packages"));
  await assert.rejects(verifyPackages(installed), (error: Error) => {
    assert.equal((error as { code?: unknown }).code, "runtime_packages");
    assert.match(error.message, /缺少 numpy-[^；]*\.whl/u);
    assert.match(error.message, /Repa 的安装不完整/u);
    assert.doesNotMatch(error.message, /npm/u);
    return true;
  });
  const checkout = path.join(PACKAGE_ROOT, ".cache", "pyodide", installed.pyodideVersion);
  // 仓库里的缓存可能已经准备好，换一个不存在的 wheel 名字让它缺。
  const missing = { ...installed, packagesDirectory: checkout, wheels: [{ name: "absent", file: "absent-0-py3-none-any.whl", sha256: "0".repeat(64) }] };
  await assert.rejects(verifyPackages(missing), /缺少 absent-0-py3-none-any\.whl。先运行 npm run course:runtime 准备离线包/u);
});
