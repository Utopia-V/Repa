import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const dmg = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("用法：node verify-mac-package.mjs <Repa.dmg>");

// macOS 的 /var 是 /private/var 的链接，后端返回空间的真实路径，比较前先取真实路径。
const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-dmg-check-")));
const mount = path.join(temporary, "mount");
let mounted = false;
let backend;
let client;
try {
  await exec("hdiutil", ["attach", dmg, "-nobrowse", "-readonly", "-mountpoint", mount]);
  mounted = true;
  const bundle = path.join(mount, "Repa.app");
  const application = path.join(bundle, "Contents/Resources/app");
  const executable = path.join(bundle, "Contents/MacOS/Repa");
  const base = path.join(application, "node_modules/@repa/base/dist");
  const learning = path.join(application, "node_modules/@repa/learning");
  for (const file of [executable, path.join(base, "cli.js"), path.join(base, "process.js"),
    path.join(application, "node_modules/@repa/space-history/dist/index.js"),
    path.join(learning, "repa-plugin.json"),
    path.join(application, "out/renderer/index.html"),
    // 主进程的 repa 协议从这里提供 Pyodide；wheel 由打包脚本按 lockfile 核对过。
    ...["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"].map((name) => path.join(application, "pyodide", name))]) {
    await access(file);
  }
  // ad-hoc 签名要能通过校验，否则 Apple Silicon 上程序起不来。
  await exec("codesign", ["--verify", "--deep", "--strict", bundle]);
  const environment = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  const { stdout: runtime } = await exec(executable, ["-e", "console.log(JSON.stringify({node:process.versions.node}))"], { env: environment });
  const runtimeInfo = JSON.parse(runtime);
  assert(Number(runtimeInfo.node.split(".")[0]) >= 24);
  // 从安装布局导入 launcher 和 client，按桌面端的装配拉起后端，工作区依赖不能掩盖遗漏的运行依赖。
  const { startRepaProcess } = await import(pathToFileURL(path.join(base, "process.js")));
  const { RepaClient } = await import(pathToFileURL(path.join(base, "client.js")));
  backend = await startRepaProcess({
    home: path.join(temporary, "home"), plugins: [learning], generalAgent: false, nodeExecutable: executable, environment,
  });
  client = await RepaClient.connect(backend.connection);
  const root = path.join(temporary, "space");
  assert.deepEqual(await client.call("space.create", { root }), { root, disabledPlugins: [] });
  assert.deepEqual((await client.call("plugin.list", {})).map((plugin) => plugin.id), ["learning"]);
  await client.close();
  await backend.close();
  console.log(JSON.stringify({ dmg, runtime: runtimeInfo, base: true, learning: true, connection: true, signature: "ad-hoc" }, null, 2));
} finally {
  await client?.close();
  await backend?.close();
  if (mounted) await exec("hdiutil", ["detach", mount]).catch(() => exec("hdiutil", ["detach", mount, "-force"]));
  await rm(temporary, { recursive: true, force: true });
}
