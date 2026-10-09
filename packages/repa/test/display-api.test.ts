import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { App } from "@modelcontextprotocol/ext-apps";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { fauxProvider, fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { RepaClient, RpcError } from "../src/client.js";
import { createDisplayBridge } from "../src/display.js";
import { DisplayResultSchema, SAVE_NEW_RESULT, SUBMIT_RESULT, type BackgroundRequest, type ContentTarget } from "../src/protocol.js";
import { ContentStore } from "../src/content/store.js";
import { startRepaServer, type ServerOptions } from "../src/server.js";

const schema = Type.Object({ amplitude: Type.Number({ minimum: 0, maximum: 5 }), result: Type.Number() }, { additionalProperties: false });
const oldHtml = "<!doctype html><html><body>固定第一版实验</body></html>";
const newHtml = "<!doctype html><html><body>之后改过的实验</body></html>";
const fault = (code: string) => (error: unknown) => error instanceof RpcError &&
  error.data !== null && typeof error.data === "object" && "code" in error.data && error.data.code === code;

async function until<T>(read: () => T | Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= deadline) assert.fail(`展示状态超时：${JSON.stringify(value)}`);
    await delay(10);
  }
}

async function fixture(t: TestContext, configure?: (agentDir: string) => Promise<Partial<ServerOptions>>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-display-"));
  const agentDir = path.join(root, "agent");
  const directory = path.join(root, "space");
  await mkdir(agentDir);
  await mkdir(directory);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [], extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"] }));
  await writeFile(path.join(directory, "experiment.html"), oldHtml);
  const options = { agentDir, appDirectory: path.join(root, "app"), disconnectGraceMs: 50, ...await configure?.(agentDir) };
  let server = await startRepaServer(options);
  const clients: RepaClient[] = [];
  const connect = async (hostKey?: string) => {
    const client = await RepaClient.connect(server.connection, hostKey ? { hostKey } : undefined);
    clients.push(client);
    return client;
  };
  let client = await connect();
  t.after(async () => {
    await server.close("cancel");
    await Promise.all(clients.map(item => item.close()));
    await rm(root, { recursive: true, force: true });
  });
  const space = await client.call("space.open", { path: directory });
  const target = (file: string): ContentTarget => ({ kind: "file", spaceId: space.id, location: { kind: "relative", path: file } });
  const open = (resultPath?: string) => client.call("display.open", {
    spaceId: space.id, instanceId: randomUUID(), source: { kind: "content", target: target("experiment.html") },
    ...(resultPath ? { saveNewResult: { path: resultPath, inputSchema: { ...schema } } } : {}),
  });
  const finished = (request: BackgroundRequest) => until(async () => {
    const value = await client.call("request.get", { spaceId: space.id, requestId: request.requestId });
    assert("operation" in value);
    return value;
  }, value => !["accepted", "running", "cancelling"].includes(value.status));
  return { root, directory, space, target, connect, open, finished,
    get client() { return client; }, get server() { return server; },
    async reopen() {
      await server.close("cancel");
      server = await startRepaServer(options);
      client = await connect();
      await client.call("space.open", { path: directory });
    },
  };
}

function key(instance: { spaceId: string; instanceId: string }) {
  return { spaceId: instance.spaceId, instanceId: instance.instanceId };
}

test("实例绑定同一内容的独立版本，SDK只转发有限动作与资源，保存后关闭仍能重开原版本", async (t) => {
  const f = await fixture(t);
  const samples = "x,y\n0,0\n1,0.5\n";
  const uploaded = await f.client.uploadResource(f.space.id, new TextEncoder().encode(samples), "text/csv");
  await f.client.call("content.associate", {
    spaceId: f.space.id, operationId: randomUUID(), location: { kind: "relative", path: "experiment.html" }, role: "document",
  });
  const content = await f.client.call("content.get", { target: f.target("experiment.html") });
  assert(content.ref && content.revision);
  await f.client.call("content.setComposition", {
    ref: content.ref, operationId: randomUUID(), base: content.revision, members: [], resources: [uploaded.resource],
  });
  const seed = await f.open();
  const initialData = { prompt: "本次实际初始化的题面", parameters: { amplitude: 1 } };
  const initialSnapshot = structuredClone(initialData);
  const first = await f.client.call("display.open", {
    spaceId: f.space.id, instanceId: randomUUID(),
    source: { kind: "artifact", artifact: seed.artifact, initialData },
    saveNewResult: { path: "result.json", inputSchema: { ...schema } },
  });
  await f.client.call("display.close", key(seed));
  initialData.prompt = "调用方后来改写的题面";
  initialData.parameters.amplitude = 4;
  assert.deepEqual((await f.client.call("display.get", key(first))).initialData, initialSnapshot);
  await writeFile(path.join(f.directory, "experiment.html"), newHtml);
  const second = await f.open();
  assert.notEqual(first.artifact.value.resource.id, second.artifact.value.resource.id);
  const bytes = await f.client.call("display.readResource", { ...key(first), resourceId: first.artifact.value.resource.id });
  assert.equal(Buffer.from(bytes.base64, "base64").toString("utf8"), oldHtml);
  const other = await f.connect();
  await assert.rejects(other.call("display.get", key(first)), fault("permission_required"));
  await assert.rejects(f.client.call("display.readResource", { ...key(first), resourceId: second.artifact.value.resource.id }), fault("permission_required"));
  const bridge = createDisplayBridge(f.client, first);
  const app = new App({ name: "实际实验页", version: "1.0.0" }, {}, { autoResize: false });
  const [hostTransport, pageTransport] = InMemoryTransport.createLinkedPair();
  let initialize: unknown;
  app.ontoolinput = params => { initialize = params.arguments; };
  t.after(async () => { await app.close(); await bridge.close(); });
  await bridge.connect(hostTransport);
  await app.connect(pageTransport);
  await until(() => initialize, value => value !== undefined);
  assert.deepEqual(initialize, { initialData: initialSnapshot, actions: [{ name: SAVE_NEW_RESULT, inputSchema: { ...schema } }] });
  const resources = await app.listServerResources({});
  assert(resources.resources.every(item => item.uri.includes(first.instanceId)));
  const csv = resources.resources.find(item => item.mimeType === "text/csv");
  assert(csv);
  const csvRead = (await app.readServerResource({ uri: csv.uri })).contents[0];
  assert(csvRead && "blob" in csvRead);
  assert.equal(Buffer.from(csvRead.blob, "base64").toString("utf8"), samples);
  const resource = resources.resources.find(item => item.name === first.artifact.value.resource.id);
  assert(resource);
  const read = await app.readServerResource({ uri: resource.uri });
  const data = read.contents[0];
  assert(data && "blob" in data);
  assert.equal(Buffer.from(data.blob, "base64").toString("utf8"), oldHtml);
  await assert.rejects(app.callServerTool({ name: "execution.run", arguments: { command: "not allowed" } }));
  await assert.rejects(app.callServerTool({ name: SAVE_NEW_RESULT, arguments: { requestId: randomUUID(), input: { amplitude: 7, result: 1 } } }));
  const requestId = randomUUID();
  const input = { amplitude: 2, result: 0.5 };
  await app.callServerTool({ name: SAVE_NEW_RESULT, arguments: { requestId, input } });
  const accepted = await f.client.call("request.get", { spaceId: f.space.id, requestId });
  assert("operation" in accepted);
  const completed = await f.finished(accepted);
  assert.equal(completed.status, "completed", JSON.stringify(completed));
  assert.equal(completed.operation, "repa.display.save-result");
  const savedBytes = await readFile(path.join(f.directory, "result.json"));
  const saved: unknown = JSON.parse(savedBytes.toString("utf8"));
  assert(Check(DisplayResultSchema, saved));
  assert.equal(saved.value.data.source.kind, "display");
  assert.equal(saved.value.data.source.spaceId, f.space.id);
  assert.equal(saved.value.data.source.instanceId, first.instanceId);
  assert.equal(typeof saved.value.data.source.hostId, "string");
  assert.deepEqual(completed.configuration, { hostId: saved.value.data.source.hostId, source: saved.value.data.source, path: "result.json" });
  assert.deepEqual(saved.value.data.input, input);
  assert("initialData" in saved.value.data, "保存结果需要保留本实例实际初始化数据");
  assert.deepEqual(saved.value.data.initialData, initialSnapshot);
  assert.equal(saved.value.data.artifact.value.resource.id, first.artifact.value.resource.id);
  const document = await f.client.call("content.get", { target: f.target("result.json") });
  assert(document.ref);
  assert(document.resources.some(item => item.id === first.artifact.value.resource.id));
  await f.client.call("display.close", key(first));
  await f.client.call("display.close", key(first));
  await assert.rejects(f.client.call("display.get", key(first)), fault("display_closed"));
  assert.deepEqual(await f.client.call("display.invoke", { ...key(first), requestId, action: SAVE_NEW_RESULT, input }), completed);
  await f.reopen();
  assert.deepEqual(await readFile(path.join(f.directory, "result.json")), savedBytes, "重开不改写原结果字节");
  await assert.rejects(f.client.call("display.get", key(first)), fault("display_closed"));
  const restored = await f.client.call("display.open", {
    spaceId: f.space.id, instanceId: randomUUID(), source: { kind: "content", target: f.target("result.json") },
  });
  assert.deepEqual(restored.initialData, input);
  assert.equal(restored.artifact.value.resource.id, first.artifact.value.resource.id);
  assert.deepEqual(restored.actions, [], "重开结果不自动恢复保存授权");
  await assert.rejects(f.client.call("display.invoke", { ...key(restored), requestId: randomUUID(), action: SAVE_NEW_RESULT, input }), fault("permission_required"));
  const copied = await f.client.call("space.copy", { spaceId: f.space.id, operationId: randomUUID(), destination: path.join(f.root, "copy") });
  await f.client.call("space.open", { path: copied.destination });
  const copy = await f.client.call("display.open", { spaceId: copied.spaceId, instanceId: randomUUID(),
    source: { kind: "content", target: { kind: "file", spaceId: copied.spaceId, location: { kind: "relative", path: "result.json" } } } });
  assert.equal(copy.artifact.value.resource.spaceId, copied.spaceId);
  assert.equal(copy.artifact.value.resource.id, first.artifact.value.resource.id);
  const savedSamples = await f.client.call("display.readResource", { ...key(copy), resourceId: uploaded.resource.id });
  assert.equal(savedSamples.resource.spaceId, copied.spaceId);
  assert.equal(Buffer.from(savedSamples.base64, "base64").toString("utf8"), samples);
  const copiedBytes = await readFile(path.join(copied.destination, "result.json"), "utf8");
  assert.equal(copiedBytes, await readFile(path.join(f.directory, "result.json"), "utf8"), "副本不重写 JSON 中历史产生者或原字节");
  assert(copy.artifact.sources.every(item => item.target.kind === "file" && item.target.spaceId === copied.spaceId));
  const originalResource = await f.client.call("display.readResource", { ...key(copy), resourceId: copy.artifact.value.resource.id });
  assert.equal(Buffer.from(originalResource.base64, "base64").toString("utf8"), oldHtml);
});

test("已受理保存先接续资源，等待内容队列时关闭展示并清理不丢失旧页面", async (t) => {
  const f = await fixture(t);
  const instance = await f.open("queued-result.json");
  await writeFile(path.join(f.directory, "experiment.html"), newHtml);
  const apply = ContentStore.prototype.applyPatch;
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = () => {};
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(ContentStore.prototype, "applyPatch", async function (this: ContentStore, input: Parameters<typeof apply>[0]) {
    if (input.registrations?.some(item => item.path === "queued-result.json")) {
      entered();
      await gate;
    }
    return apply.call(this, input);
  });
  try {
    const accepted = await f.client.call("display.invoke", { ...key(instance), requestId: randomUUID(), action: SAVE_NEW_RESULT, input: { amplitude: 1, result: 0.2 } });
    assert("operation" in accepted);
    await waiting;
    await f.client.call("display.close", key(instance));
    await f.client.call("resource.collect", { spaceId: f.space.id });
    assert.equal(await (await f.client.resource(instance.artifact.value.resource)).text(), oldHtml);
    release();
    const completed = await f.finished(accepted);
    assert.equal(completed.status, "completed", JSON.stringify(completed));
    const document = await f.client.call("content.get", { target: f.target("queued-result.json") });
    assert(document.resources.some(ref => ref.id === instance.artifact.value.resource.id));
  } finally { release(); }
});

test("短暂重连保留实例，确认宿主关闭撤销动作，重开已保存表示需要新的授权", async (t) => {
  const f = await fixture(t);
  const instance = await f.open("closed-host-result.json");
  const hostKey = f.client.hostKey;
  assert(hostKey);
  await f.client.reconnect();
  assert.equal((await f.client.call("display.get", key(instance))).instanceId, instance.instanceId);
  await f.client.close();
  const resumed = await f.connect(hostKey);
  await assert.rejects(resumed.call("display.get", key(instance)), fault("display_closed"));
  await assert.rejects(resumed.call("display.invoke", { ...key(instance), requestId: randomUUID(), action: SAVE_NEW_RESULT, input: { amplitude: 1, result: 0.2 } }), fault("display_closed"));
});

test("实验参数只投递给绑定会话，模型看到展示来源和固定表示，实例关闭不取消已受理请求", async (t) => {
  const contexts: TranscriptContext[] = [];
  const f = await fixture(t, async agentDir => {
    const provider = fauxProvider({
      api: `display-test-${randomUUID()}`, provider: `display-test-${randomUUID()}`,
      models: [{ id: "experiment", name: "实验解释", reasoning: false, input: ["text"], contextWindow: 16384, maxTokens: 512 }],
      tokensPerSecond: 0,
    });
    provider.setResponses([context => {
      contexts.push(structuredClone(context));
      return fauxAssistantMessage("实验参数已读取。");
    }]);
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(provider.provider);
    return { modelOverride: { modelRuntime, model: provider.getModel() } };
  });
  const session = await f.client.call("session.create", { spaceId: f.space.id });
  const seed = await f.open();
  const initialData = { prompt: "实际展示给页面的原始条件", amplitude: 1 };
  const initialSnapshot = structuredClone(initialData);
  const instance = await f.client.call("display.open", {
    spaceId: f.space.id, instanceId: randomUUID(), source: { kind: "artifact", artifact: seed.artifact, initialData },
    submitResult: { sessionId: session.sessionId, instruction: "请解释这次实验结果。", inputSchema: { ...schema } },
  });
  await f.client.call("display.close", key(seed));
  initialData.prompt = "提交前调用方已经改写";
  const bridge = createDisplayBridge(f.client, instance);
  const app = new App({ name: "实验参数页", version: "1.0.0" }, {}, { autoResize: false });
  const [host, page] = InMemoryTransport.createLinkedPair();
  let initialize: unknown;
  app.ontoolinput = params => { initialize = params.arguments; };
  t.after(async () => { await app.close(); await bridge.close(); });
  await bridge.connect(host);
  await app.connect(page);
  await until(() => initialize, value => value !== undefined);
  assert.deepEqual(initialize, { initialData: initialSnapshot, actions: [{ name: SUBMIT_RESULT, inputSchema: { ...schema } }] });
  const requestId = randomUUID();
  const input = { amplitude: 3, result: 0.75 };
  const receipt = await app.callServerTool({ name: SUBMIT_RESULT, arguments: { requestId, input } });
  assert.deepEqual(Object.keys(receipt.structuredContent ?? {}).sort(), ["requestId", "status"]);
  await f.client.call("display.close", key(instance));
  await writeFile(path.join(f.directory, "experiment.html"), newHtml);
  await f.client.call("resource.collect", { spaceId: f.space.id });
  const request = await until(() => f.client.call("request.get", { spaceId: f.space.id, requestId }),
    value => !["queued", "running", "unknown"].includes(value.status));
  assert("source" in request);
  assert.equal(request.status, "completed", JSON.stringify(request));
  assert.equal(request.source.kind, "display");
  assert.equal(request.target.sessionId, session.sessionId);
  const submitted = request.input.parts.find(part => part.kind === "data");
  assert(submitted?.kind === "data" && Check(DisplayResultSchema, submitted.representation));
  assert.deepEqual(submitted.representation.value.data.initialData, initialSnapshot);
  assert.deepEqual(submitted.representation.value.data.input, input);
  assert.equal(await (await f.client.resource(instance.artifact.value.resource)).text(), oldHtml);
  assert.equal(contexts.length, 1);
  const actual = JSON.stringify(contexts[0]?.messages);
  assert.match(actual, /请解释这次实验结果/u);
  assert.match(actual, /repa\.display-result/u);
  assert(actual.includes(instance.instanceId));
  assert(actual.includes("实际展示给页面的原始条件"));
  assert.equal(actual.includes("提交前调用方已经改写"), false);
  assert(actual.includes('\\"amplitude\\":3'));
  assert(actual.includes(instance.artifact.value.resource.id));
  assert.deepEqual(await f.client.call("display.invoke", { ...key(instance), requestId, action: SUBMIT_RESULT, input }), request);
  await assert.rejects(f.client.call("display.invoke", {
    ...key(instance), requestId, action: SUBMIT_RESULT, input: { amplitude: 4, result: 1 },
  }), fault("request_id_conflict"));
});

test("初始数据的缺省、null及空值在保存与提交中区分，旧结果重开不倒填或改写", async t => {
  const values = [undefined, null, "", [], {}, 0, false];
  const f = await fixture(t, async agentDir => {
    const provider = fauxProvider({ api: `display-values-${randomUUID()}`, provider: `display-values-${randomUUID()}`,
      models: [{ id: "values", reasoning: false, input: ["text"], contextWindow: 16384, maxTokens: 512 }], tokensPerSecond: 0 });
    provider.setResponses(values.map(() => fauxAssistantMessage("已取得原始初始化数据与提交参数。")));
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null,
      allowModelNetwork: false, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(provider.provider);
    return { modelOverride: { modelRuntime, model: provider.getModel() } };
  });
  const seed = await f.open();
  const session = await f.client.call("session.create", { spaceId: f.space.id });
  const savedFiles: Array<{ path: string; bytes: Buffer; initialData: unknown }> = [];
  for (const [index, initialData] of values.entries()) {
    const file = `value-${index}.json`;
    const instance = await f.client.call("display.open", {
      spaceId: f.space.id, instanceId: randomUUID(),
      source: { kind: "artifact", artifact: seed.artifact, ...(initialData === undefined ? {} : { initialData }) },
      saveNewResult: { path: file, inputSchema: { ...schema } },
      submitResult: { sessionId: session.sessionId, instruction: "核对这次实际提交。", inputSchema: { ...schema } },
    });
    assert.equal(Object.hasOwn(instance, "initialData"), initialData !== undefined);
    assert.deepEqual(instance.initialData, initialData);
    const input = { amplitude: 2, result: index };
    const saving = await f.client.call("display.invoke", { ...key(instance), requestId: randomUUID(), action: SAVE_NEW_RESULT, input });
    assert("operation" in saving);
    assert.equal((await f.finished(saving)).status, "completed");
    const bytes = await readFile(path.join(f.directory, file));
    const saved: unknown = JSON.parse(bytes.toString("utf8"));
    assert(Check(DisplayResultSchema, saved));
    assert.equal(Object.hasOwn(saved.value.data, "initialData"), initialData !== undefined);
    assert.deepEqual(saved.value.data.initialData, initialData);
    assert.deepEqual(saved.value.data.input, input);
    const requestId = randomUUID();
    await f.client.call("display.invoke", { ...key(instance), requestId, action: SUBMIT_RESULT, input });
    await f.client.call("display.close", key(instance));
    const request = await until(() => f.client.call("request.get", { spaceId: f.space.id, requestId }),
      value => !["unknown", "queued", "running"].includes(value.status));
    assert("input" in request);
    assert.equal(request.status, "completed");
    const part = request.input.parts.find(part => part.kind === "data");
    assert(part?.kind === "data" && Check(DisplayResultSchema, part.representation));
    assert.equal(Object.hasOwn(part.representation.value.data, "initialData"), initialData !== undefined);
    assert.deepEqual(part.representation.value.data.initialData, initialData);
    assert.deepEqual(part.representation.value.data.input, input);
    savedFiles.push({ path: file, bytes, initialData });
  }
  await f.client.call("display.close", key(seed));
  await f.reopen();
  const copied = await f.client.call("space.copy", { spaceId: f.space.id, operationId: randomUUID(),
    destination: path.join(f.root, "initial-data-copy") });
  assert.equal(copied.status, "completed", copied.error?.message);
  await f.client.call("space.open", { path: copied.destination });
  for (const [index, saved] of savedFiles.entries()) {
    const reopened = await f.client.call("display.open", { spaceId: f.space.id, instanceId: randomUUID(),
      source: { kind: "content", target: f.target(saved.path) } });
    assert.deepEqual(reopened.initialData, { amplitude: 2, result: index }, "重放继续使用已提交input，而不是历史initialData");
    assert.deepEqual(await readFile(path.join(f.directory, saved.path)), saved.bytes);
    const original: unknown = JSON.parse(saved.bytes.toString("utf8"));
    assert(Check(DisplayResultSchema, original));
    assert.equal(Object.hasOwn(original.value.data, "initialData"), saved.initialData !== undefined, "缺省字段的旧结果不倒填");
    await f.client.call("display.close", key(reopened));
    assert.deepEqual(await readFile(path.join(copied.destination, saved.path)), saved.bytes, "复制保留initialData与原始结果字节");
    const copiedInstance = await f.client.call("display.open", { spaceId: copied.spaceId, instanceId: randomUUID(),
      source: { kind: "content", target: { kind: "file", spaceId: copied.spaceId, location: { kind: "relative", path: saved.path } } } });
    assert.deepEqual(copiedInstance.initialData, { amplitude: 2, result: index });
    await f.client.call("display.close", key(copiedInstance));
  }
});
