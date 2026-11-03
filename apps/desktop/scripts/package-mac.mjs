import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Arch, Platform, build } from "electron-builder";

import { electronDist, output, prepareApplication } from "./package-application.mjs";

const exec = promisify(execFile);
const desktop = fileURLToPath(new URL("..", import.meta.url));
const root = path.resolve(desktop, "../..");

if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("macOS 安装包只能在 Apple Silicon 的 macOS 上打。");

// electron-builder 在 PR 构建里默认跳过签名，免得 PR 里的代码拿到证书；ad-hoc 签名不用证书，照常签。
// 不签的话改过的 Electron.app 带着失效的签名，Apple Silicon 上打不开。
process.env.CSC_FOR_PULL_REQUEST = "true";

const { application, manifest, python, inventory, packed } = await prepareApplication();

await build({
  projectDir: desktop,
  targets: Platform.MAC.createTarget(["dmg"], Arch.arm64),
  config: {
    appId: "org.utopia-v.repa",
    productName: "Repa",
    artifactName: "Repa-${version}-${arch}.${ext}",
    directories: { app: application, output },
    electronVersion: "44.3.0",
    electronDist,
    // Node 宿主通过 CLI 的物理路径启动底座，保留物理安装布局。
    asar: false,
    npmRebuild: false,
    files: ["out/**/*", "pyodide/**/*", "node_modules/**/*", "third-party-licenses/**/*", "package.json"],
    mac: {
      category: "public.app-category.education",
      // 没有 Apple 开发者证书，只做 ad-hoc 签名：Apple Silicon 上完全不签名的程序不能运行。
      // 没有公证，从网上下载后 Gatekeeper 会拦下，首次打开要在“隐私与安全性”里放行。
      identity: "-",
      // hardened runtime 是公证的前提；ad-hoc 签名下开着它，库校验会拒绝加载 Electron 自己的框架。
      hardenedRuntime: false,
      notarize: false,
    },
    dmg: { writeUpdateInfo: false },
    // 只产出文件；发布到 GitHub Release 等由维护者决定，CI 里也不自动上传。
    publish: null,
  },
});
const dmg = path.join(output, `Repa-${manifest.version}-arm64.dmg`);
const { stdout: verification } = await exec(process.execPath, [path.join(desktop, "scripts/verify-mac-package.mjs"), dmg], {
  cwd: root,
  maxBuffer: 4 * 1024 * 1024,
});
console.log(JSON.stringify({ output, packages: packed.map(({ name, version }) => ({ name, version })), python, licenses: inventory.length,
  verification: JSON.parse(verification) }, null, 2));
