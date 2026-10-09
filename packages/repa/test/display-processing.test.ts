import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { App } from "@modelcontextprotocol/ext-apps";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { BackendPluginRegistration, InvocationContext } from "../src/capabilities/types.js";
import { RepaClient, RpcError } from "../src/client.js";
import { createDisplayBridge } from "../src/display.js";
import { CapabilitySourceSchema, ContentRefSchema, DisplayResultSchema, IdSchema, PROCESS_RESULT,
  ResourceRefSchema, SAVE_NEW_RESULT, type BackgroundRequest, type ContentTarget, type DisplayInstance } from "../src/protocol.js";
import { startRepaServer } from "../src/server.js";

const contract = { id: "fixture.display.process", version: "1" };
const pageSchema = Type.Object({ answer: Type.String() }, { additionalProperties: true });
const processorInput = Type.Object({ operationId: IdSchema, result: DisplayResultSchema }, { additionalProperties: false });
const processorOutput = Type.Object({ ref: ContentRefSchema, resource: ResourceRefSchema, source: CapabilitySourceSchema }, { additionalProperties: false });
type ProcessorInput = Static<typeof processorInput>;
type ProcessorOutput = Static<typeof processorOutput>;
const html = "<!doctype html><html><body>本实例固定题面</body></html>";
const fault = (code: string) => (error: unknown) => error instanceof RpcError && error.data !== null &&
  typeof error.data === "object" && "code" in error.data && error.data.code === code;
const key = (instance: DisplayInstance) => ({ spaceId: instance.spaceId, instanceId: instance.instanceId });
function gate() {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function until<T>(read: () => T | Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= deadline) assert.fail(`展示处理状态超时：${JSON.stringify(value)}`);
    await delay(10);
  }
}

interface FixtureOptions {
  beforeExecute?(input: ProcessorInput, context: InvocationContext): Promise<void>;
  beforeFactory?(): Promise<void>;
  afterExecute?(input: ProcessorInput, context: InvocationContext): Promise<void>;
  plugins?: BackendPluginRegistration[];
}

async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-display-processing-"));
  const agentDir = path.join(root, "agent");
  const directory = path.join(root, "space");
  await mkdir(agentDir);
  await mkdir(directory);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [],
    extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"] }));
  await writeFile(path.join(directory, "exercise.html"), html);
  const calls: { implementation: string; input: ProcessorInput; source: InvocationContext["source"] }[] = [];
  const plugins: BackendPluginRegistration[] = ["a", "b"].map(implementation => ({
    id: `processor-${implementation}`, enabled: true, factory: async () => {
      await options.beforeFactory?.();
      return { capabilities: [{
      contract, implementationId: implementation, scopes: ["space"], execution: "inline",
      inputSchema: processorInput, outputSchema: processorOutput,
      inputResources: input => { assert(Check(processorInput, input)); return input.result.resources; },
      outputResources: output => { assert(Check(processorOutput, output)); return [output.resource]; },
      async invoke(input, context) {
        assert(Check(processorInput, input));
        calls.push({ implementation, input: structuredClone(input), source: structuredClone(context.source) });
        await options.beforeExecute?.(input, context);
        assert(context.content);
        const bytes = Buffer.from(`处理器${implementation}产生的独立输出\n`);
        const resource = { spaceId: context.content.options.spaceId,
          id: await context.content.blobs.put(bytes), mediaType: "text/plain" };
        const file = `processed-${input.operationId}.json`;
        const text = `${JSON.stringify(input.result)}\n`;
        const result = await context.content.applyPatch({ operationId: input.operationId,
          patch: ["*** Begin Patch", `*** Add File: ${file}`, ...text.slice(0, -1).split("\n").map(line => `+${line}`), "*** End Patch"].join("\n"),
          registrations: [{ path: file, role: "document", resources: [...input.result.resources, resource] }],
        });
        const ref = result.contents[0]?.ref;
        assert(ref);
        await options.afterExecute?.(input, context);
        return { ref, resource, source: context.source };
      },
    }] };
    },
  }));
  plugins.push(...(options.plugins ?? []));
  let server = await startRepaServer({ appDirectory: path.join(root, "app"), agentDir, plugins });
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
  const setting = async (name: string, value: unknown) => {
    const scope = { kind: "space" as const, spaceId: space.id };
    const view = await client.call("settings.get", { scope, namespace: "plugins" });
    const entry = view.entries.find(item => item.key === name);
    assert(entry);
    await client.call("settings.set", { scope, namespace: "plugins", key: name, value, base: entry.revision });
  };
  await setting("implementations", { [contract.id]: "a" });
  const open = async (initialData: unknown = { fixed: "实际初始化条件" }) => {
    const seed = await client.call("display.open", { spaceId: space.id, instanceId: randomUUID(),
      source: { kind: "content", target: target("exercise.html") } });
    const instance = await client.call("display.open", { spaceId: space.id, instanceId: randomUUID(),
      source: { kind: "artifact", artifact: seed.artifact, initialData },
      processResult: { selection: { contract }, inputSchema: { ...pageSchema } } });
    await client.call("display.close", key(seed));
    return instance;
  };
  const finished = (requestId: string) => until(async () => {
    const request = await client.call("request.get", { spaceId: space.id, requestId });
    assert("operation" in request);
    return request;
  }, request => !["accepted", "running", "cancelling"].includes(request.status));
  return { root, directory, space, calls, target, open, connect, setting, finished,
    get client() { return client; }, get server() { return server; },
    async reopen() {
      const hostKey = client.hostKey;
      assert(hostKey);
      await server.close("cancel");
      server = await startRepaServer({ appDirectory: path.join(root, "app"), agentDir, plugins });
      client = await connect(hostKey);
      assert.equal((await client.call("space.open", { path: directory })).id, space.id);
    },
  };
}

function output(request: BackgroundRequest): ProcessorOutput {
  assert(request.result?.value.kind === "inline");
  const value = request.result.value.data;
  assert(Check(processorOutput, value));
  return value;
}

async function sdk(t: TestContext, client: RepaClient, instance: DisplayInstance) {
  const bridge = createDisplayBridge(client, instance);
  const app = new App({ name: "实际处理结果页", version: "1.0.0" }, {}, { autoResize: false });
  const [host, page] = InMemoryTransport.createLinkedPair();
  let initialized: unknown;
  app.ontoolinput = params => { initialized = params.arguments; };
  t.after(async () => { await app.close(); await bridge.close(); });
  await bridge.connect(host);
  await app.connect(page);
  await until(() => initialized, value => value !== undefined);
  return { app, initialized };
}

test("SDK页面只提交input，绑定处理器收到本实例固定条件、资源和实际display来源", async t => {
  const f = await fixture(t);
  const uploaded = await f.client.uploadResource(f.space.id, Buffer.from("题目附属固定资源\n"), "text/plain");
  const associated = await f.client.call("content.associate", { spaceId: f.space.id, operationId: randomUUID(),
    location: { kind: "relative", path: "exercise.html" }, role: "document" });
  const ref = associated.contents[0]?.ref;
  assert(ref);
  const info = await f.client.call("content.get", { target: { kind: "content", ref } });
  assert(info.revision);
  await f.client.call("content.setComposition", { ref, operationId: randomUUID(), base: info.revision,
    members: [], resources: [uploaded.resource] });
  const data = { fixed: "固定第一版条件", nested: { count: 1 } };
  const fixed = structuredClone(data);
  const instance = await f.open(data);
  data.fixed = "后来改写";
  const page = await sdk(t, f.client, instance);
  assert.deepEqual(page.initialized, { initialData: fixed, actions: [{ name: PROCESS_RESULT, inputSchema: { ...pageSchema } }] });
  assert.deepEqual(instance.actions, [{ name: PROCESS_RESULT, inputSchema: { ...pageSchema } }]);
  const requestId = randomUUID();
  const input = { answer: "原始回答", source: { kind: "client", hostId: "forged" },
    initialData: "伪造初始化", artifact: "伪造artifact", selection: { contract: { id: "forged", version: "1" } } };
  const receipt = await page.app.callServerTool({ name: PROCESS_RESULT, arguments: { requestId, input } });
  assert.deepEqual(Object.keys(receipt.structuredContent ?? {}).sort(), ["requestId", "status"]);
  assert(Check(Type.Object({ requestId: IdSchema, status: Type.String() }), receipt.structuredContent));
  assert.equal(receipt.structuredContent.requestId, requestId);
  const completed = await f.finished(requestId);
  assert.equal(completed.status, "completed", JSON.stringify(completed));
  assert.equal(completed.operation, "repa.display.process-result");
  const call = f.calls[0];
  assert(call && f.calls.length === 1);
  assert.equal(call.implementation, "a");
  assert.equal(call.input.operationId, requestId);
  assert.deepEqual(call.input.result.value.data.input, input);
  assert.deepEqual(call.input.result.value.data.initialData, fixed);
  assert.deepEqual(call.input.result.value.data.artifact, instance.artifact);
  const part = completed.input.parts[0];
  assert(part?.kind === "data" && part.representation.value.kind === "inline");
  assert.deepEqual(part.representation.format, contract);
  assert.deepEqual(part.representation.value.data, call.input);
  assert.deepEqual(part.representation.resources, [...call.input.result.resources, ...call.input.result.resources]);
  assert.deepEqual(call.input.result.value.data.source, call.source);
  assert(call.source.kind === "display");
  assert.equal(call.source.spaceId, f.space.id);
  assert.equal(call.source.instanceId, instance.instanceId);
  assert.notEqual(call.source.hostId, "forged");
  assert.deepEqual(call.input.result.resources, [instance.artifact.value.resource, ...instance.artifact.resources]);
  assert(call.input.result.resources.some(resource => resource.id === uploaded.resource.id));
  assert.deepEqual(completed.configuration, { hostId: call.source.hostId, source: call.source,
    operationId: requestId, contract, implementationId: "a", pluginId: "processor-a" });
  const saved = await f.client.readText(f.target(`processed-${requestId}.json`));
  const parsed: unknown = JSON.parse(saved.text);
  assert(Check(DisplayResultSchema, parsed));
  assert.deepEqual(parsed, call.input.result);
  assert.deepEqual(output(completed).source, call.source);
  await assert.rejects(page.app.callServerTool({ name: PROCESS_RESULT,
    arguments: { requestId: randomUUID(), input, selection: { contract } } }));
});

test("动作与宿主受实例授权约束，同ID重传关闭后仍回原状态，异载荷或换实例冲突", async t => {
  const f = await fixture(t);
  const instance = await f.open();
  const other = await f.connect();
  const input = { answer: "固定原回答" };
  await assert.rejects(other.call("display.invoke", { ...key(instance), requestId: randomUUID(), action: PROCESS_RESULT, input }), fault("permission_required"));
  await assert.rejects(f.client.call("display.invoke", { ...key(instance), requestId: randomUUID(), action: SAVE_NEW_RESULT, input }), fault("permission_required"));
  const unbound = await f.client.call("display.open", { spaceId: f.space.id, instanceId: randomUUID(),
    source: { kind: "content", target: f.target("exercise.html") } });
  await assert.rejects(f.client.call("display.invoke", { ...key(unbound), requestId: randomUUID(), action: PROCESS_RESULT, input }), fault("permission_required"));
  const requestId = randomUUID();
  await f.client.call("display.invoke", { ...key(instance), requestId, action: PROCESS_RESULT, input });
  const completed = await f.finished(requestId);
  assert.equal(completed.status, "completed");
  await f.client.call("display.close", key(instance));
  assert.deepEqual(await f.client.call("display.invoke", { ...key(instance), requestId, action: PROCESS_RESULT, input }), completed);
  await assert.rejects(f.client.call("display.invoke", { ...key(instance), requestId, action: PROCESS_RESULT, input: { answer: "改过的载荷" } }), fault("request_id_conflict"));
  await assert.rejects(f.client.call("display.invoke", { ...key(unbound), requestId, action: PROCESS_RESULT, input }), fault("request_id_conflict"));
  await assert.rejects(f.client.call("display.invoke", { ...key(instance), requestId, action: SAVE_NEW_RESULT, input }), fault("request_id_conflict"));
  await assert.rejects(other.call("display.invoke", { ...key(instance), requestId, action: PROCESS_RESULT, input }), fault("request_id_conflict"));
  assert.equal(f.calls.length, 1);
});

test("open时固定默认实现，后来改变默认不换处理器，禁用绑定实现明确失败而不fallback", async t => {
  const f = await fixture(t);
  const boundA = await f.open();
  await f.setting("implementations", { [contract.id]: "b" });
  const input = { answer: "原回答" };
  const requestId = randomUUID();
  await f.client.call("display.invoke", { ...key(boundA), requestId, action: PROCESS_RESULT, input });
  assert.equal((await f.finished(requestId)).status, "completed");
  assert.equal(f.calls[0]?.implementation, "a");
  const boundB = await f.open();
  const bId = randomUUID();
  await f.client.call("display.invoke", { ...key(boundB), requestId: bId, action: PROCESS_RESULT, input });
  assert.equal((await f.finished(bId)).status, "completed");
  assert.equal(f.calls[1]?.implementation, "b");
  await f.setting("disabled", ["processor-a"]);
  const disabledId = randomUUID();
  await assert.rejects(f.client.call("display.invoke", { ...key(boundA), requestId: disabledId, action: PROCESS_RESULT, input }), fault("capability_not_found"));
  assert.equal((await f.client.call("request.get", { spaceId: f.space.id, requestId: disabledId })).status, "unknown");
  assert.equal(f.calls.length, 2);
});

test("prepare尚未受理时关闭实例拒绝请求，不调用处理器或留下内容操作", async t => {
  const entered = gate();
  const release = gate();
  let blocked = false;
  const f = await fixture(t, { beforeFactory: async () => {
    if (!blocked) return;
    entered.release();
    await release.promise;
  } });
  const instance = await f.open();
  await f.setting("implementations", { [contract.id]: "b" });
  blocked = true;
  const requestId = randomUUID();
  const invoking = f.client.call("display.invoke", { ...key(instance), requestId, action: PROCESS_RESULT, input: { answer: "准备中的请求" } });
  const rejected = assert.rejects(invoking, fault("display_closed"));
  try {
    await entered.promise;
    await f.client.call("display.close", key(instance));
  } finally { release.release(); }
  await rejected;
  assert.equal(f.calls.length, 0);
  assert.equal((await f.client.call("request.get", { spaceId: f.space.id, requestId })).status, "unknown");
  assert.equal((await f.client.call("operation.get", { spaceId: f.space.id, operationId: requestId })).status, "unknown");
});

test("已受理执行不因实例close取消，输入输出资源在关闭、清理内容历史和重启后仍可读", async t => {
  const entered = gate();
  const release = gate();
  const f = await fixture(t, { beforeExecute: async (_input, context) => {
    entered.release();
    await release.promise;
    assert.equal(context.signal.aborted, false);
  } });
  const attachment = await f.client.uploadResource(f.space.id, Buffer.from("已绑定的附属资源\n"), "text/plain");
  const associating = randomUUID();
  const associated = await f.client.call("content.associate", { spaceId: f.space.id, operationId: associating,
    location: { kind: "relative", path: "exercise.html" }, role: "document" });
  const sourceRef = associated.contents[0]?.ref;
  assert(sourceRef);
  const sourceInfo = await f.client.call("content.get", { target: { kind: "content", ref: sourceRef } });
  assert(sourceInfo.revision);
  const composing = randomUUID();
  await f.client.call("content.setComposition", { ref: sourceRef, operationId: composing, base: sourceInfo.revision,
    members: [], resources: [attachment.resource] });
  await f.client.call("resource.release", { spaceId: f.space.id, id: attachment.id });
  const instance = await f.open();
  const input = { answer: "已受理回答" };
  const requestId = randomUUID();
  try {
    const accepted = await f.client.call("display.invoke", { ...key(instance), requestId, action: PROCESS_RESULT, input });
    assert("operation" in accepted);
    await entered.promise;
    await f.client.call("display.close", key(instance));
    await writeFile(path.join(f.directory, "exercise.html"), "<!doctype html><html>后来版本</html>");
    const changed = await f.client.call("content.get", { target: { kind: "content", ref: sourceRef } });
    assert(changed.bodyRevision);
    const removingSource = randomUUID();
    await f.client.call("content.remove", { target: { kind: "content", ref: sourceRef },
      operationId: removingSource, base: changed.bodyRevision });
    await f.client.call("operation.prune", { spaceId: f.space.id, operationIds: [associating, composing, removingSource] });
    await f.client.call("resource.collect", { spaceId: f.space.id });
    assert.equal(await (await f.client.resource(instance.artifact.value.resource)).text(), html);
    assert.equal(await (await f.client.resource(attachment.resource)).text(), "已绑定的附属资源\n");
  } finally { release.release(); }
  const completed = await f.finished(requestId);
  assert.equal(completed.status, "completed", JSON.stringify(completed));
  const result = output(completed);
  const info = await f.client.call("content.get", { target: { kind: "content", ref: result.ref } });
  assert(info.bodyRevision);
  const removing = randomUUID();
  await f.client.call("content.remove", { target: { kind: "content", ref: result.ref }, operationId: removing, base: info.bodyRevision });
  await f.client.call("operation.prune", { spaceId: f.space.id, operationIds: [requestId, removing] });
  await f.client.call("resource.collect", { spaceId: f.space.id });
  assert.equal(await (await f.client.resource(instance.artifact.value.resource)).text(), html);
  assert.equal(await (await f.client.resource(result.resource)).text(), "处理器a产生的独立输出\n");
  assert.equal(await (await f.client.resource(attachment.resource)).text(), "已绑定的附属资源\n");
  await f.reopen();
  const reopened = await f.client.call("request.get", { spaceId: f.space.id, requestId });
  assert.deepEqual(reopened, completed);
  assert.equal(await (await f.client.resource(result.resource)).text(), "处理器a产生的独立输出\n");
  assert.equal(await (await f.client.resource(instance.artifact.value.resource)).text(), html);
  assert.equal(await (await f.client.resource(attachment.resource)).text(), "已绑定的附属资源\n");
  assert.equal(f.calls.length, 1);
});

test("query不能绑定持久处理，能力input不匹配和声明超出hold资源在受理前拒绝", async t => {
  const query = { id: "fixture.display.query", version: "1" };
  const invalid = { id: "fixture.display.invalid-input", version: "1" };
  const outside = { id: "fixture.display.outside-resource", version: "1" };
  let hidden: Static<typeof ResourceRefSchema> | undefined;
  let executions = 0;
  const extra: BackendPluginRegistration = { id: "processor-invalid", enabled: true, factory: () => ({ capabilities: [
    { contract: query, implementationId: "local", scopes: ["space"], execution: "query",
      inputSchema: processorInput, outputSchema: Type.Null(), invoke() { executions++; return null; } },
    { contract: invalid, implementationId: "local", scopes: ["space"], execution: "inline",
      inputSchema: Type.Object({ requiredField: Type.String() }, { additionalProperties: false }),
      outputSchema: Type.Null(), invoke() { executions++; return null; } },
    { contract: outside, implementationId: "local", scopes: ["space"], execution: "inline",
      inputSchema: processorInput, outputSchema: Type.Null(),
      inputResources() { assert(hidden); return [hidden]; }, invoke() { executions++; return null; } },
  ] }) };
  const f = await fixture(t, { plugins: [extra] });
  const opening = (selected: typeof query) => f.client.call("display.open", {
    spaceId: f.space.id, instanceId: randomUUID(), source: { kind: "content", target: f.target("exercise.html") },
    processResult: { selection: { contract: selected }, inputSchema: { ...pageSchema } },
  });
  await assert.rejects(opening(query), fault("invalid_display_processor"));
  const badInput = await opening(invalid);
  const invalidId = randomUUID();
  await assert.rejects(f.client.call("display.invoke", { ...key(badInput), requestId: invalidId,
    action: PROCESS_RESULT, input: { answer: "原回答" } }), fault("invalid_capability_input"));
  const uploaded = await f.client.uploadResource(f.space.id, Buffer.from("不在展示hold内的资源"), "text/plain");
  hidden = uploaded.resource;
  const escaping = await opening(outside);
  const escapeId = randomUUID();
  await assert.rejects(f.client.call("display.invoke", { ...key(escaping), requestId: escapeId,
    action: PROCESS_RESULT, input: { answer: "原回答" } }), fault("permission_required"));
  for (const requestId of [invalidId, escapeId])
    assert.equal((await f.client.call("request.get", { spaceId: f.space.id, requestId })).status, "unknown");
  assert.equal(executions, 0);
});

test("内容已经提交但处理请求实际取消时，重传返回取消状态，旧content操作仍能明确确认", async t => {
  const committed = gate();
  const f = await fixture(t, { afterExecute: async (_input, context) => {
    committed.release();
    await new Promise<void>(resolve => {
      if (context.signal.aborted) resolve();
      else context.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  } });
  const instance = await f.open();
  const input = { answer: "原始回答" };
  const requestId = randomUUID();
  await f.client.call("display.invoke", { ...key(instance), requestId, action: PROCESS_RESULT, input });
  await committed.promise;
  const op = await f.client.call("operation.get", { spaceId: f.space.id, operationId: requestId });
  assert.equal(op.status, "committed");
  const original = await readFile(path.join(f.directory, `processed-${requestId}.json`));
  await f.client.call("request.cancel", { spaceId: f.space.id, requestId });
  const cancelled = await f.finished(requestId);
  assert.equal(cancelled.status, "cancelled");
  await f.client.call("display.close", key(instance));
  assert.deepEqual(await f.client.call("display.invoke", { ...key(instance), requestId, action: PROCESS_RESULT, input }), cancelled);
  assert.equal(f.calls.length, 1);
  await f.reopen();
  assert.deepEqual(await f.client.call("request.get", { spaceId: f.space.id, requestId }), cancelled);
  assert.equal((await f.client.call("operation.get", { spaceId: f.space.id, operationId: requestId })).status, "committed");
  assert.deepEqual(await readFile(path.join(f.directory, `processed-${requestId}.json`)), original);
  assert.equal(f.calls.length, 1);
});

test("重开结果hold中的额外资源由处理请求接续，不要求把它塞入原artifact资源数组", async t => {
  const entered = gate();
  const release = gate();
  const selected = { id: "fixture.display.held-extra", version: "1" };
  let extra: Static<typeof ResourceRefSchema> | undefined;
  let actual: ProcessorInput | undefined;
  const plugin: BackendPluginRegistration = { id: "processor-held-extra", enabled: true, factory: () => ({ capabilities: [{
    contract: selected, implementationId: "local", scopes: ["space"], execution: "inline",
    inputSchema: processorInput, outputSchema: Type.Object({ text: Type.String() }, { additionalProperties: false }),
    inputResources() { assert(extra); return [extra]; },
    async invoke(input, context) {
      assert(Check(processorInput, input) && context.content && extra);
      actual = structuredClone(input);
      entered.release();
      await release.promise;
      assert.equal(context.signal.aborted, false);
      return { text: (await context.content.blobs.get(extra.id)).toString("utf8") };
    },
  }] }) };
  const f = await fixture(t, { plugins: [plugin] });
  const seed = await f.open();
  const saving = await f.client.call("display.open", { spaceId: f.space.id, instanceId: randomUUID(),
    source: { kind: "artifact", artifact: seed.artifact, initialData: { fixed: "原始初始化" } },
    saveNewResult: { path: "original-result.json", inputSchema: { ...pageSchema } } });
  await f.client.call("display.close", key(seed));
  const saveId = randomUUID();
  await f.client.call("display.invoke", { ...key(saving), requestId: saveId, action: SAVE_NEW_RESULT,
    input: { answer: "先前页面保存的回答" } });
  assert.equal((await f.finished(saveId)).status, "completed");
  await f.client.call("display.close", key(saving));
  const document = await f.client.call("content.get", { target: f.target("original-result.json") });
  assert(document.ref && document.revision);
  const prepared = await f.client.uploadResource(f.space.id, Buffer.from("只在结果文档登记的额外资源\n"), "text/plain");
  extra = prepared.resource;
  const compositionId = randomUUID();
  await f.client.call("content.setComposition", { ref: document.ref, operationId: compositionId,
    base: document.revision, members: document.members, resources: [...document.resources, extra] });
  await f.client.call("resource.release", { spaceId: f.space.id, id: prepared.id });
  const instance = await f.client.call("display.open", { spaceId: f.space.id, instanceId: randomUUID(),
    source: { kind: "content", target: f.target("original-result.json") },
    processResult: { selection: { contract: selected }, inputSchema: { ...pageSchema } } });
  assert(instance.hold.resources.some(resource => resource.id === extra.id));
  assert.equal(instance.artifact.resources.some(resource => resource.id === extra.id), false);
  const requestId = randomUUID();
  try {
    const accepted = await f.client.call("display.invoke", { ...key(instance), requestId, action: PROCESS_RESULT,
      input: { answer: "重开页面的新回答" } });
    assert("operation" in accepted);
    const part = accepted.input.parts[0];
    assert(part?.kind === "data" && part.representation.value.kind === "inline");
    assert.deepEqual(part.representation.format, selected);
    const capInput = part.representation.value.data;
    assert(Check(processorInput, capInput));
    assert.equal(capInput.operationId, requestId);
    assert.deepEqual(capInput.result.value.data.initialData, { answer: "先前页面保存的回答" });
    assert.deepEqual(capInput.result.value.data.input, { answer: "重开页面的新回答" });
    assert.deepEqual(capInput.result.value.data.artifact, instance.artifact);
    assert.equal(capInput.result.resources.some(resource => resource.id === extra.id), false);
    assert.deepEqual(part.representation.resources, [...capInput.result.resources, extra]);
    await entered.promise;
    await f.client.call("display.close", key(instance));
    const latest = await f.client.call("content.get", { target: f.target("original-result.json") });
    assert(latest.bodyRevision);
    const removeId = randomUUID();
    await f.client.call("content.remove", { target: f.target("original-result.json"), base: latest.bodyRevision, operationId: removeId });
    await f.client.call("operation.prune", { spaceId: f.space.id, operationIds: [saveId, compositionId, removeId] });
    await f.client.call("resource.collect", { spaceId: f.space.id });
    assert.equal(await (await f.client.resource(extra)).text(), "只在结果文档登记的额外资源\n");
  } finally { release.release(); }
  const completed = await f.finished(requestId);
  assert.equal(completed.status, "completed", JSON.stringify(completed));
  assert(completed.result?.value.kind === "inline");
  assert.deepEqual(completed.result.value.data, { text: "只在结果文档登记的额外资源\n" });
  assert(actual);
  const savedPart = completed.input.parts[0];
  assert(savedPart?.kind === "data" && savedPart.representation.value.kind === "inline");
  assert.deepEqual(savedPart.representation.value.data, actual);
  await f.reopen();
  assert.deepEqual(await f.client.call("request.get", { spaceId: f.space.id, requestId }), completed);
  await f.client.call("resource.collect", { spaceId: f.space.id });
  assert.equal(await (await f.client.resource(extra)).text(), "只在结果文档登记的额外资源\n");
});
