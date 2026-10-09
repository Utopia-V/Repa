import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxProvider, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InstalledContributions } from "../src/agent/contributions.js";
import type { BundledPluginRegistration } from "../src/plugins/schema.js";
import type { ContentRef, SessionKey, SettingScope } from "../src/protocol.js";
import { RepaClient, RpcError } from "../src/client.js";
import { startRepaServer } from "../src/server.js";

const application = { kind: "application" as const };
const fault = (expected: string) => (error: unknown) => error instanceof RpcError &&
  error.data !== null && typeof error.data === "object" && "code" in error.data && error.data.code === expected;
function gate() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>(ready => { resolve = ready; });
  return { promise, release() { assert(resolve); resolve(); } };
}
type Pause = { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> };
type Control = { loading?: Pause; preview?: Pause };
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= deadline) assert.fail(`安装级贡献状态超时：${JSON.stringify(value)}`);
    await delay(10);
  }
}
async function setting(client: RepaClient, scope: SettingScope, key: string, value: unknown) {
  const view = await client.call("settings.get", { scope, namespace: "plugins" });
  const entry = view.entries.find(item => item.key === key);
  assert(entry);
  return client.call("settings.set", { scope, namespace: "plugins", key, value, base: entry.revision });
}
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map(part => part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "").join("\n");
}
const background = (context: TranscriptContext) => context.messages.map(message => textOf(message.content)).filter(text => text.includes("<installed_fixture>"));
function assertBackground(context: TranscriptContext, pattern: RegExp) {
  const last = background(context).at(-1);
  assert(last);
  assert.match(last, pattern);
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-installation-api-"));
  const agentDir = path.join(root, "agent"), appDirectory = path.join(root, "app");
  await mkdir(agentDir);
  await mkdir(appDirectory);
  const controls: Control[] = [];
  const globals: symbol[] = [];
  const faux = fauxProvider({ api: `installed-${randomUUID()}`, provider: `installed-${randomUUID()}`,
    models: [{ id: "test", reasoning: false, input: ["text"], contextWindow: 16384, maxTokens: 512 }], tokensPerSecond: 0 });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "test-auth.json"), modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  let bundledPackages: (() => readonly BundledPluginRegistration[]) | undefined;
  let server: Awaited<ReturnType<typeof startRepaServer>> | undefined;
  let client: RepaClient | undefined;
  t.after(async () => {
    for (const control of controls) { control.loading?.release.release(); control.preview?.release.release(); }
    try { await server?.close("cancel"); await client?.close(); }
    finally { for (const key of globals) Reflect.deleteProperty(globalThis, key); await rm(root, { recursive: true, force: true }); }
  });
  async function makePackage(label: string) {
    const directory = path.join(root, "packages", label);
    await mkdir(directory, { recursive: true });
    const marker = path.join(root, `${label}-events.txt`);
    const key = `repa-installation-fixture-${randomUUID()}`;
    const control: Control = {};
    controls.push(control);
    const symbol = Symbol.for(key);
    globals.push(symbol);
    Object.defineProperty(globalThis, symbol, { configurable: true, value: control });
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: `fixture-${label}`, version: "1.0.0", type: "module",
      repa: { manifestVersion: 1, backend: { entry: "./backend.js", api: "^1.0.0" }, contributions: { entry: "./contributions.js", api: "^1.0.0" } } }));
    await writeFile(path.join(directory, "shared.js"), `
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Type } from ${JSON.stringify(import.meta.resolve("typebox"))};
import { Check } from ${JSON.stringify(import.meta.resolve("typebox/value"))};
import { object, ContentRefSchema, ContentChangeResultSchema } from ${JSON.stringify(import.meta.resolve("repa/protocol"))};
export { object, ContentChangeResultSchema };
export const control = globalThis[Symbol.for(${JSON.stringify(key)})] ?? {};
export const track = name => appendFileSync(${JSON.stringify(marker)}, name + "\\n");
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const inputSchema = object({});
export const bindSchema = object({ ref: ContentRefSchema, operationId: Type.String() });
export const viewSchema = object({ ref: Type.Union([Type.Null(), ContentRefSchema]), text: Type.String(), revision: Type.String() });
export const format = {
 id: "installed-fixture", field: "installedFixture", default: null, schema: Type.Union([Type.Null(), ContentRefSchema]),
 references(value) { track("references"); return Check(ContentRefSchema,value) ? [value] : []; },
 files(value) { track("files"); return Check(ContentRefSchema,value) ? [value] : []; },
 remapMetadata(value,mapping) { track("remapMetadata"); return value === null ? null : {...value,spaceId:value.spaceId === mapping.fromSpace ? mapping.toSpace : value.spaceId,id:mapping.ids.get(value.id) ?? value.id}; },
 remapFile(bytes) { track("remapFile"); return bytes; },
};
export async function view(content) {
 return content.observe(async scope => {
  const ref = scope.metadata(format.field);
  const text = ref ? new TextDecoder("utf-8",{fatal:true}).decode((await scope.read(ref)).bytes) : "";
  return {ref,text:${JSON.stringify(label)} + ":" + text,revision:hash({ref,text})};
 });
}
export function prepared(value) {
 return {message:{role:"custom",customType:"fixture.installed-background",content:"<installed_fixture>\\n" + value.text + "\\n</installed_fixture>",details:value,display:false,timestamp:Date.now()},revision:value.revision,text:value.text};
}
`);
    await writeFile(path.join(directory, "contributions.js"), `
import {track,control,format,view,prepared} from "./shared.js";
track("contributions-import");
if (control.loading) { control.loading.entered.release(); await control.loading.release.promise; }
export default {formats:[format],backgrounds:[{
 codec:{id:"installedFixture",customType:"fixture.installed-background",snapshot(message){track("codec");return message.role === "custom" && message.customType === this.customType ? message.details : undefined;}},
 selection:{contract:{id:"fixture.installed.view",version:"1"},implementationId:"local"},input:{},prepare:prepared,
 preview:{implementationId:"local",async read(content){track("preview");if(control.preview){control.preview.entered.release();await control.preview.release.promise;}return prepared(await view(content));}}
}]};
`);
    await writeFile(path.join(directory, "backend.js"), `
import {track,view,inputSchema,viewSchema,bindSchema,ContentChangeResultSchema} from "./shared.js";
import {canonicalJson,digest} from ${JSON.stringify(import.meta.resolve("repa/plugin"))};
track("backend-import");
export default function(){track("factory");return {capabilities:[
 {contract:{id:"fixture.installed.view",version:"1"},implementationId:"local",inputSchema,outputSchema:viewSchema,scopes:["space"],execution:"query",async invoke(input,context){track("query");return view(context.content);}},
 {contract:{id:"fixture.installed.bind",version:"1"},implementationId:"local",inputSchema:bindSchema,outputSchema:ContentChangeResultSchema,scopes:["space"],execution:"inline",async invoke(input,context){const previous=await context.content.observe(async scope=>scope.metadata("installedFixture"));return context.content.setMetadata({field:"installedFixture",value:input.ref,base:digest(canonicalJson(previous)),operationId:input.operationId,request:input});}}
]};}
`);
    async function events() {
      try { return (await readFile(marker, "utf8")).split("\n").filter(Boolean); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    }
    const selection = { kind: "source" as const, source: directory, scope: "user" as const };
    return { directory, selection, control, events };
  }
  async function packages(directories: string[]) {
    await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: directories,
      extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"], retry: { enabled: false }, compaction: { enabled: false } }));
  }
  async function seed(name: string, selection?: Awaited<ReturnType<typeof makePackage>>["selection"]) {
    const directory = path.join(root, name);
    await mkdir(path.join(directory, ".repa"), { recursive: true });
    await mkdir(path.join(directory, ".git"));
    if (selection) await writeFile(path.join(directory, ".repa/settings.json"), JSON.stringify({ format: "repa.settings", version: 2,
      namespaces: { plugins: { backends: { revision: randomUUID(), value: [{ id: "installed", package: selection }] } } } }));
    return directory;
  }
  async function start() {
    server = await startRepaServer({ agentDir, appDirectory, diagnostics: { level: "off" },
      ...(bundledPackages ? { bundledPackages } : {}), modelOverride: { modelRuntime, model: faux.getModel() } });
    client = await RepaClient.connect(server.connection);
  }
  function rpc() { assert(client); return client; }
  async function stop() { assert(server); await server.close("cancel"); await rpc().close(); server = undefined; client = undefined; }
  async function reopen() { await stop(); await start(); }
  async function document(spaceId: string, name: string, text: string): Promise<ContentRef> {
    await rpc().call("content.write", { target: { kind: "file", spaceId, location: { kind: "relative", path: name } },
      value: { kind: "text", text }, base: { kind: "absent" }, operationId: randomUUID() });
    const result = await rpc().call("content.associate", { spaceId, location: { kind: "relative", path: name }, role: "document", operationId: randomUUID() });
    const ref = result.contents[0]?.ref;
    assert(ref);
    return ref;
  }
  async function bind(ref: ContentRef) {
    return rpc().call("capability.invoke", { scope: { kind: "space", spaceId: ref.spaceId }, requestId: randomUUID(),
      contract: { id: "fixture.installed.bind", version: "1" }, input: { ref, operationId: randomUUID() } });
  }
  async function send(key: SessionKey, inspect: (context: TranscriptContext) => void) {
    faux.setResponses([context => { inspect(context); return fauxAssistantMessage("fixture完成"); }]);
    const request = await rpc().call("session.submit", { target: key, requestId: randomUUID(), input: { parts: [{ kind: "text", text: "接续固定材料" }] }, dispatch: { kind: "start" } });
    const runId = request.runId;
    assert(runId);
    const run = await until(() => rpc().call("run.get", { spaceId: key.spaceId, runId }), value => ["completed", "failed", "cancelled", "interrupted"].includes(value.status));
    assert.equal(run.status, "completed");
  }
  return { root, agentDir, appDirectory, makePackage, packages, seed, start, reopen, stop, document, bind, send,
    bundle(read: () => readonly BundledPluginRegistration[]) { bundledPackages = read; },
    get client() { return rpc(); } };
}

const count = (events: string[], name: string) => events.filter(value => value === name).length;

test("真实包发现不导入，首次静态预览不跑factory，禁用保留历史codec与复制并重开接续", async t => {
  const f = await fixture(t);
  const installed = await f.makePackage("Alpha"), untrusted = await f.makePackage("Untrusted"), unconfigured = await f.makePackage("Unconfigured");
  await f.packages([installed.directory, untrusted.directory, unconfigured.directory]);
  const directory = await f.seed("space", installed.selection);
  const untrustedDirectory = await f.seed("untrusted", untrusted.selection);
  await f.start();
  const catalog = await f.client.call("package.list", { scope: application });
  assert(catalog.some(item => item.name === "fixture-Alpha" && item.contributions?.status === "ready"));
  assert.deepEqual(await installed.events(), []);
  assert.deepEqual(await untrusted.events(), []);
  assert.deepEqual(await unconfigured.events(), []);
  await setting(f.client, application, "trusted", [installed.selection, unconfigured.selection]);
  await f.client.call("space.open", { path: untrustedDirectory });
  assert.deepEqual(await untrusted.events(), []);
  const space = await f.client.call("space.open", { path: directory });
  assert.equal(count(await installed.events(), "contributions-import"), 1);
  const session = await f.client.call("session.create", { spaceId: space.id });
  const key = { spaceId: space.id, sessionId: session.sessionId };
  const first = await f.client.call("prompts.preview", key);
  assert.equal(first.prompt.sources.find(source => source.id === "installedFixture")?.content, "Alpha:");
  assert.equal(count(await installed.events(), "factory"), 0);
  assert.equal(count(await installed.events(), "backend-import"), 0);
  const ref = await f.document(space.id, "story.txt", "海底城。🪸\r\n");
  await f.bind(ref);
  await setting(f.client, { kind: "space", spaceId: space.id }, "implementations", { "fixture.installed.view": "local" });
  await f.send(key, context => assertBackground(context, /Alpha:海底城。🪸/u));
  await setting(f.client, { kind: "space", spaceId: space.id }, "disabled", ["installed"]);
  await f.send(key, context => assert.deepEqual(background(context), []));
  const history = await f.client.call("session.history", key);
  assert(history.messages.some(message => textOf(message.content).includes("Alpha:海底城。🪸")));
  const factories = count(await installed.events(), "factory");
  const copy = await f.client.call("space.copy", { spaceId: space.id, destination: path.join(f.root, "copy"), operationId: randomUUID() });
  assert.equal(copy.status, "completed", copy.error?.message);
  const copied = await f.client.call("space.open", { path: copy.destination });
  const stored = JSON.parse(await readFile(path.join(copied.path, ".repa/content/catalog.json"), "utf8"));
  assert.deepEqual(stored.installedFixture, { ...ref, spaceId: copied.id });
  assert(count(await installed.events(), "remapMetadata") > 0);
  assert(count(await installed.events(), "remapFile") > 0);
  await f.reopen();
  await f.client.call("space.open", { path: directory });
  const disabled = await f.client.call("prompts.preview", key);
  assert.equal(disabled.prompt.sources.find(source => source.id === "installedFixture")?.enabled, false);
  assert.equal(count(await installed.events(), "factory"), factories);
  await setting(f.client, { kind: "space", spaceId: space.id }, "disabled", []);
  assert.equal((await f.client.call("prompts.preview", key)).prompt.sources.find(source => source.id === "installedFixture")?.content, "Alpha:海底城。🪸\r\n");
  await f.send(key, context => assertBackground(context, /Alpha:海底城。🪸/u));
  assert.deepEqual(await unconfigured.events(), []);
  assert.deepEqual(await untrusted.events(), []);
});

test("两个空间声明来源独立，撤销一个包信任封锁旧owner而保留raw读取和另一空间", async t => {
  const f = await fixture(t);
  const alpha = await f.makePackage("Alpha"), beta = await f.makePackage("Beta");
  await f.packages([alpha.directory, beta.directory]);
  const da = await f.seed("alpha", alpha.selection), db = await f.seed("beta", beta.selection);
  await f.start();
  await setting(f.client, application, "trusted", [alpha.selection, beta.selection]);
  const sa = await f.client.call("space.open", { path: da }), sb = await f.client.call("space.open", { path: db });
  const ka = { spaceId: sa.id, sessionId: (await f.client.call("session.create", { spaceId: sa.id })).sessionId };
  const kb = { spaceId: sb.id, sessionId: (await f.client.call("session.create", { spaceId: sb.id })).sessionId };
  const ra = await f.document(sa.id, "story.txt", "甲空间原文\n"), rb = await f.document(sb.id, "story.txt", "乙空间原文\n");
  await f.bind(ra); await f.bind(rb);
  assert.equal((await f.client.call("prompts.preview", ka)).prompt.sources.find(source => source.id === "installedFixture")?.content, "Alpha:甲空间原文\n");
  assert.equal((await f.client.call("prompts.preview", kb)).prompt.sources.find(source => source.id === "installedFixture")?.content, "Beta:乙空间原文\n");
  await setting(f.client, application, "trusted", [beta.selection]);
  const before = await alpha.events();
  const base = (await f.client.call("content.get", { target: { kind: "content", ref: ra } })).revision;
  assert(base);
  await assert.rejects(f.client.call("prompts.preview", ka), fault("plugin_restart_required"));
  await assert.rejects(f.client.call("capability.invoke", { scope: { kind: "space", spaceId: sa.id }, requestId: randomUUID(),
    contract: { id: "fixture.installed.view", version: "1" }, input: {} }), fault("plugin_restart_required"));
  await assert.rejects(f.client.call("content.copy", { target: { kind: "content", ref: ra },
    destination: { kind: "relative", path: "rejected.txt" }, base, operationId: randomUUID() }), fault("plugin_restart_required"));
  assert.equal((await f.client.call("content.read", { target: { kind: "content", ref: ra } })).text, "甲空间原文\n");
  assert.deepEqual(await alpha.events(), before);
  assert.equal((await f.client.call("prompts.preview", kb)).prompt.sources.find(source => source.id === "installedFixture")?.content, "Beta:乙空间原文\n");
  await f.reopen();
  await f.client.call("space.open", { path: da });
  assert.equal((await f.client.call("content.read", { target: { kind: "content", ref: ra } })).text, "甲空间原文\n");
  assert.equal((await f.client.call("prompts.preview", ka)).prompt.sources.some(source => source.id === "installedFixture"), false);
  assert.deepEqual(await alpha.events(), before);
});

test("bundle函数换真实目录要求重启，旧声明不继续执行，新应用从新来源读取既有数据", async t => {
  const f = await fixture(t);
  const alpha = await f.makePackage("Alpha"), beta = await f.makePackage("Beta");
  await f.packages([]);
  let directory = alpha.directory;
  f.bundle(() => [{ id: "installed", directory, enabled: true }]);
  const ds = await f.seed("space");
  await f.start();
  const space = await f.client.call("space.open", { path: ds });
  const key = { spaceId: space.id, sessionId: (await f.client.call("session.create", { spaceId: space.id })).sessionId };
  const ref = await f.document(space.id, "story.txt", "不覆盖的原始材料\n");
  await f.bind(ref);
  directory = beta.directory;
  await setting(f.client, { kind: "space", spaceId: space.id }, "disabled", []);
  const before = await alpha.events();
  await assert.rejects(f.client.call("prompts.preview", key), fault("plugin_restart_required"));
  assert.deepEqual(await alpha.events(), before);
  assert.deepEqual(await beta.events(), []);
  await f.reopen();
  await f.client.call("space.open", { path: ds });
  assert.equal((await f.client.call("prompts.preview", key)).prompt.sources.find(source => source.id === "installedFixture")?.content, "Beta:不覆盖的原始材料\n");
  assert.equal(count(await beta.events(), "factory"), 0);
  assert.equal(count(await beta.events(), "contributions-import"), 1);
});

test("首次声明异步导入与撤信任共用受理顺序，不在撤权完成后发布旧可用声明", async t => {
  const f = await fixture(t);
  const alpha = await f.makePackage("Alpha");
  await f.packages([alpha.directory]);
  const directory = await f.seed("space", alpha.selection);
  await f.start();
  await setting(f.client, application, "trusted", [alpha.selection]);
  const entry = (await f.client.call("settings.get", { scope: application, namespace: "plugins" })).entries.find(value => value.key === "trusted");
  assert(entry);
  alpha.control.loading = { entered: gate(), release: gate() };
  const opened = f.client.call("space.open", { path: directory });
  await alpha.control.loading.entered.promise;
  const revoked = f.client.call("settings.set", { scope: application, namespace: "plugins", key: "trusted", value: [], base: entry.revision });
  const during = await f.client.call("settings.get", { scope: application, namespace: "plugins" });
  assert.deepEqual(during.entries.find(value => value.key === "trusted")?.effective, [alpha.selection]);
  alpha.control.loading.release.release();
  const space = await opened;
  await revoked;
  const key = { spaceId: space.id, sessionId: (await f.client.call("session.create", { spaceId: space.id })).sessionId };
  const before = await alpha.events();
  await assert.rejects(f.client.call("prompts.preview", key), fault("plugin_restart_required"));
  assert.deepEqual(await alpha.events(), before);
  assert.equal(count(before, "factory"), 0);
});

test("异步静态预览在撤权时收尾，不把旧声明的晚结果作为成功返回", async t => {
  const f = await fixture(t);
  const alpha = await f.makePackage("Alpha");
  await f.packages([alpha.directory]);
  const directory = await f.seed("space", alpha.selection);
  await f.start();
  await setting(f.client, application, "trusted", [alpha.selection]);
  const space = await f.client.call("space.open", { path: directory });
  const key = { spaceId: space.id, sessionId: (await f.client.call("session.create", { spaceId: space.id })).sessionId };
  await f.bind(await f.document(space.id, "story.txt", "撤权前原文\n"));
  const invalidated = gate();
  const originalInvalidate = InstalledContributions.prototype.invalidate;
  // 透明观察实际后端所用对象的失效点，不以设置文件已rename推断受理已完成。
  t.mock.method(InstalledContributions.prototype, "invalidate", function (this: InstalledContributions) {
    originalInvalidate.call(this);
    if (this.formats.some(format => format.id === "installed-fixture")) invalidated.release();
  });
  alpha.control.preview = { entered: gate(), release: gate() };
  const preview = f.client.call("prompts.preview", key);
  const rejected = assert.rejects(preview, fault("plugin_restart_required"));
  await alpha.control.preview.entered.promise;
  const revoked = setting(f.client, application, "trusted", []);
  await invalidated.promise;
  alpha.control.preview.release.release();
  await rejected;
  await revoked;
  const before = await alpha.events();
  await assert.rejects(f.client.call("prompts.preview", key), fault("plugin_restart_required"));
  assert.deepEqual(await alpha.events(), before);
});

test("关闭后的独立Node进程从真实安装包加载disabled格式并复制既有绑定，不执行backend", async t => {
  const f = await fixture(t);
  const alpha = await f.makePackage("Alpha");
  await f.packages([alpha.directory]);
  const directory = await f.seed("space", alpha.selection);
  await f.start();
  await setting(f.client, application, "trusted", [alpha.selection]);
  const space = await f.client.call("space.open", { path: directory });
  const key = { spaceId: space.id, sessionId: (await f.client.call("session.create", { spaceId: space.id })).sessionId };
  const ref = await f.document(space.id, "story.txt", "跨进程固定原文\r\n");
  await f.bind(ref);
  await setting(f.client, { kind: "space", spaceId: space.id }, "disabled", ["installed"]);
  await f.stop();
  const before = await alpha.events();
  const child = spawn(process.execPath, ["--input-type=module"], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", value => { stdout += value; });
  child.stderr.setEncoding("utf8").on("data", value => { stderr += value; });
  const ended = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`独立后端退出：${code}/${signal}\n${stderr}`)));
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 10000);
  deadline.unref();
  t.after(async () => { clearTimeout(deadline); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await ended; });
  child.stdin.end(`
import {startRepaServer} from ${JSON.stringify(import.meta.resolve("repa"))};
import {RepaClient} from ${JSON.stringify(import.meta.resolve("repa/client"))};
const server=await startRepaServer(${JSON.stringify({ agentDir: f.agentDir, appDirectory: f.appDirectory, diagnostics: { level: "off" } })});
const client=await RepaClient.connect(server.connection);
try {
 const space=await client.call("space.open",{path:${JSON.stringify(directory)}});
 const preview=await client.call("prompts.preview",${JSON.stringify(key)});
 const read=await client.call("content.read",{target:{kind:"content",ref:${JSON.stringify(ref)}}});
 const copy=await client.call("space.copy",{spaceId:space.id,destination:${JSON.stringify(path.join(f.root, "child-copy"))},operationId:${JSON.stringify(randomUUID())}});
 process.stdout.write(JSON.stringify({spaceId:space.id,text:read.text,backgroundEnabled:preview.prompt.sources.find(source=>source.id==="installedFixture")?.enabled,copy}));
} finally {await server.close("cancel");await client.close();}
`);
  await ended;
  clearTimeout(deadline);
  const result: { spaceId: string; text: string; backgroundEnabled: boolean; copy: { status: string; destination: string; spaceId: string } } = JSON.parse(stdout);
  assert.equal(result.spaceId, space.id);
  assert.equal(result.text, "跨进程固定原文\r\n");
  assert.equal(result.backgroundEnabled, false);
  assert.equal(result.copy.status, "completed");
  const copied = JSON.parse(await readFile(path.join(result.copy.destination, ".repa/content/catalog.json"), "utf8"));
  assert.deepEqual(copied.installedFixture, { ...ref, spaceId: result.copy.spaceId });
  const after = await alpha.events();
  assert.equal(count(after, "contributions-import"), count(before, "contributions-import") + 1);
  assert.equal(count(after, "factory"), count(before, "factory"));
  assert.equal(count(after, "backend-import"), count(before, "backend-import"));
});
