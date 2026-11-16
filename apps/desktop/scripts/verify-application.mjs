/**
 * 各平台安装包共用的核对：文件齐全、安装包带的 Git 能保存和恢复空间、用安装包里的 Electron 当 Node 拉起后端并加载随包插件、
 * 像学习者那样打开应用，确认页面的 Worker 里能运行 Python，带计算题的课能通过检查并换用。
 * 平台脚本（verify-mac-package.mjs、verify-win-package.mjs）负责把安装包展开到磁盘，再交给这里。
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
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

/** 在页面里求值，经 Chrome 调试协议；表达式是 Promise 时等它完成。 */
async function evaluate(target, expression) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
  const reply = await new Promise((resolve) => { socket.onmessage = (event) => resolve(JSON.parse(event.data)); });
  socket.close();
  return reply.result?.result?.value;
}

/** 请应用正常退出：Windows 上 taskkill 不带 /F 是给窗口发关闭消息，窗口全关后主进程退出；其他平台发 SIGTERM。 */
async function quit(app) {
  if (process.platform === "win32") await exec("taskkill", ["/PID", String(app.pid)]).catch(() => {});
  else app.kill("SIGTERM");
}

/** 探针插件：一个自写插件，它唯一的方法把输入原样交给前端服务 python.run，再把结果交回。 */
const PROBE = "python-probe";
const PROBE_FILES = {
  "repa-plugin.json": JSON.stringify({ id: PROBE, version: "0.1.0", entry: "index.js" }),
  "index.js": `export default {
  id: ${JSON.stringify(PROBE)},
  async open(host) {
    return { methods: { run: { parameters: { type: "object" }, invoke: (input) => host.services.call("python.run", input) } } };
  },
};
`,
};
/** 页面这一次最多等多久：Pyodide 启动 60 秒，加上两个测试，留出余量。 */
const PAGE_PYTHON_TIMEOUT_MS = 180_000;

/**
 * 页面的 Worker 里真的能运行 Python：判分和课程核对都靠它，安装包里的 repa 协议、Worker 的 CSP、wasm 和离线包少了哪一样，
 * 学习者的机器上这条路就是断的。没有模型时，让后端向页面发 python.run 的最直接的办法是一个自写插件：
 * 脚本经页面取得后端的连接信息，以第二个连接接上（不声明 python.run），在临时空间里装上探针插件、调用它；
 * 底座把服务请求交给唯一声明了 python.run 的连接，也就是页面。交给页面的一批里有一个普通测试（用 pandas 求和）
 * 和一个课程核对的 verify 任务，结果、页面的 Python 环境版本（以随包 Python 课的清单为准）和按需加载的包都要对：
 * 只有引入了 pandas 的普通测试让页面加载 pandas，只用标准库的 verify 任务什么都不加载。
 */
async function checkPagePython(page, application, temporary) {
  const { RepaClient } = await import(pathToFileURL(path.join(application, "node_modules/@repa/base/dist/client.js")));
  const { PYTHON_BATCH } = await import(pathToFileURL(path.join(application, "node_modules/@repa/python-runner/dist/protocol.js")));
  const { parse } = await import(pathToFileURL(path.join(application, "node_modules/yaml/dist/index.js")));
  const course = parse(await readFile(path.join(application, "node_modules/@repa/learning/courses/python/course.yaml"), "utf8"));
  const expected = { pyodide: String(course.runtime.pyodide), python: String(course.runtime.python), packages: course.runtime.packages };
  const connection = await evaluate(page, "window.repaHost.getConnection()");
  assert.ok(connection?.url && connection?.token, "页面没有交出后端的连接信息");
  const client = await RepaClient.connect(connection);
  try {
    // 加载自写插件要使用者批准；这里只批准探针插件。
    client.on("confirm.request", ({ id, request }) => {
      void client.call("confirm.reply", { id, value: request.kind === "plugin" && request.plugin?.id === PROBE }).catch(() => {});
    });
    const root = path.join(temporary, "python 空间");
    const { opening } = await client.call("space.create", { root });
    for (const [name, content] of Object.entries(PROBE_FILES)) {
      await mkdir(path.join(root, ".agents", "plugins", PROBE), { recursive: true });
      await writeFile(path.join(root, ".agents", "plugins", PROBE, name), content);
    }
    const loaded = await client.call("plugin.load", { id: PROBE });
    assert.equal(loaded.state, "running", `探针插件没有运行：${JSON.stringify(loaded.reason)}`);
    const base = { prelude: "import pandas as pd", setup: "", data: [], doctest: [] };
    const input = {
      protocol: PYTHON_BATCH,
      tests: [
        { ...base, id: "sum", program: "total = int(pd.Series([1, 2, 3]).sum())", captures: ["total"] },
        {
          ...base, id: "verify", program: "import math\nanswers = {'n': math.ceil(70 / 20)}", captures: [],
          verify: { code: "", blocks: [], options: {}, cells: {}, shape: { n: "text" } },
        },
      ],
    };
    let timer;
    const reply = await Promise.race([
      client.call("plugin.call", { pluginId: PROBE, method: "run", input, opening }).catch((error) => {
        // 页面起不来时 python.run 以运行器的原因失败：Worker 起不来（CSP 没生效、脚本加载失败）、Pyodide 文件或 wheel 取不到、
        // 摘要不符、启动超时，都写在这句话里。
        throw new Error(`页面没能运行 Python：${error instanceof Error ? error.message : String(error)}`);
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`页面 ${PAGE_PYTHON_TIMEOUT_MS / 1000} 秒内没有交回 Python 的运行结果`)), PAGE_PYTHON_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
    const [sum, verify] = reply.tests ?? [];
    const runtime = { pyodide: reply.runtime?.pyodide, python: reply.runtime?.python, packages: Object.fromEntries(Object.keys(expected.packages).map((name) => [name, reply.runtime?.packages?.[name]])) };
    assert.deepEqual(runtime, expected, `页面的 Pyodide、Python 或带的包与随包课程的清单不符：${JSON.stringify(reply.runtime)}`);
    assert.deepEqual(reply.loaded, ["pandas"], `页面按需加载的包不对：${JSON.stringify(reply.loaded)}`);
    assert.deepEqual(sum?.status === "completed" ? sum.result.captures : sum, { total: { value: { t: "int", v: "6" } } }, "页面里的普通测试没有算出 6");
    assert.deepEqual(verify?.status === "completed" ? verify.result.verified : verify, { answers: { n: "4" }, unknown: [] }, "页面里的 verify 任务没有算出 4");
    return { runtime: reply.runtime, loaded: reply.loaded, sum: 6, verify: 4 };
  } finally {
    await client.close();
  }
}

/** 假模型的提供方 id，写进临时配置目录的 agent/models.json；只在这里的临时 home 里有。 */
const SCRIPTED = { provider: "repa-verify", id: "scripted" };

/**
 * 本机的假模型：说 OpenAI 兼容的 chat completions（流式），第一次回答调用 course_use，之后回一句话结束。
 * 请求里出现工具结果时记下它，那就是做课的 Agent 读到的检查结果。返回写进 models.json 的配置和收到的工具结果。
 */
async function startScriptedModel() {
  const toolResults = [];
  const server = createHttpServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const messages = JSON.parse(body).messages ?? [];
      const results = messages.filter((message) => message.role === "tool");
      const chunk = (delta, finish) => `data: ${JSON.stringify({
        id: "verify", object: "chat.completion.chunk", created: 0, model: SCRIPTED.id,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (results.length === 0) {
        response.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_use", type: "function", function: { name: "course_use", arguments: "{}" } }] }, null));
        response.write(chunk({}, "tool_calls"));
      } else {
        const content = results.at(-1).content;
        toolResults.push(typeof content === "string" ? content : content.map((part) => part.text ?? "").join(""));
        response.write(chunk({ role: "assistant", content: "好。" }, null));
        response.write(chunk({}, "stop"));
      }
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const models = {
    providers: {
      [SCRIPTED.provider]: {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "verify",
        models: [{ id: SCRIPTED.id }],
      },
    },
  };
  return { models, toolResults, close: () => new Promise((resolve) => server.close(resolve)) };
}

/**
 * 给 topic 里每道由程序判分的题写上当前的核对记录：course_use 只换用核对过的课。模型核对是一次普通的模型请求，
 * 走的路与平台和安装包无关，这里不经假模型重做一遍，直接用安装包里的函数算出记录写进文件。
 */
async function writeConfirmationRecords(application, topicFile, topic) {
  const check = path.join(application, "node_modules/@repa/learning/dist/check");
  const { confirmationSlots, lessonVersion, localDate, writeConfirmations } = await import(pathToFileURL(path.join(check, "confirm.js")));
  const { topicQuestions } = await import(pathToFileURL(path.join(check, "items.js")));
  const scope = "question-lesson-v1";
  const records = [];
  for (const entry of topicQuestions(topic)) {
    const slots = confirmationSlots(entry, scope);
    if (slots.length === 0) continue;
    records.push({ question: entry.question.id, version: await lessonVersion(entry, topic), scope, slots, model: `${SCRIPTED.provider}/${SCRIPTED.id}`, date: localDate() });
  }
  assert.ok(records.length > 0, "示例课里没有要核对的题");
  await writeConfirmations(topicFile, records);
}

/** 做课的 Agent 等检查结果最多多久：页面这一次要启动 Pyodide（60 秒）再运行核对，留出余量。 */
const COURSE_USE_TIMEOUT_MS = 240_000;

/**
 * 带计算题的课在装好的应用里能通过检查并换用：checkPagePython 只确认 python.run 本身能用，课程核对另有一段路
 * （找离线包、选沙箱还是页面、比较版本），曾在安装包里因为 Node 一侧找不到 wheel 而整个失败。这里走真正的 course_use：
 * 在临时空间里放一门示例课，加上写课说明里的 verify 例题（清单照说明不写 runtime），写上核对记录，由假模型让通用 Agent 调用 course_use，
 * 读它交回给模型的检查结果。Linux 上经沙箱核对，Windows 和 macOS 上经开着的应用页面核对。
 */
async function checkCourseUse(connection, application, temporary, model) {
  const { RepaClient } = await import(pathToFileURL(path.join(application, "node_modules/@repa/base/dist/client.js")));
  const { parse, stringify } = await import(pathToFileURL(path.join(application, "node_modules/yaml/dist/index.js")));
  const guides = path.join(application, "node_modules/@repa/learning/guides");
  const guide = (await readFile(path.join(guides, "making-courses.md"), "utf8")).replaceAll("\r\n", "\n");
  const examples = [...guide.matchAll(/^```yaml\n([\s\S]*?)^```$/gmu)].map((match) => parse(match[1]));
  const question = examples.find((entry) => Array.isArray(entry) && entry[0]?.verify !== undefined);
  assert.ok(question, "写课说明里找不到 verify 例题");
  const root = path.join(temporary, "做课 空间");
  const course = path.join(root, "course");
  await cp(path.join(guides, "example-course"), course, { recursive: true });
  const topicFile = path.join(course, "topics", "os01.yaml");
  const topic = parse(await readFile(topicFile, "utf8"));
  topic.kps[0].practice.push(...question);
  await writeFile(topicFile, stringify(topic, { aliasDuplicateObjects: false }));
  await writeConfirmationRecords(application, topicFile, topic);

  const client = await RepaClient.connect(connection);
  try {
    await client.call("space.create", { root });
    const session = await client.call("session.create", { model: SCRIPTED });
    await client.call("session.send", { sessionId: session.id, text: "检查这门课，通过就换用。" });
    const deadline = Date.now() + COURSE_USE_TIMEOUT_MS;
    while (model.toolResults.length === 0) {
      if (Date.now() > deadline) throw new Error(`${COURSE_USE_TIMEOUT_MS / 1000} 秒内做课的 Agent 没有拿到 course_use 的结果`);
      await wait(500);
    }
    const [result] = model.toolResults;
    const where = process.platform === "linux" ? " Linux 沙箱里" : "应用页面的 Worker 里";
    assert.match(result, /^已换用/u, `课没有换用：${result}`);
    assert.ok(result.includes(`在${where}运行了 verify 核对程序`), `核对不是在${where.trim()}运行的：${result}`);
    assert.doesNotMatch(result, /npm/u);
    return { used: true, where: where.trim() };
  } finally {
    await client.close();
  }
}

/**
 * 像学习者那样打开应用：主进程启动后端、repa 协议提供 Web 界面、页面经 preload 连上后端，
 * 首次打开没有学习空间，应停在选空间页；再确认页面的 Worker 里能运行 Python（见 checkPagePython）。
 * 之后请它正常退出，主进程会等后端收尾。hideGit 时 PATH 里没有其他 Git。
 */
async function checkLaunch(executable, application, temporary, hideGit) {
  const home = path.join(temporary, "app-home");
  const model = await startScriptedModel();
  await mkdir(path.join(home, "agent"), { recursive: true });
  await writeFile(path.join(home, "agent", "models.json"), JSON.stringify(model.models));
  const userData = path.join(temporary, "app-data");
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
      if (typeof text === "string" && text.includes("创建第一门课")) {
        const python = await checkPagePython(page, application, temporary);
        const course = await checkCourseUse(await evaluate(page, "window.repaHost.getConnection()"), application, temporary, model);
        return { url: page.url, python, course };
      }
    }
    throw new Error(`60 秒内应用没有显示选空间页，最后看到 ${last}`);
  } finally {
    await model.close();
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
  const materials = path.join(application, "node_modules/@repa/materials");
  for (const file of [executable, path.join(base, "cli.js"), path.join(base, "process.js"),
    // 通用 Agent 写插件时读的 Skill 与模板，随 @repa/base 的 files 装进来。
    path.join(base, "../skills/plugin-authoring/SKILL.md"), path.join(base, "../skills/plugin-authoring/template/index.ts"),
    path.join(application, "node_modules/@repa/space-history/dist/index.js"),
    path.join(learning, "repa-plugin.json"),
    // 课件转文字插件读中文 PDF 要用的 CMap 数据，随包的 files 装进来。
    path.join(materials, "repa-plugin.json"), path.join(materials, "cmaps/UniGB-UCS2-H.bcmap"),
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
    home: path.join(temporary, "home"), plugins: [learning, materials], nodeExecutable: executable, environment,
    ...(gitPath === undefined ? {} : { gitPath }),
  });
  let client;
  try {
    client = await RepaClient.connect(backend.connection);
    const root = path.join(temporary, "space");
    const created = await client.call("space.create", { root });
    assert.equal(created.root, root);
    const running = [["learning", "running"], ["materials", "running"]];
    assert.deepEqual(created.plugins.map((plugin) => [plugin.id, plugin.state]), running);
    assert.deepEqual((await client.call("plugin.list", {})).map((plugin) => [plugin.id, plugin.state]), running);
    // 学习者版本带通用 Agent：做课由它完成，设置页按它读提示段。
    assert.ok((await client.call("agent.list", {})).some((agent) => agent.id === "general"));
    await client.call("prompt.list", {});
  } finally {
    await client?.close();
    await backend.close();
  }
  const launch = await checkLaunch(executable, application, temporary, gitPath !== undefined);
  return { runtime: runtimeInfo, git, base: true, learning: true, materials: true, connection: true, launch };
}
