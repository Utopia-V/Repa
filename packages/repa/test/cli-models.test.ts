import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { RepaClient } from "../src/client.js";
import { createConfigurationTerminal } from "../src/cli-models.js";
import type { ConnectionInput } from "../src/models/schema.js";
import { isTerminal, type Result } from "../src/protocol.js";
import { startRepaServer, type RepaServer } from "../src/server.js";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const packageDirectory = fileURLToPath(new URL("..", import.meta.url));

async function runCli(t: TestContext, args: string[], input: string, options: { interruptOnPrompt?: boolean } = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", cliPath, ...args], {
    cwd: packageDirectory,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let interrupted = false;
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (options.interruptOnPrompt && !interrupted && /Enter .*API key：/.test(stdout)) {
      interrupted = true;
      child.kill("SIGINT");
    }
  });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  if (options.interruptOnPrompt) child.stdin.write(input);
  else child.stdin.end(input);
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI 配置超时：${stdout}\n${stderr}`));
    }, 10000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve(code); });
  });
  return { code, stdout, stderr };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-cli-models-"));
  const requests: { url: string; authorization?: string }[] = [];
  const providerErrors: unknown[] = [];
  let backend: RepaServer | undefined;
  let client: RepaClient | undefined;
  const provider = createServer((request, response) => {
    void (async () => {
      for await (const _chunk of request) { /* 完整读取真实 SDK 请求。 */ }
      requests.push({ url: request.url ?? "", authorization: request.headers.authorization });
      const chunk = (content: string, finishReason: string | null) => ({
        id: "cli-local", object: "chat.completion.chunk", created: 1, model: "cli-model",
        choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: finishReason }],
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        `data: ${JSON.stringify(chunk("CLI 本地回复", null))}`,
        `data: ${JSON.stringify({ ...chunk("", "stop"), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,
        "data: [DONE]", "",
      ].join("\n\n"));
    })().catch((error: unknown) => {
      providerErrors.push(error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  t.after(async () => {
    try {
      await backend?.close("cancel");
      await client?.close();
    } finally {
      provider.closeAllConnections();
      if (provider.listening)
        await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    }
    assert.deepEqual(providerErrors, [], "本地 provider 不应发生夹具错误");
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("本地 provider 未监听");
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    extensions: [], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"], packages: [],
    retry: { enabled: false }, compaction: { enabled: false },
  }));
  backend = await startRepaServer({ agentDir, appDirectory: path.join(root, "app") });
  client = await RepaClient.connect(backend.connection);
  const connectionFile = path.join(root, "connection.json");
  await writeFile(connectionFile, JSON.stringify({ ...backend.connection, pid: process.pid, agentDir, trustExtensions: false }), { mode: 0o600 });
  const input: ConnectionInput = {
    name: "CLI 本地连接", provider: "openai", authMode: "credentials", baseUrl: `http://127.0.0.1:${address.port}/v1`,
    models: [{
      id: "cli-model", name: "CLI 本地模型", api: "openai-completions", reasoning: false, input: ["text"],
      contextWindow: 8192, maxTokens: 256, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  };
  const configFile = path.join(root, "local-connection.json");
  await writeFile(configFile, JSON.stringify(input));
  return { root, backend, client, connectionFile, configFile, requests };
}

test("configure 子进程保存具名连接与默认模型，常规会话直接使用真实 SDK 凭据发送", async (t) => {
  const f = await fixture(t);
  const configured = await runCli(t, ["configure", "--connect", f.connectionFile, "--connection-config", f.configFile], "1\ncli-local-fake-key\n1\n");
  assert.equal(configured.code, 0, configured.stderr);
  assert.match(configured.stdout, /已设置应用默认模型/);
  assert.equal(configured.stdout.includes("cli-local-fake-key"), false);
  assert.equal(configured.stderr.includes("cli-local-fake-key"), false);
  const connections = await f.client.call("connection.list", {});
  assert.equal(connections.length, 1);
  const connection = connections[0];
  assert(connection);
  assert.equal(connection.authentication.configured, true);
  const defaults = await f.client.call("settings.get", { scope: { kind: "application" }, namespace: "runtime" });
  assert.deepEqual(defaults.entries.find((entry) => entry.key === "model")?.effective, { connectionId: connection.id, id: "cli-model" });
  const reused = await runCli(t, ["configure", "--connect", f.connectionFile], "1\n1\n1\n");
  assert.equal(reused.code, 0, reused.stderr);
  assert.equal((await f.client.call("connection.get", { connectionId: connection.id })).authId, connection.authId);
  const space = await f.client.call("space.open", { path: path.join(f.root, "space") });
  const session = await f.client.call("session.create", { spaceId: space.id });
  const accepted = await f.client.call("session.submit", {
    target: { spaceId: space.id, sessionId: session.sessionId }, requestId: randomUUID(),
    input: { parts: [{ kind: "text", text: "配置后直接发送" }] }, dispatch: { kind: "start" },
  });
  assert(accepted.runId);
  const deadline = Date.now() + 8000;
  for (;;) {
    const run: Result<"run.get"> = await f.client.call("run.get", { spaceId: space.id, runId: accepted.runId });
    assert.notEqual(run.status, "unknown");
    if (run.status !== "unknown" && isTerminal(run)) {
      assert.equal(run.status, "completed", run.error?.message);
      break;
    }
    if (Date.now() > deadline) assert.fail(`CLI 配置后的运行超时：${JSON.stringify(run)}`);
    await delay(10);
  }
  assert.deepEqual(f.requests, [{ url: "/v1/chat/completions", authorization: "Bearer cli-local-fake-key" }]);
  const loggedInAgain = await runCli(t, ["configure", "--connect", f.connectionFile], "1\n2\n1\ncli-replacement-fake-key\n1\n");
  assert.equal(loggedInAgain.code, 0, loggedInAgain.stderr);
  assert.notEqual((await f.client.call("connection.get", { connectionId: connection.id })).authId, connection.authId);
  assert.equal(loggedInAgain.stdout.includes("cli-replacement-fake-key"), false);
});

test("secret 终端输入不回显，也不进入 readline 历史", async (t) => {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  let output = "";
  const sink = Object.assign(new Writable({ write(chunk, _encoding, callback) { output += String(chunk); callback(); } }), { isTTY: true });
  const terminal = createConfigurationTerminal(input, sink);
  t.after(() => { terminal.close(); input.destroy(); sink.destroy(); });
  const secret = terminal.read("API key：", { secret: true });
  input.write("terminal-local-fake-key\r");
  assert.equal(await secret, "terminal-local-fake-key");
  assert.equal(output.includes("terminal-local-fake-key"), false);
  const next = terminal.read("下一步：");
  input.write("\u001b[A\r");
  assert.equal(await next, "");
  assert.equal(output.includes("terminal-local-fake-key"), false);
});

test("配置时输入关闭会等待 auth.cancel 收尾，后端能够完整 drain", async (t) => {
  const f = await fixture(t);
  const cancelled = await runCli(t, ["configure", "--connect", f.connectionFile], "手动连接\nopenai\n\n1\n1\n");
  assert.equal(cancelled.code, 1);
  const connections = await f.client.call("connection.list", {});
  assert.equal(connections[0]?.name, "手动连接");
  assert.equal(connections[0]?.authentication.configured, false);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      f.backend.close("drain"),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("取消后仍有登录阻止后端 drain")), 3000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
});


test("登录提示处收到 SIGINT 会取消 SDK 登录而非直接终止进程", async (t) => {
  const f = await fixture(t);
  const cancelled = await runCli(t, ["configure", "--connect", f.connectionFile, "--connection-config", f.configFile], "1\n", { interruptOnPrompt: true });
  assert.equal(cancelled.code, 1);
  assert.match(cancelled.stderr, /配置已取消/);
  assert.equal((await f.client.call("connection.list", {}))[0]?.authentication.configured, false);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      f.backend.close("drain"),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("SIGINT 后仍有登录阻止后端 drain")), 3000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
});
