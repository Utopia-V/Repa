import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 向系统要一个空闲端口给应用的远程调试用。 */
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** 在页面里求值，经 Chrome 调试协议。 */
async function evaluate(target, expression) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  const reply = await new Promise((resolve) => { socket.onmessage = (event) => resolve(JSON.parse(event.data)); });
  socket.close();
  return reply.result?.result?.value;
}

/**
 * 像学习者那样打开应用：主进程启动后端、repa 协议提供 Web 界面、页面经 preload 连上后端，
 * 首次打开没有学习空间，应停在选空间页。之后按正常退出关闭，主进程会等后端收尾。
 */
async function checkLaunch(executable, home, userData) {
  const port = await freePort();
  const environment = { ...process.env, REPA_HOME: home };
  delete environment.ELECTRON_RUN_AS_NODE;
  // 浏览器数据（localStorage 里记着上次的空间）也放进临时目录，本机验证不受之前用过的影响。
  const app = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], { env: environment, stdio: "ignore" });
  const exited = new Promise((resolve) => app.once("exit", resolve));
  let last = "（没有找到 repa://app/ 的页面）";
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      await wait(500);
      let targets;
      try {
        targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      } catch {
        continue;
      }
      const page = targets.find((target) => target.type === "page" && target.url.startsWith("repa://app/"));
      if (!page) continue;
      const text = await evaluate(page, "document.body.innerText");
      last = `${page.url}：${String(text).slice(0, 200)}`;
      if (typeof text === "string" && text.includes("开始第一个学习空间")) return { url: page.url };
    }
    throw new Error(`60 秒内应用没有显示选空间页，最后看到 ${last}`);
  } finally {
    app.kill("SIGTERM");
    const code = await Promise.race([exited, wait(20_000).then(() => "timeout")]);
    if (code === "timeout") {
      app.kill("SIGKILL");
      throw new Error("应用 20 秒内没有退出");
    }
  }
}
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
  const launch = await checkLaunch(executable, path.join(temporary, "app-home"), path.join(temporary, "app-data"));
  console.log(JSON.stringify({ dmg, runtime: runtimeInfo, base: true, learning: true, connection: true, signature: "ad-hoc", launch }, null, 2));
} finally {
  await client?.close();
  await backend?.close();
  if (mounted) await exec("hdiutil", ["detach", mount]).catch(() => exec("hdiutil", ["detach", mount, "-force"]));
  await rm(temporary, { recursive: true, force: true });
}
