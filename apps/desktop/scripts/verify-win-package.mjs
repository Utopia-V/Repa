import { execFile } from "node:child_process";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { verifyApplication } from "./verify-application.mjs";

const exec = promisify(execFile);
const installer = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("用法：node verify-win-package.mjs <Repa-Setup.exe>");

// 临时目录可能是 8.3 短名，后端返回空间的真实路径，比较前先取真实路径。
const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-setup-check-")));
const target = path.join(temporary, "Repa");
let installed = false;
try {
  // NSIS 的 /S 是静默安装，/D 指定安装目录，必须放在最后且不加引号。
  await exec(installer, ["/S", `/D=${target}`]);
  installed = true;
  const executable = path.join(target, "Repa.exe");
  await access(executable);
  const result = await verifyApplication({ application: path.join(target, "resources/app"), executable, temporary });
  console.log(JSON.stringify({ installer, installedTo: "temporary directory", ...result }, null, 2));
} finally {
  if (installed) await exec(path.join(target, "Uninstall Repa.exe"), ["/S"]).catch(() => {});
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
}
