import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { verifyApplication } from "./verify-application.mjs";

const exec = promisify(execFile);
const dmg = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("用法：node verify-mac-package.mjs <Repa.dmg>");

// macOS 的 /var 是 /private/var 的链接，后端返回空间的真实路径，比较前先取真实路径。
const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-dmg-check-")));
const mount = path.join(temporary, "mount");
let mounted = false;
try {
  await exec("hdiutil", ["attach", dmg, "-nobrowse", "-readonly", "-mountpoint", mount]);
  mounted = true;
  const bundle = path.join(mount, "Repa.app");
  // ad-hoc 签名要能通过校验，否则 Apple Silicon 上程序起不来。
  await exec("codesign", ["--verify", "--deep", "--strict", bundle]);
  const result = await verifyApplication({
    application: path.join(bundle, "Contents/Resources/app"),
    executable: path.join(bundle, "Contents/MacOS/Repa"),
    temporary,
  });
  console.log(JSON.stringify({ dmg, signature: "ad-hoc", ...result }, null, 2));
} finally {
  if (mounted) await exec("hdiutil", ["detach", mount]).catch(() => exec("hdiutil", ["detach", mount, "-force"]));
  await rm(temporary, { recursive: true, force: true });
}
