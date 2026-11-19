import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
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
    // Chromium 的语言包只留简体中文与英文：界面只有中文；繁体中文系统上 Chromium 回落到 zh-CN，其余语言回落到 en-US。
    // en-US 不能去掉：系统语言与 zh-CN 都对不上时，Chromium 自带的提示文字（如输入框校验）就取不到了。
    electronLanguages: ["zh-CN", "en-US"],
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
      // 应用文件按 zip（Deflate）打进安装程序，安装时直接解压到安装目录。缺省的 7z 先解压到 %TEMP%、再整份复制到安装目录，
      // 每个文件写两遍，安装时间约是现在的两倍；7z 的安装程序小约 45 MB，但它要经聊天软件发送，200 MB 以内即可。
      // 差分包只服务于 electron-updater 的增量更新，Repa 不用自动更新；用 zip 也要求关掉它。
      useZip: true,
      differentialPackage: false,
    },
    // 只产出文件；发布到 GitHub Release 等由维护者决定，CI 里也不自动上传。
    publish: null,
  },
});
const installer = path.join(output, `Repa-Setup-${manifest.version}-x64.exe`);
// 安装程序经聊天软件发给试用者，超过 200 MB 就发不出去；zip 比 7z 大，余量不多，超了在这里停下。
const { size } = await stat(installer);
if (size > 200e6) throw new Error(`安装程序 ${(size / 1e6).toFixed(1)} MB，超过了 200 MB`);
const { stdout: verification } = await exec(process.execPath, [path.join(desktop, "scripts/verify-win-package.mjs"), installer], {
  cwd: root,
  maxBuffer: 4 * 1024 * 1024,
});
console.log(JSON.stringify({ output, packages: packed.map(({ name, version }) => ({ name, version })), python, git, licenses: inventory.length,
  installerMB: Math.round(size / 1e5) / 10, verification: JSON.parse(verification) }, null, 2));
