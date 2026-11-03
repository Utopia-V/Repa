/**
 * 各平台安装包共用的核对：文件齐全、用安装包里的 Electron 当 Node 拉起后端并加载学习插件、像学习者那样打开应用。
 * 平台脚本（verify-mac-package.mjs、verify-win-package.mjs）负责把安装包展开到磁盘，再交给这里。
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
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

/** 请应用正常退出：Windows 上 taskkill 不带 /F 是给窗口发关闭消息，窗口全关后主进程退出；其他平台发 SIGTERM。 */
async function quit(app) {
  if (process.platform === "win32") await exec("taskkill", ["/PID", String(app.pid)]).catch(() => {});
  else app.kill("SIGTERM");
}

/**
 * 像学习者那样打开应用：主进程启动后端、repa 协议提供 Web 界面、页面经 preload 连上后端，
 * 首次打开没有学习空间，应停在选空间页。之后请它正常退出，主进程会等后端收尾。
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
    await quit(app);
    const code = await Promise.race([exited, wait(20_000).then(() => "timeout")]);
    if (code === "timeout") {
      app.kill("SIGKILL");
      throw new Error("应用 20 秒内没有退出");
    }
  }
}

/**
 * 核对一份展开在磁盘上的安装：application 是应用目录（resources/app），executable 是应用的可执行文件，
 * temporary 放配置、空间和浏览器数据，调用方负责删除。返回给打包脚本输出的摘要。
 */
export async function verifyApplication({ application, executable, temporary }) {
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
  const environment = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  const { stdout: runtime } = await exec(executable, ["-e", "console.log(JSON.stringify({node:process.versions.node}))"], { env: environment });
  const runtimeInfo = JSON.parse(runtime);
  assert(Number(runtimeInfo.node.split(".")[0]) >= 24);
  // 从安装布局导入 launcher 和 client，按桌面端的装配拉起后端，工作区依赖不能掩盖遗漏的运行依赖。
  const { startRepaProcess } = await import(pathToFileURL(path.join(base, "process.js")));
  const { RepaClient } = await import(pathToFileURL(path.join(base, "client.js")));
  const backend = await startRepaProcess({
    home: path.join(temporary, "home"), plugins: [learning], generalAgent: false, nodeExecutable: executable, environment,
  });
  let client;
  try {
    client = await RepaClient.connect(backend.connection);
    const root = path.join(temporary, "space");
    assert.deepEqual(await client.call("space.create", { root }), { root, disabledPlugins: [] });
    assert.deepEqual((await client.call("plugin.list", {})).map((plugin) => plugin.id), ["learning"]);
  } finally {
    await client?.close();
    await backend.close();
  }
  const launch = await checkLaunch(executable, path.join(temporary, "app-home"), path.join(temporary, "app-data"));
  return { runtime: runtimeInfo, base: true, learning: true, connection: true, launch };
}
