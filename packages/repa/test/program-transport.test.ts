import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { RepaFault } from "../src/errors.js";
import { ProgramBridge, type ProgramInvokeParams, type ProgramMethod } from "../src/execution/program.js";
import { runCommand } from "../src/execution/process.js";
import type { ExecutionPolicy } from "../src/execution/schema.js";

const restrictedSkip = process.platform !== "linux" ? "需要 Linux" : !existsSync(new URL("../resources/sandbox/linux-x64/codex-linux-sandbox", import.meta.url)) ? "需要固定 Linux helper" : false;
const restricted: ExecutionPolicy = { mode: "restricted", readPaths: [process.execPath], writePaths: [], network: false };
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-program-test-")));
  const cwd = path.join(root, "workspace");
  const sdk = path.join(root, "program-client.mjs");
  const denied = path.join(root, "private.txt");
  await mkdir(cwd);
  await writeFile(denied, "must-not-read");
  const source = await readFile(new URL("../src/program-client.ts", import.meta.url), "utf8");
  await writeFile(sdk, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const execute = async (code: string, dispatch: (method: ProgramMethod, params: ProgramInvokeParams | undefined, signal: AbortSignal) => Promise<unknown>, options: { policy?: ExecutionPolicy; timeout?: number; signal?: AbortSignal; onExited?(): void } = {}) => {
    const script = path.join(cwd, "main.mjs");
    await writeFile(script, `import { getProgramClient } from ${JSON.stringify(pathToFileURL(sdk).href)};\n${code}`);
    const bridge = new ProgramBridge({ dispatch, signal: options.signal });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const result = await runCommand({
      command: `${quote(process.execPath)} ${quote(script)}`, cwd, policy: options.policy ?? restricted, protectedPaths: [],
      env: { ...process.env, SECRET_PROGRAM_TEST: "host-secret" }, timeout: options.timeout, signal: options.signal,
      program: { env: { REPA_PROGRAM_FD: "3", REPA_PROGRAM_CLIENT: pathToFileURL(sdk).href }, readPaths: [sdk], attach: (stream) => { bridge.attach(stream); }, close: () => bridge.close() },
      onData(stream, bytes) { (stream === "stdout" ? stdout : stderr).push(bytes); }, onExited: options.onExited,
    });
    return { ...result, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
  };
  return { root, cwd, sdk, denied, execute };
}

for (const policy of [restricted, { mode: "full-access" } as const]) {
  test(`${policy.mode} 普通脚本并发调用能力，通过继承管道关联乱序响应后自动退出`, { skip: policy.mode === "restricted" ? restrictedSkip : process.platform !== "linux", timeout: 10000 }, async (t) => {
    const f = await fixture(t);
    let release: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    const calls: unknown[] = [];
    const result = await f.execute(`
const client = getProgramClient();
const results = await Promise.all([
  client.invoke({contract:{id:"fixture",version:"1"},input:"first"}),
  client.invoke({contract:{id:"fixture",version:"1"},implementationId:"choice",input:"second"}),
  client.describe(),
]);
console.log(JSON.stringify(results));
`, async (method, params) => {
      if (method === "describe") return [];
      calls.push(params);
      if (params?.input === "first") await slow;
      else release?.();
      return params?.input;
    }, { policy });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ["first", "second", []]);
    assert.deepEqual(calls, [
      { contract: { id: "fixture", version: "1" }, input: "first" },
      { contract: { id: "fixture", version: "1" }, implementationId: "choice", input: "second" },
    ]);
  });
}

test("受限脚本只获得 SDK 单文件和父命令能力通道，仍拒绝越界读取与创建网络 listener", { skip: restrictedSkip, timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const result = await f.execute(`
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
let denied = false;
try { readFileSync(${JSON.stringify(f.denied)}); } catch { denied = true; }
const network = await new Promise(resolve => {
  const server = createServer();
  server.on("error", () => resolve("denied"));
  server.listen(0,"127.0.0.1", () => { server.close(); resolve("allowed"); });
});
const descriptors = await getProgramClient().describe();
console.log(JSON.stringify({denied, network, secret:process.env.SECRET_PROGRAM_TEST ?? null, descriptors, sdk:process.env.REPA_PROGRAM_CLIENT}));
`, async () => []);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { denied: true, network: "denied", secret: null, descriptors: [], sdk: pathToFileURL(f.sdk).href });
});

test("能力失败保留可处理的产品错误，关闭 SDK 后脚本立即完成", { skip: restrictedSkip, timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const result = await f.execute(`
const client=getProgramClient();
try { await client.invoke({contract:{id:"fixture",version:"1"},input:null}); }
catch(error) { console.log(JSON.stringify({code:error.code,details:error.details})); }
client.close();
`, async () => { throw new RepaFault("fixture_failure", "样本失败。", { reason: "expected" }); });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { code: "fixture_failure", details: { reason: "expected" } });
});

test("初始化但未请求的 SDK 不阻止普通脚本退出", { skip: restrictedSkip, timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const result = await f.execute("getProgramClient(); console.log('done');", async () => []);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, "done\n");
});

for (const kind of ["timeout", "abort", "exit"] as const) {
  test(`父命令 ${kind} 时取消能力调用并等待清理完成后报告退出`, { skip: restrictedSkip, timeout: 10000 }, async (t) => {
    const f = await fixture(t);
    const controller = new AbortController();
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let cancelled: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => { cancelled = resolve; });
    let release: (() => void) | undefined;
    const cleaned = new Promise<void>((resolve) => { release = resolve; });
    const events: string[] = [];
    const code = kind === "exit" ? "getProgramClient().invoke({contract:{id:'fixture',version:'1'},input:null});setTimeout(()=>process.exit(0),200);" : "await getProgramClient().invoke({contract:{id:'fixture',version:'1'},input:null});";
    const running = f.execute(code, async (_method, _params, signal) => {
      entered?.();
      await new Promise<void>((resolve) => { signal.addEventListener("abort", () => { cancelled?.(); resolve(); }, { once: true }); });
      await cleaned;
      events.push("cleaned");
      return null;
    }, { signal: controller.signal, timeout: kind === "timeout" ? 0.5 : undefined, onExited() { events.push("exited"); } });
    const completion = kind === "exit" ? running : assert.rejects(running, kind === "timeout" ? { message: "timeout:0.5" } : { message: "aborted" });
    t.after(async () => { release?.(); controller.abort(); await completion; });
    await started;
    if (kind === "abort") controller.abort();
    await aborted;
    assert.deepEqual(events, []);
    release?.();
    await completion;
    assert.deepEqual(events, ["cleaned", "exited"]);
  });
}

test("坏协议先返回明确错误，再关闭通道且不调用宿主能力", { skip: restrictedSkip, timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  for (const line of ["not-json", JSON.stringify({ id: 1, method: "invoke", params: { scope: { kind: "application" } } })]) {
    const result = await f.execute(`
import { Socket } from "node:net";
const read=new Socket({fd:3,readable:true,writable:false});
const write=new Socket({fd:4,readable:false,writable:true});
read.on('data',data=>{console.log(data.toString());read.destroy();write.destroy();});
write.write(${JSON.stringify(`${line}\n`)});
`, async () => { assert.fail("坏请求不应 dispatch"); });
    assert.equal(result.exitCode, 0, result.stderr);
    const value: unknown = JSON.parse(result.stdout);
    assert(value && typeof value === "object" && "error" in value);
    assert.deepEqual(value.error, { code: "invalid_program_request", message: "程序请求必须符合 describe 或 invoke 协议。" });
  }
});

test("执行准备失败也关闭能力通道且不尝试回退执行", { skip: process.platform !== "linux" }, async () => {
  let closed = 0;
  await assert.rejects(runCommand({
    command: "true", cwd: fileURLToPath(new URL(".", import.meta.url)), policy: { mode: "full-access" }, protectedPaths: [], timeout: 0,
    program: { env: {}, readPaths: [], attach() { assert.fail("不应 attach"); }, async close() { closed++; } }, onData() {},
  }), (error: unknown) => error instanceof RepaFault && error.code === "invalid_execution_timeout");
  assert.equal(closed, 1);
});

test("子进程启动失败时关闭已经连接的能力通道", { skip: process.platform !== "linux" }, async (t) => {
  const f = await fixture(t);
  const events: string[] = [];
  const bridge = new ProgramBridge({ async dispatch() { return []; } });
  await assert.rejects(runCommand({
    command: "true", cwd: path.join(f.root, "missing"), policy: { mode: "full-access" }, protectedPaths: [],
    program: {
      env: { REPA_PROGRAM_FD: "3" }, readPaths: [],
      attach(stream) { events.push("attached"); bridge.attach(stream); },
      async close() { await bridge.close(); events.push("closed"); },
    },
    onData() {},
  }), { code: "ENOENT" });
  assert.equal(events[0], "attached");
  assert(events.slice(1).every((event) => event === "closed"));
  assert(events.includes("closed"));
});
