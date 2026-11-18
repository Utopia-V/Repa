import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAgentRuntimeForTest } from "../src/agent/runtime.js";
import { RepaClient, RpcError } from "../src/client.js";
import type { Plugin } from "../src/plugin.js";
import { startServer } from "../src/protocol/server.js";
import type { Confirmation, McpServerInfo } from "../src/schema.js";
import { MAX_DESCRIPTION, MAX_SERVERS, MAX_TOOLS } from "../src/mcp/servers.js";
import { unzip } from "./unzip.js";

const SERVER = fileURLToPath(new URL("fixtures/mcp-server.mjs", import.meta.url));
const SECRET = `token-${randomUUID()}`;

// 学习插件的替身：一个辅导 Agent，以及一个在后台起通用 Agent 的方法（相当于后台展开课程）。
const learning: Plugin = {
  id: "learning",
  async open(host) {
    return {
      agents: () => [{ id: "tutor", instructions: () => "你陪学习者练习。", tools: [], direct: true }],
      methods: {
        background: {
          parameters: Type.Object({}, { additionalProperties: false }),
          async invoke() {
            const work = await host.models.runAgent({ agent: "general", text: "后台任务" });
            await work.result;
            return { id: work.id };
          },
        },
      },
    };
  },
};

interface Started {
  server: Awaited<ReturnType<typeof startServer>>;
  client: RepaClient;
}

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-mcp-")));
  const root = path.join(directory, "space");
  const home = path.join(directory, "home");
  const log = path.join(directory, "mcp.log");
  await mkdir(root);
  await mkdir(path.join(home, "agent"), { recursive: true });
  const faux = fauxProvider({ api: `mcp-${randomUUID()}`, provider: `mcp-${randomUUID()}`, models: [{ id: "scripted", contextWindow: 65536, maxTokens: 256 }], tokensPerSecond: 0 });
  const requests: TranscriptContext[] = [];
  const confirmations: Confirmation[] = [];
  let answer = true;
  let current: Started | undefined;
  const start = async (): Promise<Started> => {
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(home, "agent", "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const runtime = await createAgentRuntimeForTest({
      agentDir: path.join(home, "agent"),
      modelRuntime,
      defaultModel: { provider: faux.getModel().provider, id: "scripted" },
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
    });
    const server = await startServer({ home, plugins: [learning], runtime });
    const client = await RepaClient.connect(server.connection);
    client.on("confirm.request", ({ id, request }) => {
      confirmations.push(request);
      void client.call("confirm.reply", { id, value: answer }).catch(() => undefined);
    });
    current = { server, client };
    return current;
  };
  const stop = async () => {
    const started = current;
    current = undefined;
    await started?.client.close();
    await started?.server.close();
  };
  t.after(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });
  const started = await start();
  const opened = await started.client.call("space.open", { root });
  /** 回答依次取用；每次请求记下 provider 实际收到的内容。 */
  const respond = (...steps: Parameters<typeof fauxAssistantMessage>[0][]) => {
    faux.setResponses(steps.map(step => (context: TranscriptContext) => {
      requests.push(context);
      return fauxAssistantMessage(step);
    }));
  };
  const client = () => {
    if (current === undefined) throw new Error("后端没有在运行");
    return current.client;
  };
  const lines = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
  return {
    directory, root, home, log, faux, requests, confirmations, opening: opened.opening, respond, client, start, stop, lines,
    setAnswer(value: boolean) { answer = value; },
    /** 测试服务器的配置：本机 Node 跑手写的服务器，进程日志写到 log。 */
    stdio(env: Record<string, string> = {}, extra: object = {}) {
      return { command: process.execPath, args: [SERVER], cwd: directory, env: { MCP_LOG: log, MCP_SECRET: SECRET, ...env }, ...extra };
    },
    async starts() { return (await lines()).filter(line => line.startsWith("start ")).map(line => Number(line.split(" ")[1])); },
    async calls() { return (await lines()).filter(line => line.startsWith("tools/call ")); },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) assert.fail(`等不到${what}：${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function server(list: McpServerInfo[], name: string): McpServerInfo {
  const found = list.find(item => item.name === name);
  assert.ok(found, `列表里没有 ${name}`);
  return found;
}

const state = (f: Fixture, name: string, wanted: McpServerInfo["state"]) =>
  until(() => f.client().call("mcp.list", {}), list => server(list, name).state === wanted, `${name} 成为 ${wanted}`);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function history(f: Fixture, sessionId: string) {
  return f.client().call("session.history", { sessionId });
}

async function toolResults(f: Fixture, sessionId: string) {
  return (await history(f, sessionId)).filter(entry => entry.type === "tool").map(entry => ({ text: entry.text, data: entry.data as { tool: string; isError: boolean } }));
}

function declared(context: TranscriptContext | undefined): string[] {
  assert.ok(context);
  return getCurrentTools(context.messages).map(tool => tool.name);
}

test("粘贴一段 stdio 配置以后显示已连接和工具；通用 Agent 调用前先请求确认，允许后拿到结果并记进会话，拒绝时服务器收不到调用", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.client().call("mcp.list", {}), []);
  // 服务器说明里常只给 "名字": {...} 这一段。
  const pasted = `"local": ${JSON.stringify(f.stdio())}`;
  const added = await f.client().call("mcp.add", { config: pasted });
  assert.equal(server(added, "local").state, "connecting");
  const list = await state(f, "local", "connected");
  assert.deepEqual(server(list, "local"), {
    name: "local", transport: "stdio", target: process.execPath, enabled: true, ask: true, state: "connected",
    tools: ["mcp__local__echo", "mcp__local__slow", "mcp__local__add_tool", "mcp__local__crash", "mcp__local__big", "mcp__local__secret"],
  });
  assert.ok(!JSON.stringify(list).includes(SECRET));
  const saved = JSON.parse(await readFile(path.join(f.home, "mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> };
  assert.deepEqual(Object.keys(saved.mcpServers), ["local"]);

  const session = await f.client().call("session.create", {});
  f.respond(fauxToolCall("mcp__local__echo", { text: "你好" }), "第一次完成", fauxToolCall("mcp__local__echo", { text: "再来" }), "第二次完成");
  await f.client().call("session.send", { sessionId: session.id, text: "调用一次" });
  assert.ok(declared(f.requests[0]).includes("mcp__local__echo"));
  assert.deepEqual(f.confirmations, [{ kind: "mcp", title: "", mcp: { server: "local", tool: "echo", input: { text: "你好" } } }]);
  f.setAnswer(false);
  await f.client().call("session.send", { sessionId: session.id, text: "再调用一次" });
  assert.equal(f.confirmations.length, 2);
  assert.deepEqual(await f.calls(), [`tools/call echo {"text":"你好"}`]);
  const results = await toolResults(f, session.id);
  assert.deepEqual(results.map(result => [result.data.tool, result.data.isError, result.text]), [
    ["mcp__local__echo", false, "echo: 你好"],
    ["mcp__local__echo", true, "使用者拒绝了这次调用"],
  ]);
  assert.deepEqual(await f.starts().then(pids => pids.length), 1);
});

test("关掉调用前询问以后不再询问，后台运行也能调用；开着询问时后台调用被拒绝，原因交回模型，服务器收不到调用", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.home, "mcp.json"), JSON.stringify({ mcpServers: { local: f.stdio() } }));
  await f.client().call("mcp.list", {});
  await state(f, "local", "connected");
  f.respond(fauxToolCall("mcp__local__echo", { text: "后台" }), "后台结束");
  const first = await f.client().call("plugin.call", { pluginId: "learning", method: "background", input: {}, opening: f.opening }) as { id: string };
  const refused = await toolResults(f, first.id);
  assert.equal(refused.length, 1);
  assert.equal(refused[0]?.data.isError, true);
  assert.match(refused[0]?.text ?? "", /调用前询问，没有得到使用者的确认/u);
  assert.deepEqual(await f.calls(), []);
  assert.deepEqual(f.confirmations, []);

  const list = await f.client().call("mcp.set", { name: "local", ask: false });
  assert.equal(server(list, "local").ask, false);
  assert.equal(server(list, "local").state, "connected");
  // 只改了询问开关：连接不重建。
  assert.equal((await f.starts()).length, 1);
  const saved = JSON.parse(await readFile(path.join(f.home, "mcp.json"), "utf8")) as { mcpServers: { local: Record<string, unknown> } };
  assert.equal(saved.mcpServers.local.askBeforeCall, false);
  f.respond(fauxToolCall("mcp__local__echo", { text: "后台" }), "后台结束");
  const second = await f.client().call("plugin.call", { pluginId: "learning", method: "background", input: {}, opening: f.opening }) as { id: string };
  assert.deepEqual((await toolResults(f, second.id)).map(result => [result.data.isError, result.text]), [[false, "echo: 后台"]]);
  const session = await f.client().call("session.create", {});
  f.respond(fauxToolCall("mcp__local__echo", { text: "对话" }), "完成");
  await f.client().call("session.send", { sessionId: session.id, text: "调用" });
  assert.deepEqual(f.confirmations, []);
  assert.equal((await f.calls()).length, 2);
});

test("命令授权为完全访问时，开着询问的服务器也不问", async t => {
  const f = await fixture(t);
  await f.client().call("settings.set", { commandPolicy: "fullAccess" });
  await f.client().call("mcp.add", { config: JSON.stringify({ mcpServers: { local: f.stdio() } }) });
  await state(f, "local", "connected");
  const session = await f.client().call("session.create", {});
  f.respond(fauxToolCall("mcp__local__echo", { text: "x" }), "完成");
  await f.client().call("session.send", { sessionId: session.id, text: "调用" });
  assert.deepEqual(f.confirmations, []);
  assert.equal((await f.calls()).length, 1);
});

test("不回答握手的服务器不拖住消息，超时以后显示原因；关闭后端时它和别的服务器连同子进程都结束", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.home, "mcp.json"), JSON.stringify({ mcpServers: {
    stuck: f.stdio({ MCP_HANG_INIT: "1" }, { timeout: 2 }),
    stubborn: f.stdio({ MCP_IGNORE_EOF: "1", MCP_GRANDCHILD: "1" }),
  } }));
  // 手改的文件在读列表时生效。
  await f.client().call("mcp.list", {});
  await state(f, "stubborn", "connected");
  assert.equal(server(await f.client().call("mcp.list", {}), "stuck").state, "connecting");
  const session = await f.client().call("session.create", {});
  f.respond("照常回答");
  await f.client().call("session.send", { sessionId: session.id, text: "你好" });
  assert.equal(server(await f.client().call("mcp.list", {}), "stuck").state, "connecting");
  assert.ok(!declared(f.requests[0]).some(name => name.startsWith("mcp__stuck__")));
  const failed = server(await state(f, "stuck", "failed"), "stuck");
  assert.equal(failed.reason?.code, "mcp_timeout");
  // 两个服务器同时启动，日志里谁先谁后不一定；stubborn 的进程号取自它记下孙进程的那一行。握手超时的那个此时已被结束。
  const [, grandchild = 0, stubborn = 0] = ((await f.lines()).find(line => line.startsWith("grandchild ")) ?? "").split(" ").map(Number);
  const pids = [...await f.starts(), grandchild];
  assert.equal(pids.length, 3);
  assert.ok(pids.includes(stubborn));
  assert.ok(alive(stubborn) && alive(grandchild));
  await f.stop();
  // 孙进程不是后端的子进程，关闭只能向它发出结束信号，等不到它退出；它收到信号后自行结束。
  await until(async () => pids.filter(alive), left => left.length === 0, "进程都结束");
});

test("关闭后端时服务器进程结束；重新启动后打开旧会话看历史不多起进程", async t => {
  const f = await fixture(t);
  await f.client().call("mcp.add", { config: JSON.stringify({ mcpServers: { local: f.stdio() } }) });
  await state(f, "local", "connected");
  const session = await f.client().call("session.create", {});
  f.respond(fauxToolCall("mcp__local__echo", { text: "一" }), "完成");
  await f.client().call("session.send", { sessionId: session.id, text: "调用" });
  const [first] = await f.starts();
  await f.stop();
  assert.equal(alive(first ?? 0), false);
  // 后端启动后在后台连接，不等谁来读列表。
  await f.start();
  await until(() => f.starts(), pids => pids.length === 2, "重新启动后连上");
  await f.client().call("space.open", { root: f.root });
  await state(f, "local", "connected");
  const entries = await history(f, session.id);
  assert.ok(entries.some(entry => entry.type === "tool"));
  assert.equal((await f.starts()).length, 2);
});

test("学习辅导的请求里没有 MCP 工具，通用 Agent 的有", async t => {
  const f = await fixture(t);
  await f.client().call("mcp.add", { config: JSON.stringify({ mcpServers: { local: f.stdio() } }) });
  await state(f, "local", "connected");
  const tutor = await f.client().call("session.create", { agent: "tutor" });
  f.respond("辅导回答");
  await f.client().call("session.send", { sessionId: tutor.id, text: "开始" });
  assert.deepEqual(declared(f.requests[0]).filter(name => name.startsWith("mcp__")), []);
  const general = await f.client().call("session.create", {});
  f.respond("通用回答");
  await f.client().call("session.send", { sessionId: general.id, text: "开始" });
  assert.ok(declared(f.requests[1]).includes("mcp__local__echo"));
});

test("配置里的令牌不出现在列表、会话记录和最近错误里；服务器把令牌写进结果时，反馈包里已脱敏", async t => {
  const f = await fixture(t);
  const headers: IncomingHttpHeaders[] = [];
  const http = createServer((request, response) => {
    headers.push(request.headers);
    if (request.method !== "POST") return response.writeHead(405).end();
    let body = "";
    request.on("data", chunk => { body += String(chunk); });
    request.on("end", () => {
      const message = JSON.parse(body) as { id?: number; method: string; params?: { protocolVersion?: string } };
      if (message.id === undefined) return response.writeHead(202).end();
      const reply = (result: unknown) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      if (message.method === "initialize") return reply({ protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "http", version: "1" } });
      if (message.method === "tools/list") return reply({ tools: [{ name: "hello", inputSchema: { type: "object" } }] });
      return reply({ content: [{ type: "text", text: "hello back" }] });
    });
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => http.close(() => resolve())));
  const address = http.address();
  assert.ok(address !== null && typeof address === "object");
  await f.client().call("mcp.add", { config: JSON.stringify({ mcpServers: {
    local: f.stdio(),
    remote: { url: `http://127.0.0.1:${address.port}/mcp?key=${SECRET}`, headers: { Authorization: `Bearer ${SECRET}` } },
  } }) });
  await state(f, "local", "connected");
  const list = await state(f, "remote", "connected");
  assert.deepEqual(server(list, "remote").target, `http://127.0.0.1:${address.port}/mcp`);
  assert.ok(headers.every(item => item.authorization === `Bearer ${SECRET}`));
  assert.ok(!JSON.stringify(list).includes(SECRET));
  await f.client().call("mcp.set", { name: "remote", ask: false });
  await f.client().call("mcp.set", { name: "local", ask: false });

  const session = await f.client().call("session.create", {});
  f.respond(fauxToolCall("mcp__remote__hello", {}), fauxToolCall("mcp__local__secret", {}), "完成", fauxToolCall("mcp__local__crash", {}), "断了");
  await f.client().call("session.send", { sessionId: session.id, text: "调用" });
  const results = await toolResults(f, session.id);
  assert.deepEqual(results.map(result => result.text), ["hello back", `secret: ${SECRET}`]);
  // 服务器退出时把令牌写到了 stderr：状态说明里换掉。
  await f.client().call("session.send", { sessionId: session.id, text: "再调用" });
  const crashed = server(await state(f, "local", "failed"), "local");
  assert.equal(crashed.reason?.code, "mcp_disconnected");
  assert.match(crashed.reason?.message ?? "", /fatal: lost \*\*\*/u);

  const bundle = await f.client().call("feedback.create", { sessionId: session.id, describe: false, directory: f.directory });
  const files = unzip(await readFile(bundle.path));
  const record = files.get(`sessions/${session.id}.jsonl`)?.text ?? "";
  assert.ok(record.includes("secret: [已脱敏:credential]"));
  for (const [name, file] of files) assert.ok(!file.text.includes(SECRET), `${name} 里有令牌`);
});

test("命令不存在、工作目录不存在时分别说明原因，不报笼统的连接关闭；命令在而起来就退出的报连接失败", async t => {
  const f = await fixture(t);
  const missingDirectory = path.join(f.directory, "没有这个目录");
  // Windows 上按名称找不到的命令经 cmd.exe 起来再失败，与写 initialize 时的管道断开同时发生；多起几个，先后各种情形都会遇到。
  const missing = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`missing${index}`, { command: "repa-no-such-command", env: { PATH: path.join(f.directory, "bin") } }]));
  await f.client().call("mcp.add", { config: JSON.stringify({ mcpServers: {
    ...missing,
    absolute: { command: path.join(f.directory, "no-such-server") },
    nocwd: { ...f.stdio(), cwd: missingDirectory },
    // 命令在、只是起来就退出的，照实报连接失败并附上 stderr；按名字写的命令在 PATH 里找（Windows 上带 PATHEXT）。
    exits: { command: "node", args: ["-e", "process.stderr.write('boom'); process.exit(1)"] },
  } }) });
  const list = await until(() => f.client().call("mcp.list", {}), items => items.every(item => item.state !== "connecting"), "全部连完");
  for (const name of Object.keys(missing)) assert.deepEqual(server(list, name).reason, { code: "mcp_command_not_found", message: "找不到命令 repa-no-such-command" });
  assert.equal(server(list, "absolute").reason?.code, "mcp_command_not_found");
  assert.deepEqual(server(list, "nocwd").reason, { code: "mcp_cwd_not_found", message: `工作目录不存在 ${missingDirectory}` });
  assert.equal(server(list, "exits").reason?.code, "mcp_connect_failed");
  assert.match(server(list, "exits").reason?.message ?? "", /boom/u);
  assert.deepEqual(await f.lines(), []);
});

test("Windows：经 npm 式 .cmd 包装起的服务器逐字收到参数；配置里小写的 path 也照样生效", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  // npm 装出的包装在 node_modules\.bin 下，由 cmd.exe 运行再经 %* 转交；学习者的用户名常是中文，路径里也常有空格。
  const bin = path.join(f.directory, "中文 目录", "node_modules", ".bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "repa-probe.cmd"), `@"${process.execPath}" "${SERVER}" %*\r\n`);
  const args = ["with space", "quote\"inside", "\"wrapped\"", "100%", "%PATH%", "caret^x", "a&b", "pipe|x", "<lt>", "(paren)", "!bang!", "中文参数", "C:\\Users\\张三\\My Docs\\", "back\\\"slash", "", "tab\tx"];
  const argsLog = path.join(f.directory, "args.log");
  const pathLog = path.join(f.directory, "lower.log");
  await f.client().call("mcp.add", { config: JSON.stringify({ mcpServers: {
    args: { command: path.join(bin, "repa-probe.cmd"), args, env: { MCP_LOG: argsLog } },
    lower: { command: "repa-probe", env: { path: `${bin};${process.env.Path ?? process.env.PATH ?? ""}`, MCP_LOG: pathLog, MCP_ECHO_ENV: "PATH" } },
  } }) });
  await state(f, "args", "connected");
  await state(f, "lower", "connected");
  const logged = async (log: string, prefix: string) => (await readFile(log, "utf8")).split("\n").find(line => line.startsWith(prefix))?.slice(prefix.length);
  assert.deepEqual(JSON.parse(await logged(argsLog, "argv ") ?? "null"), args);
  assert.equal((await logged(pathLog, "env "))?.split(";")[0], bin);
});

test("需要登录的远程服务器显示需要登录，暂不支持；工具不出现", async t => {
  const f = await fixture(t);
  const http = createServer((_request, response) => response.writeHead(401, { "www-authenticate": "Bearer" }).end());
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => http.close(() => resolve())));
  const address = http.address();
  assert.ok(address !== null && typeof address === "object");
  await f.client().call("mcp.add", { config: JSON.stringify({ mcpServers: { remote: { url: `http://127.0.0.1:${address.port}/mcp` } } }) });
  const failed = server(await state(f, "remote", "failed"), "remote");
  assert.deepEqual(failed.reason, { code: "mcp_auth_required", message: "服务器需要登录，暂不支持" });
  assert.deepEqual(failed.tools, []);
});

test("停止运行时取消进行中的调用，服务器收到取消", async t => {
  const f = await fixture(t);
  await f.client().call("mcp.add", { config: JSON.stringify({ mcpServers: { local: f.stdio({}, { askBeforeCall: false }) } }) });
  await state(f, "local", "connected");
  const session = await f.client().call("session.create", {});
  f.respond(fauxToolCall("mcp__local__slow", { ms: 60_000 }), "不会走到这里");
  const sending = f.client().call("session.send", { sessionId: session.id, text: "慢慢来" }).catch((error: unknown) => error);
  await until(() => f.calls(), calls => calls.length === 1, "调用开始");
  await f.client().call("session.abort", { sessionId: session.id });
  const outcome = await sending;
  assert.ok(outcome instanceof RpcError);
  assert.deepEqual(outcome.data, { code: "cancelled" });
  await until(() => f.lines(), lines => lines.includes("notifications/cancelled"), "服务器收到取消");
});

test("服务器的工具列表变了，下一次请求声明新的工具；进程退出后标为断开，重新连接后恢复", async t => {
  const f = await fixture(t);
  await f.client().call("mcp.add", { config: JSON.stringify({ mcpServers: { local: f.stdio({}, { askBeforeCall: false }) } }) });
  await state(f, "local", "connected");
  const session = await f.client().call("session.create", {});
  f.respond(fauxToolCall("mcp__local__add_tool", {}), "加好了");
  await f.client().call("session.send", { sessionId: session.id, text: "加一个工具" });
  await until(() => f.client().call("mcp.list", {}), list => server(list, "local").tools.length === 7, "新工具出现");
  f.respond("看到了");
  await f.client().call("session.send", { sessionId: session.id, text: "现在呢" });
  assert.ok(declared(f.requests[2]).includes("mcp__local__added_6"));

  f.respond(fauxToolCall("mcp__local__crash", {}), "断了");
  await f.client().call("session.send", { sessionId: session.id, text: "退出" });
  const lost = server(await state(f, "local", "failed"), "local");
  assert.equal(lost.reason?.code, "mcp_disconnected");
  assert.deepEqual(lost.tools, []);
  f.respond("没有工具了");
  await f.client().call("session.send", { sessionId: session.id, text: "还在吗" });
  assert.ok(!declared(f.requests.at(-1)).some(name => name.startsWith("mcp__")));
  await f.client().call("mcp.reconnect", { name: "local" });
  await state(f, "local", "connected");
  assert.equal((await f.starts()).length, 2);
});

test("停用、删除服务器时进程结束、工具撤下，启用后重新连接，不必重启后端", async t => {
  const f = await fixture(t);
  await f.client().call("mcp.add", { config: JSON.stringify({ mcpServers: { local: f.stdio() } }) });
  await state(f, "local", "connected");
  const [first] = await f.starts();
  const disabled = await f.client().call("mcp.set", { name: "local", enabled: false });
  assert.deepEqual(server(disabled, "local"), { ...server(disabled, "local"), state: "disabled", enabled: false, tools: [] });
  assert.equal(alive(first ?? 0), false);
  const session = await f.client().call("session.create", {});
  f.respond("没有工具");
  await f.client().call("session.send", { sessionId: session.id, text: "你好" });
  assert.ok(!declared(f.requests[0]).some(name => name.startsWith("mcp__")));
  await f.client().call("mcp.set", { name: "local", enabled: true });
  await state(f, "local", "connected");
  const [, second] = await f.starts();
  assert.deepEqual(await f.client().call("mcp.remove", { name: "local" }), []);
  assert.equal(alive(second ?? 0), false);
  await assert.rejects(f.client().call("mcp.remove", { name: "local" }), (error: unknown) => error instanceof RpcError && (error.data as { code: string }).code === "mcp_server_not_found");
});

test("上限：工具超过上限的服务器标为失败，过长的说明截断，超过服务器数上限的按次序标为失败", async t => {
  const f = await fixture(t);
  const servers: Record<string, object> = {
    many: f.stdio({ MCP_EXTRA_TOOLS: String(MAX_TOOLS) }),
    long: f.stdio({ MCP_LONG_DESCRIPTION: String(MAX_DESCRIPTION * 3) }, { askBeforeCall: false }),
  };
  for (let index = 0; index < MAX_SERVERS - 1; index += 1) servers[`s${index}`] = f.stdio();
  await f.client().call("mcp.add", { config: JSON.stringify({ mcpServers: servers }) });
  const list = await until(() => f.client().call("mcp.list", {}), items => items.every(item => item.state !== "connecting"), "全部连完");
  assert.equal(server(list, "many").reason?.code, "mcp_too_many_tools");
  assert.equal(server(list, "long").state, "connected");
  const last = `s${MAX_SERVERS - 2}`;
  assert.equal(server(list, last).reason?.code, "mcp_too_many_servers");
  assert.equal(list.filter(item => item.state === "connected").length, MAX_SERVERS - 1);
  assert.equal((await f.starts()).length, MAX_SERVERS);
  const session = await f.client().call("session.create", {});
  f.respond("好");
  await f.client().call("session.send", { sessionId: session.id, text: "你好" });
  assert.ok(f.requests[0]);
  const echo = getCurrentTools(f.requests[0].messages).find(tool => tool.name === "mcp__long__echo");
  assert.equal(echo?.description.length, MAX_DESCRIPTION);
});

test("没有配置服务器时不起进程、不建 mcp.json，请求里没有 MCP 工具；写坏的 mcp.json 如实报错，不被覆盖", async t => {
  const f = await fixture(t);
  const session = await f.client().call("session.create", {});
  f.respond("好");
  await f.client().call("session.send", { sessionId: session.id, text: "你好" });
  assert.ok(!declared(f.requests[0]).some(name => name.startsWith("mcp__")));
  assert.deepEqual(await f.lines(), []);
  await assert.rejects(readFile(path.join(f.home, "mcp.json")), { code: "ENOENT" });
  await writeFile(path.join(f.home, "mcp.json"), "{ 写坏了");
  const broken = (error: unknown) => error instanceof RpcError && (error.data as { code: string }).code === "mcp_config_invalid";
  await assert.rejects(f.client().call("mcp.list", {}), broken);
  await assert.rejects(f.client().call("mcp.add", { config: JSON.stringify({ mcpServers: { local: f.stdio() } }) }), broken);
  assert.equal(await readFile(path.join(f.home, "mcp.json"), "utf8"), "{ 写坏了");
});
