import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Arch, Platform, build } from "electron-builder";

import { electronDist, output, prepareApplication } from "./package-application.mjs";

const exec = promisify(execFile);
const desktop = fileURLToPath(new URL("..", import.meta.url));
const root = path.resolve(desktop, "../..");

if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Linux 安装包只能在 Linux x64 上打。");

const { application, manifest, python, inventory, packed } = await prepareApplication();

await build({
  projectDir: desktop,
  targets: Platform.LINUX.createTarget(["deb"], Arch.x64),
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
    linux: { category: "Education", executableName: "repa", target: "deb", syncDesktopName: true },
    deb: {
      maintainer: "Utopia-V",
      depends: ["libgtk-3-0", "libnotify4", "libnss3", "libxss1", "libxtst6", "xdg-utils", "libatspi2.0-0", "libuuid1", "libsecret-1-0", "git", "ripgrep"],
    },
  },
});
const deb = path.join(output, `Repa-${manifest.version}-amd64.deb`);
const { stdout: verification } = await exec(process.execPath, [path.join(desktop, "scripts/verify-linux-package.mjs"), deb], {
  cwd: root,
  maxBuffer: 4 * 1024 * 1024,
});
console.log(JSON.stringify({ output, packages: packed.map(({ name, version }) => ({ name, version })), python, licenses: inventory.length,
  verification: JSON.parse(verification) }, null, 2));
