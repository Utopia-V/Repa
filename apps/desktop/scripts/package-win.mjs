import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Arch, Platform, build } from "electron-builder";

import { electronDist, output, prepareApplication } from "./package-application.mjs";

const exec = promisify(execFile);
const desktop = fileURLToPath(new URL("..", import.meta.url));
const root = path.resolve(desktop, "../..");

if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Windows 安装包只能在 Windows x64 上打。");

const { application, manifest, python, inventory, packed } = await prepareApplication();

await build({
  projectDir: desktop,
  targets: Platform.WINDOWS.createTarget(["nsis"], Arch.x64),
  config: {
    appId: "org.utopia-v.repa",
    productName: "Repa",
    directories: { app: application, output },
    electronVersion: "44.3.0",
    electronDist,
    // Node 宿主通过 CLI 的物理路径启动底座，保留物理安装布局。
    asar: false,
    npmRebuild: false,
    files: ["out/**/*", "pyodide/**/*", "node_modules/**/*", "third-party-licenses/**/*", "package.json"],
    // 没有代码签名证书：下载后首次运行，SmartScreen 会提示“未知发布者”，要点“仍要运行”。
    win: { target: "nsis" },
    nsis: {
      artifactName: "Repa-Setup-${version}-${arch}.${ext}",
      // 装到当前用户的目录，不需要管理员权限，也不改动其他用户和系统。
      oneClick: true,
      perMachine: false,
      // 静默安装时不顺手打开应用，核对脚本要自己启动它。
      runAfterFinish: false,
    },
    // 只产出文件；发布到 GitHub Release 等由维护者决定，CI 里也不自动上传。
    publish: null,
  },
});
const installer = path.join(output, `Repa-Setup-${manifest.version}-x64.exe`);
const { stdout: verification } = await exec(process.execPath, [path.join(desktop, "scripts/verify-win-package.mjs"), installer], {
  cwd: root,
  maxBuffer: 4 * 1024 * 1024,
});
console.log(JSON.stringify({ output, packages: packed.map(({ name, version }) => ({ name, version })), python, licenses: inventory.length,
  verification: JSON.parse(verification) }, null, 2));
