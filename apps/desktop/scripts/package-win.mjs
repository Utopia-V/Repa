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

const { application, manifest, python, git, inventory, packed } = await prepareApplication();

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
    files: ["out/**/*", "pyodide/**/*", "git/**/*", "node_modules/**/*", "third-party-licenses/**/*", "package.json"],
    // 没有代码签名证书：下载后首次运行，SmartScreen 会提示“未知发布者”，要点“仍要运行”。
    win: { target: "nsis" },
    nsis: {
      artifactName: "Repa-Setup-${version}-${arch}.${ext}",
      // 装在当前用户名下，不需要管理员权限，也不改动其他用户和系统。安装位置可以改：不少人的 C 盘很小。
      // 缺省是 %LOCALAPPDATA%\Programs\Repa，一路“下一步”就装在那里；再次安装时缺省是上次的位置（第一个测试版一键安装，
      // 装在 Programs\repa-desktop：一键安装用包名作目录名），换了位置时安装程序先卸载原位置的那份。
      // 选的文件夹名里没有 Repa 时，安装程序在它下面建 Repa 子文件夹。
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      perMachine: false,
      // 跳过“为哪位用户安装”那一页；装完删掉 electron-builder 留在 C 盘的安装程序副本。见 installer.nsh。
      include: "scripts/installer.nsh",
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
console.log(JSON.stringify({ output, packages: packed.map(({ name, version }) => ({ name, version })), python, git, licenses: inventory.length,
  verification: JSON.parse(verification) }, null, 2));
