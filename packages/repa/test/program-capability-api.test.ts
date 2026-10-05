import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { CapabilityScopeSchema, CapabilitySourceSchema } from "../src/capabilities/schema.js";
import type { RepaCapabilityServices } from "../src/capabilities/services.js";
import type { BackendPluginRegistration, CapabilityDefinition } from "../src/capabilities/types.js";
import { RepaClient } from "../src/client.js";
import { ResourceRefSchema } from "../src/content/schema.js";
import { ExecutionViewSchema, RepresentationSchema, type ResourceRef } from "../src/protocol.js";
import { object } from "../src/schema.js";
import { startRepaServer } from "../src/server.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const savedSchema = object({
  operationId: Type.String(), value: Type.String(), scope: CapabilityScopeSchema, source: CapabilitySourceSchema,
});

function deferred() {
  let resolve = () => {};
  let resolved = false;
  const promise = new Promise<void>(done => { resolve = () => { resolved = true; done(); }; });
  return { promise, resolve, get resolved() { return resolved; } };
}

async function until<T>(read: () => T | Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= deadline) assert.fail(`等待程序调用状态超时：${JSON.stringify(value)}`);
    await delay(10);
  }
}

async function fixture(t: TestContext, plugins: readonly BackendPluginRegistration[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-program-capability-api-"));
  const agentDir = path.join(root, "agent");
  const appDirectory = path.join(root, "app");
  const directory = path.join(root, "space");
  const home = path.join(root, "home");
  await mkdir(agentDir);
  await mkdir(home);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: [], extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"],
    retry: { enabled: false }, compaction: { enabled: false },
  }));
  const faux = fauxProvider({
    api: `repa-program-api-${randomUUID()}`, provider: `repa-program-provider-${randomUUID()}`,
    models: [{ id: "test", reasoning: false, input: ["text"], contextWindow: 16384, maxTokens: 512 }],
    tokensPerSecond: 0,
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const options = {
    agentDir, appDirectory, plugins, modelOverride: { modelRuntime, model: faux.getModel() }, trustExtensions: false,
  };
  let server = await startRepaServer(options);
  let client = await RepaClient.connect(server.connection);
  const names = ["HOME", "BASH_ENV", "ENV"];
  const previous = names.map(name => process.env[name]);
  process.env.HOME = home;
  delete process.env.BASH_ENV;
  delete process.env.ENV;
  t.after(async () => {
    try {
      await server.close("cancel");
      await client.close();
    } finally {
      for (const [index, name] of names.entries()) {
        const value = previous[index];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
  const space = await client.call("space.open", { path: directory });
  const session = await client.call("session.create", { spaceId: space.id });
  const key = { spaceId: space.id, sessionId: session.sessionId };
  const settings = await client.call("settings.get", { scope: { kind: "application" }, namespace: "execution" });
  const policy = settings.entries.find(entry => entry.key === "default");
  assert(policy);
  await client.call("settings.set", {
    scope: { kind: "application" }, namespace: "execution", key: "default", value: { mode: "full-access" }, base: policy.revision,
  });
  const program = async (body: string) => {
    const file = path.join(directory, `${randomUUID()}.mjs`);
    await writeFile(file, `const { getProgramClient } = await import(process.env.REPA_PROGRAM_CLIENT);
const repa = getProgramClient();
try {
${body}
} finally {
  repa.close();
}
`);
    return `${quote(process.execPath)} ${quote(file)}`;
  };
  const finished = (requestId: string) => until(
    () => client.call("request.get", { spaceId: space.id, requestId }),
    request => ["completed", "failed", "cancelled", "interrupted"].includes(request.status),
  );
  const send = async (command: string) => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" }),
      context => {
        const result = context.messages.findLast(message => message.role === "toolResult");
        assert(result?.role === "toolResult");
        assert.equal(result.toolName, "bash");
        assert.equal(result.isError, false, JSON.stringify(result));
        return fauxAssistantMessage("程序调用完成");
      },
    ]);
    const accepted = await client.call("session.submit", {
      target: key, requestId: randomUUID(), input: { parts: [{ kind: "text", text: "运行空间中的程序" }] }, dispatch: { kind: "start" },
    });
    assert.equal((await finished(accepted.requestId)).status, "completed");
    return accepted;
  };
  const reopen = async () => {
    await server.close("cancel");
    await client.close();
    server = await startRepaServer(options);
    client = await RepaClient.connect(server.connection);
    assert.equal((await client.call("space.open", { path: directory })).id, space.id);
  };
  return { directory, space, key, program, send, finished, reopen, get client() { return client; } };
}

test("Agent 的 Node 程序发现空间能力并并发保存，业务记录沿用同一 Agent 请求来源", async (t) => {
  const inputSchema = object({ operationId: Type.String(), value: Type.String() });
  const outputSchema = object({ value: Type.String() });
  const contract = { id: "example.program.save", version: "1" };
  const save: CapabilityDefinition<typeof inputSchema, typeof outputSchema, object, string> = {
    contract, implementationId: "files", inputSchema, outputSchema, scopes: ["space"], execution: "background",
    async invoke(input, context) {
      assert(context.spaceRuntime);
      await writeFile(path.join(context.spaceRuntime, `${input.operationId}.json`), JSON.stringify({
        ...input, scope: context.scope, source: context.source,
      }));
      return { value: input.value };
    },
  };
  const f = await fixture(t, [{
    id: "program-save", enabled: true, factory: () => ({ capabilities: [save], openSpace: context => context.dataDirectory }),
  }]);
  const values = ["第一条业务记录", "第二条业务记录"];
  const operations = values.map(value => ({ operationId: randomUUID(), value }));
  const command = await f.program(`
  const capabilities = await repa.describe();
  const selected = capabilities.find(item => item.contract.id === ${JSON.stringify(contract.id)});
  if (!selected || selected.implementationId !== "files") throw new Error("缺少当前空间能力");
  const results = await Promise.all(${JSON.stringify(operations)}.map(input => repa.invoke({
    contract: ${JSON.stringify(contract)}, implementationId: selected.implementationId, input,
  })));
  console.log(JSON.stringify(results));`);
  const accepted = await f.send(command);
  assert(accepted.runId);
  for (const input of operations) {
    const saved: unknown = JSON.parse(await readFile(path.join(f.directory, ".repa/plugins/program-save", `${input.operationId}.json`), "utf8"));
    assert(Check(savedSchema, saved));
    assert.deepEqual(saved, {
      ...input, scope: { kind: "space", spaceId: f.space.id },
      source: { kind: "agent", ...f.key, runId: accepted.runId, requestId: accepted.requestId },
    });
  }
  const history = await f.client.call("session.get", f.key);
  const tool = history.messages.find(message => message.role === "tool" && message.name === "bash");
  assert(tool);
  const text = tool.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  for (const value of values) assert(text.includes(value));
  assert.deepEqual(await readdir(path.join(f.directory, ".repa/runtime/processing")), []);
});

test("取消父命令会中止在途能力，父请求等能力收尾完成且此前保存的变更保留", async (t) => {
  const entered = deferred();
  const aborted = deferred();
  const cleanup = deferred();
  let cleaned = false;
  t.after(() => { cleanup.resolve(); });
  const inputSchema = object({ operationId: Type.String() });
  const contract = { id: "example.program.wait", version: "1" };
  const waiting: CapabilityDefinition<typeof inputSchema, typeof savedSchema, object, string> = {
    contract, implementationId: "files", inputSchema, outputSchema: savedSchema, scopes: ["space"], execution: "background",
    async invoke(input, context) {
      assert(context.spaceRuntime);
      const saved = { ...input, value: "取消前已保存", scope: context.scope, source: context.source };
      await writeFile(path.join(context.spaceRuntime, `${input.operationId}.json`), JSON.stringify(saved));
      try {
        await new Promise<void>(resolve => {
          const cancel = () => { aborted.resolve(); resolve(); };
          if (context.signal.aborted) cancel();
          else context.signal.addEventListener("abort", cancel, { once: true });
          entered.resolve();
        });
        context.signal.throwIfAborted();
        return saved;
      } finally {
        await cleanup.promise;
        await writeFile(path.join(context.spaceRuntime, "cleanup.txt"), "收尾完成");
        cleaned = true;
      }
    },
  };
  const f = await fixture(t, [{
    id: "program-wait", enabled: true, factory: () => ({ capabilities: [waiting], openSpace: context => context.dataDirectory }),
  }]);
  const operationId = randomUUID();
  const command = await f.program(`await repa.invoke({ contract: ${JSON.stringify(contract)}, input: { operationId: ${JSON.stringify(operationId)} } });`);
  const accepted = await f.client.call("execution.run", { spaceId: f.space.id, requestId: randomUUID(), command });
  await until(() => entered.resolved, value => value);
  const active = (await f.client.call("execution.inspect", { spaceId: f.space.id })).active[0];
  assert(active);
  const cancelling = f.client.call("request.cancel", { spaceId: f.space.id, requestId: accepted.requestId });
  try {
    await until(() => aborted.resolved, value => value);
    assert.equal(cleaned, false);
    const pending = await f.client.call("request.get", { spaceId: f.space.id, requestId: accepted.requestId });
    assert(!["completed", "failed", "cancelled", "interrupted"].includes(pending.status), JSON.stringify(pending));
  } finally {
    cleanup.resolve();
    await cancelling;
  }
  const finished = await f.finished(accepted.requestId);
  assert.equal(finished.status, "cancelled", JSON.stringify(finished));
  assert.equal(cleaned, true);
  assert.equal(await readFile(path.join(f.directory, ".repa/plugins/program-wait/cleanup.txt"), "utf8"), "收尾完成");
  const saved: unknown = JSON.parse(await readFile(path.join(f.directory, ".repa/plugins/program-wait", `${operationId}.json`), "utf8"));
  assert(Check(savedSchema, saved));
  assert.deepEqual(saved, { operationId, value: "取消前已保存", scope: { kind: "space", spaceId: f.space.id }, source: active.source });
  assert("operation" in finished && finished.result?.value.kind === "inline");
  assert(Check(ExecutionViewSchema, finished.result.value.data));
  assert.equal(finished.result.value.data.status, "cancelled");
  assert.deepEqual(await readdir(path.join(f.directory, ".repa/runtime/processing")), [`${accepted.requestId}.json`]);
  assert.deepEqual((await f.client.call("execution.inspect", { spaceId: f.space.id })).active, []);
});

test("父命令超时解除能力的确认等待，清理交互并等待能力收尾后完成父请求", async (t) => {
  const cleanupEntered = deferred();
  const cleanupRelease = deferred();
  let aborted = false;
  let cleaned = false;
  t.after(() => { cleanupRelease.resolve(); });
  const contract = { id: "example.program.confirm", version: "1" };
  const inputSchema = object({});
  const outputSchema = Type.Boolean();
  const confirmation: CapabilityDefinition<typeof inputSchema, typeof outputSchema, RepaCapabilityServices> = {
    contract, implementationId: "confirm", inputSchema, outputSchema, scopes: ["space"], execution: "background",
    async invoke(_input, context) {
      assert(context.services?.ask);
      try {
        const answer = await context.services.ask({ kind: "confirm", title: "确认程序操作" });
        context.signal.throwIfAborted();
        return answer === true;
      } finally {
        aborted = context.signal.aborted;
        cleanupEntered.resolve();
        await cleanupRelease.promise;
        cleaned = true;
      }
    },
  };
  const f = await fixture(t, [{ id: "program-confirm", enabled: true, factory: () => ({ capabilities: [confirmation] }) }]);
  const command = await f.program(`await repa.invoke({ contract: ${JSON.stringify(contract)}, input: {} });`);
  const accepted = await f.client.call("execution.run", {
    spaceId: f.space.id, requestId: randomUUID(), command, timeout: 0.5,
  });
  const waiting = await until(
    () => f.client.call("request.get", { spaceId: f.space.id, requestId: accepted.requestId }),
    request => "interactions" in request && request.interactions.length > 0,
  );
  assert("operation" in waiting);
  const interaction = waiting.interactions[0];
  assert(interaction && "requestId" in interaction);
  assert.equal(interaction.kind, "confirm");
  assert.equal(interaction.requestId, accepted.requestId);
  try {
    await until(() => cleanupEntered.resolved, value => value);
    assert.equal(aborted, true);
    assert.equal(cleaned, false);
    const pending = await f.client.call("request.get", { spaceId: f.space.id, requestId: accepted.requestId });
    assert("operation" in pending);
    assert.deepEqual(pending.interactions, []);
    assert(!["completed", "failed", "cancelled", "interrupted"].includes(pending.status), JSON.stringify(pending));
  } finally {
    cleanupRelease.resolve();
  }
  const finished = await f.finished(accepted.requestId);
  assert.equal(finished.status, "completed", JSON.stringify(finished));
  assert.equal(cleaned, true);
  assert("operation" in finished && finished.result?.value.kind === "inline");
  assert.deepEqual(finished.interactions, []);
  assert(Check(ExecutionViewSchema, finished.result.value.data));
  assert.equal(finished.result.value.data.status, "failed");
  assert.equal(finished.result.value.data.error?.code, "execution_failed");
  assert.deepEqual((await f.client.call("execution.inspect", { spaceId: f.space.id })).active, []);
});

test("Node 程序打印能力交付的资源后，完成与重开保留字节，复制空间迁移会话结果资源归属", async (t) => {
  const contract = { id: "example.program.document", version: "1" };
  const inputSchema = object({});
  const outputSchema = object({ resource: ResourceRefSchema });
  const text = "程序能力交付的文档\n重开后继续使用。\n";
  let resource: ResourceRef | undefined;
  const document: CapabilityDefinition<typeof inputSchema, typeof outputSchema> = {
    contract, implementationId: "text", inputSchema, outputSchema, scopes: ["space"], execution: "inline",
    outputResources: output => [output.resource],
    async invoke(_input, context) {
      assert(context.content && context.scope.kind === "space");
      resource = { spaceId: context.scope.spaceId, id: await context.content.blobs.put(text), mediaType: "text/plain" };
      return { resource };
    },
  };
  const f = await fixture(t, [{ id: "program-document", enabled: true, factory: () => ({ capabilities: [document] }) }]);
  const command = await f.program(`console.log(JSON.stringify(await repa.invoke({ contract: ${JSON.stringify(contract)}, input: {} })));`);
  const accepted = await f.send(command);
  assert(resource);
  const delivered = resource;
  const history = await f.client.call("session.get", f.key);
  const tool = history.messages.find(message => message.role === "tool" && message.name === "bash");
  assert(tool && Check(RepresentationSchema, tool.details));
  assert.deepEqual(tool.details.resources, [delivered]);
  assert(tool.content.some(part => part.type === "text" && part.text.includes(delivered.id)));
  await f.client.call("resource.collect", { spaceId: f.space.id });
  assert.equal(await (await f.client.resource(delivered)).text(), text);
  await f.reopen();
  await f.client.call("resource.collect", { spaceId: f.space.id });
  assert.equal(await (await f.client.resource(delivered)).text(), text);
  const reopened = await f.client.call("session.get", f.key);
  const savedTool = reopened.messages.find(message => message.id === tool.id);
  assert(savedTool && Check(RepresentationSchema, savedTool.details));
  assert.deepEqual(savedTool.details.resources, [delivered]);
  assert(savedTool.details.value.kind === "inline" && Check(ExecutionViewSchema, savedTool.details.value.data));
  assert.deepEqual(savedTool.details.value.data.resources, [delivered]);
  const retentionSchema = object({ version: Type.Literal(1), owners: Type.Record(Type.String(), Type.Array(Type.String())), leases: Type.Unknown() });
  const retention: unknown = JSON.parse(await readFile(path.join(f.directory, ".repa/content/resources.json"), "utf8"));
  assert(Check(retentionSchema, retention));
  assert(retention.owners[`session:${f.key.sessionId}`]?.includes(delivered.id));
  assert(!retention.owners[`request:${accepted.requestId}`]?.includes(delivered.id));
  const copy = await f.client.call("space.copy", {
    spaceId: f.space.id, operationId: randomUUID(), destination: path.join(path.dirname(f.directory), "copied-space"),
  });
  assert.equal(copy.status, "completed", copy.error?.message);
  const copied = await f.client.call("space.open", { path: copy.destination });
  assert.notEqual(copied.id, f.space.id);
  const copiedHistory = await f.client.call("session.get", { ...f.key, spaceId: copied.id });
  const copiedTool = copiedHistory.messages.find(message => message.id === tool.id);
  assert(copiedTool && Check(RepresentationSchema, copiedTool.details));
  const copiedResource = { ...delivered, spaceId: copied.id };
  assert.deepEqual(copiedTool.details.resources, [copiedResource]);
  assert(copiedTool.details.value.kind === "inline" && Check(ExecutionViewSchema, copiedTool.details.value.data));
  const copiedExecution = copiedTool.details.value.data;
  assert.equal(copiedExecution.spaceId, copied.id);
  assert(copiedExecution.source.kind === "agent");
  assert.equal(copiedExecution.source.spaceId, copied.id);
  assert.deepEqual(copiedExecution.resources, [copiedResource]);
  assert.equal(copiedExecution.command, command);
  assert.equal(copiedExecution.cwd, f.directory);
  await f.client.call("resource.collect", { spaceId: copied.id });
  assert.equal(await (await f.client.resource(copiedResource)).text(), text);
  assert.equal(await (await f.client.resource(delivered)).text(), text);
});
