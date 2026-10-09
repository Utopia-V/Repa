import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { RepaClient, RpcError, type ClientConnection } from "repa/client";

const fault = (error: unknown) => error instanceof RpcError && error.data !== null &&
  typeof error.data === "object" && "code" in error.data && error.data.code === "plugin_restart_required";
function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时，不能当作成功`)), 12000);
  })]).finally(() => clearTimeout(timer));
}
function message(child: ChildProcess, type: string): Promise<Record<string, unknown>> {
  return deadline(new Promise((resolve, reject) => {
    const cleanup = () => { child.off("message", onMessage); child.off("exit", onExit); child.off("error", onError); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onExit = () => { cleanup(); reject(new Error("子后端在IPC回应前退出")); };
    const onMessage = (value: unknown) => {
      if (!value || typeof value !== "object" || !("type" in value)) return;
      if (value.type === "error") { cleanup(); reject(new Error("子后端报告启动或控制错误")); }
      else if (value.type === type) { cleanup(); resolve(value as Record<string, unknown>); }
    };
    child.on("message", onMessage); child.once("exit", onExit); child.once("error", onError);
  }), `子后端${type}`);
}
function send(child: ChildProcess, value: { type: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    child.send(value, error => error ? reject(error) : resolve());
  });
}

test("动态贡献的传递依赖仅全新Node进程重载，真实包prepare撤权且raw正文继续可读", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-installation-process-"));
  const hosts: Host[] = [];
  t.after(async () => { try { for (const host of hosts) await stop(host); } finally { await rm(root, { recursive: true, force: true }); } });
  const directory = path.join(root, "space"), agentDir = path.join(root, "agent"), appDirectory = path.join(root, "app");
  const pkg = path.join(root, "package"), marker = path.join(root, "callbacks.txt");
  const controlKey = `installation-process-${randomUUID()}`;
  await Promise.all([mkdir(path.join(directory, ".pi"), { recursive: true }), mkdir(path.join(directory, ".repa"), { recursive: true }),
    mkdir(agentDir), mkdir(appDirectory), mkdir(pkg)]);
  const selection = { kind: "source", source: pkg, scope: "project" };
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [], extensions: ["!**/*"],
    skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"] }));
  await writeFile(path.join(directory, ".pi", "settings.json"), JSON.stringify({ packages: [pkg] }));
  await writeFile(path.join(directory, ".repa", "settings.json"), JSON.stringify({ format: "repa.settings", version: 2,
    namespaces: { plugins: { backends: { revision: "process-backend", value: [{ id: "process-fixture", package: selection }] } } } }));
  await writeFile(path.join(appDirectory, "repa-settings.json"), JSON.stringify({ format: "repa.settings", version: 2,
    namespaces: { plugins: { trusted: { revision: "process-trust", value: [selection] } } } }));
  await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "fixture-installation-process", version: "1.0.0", type: "module",
    repa: { manifestVersion: 1, backend: { entry: "./backend.js", api: "^1" }, contributions: { entry: "./contributions.js", api: "^1" } } }));
  await writeFile(path.join(pkg, "dependency.js"), 'export const version="V1";\n');
  await writeFile(path.join(pkg, "backend.js"), `export default ()=>({capabilities:[{contract:{id:"fixture.process.view",version:"1"},
    implementationId:"local",inputSchema:{type:"object",properties:{},additionalProperties:false},outputSchema:{type:"null"},
    scopes:["space"],execution:"query",invoke(){return null;}}]});`);
  const pluginEntry = import.meta.resolve("repa/plugin");
  await writeFile(path.join(pkg, "contributions.js"), `
import {appendFileSync} from "node:fs";
import {Type} from ${JSON.stringify(pluginEntry)};
import {version} from "./dependency.js";
const log=(kind)=>appendFileSync(${JSON.stringify(marker)},kind+":"+version+"\\n");
log("import");
const prepared=()=>({message:{role:"custom",customType:"process-history",content:version,display:false,details:{version},timestamp:0},revision:version,text:version});
export default {
  backgrounds:[{codec:{id:"processFixture",customType:"process-history",snapshot(){log("snapshot");}},
    selection:{contract:{id:"fixture.process.view",version:"1"},implementationId:"local"},input:{},prepare(){return prepared();},
    preview:{implementationId:"local",async read(){log("preview");await globalThis[Symbol.for(${JSON.stringify(controlKey)})].waitPreview();return prepared();}}}],
  formats:[{id:"process-format",field:"processData",schema:Type.Null(),default:null,
    references(){log("references");return [];},files(){return [];},remapMetadata(value){return value;},remapFile(bytes){return bytes;}}]
};
`);
  type Host = { child: ChildProcess; client?: RepaClient; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; stopped: boolean };
  const stop = async (host: Host) => {
    if (host.stopped) return;
    await host.client?.close();
    try {
      if (host.child.connected) await send(host.child, { type: "stop" });
      const exit = await deadline(host.exited, "子后端退出");
      assert.deepEqual(exit, { code: 0, signal: null });
      host.stopped = true;
    } finally {
      if (!host.stopped) { host.child.kill("SIGKILL"); await deadline(host.exited, "强制回收失败子进程"); host.stopped = true; }
    }
  };
  const start = async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/plugin-installation-host.mjs", import.meta.url)), appDirectory, agentDir, controlKey],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
    const host: Host = { child, exited, stopped: false }; hosts.push(host);
    const ready = await message(child, "ready");
    const connection = ready.connection;
    assert(connection && typeof connection === "object" && "url" in connection && "token" in connection &&
      typeof connection.url === "string" && typeof connection.token === "string");
    const details: ClientConnection = { url: connection.url, token: connection.token };
    const client = await RepaClient.connect(details);
    host.client = client;
    assert.equal(ready.pid, child.pid);
    return { host, client };
  };
  const first = await start();
  const space = await first.client.call("space.open", { path: directory });
  const session = await first.client.call("session.create", { spaceId: space.id });
  const key = { spaceId: space.id, sessionId: session.sessionId };
  const preview = await first.client.call("prompts.preview", key);
  assert.equal(preview.prompt.sources.find(source => source.id === "processFixture")?.content, "V1");
  const target = { kind: "file" as const, spaceId: space.id, location: { kind: "relative" as const, path: "raw.txt" } };
  await first.client.call("content.write", { target, base: { kind: "absent" }, operationId: randomUUID(), value: { kind: "text", text: "原正文\r\n" } });
  assert.match(await readFile(marker, "utf8"), /references:V1/u);
  const blocked = message(first.host.child, "preview-blocked");
  await send(first.host.child, { type: "block-preview" }); await blocked;
  const entered = message(first.host.child, "preview-entered");
  const pendingPreview = first.client.call("prompts.preview", key);
  const rejectedPreview = assert.rejects(pendingPreview, fault);
  await entered;
  // V2由测试改写本地源；SDK更新用来触发prepare政策，不宣称它下载了V2。
  await writeFile(path.join(pkg, "dependency.js"), 'export const version="V2";\n');
  const requestId = randomUUID();
  await first.client.call("package.update", { scope: { kind: "space", spaceId: space.id }, requestId, source: pkg });
  const end = Date.now() + 8000;
  // 新预览会在admission排队直到旧工作排空，不能先await它再release旧屏障。
  const rejectedNewPreview = assert.rejects(first.client.call("prompts.preview", key), fault);
  const atRevocation = await readFile(marker, "utf8");
  await assert.rejects(first.client.call("content.write", { target: { ...target, location: { kind: "relative", path: "blocked.txt" } },
    base: { kind: "absent" }, operationId: randomUUID(), value: { kind: "text", text: "不应保存" } }), fault);
  await assert.rejects(readFile(path.join(directory, "blocked.txt")), { code: "ENOENT" });
  assert.equal((await first.client.readText(target)).text, "原正文\r\n");
  assert.equal(await readFile(marker, "utf8"), atRevocation, "撤权后不再运行旧preview/format回调");
  const inPreparation = await first.client.call("request.get", { spaceId: space.id, requestId });
  assert.equal(inPreparation.status, "running", "屏障确保真实package.prepare尚未收尾");
  const released = message(first.host.child, "preview-released");
  await send(first.host.child, { type: "release-preview" }); await released; await Promise.all([rejectedPreview, rejectedNewPreview]);
  let finished: Awaited<ReturnType<typeof first.client.call<"request.get">>> | undefined;
  while (Date.now() < end) {
    const request = await first.client.call("request.get", { spaceId: space.id, requestId });
    if (["completed", "failed", "cancelled", "interrupted"].includes(request.status)) { finished = request; break; }
    await delay(10);
  }
  assert(finished);
  assert.equal(finished.status, "completed", JSON.stringify(finished));
  assert("operation" in finished && finished.result?.value.kind === "inline");
  const result = finished.result.value.data;
  assert(result && typeof result === "object" && "restartRequired" in result && result.restartRequired === true);
  assert.equal((await first.client.readText(target)).text, "原正文\r\n");
  assert.equal(await readFile(marker, "utf8"), atRevocation, "SDK操作完成后也不重新运行旧贡献");
  assert.equal((await readFile(marker, "utf8")).includes(":V2"), false);
  await stop(first.host);
  const second = await start();
  assert.notEqual(second.host.child.pid, first.host.child.pid);
  assert.equal((await second.client.call("space.open", { path: directory })).id, space.id);
  const restored = await second.client.call("prompts.preview", key);
  assert.equal(restored.prompt.sources.find(source => source.id === "processFixture")?.content, "V2");
  const callbacks = await readFile(marker, "utf8");
  assert.match(callbacks, /import:V2/u);
  assert.match(callbacks, /preview:V2/u);
  assert.equal((await second.client.readText(target)).text, "原正文\r\n");
  await stop(second.host);
});
