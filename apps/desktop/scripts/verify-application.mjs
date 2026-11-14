/**
 * 各平台安装包共用的核对：文件齐全、安装包带的 Git 能保存和恢复空间、用安装包里的 Electron 当 Node 拉起后端并加载学习插件、
 * 像学习者那样打开应用。
 * 平台脚本（verify-mac-package.mjs、verify-win-package.mjs）负责把安装包展开到磁盘，再交给这里。
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
 * 首次打开没有学习空间，应停在选空间页。之后请它正常退出，主进程会等后端收尾。hideGit 时 PATH 里没有其他 Git。
 */
async function checkLaunch(executable, home, userData, hideGit) {
  const port = await freePort();
  const environment = hideGit ? withoutGit({ ...process.env, REPA_HOME: home }) : { ...process.env, REPA_HOME: home };
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

/** 安装包带的 Git 在应用目录里的位置，与主进程的 bundledGit 一致；Linux 安装包不带，返回 undefined。 */
function bundledGit(application) {
  if (process.platform === "darwin") return path.join(application, "git", "git");
  if (process.platform === "win32") return path.join(application, "git", "git.exe");
  return undefined;
}

/**
 * 不含 git 的 PATH：CI 和开发机上都装着 Git，Git 找不到自己的子命令时会退回 PATH 里的那份，--exec-path 坏了也看不出来。
 * 学习者的电脑上可能没有 Git，核对时就按没有来。
 */
function pathWithoutGit() {
  if (process.platform === "win32") {
    const system = process.env.SystemRoot ?? "C:\\Windows";
    return [path.join(system, "System32"), system].join(path.delimiter);
  }
  return ["/usr/sbin", "/sbin"].join(path.delimiter);
}

/** 把环境里的 PATH 换成 pathWithoutGit()；Windows 上变量名不分大小写，原来的 Path 要先去掉，免得子进程拿到两份。 */
function withoutGit(environment) {
  const result = Object.fromEntries(Object.entries(environment).filter(([key]) => key.toUpperCase() !== "PATH"));
  result.PATH = pathWithoutGit();
  return result;
}

/** 历史仓库里 pack 文件的个数。 */
async function packCount(gitDir) {
  return (await readdir(path.join(gitDir, "objects", "pack"))).filter((name) => name.endsWith(".pack")).length;
}

/**
 * 用安装布局里的 space-history 和安装包带的 Git 走一遍空间历史，PATH 里没有其他 Git：
 * 打开时先保存一次，改文件后再保存一次，对象少，fast-import 会调起 unpack-objects 解成松散对象；
 * fast-import 在调不起它时照样成功、只是留下 pack，所以按有没有 pack 判断。再强制维护一次（gc 调起 repack 等），
 * 最后把历史复制到新目录写出空间文件。空间目录和文件名带空格与中文。
 */
async function checkGit(application, gitPath, temporary) {
  const { stdout: version } = await exec(gitPath, ["--version"]);
  const { openHistory, checkoutLatest } = await import(pathToFileURL(path.join(application, "node_modules/@repa/space-history/dist/index.js")));
  const space = path.join(temporary, "学习 空间");
  const gitDir = path.join(space, ".repa", "history.git");
  const note = "笔记 一.md";
  await mkdir(space);
  await writeFile(path.join(space, note), "第一版\n");
  // space-history 用本进程的环境启动 Git。
  const originalPath = process.env.PATH;
  process.env.PATH = pathWithoutGit();
  try {
    const history = await openHistory(space, { exclusive: true, gitPath });
    await writeFile(path.join(space, note), "第二版\n");
    await history.snapshot();
    assert.equal(await packCount(gitDir), 0, "保存后不应留下 pack：unpack-objects 没有被调起");
    assert.equal(await history.maintain({ force: true }), true);
    assert.ok(await packCount(gitDir) > 0, "维护后应当打成 pack");
    const copy = path.join(temporary, "恢复 空间");
    await mkdir(path.join(copy, ".repa"), { recursive: true });
    await cp(gitDir, path.join(copy, ".repa", "history.git"), { recursive: true });
    await checkoutLatest(copy, { gitPath });
    assert.equal(await readFile(path.join(copy, note), "utf8"), "第二版\n");
  } finally {
    process.env.PATH = originalPath;
  }
  return { version: version.trim(), saved: true, maintained: true, restored: true };
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
  const gitPath = bundledGit(application);
  const git = gitPath === undefined ? undefined : await checkGit(application, gitPath, temporary);
  // 后端也在没有其他 Git 的 PATH 下启动，只能用安装包带的那份。
  const nodeEnvironment = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  const environment = gitPath === undefined ? nodeEnvironment : withoutGit(nodeEnvironment);
  const { stdout: runtime } = await exec(executable, ["-e", "console.log(JSON.stringify({node:process.versions.node}))"], { env: environment });
  const runtimeInfo = JSON.parse(runtime);
  assert(Number(runtimeInfo.node.split(".")[0]) >= 24);
  // 从安装布局导入 launcher 和 client，按桌面端的装配拉起后端，工作区依赖不能掩盖遗漏的运行依赖。
  const { startRepaProcess } = await import(pathToFileURL(path.join(base, "process.js")));
  const { RepaClient } = await import(pathToFileURL(path.join(base, "client.js")));
  const backend = await startRepaProcess({
    home: path.join(temporary, "home"), plugins: [learning], generalAgent: false, nodeExecutable: executable, environment,
    ...(gitPath === undefined ? {} : { gitPath }),
  });
  let client;
  try {
    client = await RepaClient.connect(backend.connection);
    const root = path.join(temporary, "space");
    const created = await client.call("space.create", { root });
    assert.equal(created.root, root);
    assert.deepEqual(created.plugins.map((plugin) => [plugin.id, plugin.state]), [["learning", "running"]]);
    assert.deepEqual((await client.call("plugin.list", {})).map((plugin) => [plugin.id, plugin.state]), [["learning", "running"]]);
  } finally {
    await client?.close();
    await backend.close();
  }
  const launch = await checkLaunch(executable, path.join(temporary, "app-home"), path.join(temporary, "app-data"), gitPath !== undefined);
  return { runtime: runtimeInfo, git, base: true, learning: true, connection: true, launch };
}
