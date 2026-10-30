import type { TestContext } from "node:test";

import { describeRuntime, verifyPackages } from "../src/runtime.js";
import { PythonSandbox, SandboxUnavailable } from "../src/sandbox.js";

/** 测试用的运行环境，与锁定的 pyodide 版本一致；runner.py 在模块顶层导入 numpy 和 pandas。 */
export const RUNTIME = { pyodide: "314.0.7", python: "3.14.2", packages: { numpy: "2.4.6", pandas: "3.0.2" } };

/** CI 要求环境完整；本机缺环境时仍按原原因跳过。 */
export function skipUnavailableEnvironment(t: TestContext, reason: string): void {
  if (process.env.REPA_TEST_REQUIRE_ENV === "1") {
    throw new Error(reason);
  }
  t.skip(reason);
}

let packages: Promise<string | undefined> | undefined;
let sandbox: Promise<string | undefined> | undefined;

/** 离线包没有准备好时返回原因，在测试进程里直接加载 Pyodide 的测试据此跳过。 */
export function packagesUnavailable(): Promise<string | undefined> {
  packages ??= (async () => {
    try {
      await verifyPackages(await describeRuntime(RUNTIME));
      return undefined;
    } catch (error) {
      if (error instanceof Error && error.name === "RuntimeProblem") return error.message;
      throw error;
    }
  })();
  return packages;
}

/** 离线包没有准备好或这台机器建不了沙箱时返回原因，需要沙箱的测试据此跳过。 */
export function sandboxUnavailable(): Promise<string | undefined> {
  if (process.platform !== "linux") return Promise.resolve("Linux 沙箱只在 Linux 上可用");
  sandbox ??= (async () => {
    const missing = await packagesUnavailable();
    if (missing) return missing;
    try {
      const { sandbox: started } = await PythonSandbox.start({ assets: await describeRuntime(RUNTIME) });
      await started.close();
      return undefined;
    } catch (error) {
      if (error instanceof SandboxUnavailable) return error.message;
      throw error;
    }
  })();
  return sandbox;
}
