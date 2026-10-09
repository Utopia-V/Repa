import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { startLearningServer } from "@repa/learning";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { DefaultPackageManager, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { RepaClient, RpcError } from "../src/client.js";
import type { BackgroundRequest, CapabilityScope, Params, SettingScope } from "../src/protocol.js";
import { startRepaServer } from "../src/server.js";

const application = { kind: "application" as const };
const localOff = { extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"] };
const typeboxUrl = import.meta.resolve("typebox");
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const fault = (code: string) => (error: unknown) => error instanceof RpcError &&
  error.data !== null && typeof error.data === "object" && "code" in error.data && error.data.code === code;

async function until<T>(read: () => T | Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= deadline) assert.fail(`插件接入状态超时：${JSON.stringify(value)}`);
    await delay(10);
  }
}

async function set(client: RepaClient, namespace: string, key: string, value: unknown, scope: SettingScope = application) {
  const view = await client.call("settings.get", { scope, namespace });
  const current = view.entries.find(entry => entry.key === key);
  assert(current);
  return client.call("settings.set", { scope, namespace, key, value, base: current.revision });
}

async function foundation(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-plugin-api-"));
  let close = async () => {};
  t.after(async () => {
    try { await close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  const agentDir = path.join(root, "agent");
  const appDirectory = path.join(root, "app");
  const spaceDirectory = path.join(root, "space");
  await mkdir(agentDir);
  await mkdir(appDirectory);
  await mkdir(path.join(spaceDirectory, ".pi"), { recursive: true });
  await mkdir(path.join(spaceDirectory, ".git"));
  const settings = async (packages: string[]) => writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    ...localOff, packages, retry: { enabled: false }, compaction: { enabled: false },
  }));
  await settings([]);
  const marker = (name: string, event: string) => path.join(root, `${name}-${event}.txt`);
  const makePackage = async (name: string, lifecycle = false) => {
    const directory = path.join(root, "packages", name);
    await mkdir(path.join(directory, "skills", `${name}-skill`), { recursive: true });
    await writeFile(path.join(directory, "package.json"), JSON.stringify({
      name, version: "1.0.0", type: "module",
      pi: { extensions: ["./extension.js"], skills: ["./skills"] },
      repa: { manifestVersion: 1, backend: { entry: "./backend.js", api: "^1.0.0" } },
    }));
    await writeFile(path.join(directory, "skills", `${name}-skill`, "SKILL.md"), `---\nname: ${name}-skill\ndescription: 来自 ${name} 的静态 Skill\n---\n技能正文。\n`);
    await writeFile(path.join(directory, "backend.js"), `
import { appendFileSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { Type } from ${JSON.stringify(typeboxUrl)};
appendFileSync(${JSON.stringify(marker(name, "import"))}, "import\\n");
export default function () {
  appendFileSync(${JSON.stringify(marker(name, "factory"))}, "factory\\n");
  return {
    capabilities: [{
      contract: { id: ${JSON.stringify(`fixture.${name}.echo`)}, version: "1" }, implementationId: "local",
      inputSchema: Type.Object({ text: Type.String() }, { additionalProperties: false }),
      outputSchema: Type.Object({ text: Type.String(), source: Type.String() }, { additionalProperties: false }),
      scopes: ["application", "space"], execution: "inline",
      tool: { name: ${JSON.stringify(`${name.replaceAll("-", "_")}_echo`)}, description: "调用同一插件处理函数" },
      async invoke(input, context) {
        appendFileSync(${JSON.stringify(marker(name, "invoke"))}, JSON.stringify({ text: input.text, source: context.source.kind }) + "\\n");
        if (context.spaceRuntime) await context.spaceRuntime.handle.writeFile(input.text + "\\n");
        return { text: input.text, source: context.source.kind };
      },
    }],
    ${lifecycle ? `
    async openSpace(context) {
      appendFileSync(${JSON.stringify(marker(name, "opened"))}, "open\\n");
      return { handle: await open(path.join(context.dataDirectory, "owned.log"), "a") };
    },
    async closeSpace(runtime) {
      await runtime.handle.close();
      appendFileSync(${JSON.stringify(marker(name, "closed"))}, "close\\n");
    },` : ""}
  };
}
`);
    await writeFile(path.join(directory, "extension.js"), `
import { appendFileSync } from "node:fs";
import { Type } from ${JSON.stringify(typeboxUrl)};
export default function (pi) {
  appendFileSync(${JSON.stringify(marker(name, "extension"))}, "extension\\n");
  pi.registerTool({ name: ${JSON.stringify(`pi_${name.replaceAll("-", "_")}`)}, label: "可信包工具", description: "验证 Pi 包扩展进入真实运行",
    parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "Pi 扩展结果" }] }; } });
}
`);
    return directory;
  };
  return { root, agentDir, appDirectory, spaceDirectory, settings, marker, makePackage, onClose: (callback: () => Promise<void>) => { close = callback; } };
}

function assertResources(context: TranscriptContext, enabled: boolean) {
  const system = getCurrentSystemPrompt(context.messages);
  const tools = getCurrentTools(context.messages).map(tool => tool.name);
  assert.equal(system.includes("trusted-mixed-skill"), enabled);
  assert.equal(tools.includes("trusted_mixed_echo"), enabled);
  assert.equal(tools.includes("pi_trusted_mixed"), enabled);
  assert.equal(tools.includes("learning_context"), enabled);
  assert.equal(system.includes("untrusted-mixed-skill"), false);
  assert.equal(tools.includes("pi_untrusted_mixed"), false);
  assert.equal(tools.includes("project_local"), false);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: unknown) => part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "").join("\n");
}

test("静态预览和真实 Pi 运行沿用明确可信混合包，禁用和恢复同步改变能力及资源", async (t) => {
  const f = await foundation(t);
  const trusted = await f.makePackage("trusted-mixed");
  const untrusted = await f.makePackage("untrusted-mixed");
  await f.settings([trusted, untrusted]);
  const local = path.join(f.spaceDirectory, ".pi", "local.js");
  await writeFile(local, `import { appendFileSync } from "node:fs"; export default function () { appendFileSync(${JSON.stringify(f.marker("project-local", "extension"))}, "loaded\\n"); }`);
  await writeFile(path.join(f.spaceDirectory, ".pi", "settings.json"), JSON.stringify({ extensions: [local] }));
  const faux = fauxProvider({ api: `plugin-api-${randomUUID()}`, provider: `plugin-provider-${randomUUID()}`,
    models: [{ id: "test", reasoning: false, input: ["text"], contextWindow: 16384, maxTokens: 512 }], tokensPerSecond: 0 });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(f.agentDir, "test-auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const server = await startLearningServer({ agentDir: f.agentDir, appDirectory: f.appDirectory, modelOverride: { modelRuntime, model: faux.getModel() } });
  const client = await RepaClient.connect(server.connection);
  f.onClose(async () => { await server.close("cancel"); await client.close(); });
  const space = await client.call("space.open", { path: f.spaceDirectory });
  const session = await client.call("session.create", { spaceId: space.id });
  const key = { spaceId: space.id, sessionId: session.sessionId };
  const scope: CapabilityScope = { kind: "space", spaceId: space.id };
  const selection = { kind: "package", name: "trusted-mixed" };
  await set(client, "plugins", "backends", [{ id: "trusted", package: selection }, { id: "untrusted", package: { kind: "package", name: "untrusted-mixed" } }]);
  await set(client, "plugins", "trusted", [selection]);
  const preview = await client.call("prompts.preview", key);
  assert.match(preview.prompt.system, /trusted-mixed-skill/);
  assert.equal(preview.prompt.system.includes("untrusted-mixed-skill"), false);
  const ToolDefinitionsSchema = Type.Array(Type.Object({ name: Type.String(), description: Type.String(), parameters: Type.Unknown() }));
  const toolDefinitions = preview.prompt.sources.find(source => source.id === "toolDefinitions");
  assert(toolDefinitions?.content);
  const staticTools: unknown = JSON.parse(toolDefinitions.content);
  assert(Check(ToolDefinitionsSchema, staticTools));
  assert(!staticTools.some(tool => tool.name === "learning_context"));
  assert(preview.prompt.sources.some(source => source.id === "capabilityPlugin:repa-learning" && source.dynamic && source.enabled));
  assert(preview.prompt.sources.some(source => source.id === "extensionContributions" && source.enabled && source.dynamic));
  assert(preview.prompt.sources.some(source => source.id === "capabilityPlugin:trusted" && source.enabled && source.dynamic && source.reference === "trusted"));
  assert(!preview.prompt.sources.some(source => source.id === "capabilityPlugin:untrusted"));
  for (const name of ["trusted-mixed", "untrusted-mixed"]) for (const event of ["import", "factory", "extension"])
    assert.equal(existsSync(f.marker(name, event)), false, "预览不能装配运行工厂");
  const described = await client.call("capability.describe", { scope });
  assert(described.capabilities.some(capability => capability.contract.id === "fixture.trusted-mixed.echo"));
  assert(!described.capabilities.some(capability => capability.contract.id === "fixture.untrusted-mixed.echo"));
  assert(described.issues.some(issue => issue.pluginId === "untrusted"));
  assert.equal(existsSync(f.marker("trusted-mixed", "factory")), true);
  assert.equal(existsSync(f.marker("trusted-mixed", "extension")), false);
  const invoked = await client.call("capability.invoke", { scope, requestId: randomUUID(), contract: { id: "fixture.trusted-mixed.echo", version: "1" }, input: { text: "公共调用" } });
  assert.equal(invoked.kind, "inline");
  if (invoked.kind !== "inline") assert.fail("应为短操作结果");
  assert.deepEqual(invoked.result, { text: "公共调用", source: "client" });
  const processingDirectory = path.join(f.spaceDirectory, ".repa", "runtime", "processing");
  const before = await readdir(processingDirectory);
  const send = async (text: string) => {
    const accepted = await client.call("session.submit", { target: key, requestId: randomUUID(), input: { parts: [{ kind: "text", text }] }, dispatch: { kind: "start" } });
    assert(accepted.runId);
    const runId = accepted.runId;
    const run = await until(() => client.call("run.get", { spaceId: space.id, runId }), value => ["completed", "failed", "cancelled", "interrupted"].includes(value.status));
    assert.equal(run.status, "completed", JSON.stringify(run));
  };
  faux.setResponses([
    context => {
      assertResources(context, true);
      const actualLearningTool = getCurrentTools(context.messages).find(tool => tool.name === "learning_context");
      assert(actualLearningTool);
      assert(actualLearningTool.description.length > 0);
      assert(actualLearningTool.parameters && typeof actualLearningTool.parameters === "object");
      return fauxAssistantMessage([fauxToolCall("trusted_mixed_echo", { text: "Agent 工具" }), fauxToolCall("pi_trusted_mixed", {})], { stopReason: "toolUse" });
    },
    context => {
      const result = context.messages.find(message => message.role === "toolResult" && message.toolName === "trusted_mixed_echo");
      assert(result);
      assert.match(textOf(result.content), /"source":"agent"/);
      const extensionResult = context.messages.find(message => message.role === "toolResult" && message.toolName === "pi_trusted_mixed");
      assert(extensionResult);
      assert.equal(textOf(extensionResult.content), "Pi 扩展结果");
      return fauxAssistantMessage("调用完成");
    },
  ]);
  await send("通过可信包工具处理");
  assert.deepEqual(await readdir(processingDirectory), before, "Agent 内部调用不能新增伪后台请求");
  assert.equal(existsSync(f.marker("trusted-mixed", "extension")), true);
  assert.equal(existsSync(f.marker("untrusted-mixed", "factory")), false);
  assert.equal(existsSync(f.marker("untrusted-mixed", "extension")), false);
  assert.equal(existsSync(f.marker("project-local", "extension")), false);
  const factoryBeforeDisable = await readFile(f.marker("trusted-mixed", "factory"), "utf8");
  await set(client, "plugins", "disabled", ["trusted", "repa-learning"]);
  const disabled = await client.call("prompts.preview", key);
  assert.equal(disabled.prompt.system.includes("trusted-mixed-skill"), false);
  const disabledToolDefinitions = disabled.prompt.sources.find(source => source.id === "toolDefinitions");
  assert(disabledToolDefinitions?.content);
  const disabledTools: unknown = JSON.parse(disabledToolDefinitions.content);
  assert(Check(ToolDefinitionsSchema, disabledTools));
  assert(!disabledTools.some(tool => tool.name === "learning_context"));
  assert(!disabled.prompt.sources.some(source => source.id === "capabilityPlugin:trusted" || source.id === "extensionContributions"));
  assert.equal(await readFile(f.marker("trusted-mixed", "factory"), "utf8"), factoryBeforeDisable);
  faux.setResponses([context => { assertResources(context, false); return fauxAssistantMessage("普通运行仍可用"); }]);
  await send("关闭包后的普通运行");
  await assert.rejects(client.call("capability.invoke", { scope, requestId: randomUUID(), contract: { id: "fixture.trusted-mixed.echo", version: "1" }, input: { text: "不应调用" } }), fault("capability_not_found"));
  await set(client, "plugins", "disabled", []);
  const restored = await client.call("prompts.preview", key);
  assert.match(restored.prompt.system, /trusted-mixed-skill/);
  const restoredToolDefinitions = restored.prompt.sources.find(source => source.id === "toolDefinitions");
  assert(restoredToolDefinitions?.content);
  const restoredTools: unknown = JSON.parse(restoredToolDefinitions.content);
  assert(Check(ToolDefinitionsSchema, restoredTools));
  assert(!restoredTools.some(tool => tool.name === "learning_context"));
  assert(restored.prompt.sources.some(source => source.id === "capabilityPlugin:repa-learning" && source.dynamic && source.enabled));
  faux.setResponses([context => { assertResources(context, true); return fauxAssistantMessage("恢复完成"); }]);
  await send("重新启用可信包");
  assert.equal((await readFile(f.marker("trusted-mixed", "factory"), "utf8")).split("factory\n").length - 1, 2);
});

const EndpointSchema = Type.Object({ url: Type.String(), token: Type.String() });
const PackageResultSchema = Type.Object({ restartRequired: Type.Literal(true), packages: Type.Array(Type.Unknown()) });

async function processBackend(agentDir: string, root: string) {
  const connectionFile = path.join(root, "connection.json");
  let child: ChildProcessWithoutNullStreams | undefined;
  let client: RepaClient | undefined;
  let output = "";
  let stopped: Promise<void> = Promise.resolve();
  const stop = async () => {
    await client?.close();
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await stopped;
  };
  const start = async () => {
    child = spawn(process.execPath, ["--import", "tsx", cliPath, "serve", "--agent-dir", agentDir, "--connection-file", connectionFile], { cwd: packageDirectory, stdio: ["pipe", "pipe", "pipe"] });
    output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => { output += data; });
    child.stderr.on("data", (data: string) => { output += data; });
    const running = child;
    stopped = new Promise<void>((resolve, reject) => {
      running.once("error", reject);
      running.once("close", code => code === 0 ? resolve() : reject(new Error(`后端子进程退出 ${code}：${output}`)));
    });
    await until(() => existsSync(connectionFile), Boolean);
    const endpoint: unknown = JSON.parse(await readFile(connectionFile, "utf8"));
    assert(Check(EndpointSchema, endpoint));
    client = await RepaClient.connect(endpoint);
    return client;
  };
  return { start, stop };
}

async function packageResult(client: RepaClient, accepted: BackgroundRequest) {
  const request = await until(() => client.call("request.get", { requestId: accepted.requestId }), value => ["completed", "failed", "cancelled", "interrupted"].includes(value.status));
  assert.equal(request.status, "completed", JSON.stringify(request));
  assert("operation" in request);
  assert.equal(request.result?.format.id, "repa.package-operation");
  assert.equal(request.result?.value.kind, "inline");
  if (request.result?.value.kind !== "inline") assert.fail("包管理必须返回持久内联结果");
  assert(Check(PackageResultSchema, request.result.value.data));
  return request;
}

test("公共包管理受理和查询使用真实 SDK 设置，关闭宿主并要求进程重启，同 ID 不重做操作", async (t) => {
  const f = await foundation(t);
  const source = await f.makePackage("managed-package", true);
  const backend = await processBackend(f.agentDir, f.root);
  f.onClose(backend.stop);
  let client = await backend.start();
  const selection = { kind: "package", name: "managed-package" };
  await set(client, "plugins", "backends", [{ id: "managed", package: selection }]);
  await set(client, "plugins", "trusted", [selection]);
  const install: Params<"package.install"> = { scope: application, requestId: randomUUID(), source };
  const installed = await packageResult(client, await client.call("package.install", install));
  const settingsFile = path.join(f.agentDir, "settings.json");
  const SettingsSchema = Type.Object({ packages: Type.Array(Type.String()) });
  const raw: unknown = JSON.parse(await readFile(settingsFile, "utf8"));
  assert(Check(SettingsSchema, raw));
  assert.equal(raw.packages.length, 1);
  const configuredSource = raw.packages[0];
  assert(configuredSource);
  await assert.rejects(client.call("capability.describe", { scope: application }), fault("plugin_restart_required"));
  const hidden = `${source}-hidden`;
  await rename(source, hidden);
  assert.deepEqual(await client.call("package.install", install), installed, "原来源暂时不存在时重传仍返回原结果，不重新安装");
  await rename(hidden, source);
  await backend.stop();
  client = await backend.start();
  const space = await client.call("space.open", { path: f.spaceDirectory });
  const scope: CapabilityScope = { kind: "space", spaceId: space.id };
  await client.call("capability.describe", { scope });
  const invoked = await client.call("capability.invoke", { scope, requestId: randomUUID(), contract: { id: "fixture.managed-package.echo", version: "1" }, input: { text: "更新前拥有的资源" } });
  assert.equal(invoked.kind, "inline");
  assert.equal(existsSync(f.marker("managed-package", "opened")), true);
  assert.equal(existsSync(f.marker("managed-package", "closed")), false);
  const update: Params<"package.update"> = { scope: application, requestId: randomUUID(), source: configuredSource };
  const updated = await packageResult(client, await client.call("package.update", update));
  assert.equal(await readFile(f.marker("managed-package", "closed"), "utf8"), "close\n");
  assert.deepEqual(await client.call("package.update", update), updated);
  await assert.rejects(client.call("capability.describe", { scope }), fault("plugin_restart_required"));
  await backend.stop();
  client = await backend.start();
  await client.call("space.open", { path: f.spaceDirectory });
  await client.call("capability.describe", { scope });
  const remove: Params<"package.remove"> = { scope: application, requestId: randomUUID(), source: configuredSource };
  const removed = await packageResult(client, await client.call("package.remove", remove));
  assert.deepEqual(await client.call("package.remove", remove), removed);
  const after: unknown = JSON.parse(await readFile(settingsFile, "utf8"));
  assert(Check(SettingsSchema, after));
  assert.deepEqual(after.packages, []);
  assert(existsSync(path.join(source, "backend.js")), "SDK local 移除不删除用户源码");
  assert.equal(await readFile(path.join(f.spaceDirectory, ".repa", "plugins", "managed", "owned.log"), "utf8"), "更新前拥有的资源\n");
  await assert.rejects(client.call("capability.describe", { scope: application }), fault("plugin_restart_required"));
});

test("空间包安装等待 SDK 时其他空间仍可运行，同范围包操作串行且退出等待安装完成", { timeout: 15000 }, async (t) => {
  const f = await foundation(t);
  const slowSource = await f.makePackage("slow-local");
  const nextSource = await f.makePackage("next-local");
  const otherSource = await f.makePackage("other-local");
  let release = () => {};
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let entered = () => {};
  const installing = new Promise<void>(resolve => { entered = resolve; });
  const started: string[] = [];
  const install = DefaultPackageManager.prototype.install;
  t.mock.method(DefaultPackageManager.prototype, "install", async function (this: DefaultPackageManager, source: string, options: Parameters<typeof install>[1]) {
    started.push(source);
    if (source === slowSource) {
      // 在实际 SDK 安装边界建立屏障，释放后仍由原方法检查本地包并保存来源。
      entered();
      await blocked;
    }
    return install.call(this, source, options);
  });
  const faux = fauxProvider({ api: `package-api-${randomUUID()}`, provider: `package-provider-${randomUUID()}`,
    models: [{ id: "test", reasoning: false, input: ["text"], contextWindow: 16384, maxTokens: 512 }], tokensPerSecond: 0 });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(f.agentDir, "test-auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("其他空间正常完成")]);
  const server = await startRepaServer({ agentDir: f.agentDir, appDirectory: f.appDirectory, modelOverride: { modelRuntime, model: faux.getModel() } });
  const client = await RepaClient.connect(server.connection);
  f.onClose(async () => { await server.close("cancel"); await client.close(); });
  let closing: Promise<void> | undefined;
  try {
    const space = await client.call("space.open", { path: f.spaceDirectory });
    const other = await client.call("space.open", { path: path.join(f.root, "other-space") });
    const scope: CapabilityScope = { kind: "space", spaceId: space.id };
    const slow = await client.call("package.install", { scope, requestId: randomUUID(), source: slowSource });
    await installing;
    const next = await client.call("package.install", { scope, requestId: randomUUID(), source: nextSource });
    await assert.rejects(client.call("capability.describe", { scope }), fault("plugin_restart_required"));
    const session = await client.call("session.create", { spaceId: other.id });
    const accepted = await client.call("session.submit", {
      target: { spaceId: other.id, sessionId: session.sessionId }, requestId: randomUUID(),
      input: { parts: [{ kind: "text", text: "包安装期间继续另一个空间的任务" }] }, dispatch: { kind: "start" },
    });
    assert(accepted.runId);
    const runId = accepted.runId;
    const run = await until(() => client.call("run.get", { spaceId: other.id, runId }), value => ["completed", "failed", "cancelled", "interrupted"].includes(value.status));
    assert.equal(run.status, "completed", JSON.stringify(run));
    const independent = await client.call("package.install", {
      scope: { kind: "space", spaceId: other.id }, requestId: randomUUID(), source: otherSource,
    });
    const independentResult = await until(() => client.call("request.get", { spaceId: other.id, requestId: independent.requestId }), value => value.status === "completed" || value.status === "failed");
    assert.equal(independentResult.status, "completed", JSON.stringify(independentResult));
    assert.deepEqual(started, [slowSource, otherSource], "同空间的第二次安装尚不能进入 SDK，其他空间有独立安装根");
    assert.equal((await client.call("request.get", { spaceId: space.id, requestId: slow.requestId })).status, "running");
    closing = server.close("drain");
    assert.equal((await client.call("state.get", { scope: {} })).lifecycle, "draining");
    release();
    await closing;
    const StoredSchema = Type.Object({
      request: Type.Object({
        status: Type.Literal("completed"),
        result: Type.Object({ value: Type.Object({ data: PackageResultSchema }) }),
      }),
    });
    for (const request of [slow, next]) {
      const stored: unknown = JSON.parse(await readFile(path.join(f.spaceDirectory, ".repa", "runtime", "processing", `${request.requestId}.json`), "utf8"));
      assert(Check(StoredSchema, stored), "排空退出前必须完成安装与持久结果");
    }
    assert.deepEqual(started, [slowSource, otherSource, nextSource]);
    const ProjectSettingsSchema = Type.Object({ packages: Type.Array(Type.String()) });
    const settings: unknown = JSON.parse(await readFile(path.join(f.spaceDirectory, ".pi", "settings.json"), "utf8"));
    assert(Check(ProjectSettingsSchema, settings));
    assert.equal(settings.packages.length, 2, "串行安装保留两次真实 SDK 设置变更");
  } finally {
    release();
    await closing;
  }
});
