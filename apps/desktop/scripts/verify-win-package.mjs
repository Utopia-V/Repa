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
// 安装目录带空格和中文，核对 Git 和后端按绝对路径启动时不受影响。
const target = path.join(temporary, "Repa 测试");
let installed = false;
try {
  // NSIS 的 /S 是静默安装，/D 指定安装目录，必须放在最后且不加引号；Node 默认给带空格的参数加引号，NSIS 就认不出 /D。
  // 所以按原样拼命令行，只给安装程序自己的路径加引号。
  await exec(installer, ["/S", `/D=${target}`], { windowsVerbatimArguments: true, argv0: `"${installer}"` });
  installed = true;
  const executable = path.join(target, "Repa.exe");
  await access(executable);
  const result = await verifyApplication({ application: path.join(target, "resources/app"), executable, temporary });
  console.log(JSON.stringify({ installer, installedTo: "temporary directory", ...result }, null, 2));
} finally {
  // 卸载失败不掩盖核对的结果，但要留下记录：否则机器上会多出一份没人知道的安装。
  if (installed) await exec(path.join(target, "Uninstall Repa.exe"), ["/S"]).catch((error) => console.error(error));
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
}
