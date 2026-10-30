import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RepaClient, RpcError } from "../src/client.js";
import { record } from "../src/protocol/json-rpc.js";
import { startRepaProcess } from "../dist/process.js";

async function fixture(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-process-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// 假后端经 NODE_OPTIONS 在真实入口之前预加载，自己完成要模拟的行为；顶层 await 永不结束，cli.js 不会运行。
// 不把脚本直接当作 nodeExecutable：Windows 不能执行带 shebang、没有扩展名的脚本。返回值作为后端的 NODE_OPTIONS。
async function fakeBackend(directory: string, source: string): Promise<string> {
  const file = path.join(directory, "backend.mjs");
  await writeFile(file, `${source}\nsetInterval(() => {}, 1000);\nawait new Promise(() => {});\n`);
  return `--import=${pathToFileURL(file).href}`;
}

const ANNOUNCE = `console.log(JSON.stringify({ url: "ws://127.0.0.1:1", token: "test" }));`;

/** 轮询到条件成立；超过截止时间就报错并停止轮询。 */
async function until(condition: () => Promise<boolean>, message: string, ms = 600_000): Promise<void> {
  const stop = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > stop) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("Node 宿主从 stdout 取得连接并可重复关闭服务", async (t) => {
  const home = await fixture(t);
  const backend = await startRepaProcess({ home });
  t.after(() => backend.close());
  const client = await RepaClient.connect(backend.connection);
  t.after(() => client.close());
  assert.equal(client.connected, true);
  assert.deepEqual(await client.call("space.list", {}), []);
  await Promise.all([backend.close(), backend.close()]);
  await backend.closed;
  assert.equal(client.connected, false);
});

test("Node 宿主传入插件并关掉通用 Agent，前端只能与插件 Agent 建会话", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-process-agents-"));
  let backend: Awaited<ReturnType<typeof startRepaProcess>> | undefined;
  let client: RepaClient | undefined;
  // 先关客户端和服务，再删除目录：服务关闭空间时还要在目录里收尾。
  t.after(async () => {
    await client?.close();
    await backend?.close();
    await rm(directory, { recursive: true, force: true });
  });
  backend = await startRepaProcess({
    home: path.join(directory, "home"),
    plugins: [fileURLToPath(new URL("fixtures/process-plugin", import.meta.url))],
    generalAgent: false,
  });
  client = await RepaClient.connect(backend.connection);
  await client.call("space.create", { root: path.join(directory, "space") });
  assert.deepEqual(await client.call("agent.list", {}), [{ id: "helper", description: "进程测试用的 Agent", direct: true }]);
  await assert.rejects(client.call("session.create", {}), (error: unknown) => {
    assert.ok(error instanceof RpcError);
    assert.equal(record(error.data)?.code, "agent_not_found");
    return true;
  });
  assert.equal((await client.call("session.create", { agent: "helper" })).agent, "helper");
});

test("启动可执行文件不存在时返回错误而不遗留进程", async (t) => {
  const home = await fixture(t);
  await assert.rejects(startRepaProcess({ home, nodeExecutable: path.join(home, "missing") }), { code: "ENOENT" });
});

test("CLI 启动失败交付诊断并完成进程回收", async (t) => {
  const directory = await fixture(t);
  const home = path.join(directory, "not-a-directory");
  await writeFile(home, "原有文件");
  await assert.rejects(startRepaProcess({ home }), /Repa 后端启动失败/);
});

test("启动超时终止尚未交付连接的进程", async (t) => {
  const options = await fakeBackend(await fixture(t), "");
  await assert.rejects(startRepaProcess({
    environment: { ...process.env, NODE_OPTIONS: options },
    startupTimeoutMs: 100,
  }), /启动超时/);
});

test("stdout 不是连接信息时终止错误服务", async (t) => {
  const options = await fakeBackend(await fixture(t), `console.log("not-json");`);
  await assert.rejects(startRepaProcess({ environment: { ...process.env, NODE_OPTIONS: options } }), /无效连接信息/);
});

test("正常关闭结束后端的 stdin，等待超过五秒的真实收尾，不截断服务保存", async (t) => {
  const options = await fakeBackend(await fixture(t), `
    process.stdin.once("end", () => { setTimeout(() => { process.exit(0); }, 5100); });
    process.stdin.resume();
    ${ANNOUNCE}
  `);
  const backend = await startRepaProcess({ environment: { ...process.env, NODE_OPTIONS: options } });
  t.after(() => backend.close());
  await backend.close();
  await backend.closed;
});

test("已启动服务的非零退出通过 closed 与 close 报告失败", async (t) => {
  const options = await fakeBackend(await fixture(t), `
    ${ANNOUNCE}
    setTimeout(() => { process.exit(7); }, 100);
  `);
  const backend = await startRepaProcess({ environment: { ...process.env, NODE_OPTIONS: options } });
  await assert.rejects(backend.closed, /异常退出（7）/);
  await assert.rejects(backend.close(), /异常退出（7）/);
});

test("宿主进程被强行结束时后端的 stdin 随之结束，后端照样收到关闭请求", async (t) => {
  const directory = await fixture(t);
  const marker = path.join(directory, "stdin-ended.txt");
  const options = await fakeBackend(directory, `
    import { writeFileSync } from "node:fs";
    process.stdin.once("end", () => {
      writeFileSync(${JSON.stringify(marker)}, "收尾");
      process.exit(0);
    });
    process.stdin.resume();
    ${ANNOUNCE}
  `);
  const host = spawn(process.execPath, ["--input-type=module", "--eval", `
    import { startRepaProcess } from ${JSON.stringify(new URL("../dist/process.js", import.meta.url).href)};
    await startRepaProcess({ environment: { ...process.env, NODE_OPTIONS: ${JSON.stringify(options)} } });
    console.log("ready");
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(host, "exit");
  t.after(async () => {
    if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
    await exited;
  });
  let stderr = "";
  host.stderr.setEncoding("utf8");
  host.stderr.on("data", (chunk: string) => { stderr += chunk; });
  host.stdout.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    host.stdout.on("data", (chunk: string) => { if (chunk.includes("ready")) resolve(); });
    void exited.then(() => reject(new Error(`宿主在后端就绪前退出\n${stderr}`)));
  });
  host.kill("SIGKILL");
  await exited;
  await until(() => access(marker).then(() => true, () => false), "宿主退出后后端没有收到关闭请求");
});

test("进程入口拒绝源码文件路径并交回构建目录诊断", async (t) => {
  const home = await fixture(t);
  await assert.rejects(startRepaProcess({
    home,
    plugins: [fileURLToPath(new URL("../examples/notes-plugin.ts", import.meta.url))],
  }), /插件路径必须是构建目录/);
});
