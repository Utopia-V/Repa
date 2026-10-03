import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BackendPluginRegistration, CapabilityDefinition } from "../src/capabilities/types.js";
import type { RepaCapabilityServices } from "../src/capabilities/services.js";
import { object } from "../src/schema.js";
import { ExecutionInputSchema } from "../src/execution/schema.js";
import { Check } from "typebox/value";
import { RepaClient, RpcError } from "../src/client.js";
import { ExecutionViewSchema, RepresentationSchema, type ResourceRef, type ExecutionPolicy, type ExecutionView, type BackgroundRequest, type Params, type Change } from "../src/protocol.js";
import { startRepaServer } from "../src/server.js";

const fault = (code: string) => (error: unknown) => error instanceof RpcError &&
  error.data !== null && typeof error.data === "object" && "code" in error.data && error.data.code === code;
const restricted: ExecutionPolicy = { mode: "restricted", readPaths: [], writePaths: [], network: false };
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function until<T>(read: () => T | Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= deadline) assert.fail(`等待执行状态超时：${JSON.stringify(value)}`);
    await delay(10);
  }
}

async function fixture(t: TestContext, plugins: readonly BackendPluginRegistration[] = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-execution-api-"));
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
    api: `repa-execution-api-${randomUUID()}`, provider: `repa-execution-provider-${randomUUID()}`,
    models: [{ id: "test", reasoning: false, input: ["text"], contextWindow: 16384, maxTokens: 512 }],
    tokensPerSecond: 0,
  });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const options = { agentDir, appDirectory, plugins, modelOverride: { modelRuntime, model: faux.getModel() }, trustExtensions: false };
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
  const finished = async (requestId: string): Promise<BackgroundRequest> => {
    const result = await until(() => client.call("request.get", { spaceId: space.id, requestId }),
      request => ["completed", "failed", "cancelled", "interrupted"].includes(request.status));
    assert("operation" in result, JSON.stringify(result));
    return result;
  };
  const setPolicy = async (policy: ExecutionPolicy) => {
    const scope = { kind: "application" as const };
    const settings = await client.call("settings.get", { scope, namespace: "execution" });
    const entry = settings.entries.find(item => item.key === "default");
    assert(entry);
    await client.call("settings.set", { scope, namespace: "execution", key: "default", value: policy, base: entry.revision });
  };
  const run = (command: string, access?: Params<"execution.run">["access"]) => client.call("execution.run", {
    spaceId: space.id, requestId: randomUUID(), command, ...(access ? { access } : {}),
  });
  const reopen = async (prepare?: () => Promise<void>, openedDirectory = directory) => {
    await server.close("cancel");
    await client.close();
    await prepare?.();
    server = await startRepaServer(options);
    client = await RepaClient.connect(server.connection);
    const opened = await client.call("space.open", { path: openedDirectory });
    if (openedDirectory === directory) assert.equal(opened.id, space.id);
    return opened;
  };
  return { root, directory, home, space, key, faux, finished, setPolicy, run, reopen,
    get client() { return client; }, get server() { return server; } };
}

function execution(request: BackgroundRequest): ExecutionView {
  assert.deepEqual(request.result?.format, { id: "repa.execution", version: "1" });
  assert(request.result?.value.kind === "inline");
  assert(Check(ExecutionViewSchema, request.result.value.data));
  return request.result.value.data;
}

async function question(f: Awaited<ReturnType<typeof fixture>>, requestId: string) {
  const request = await until(() => f.client.call("request.get", { spaceId: f.space.id, requestId }),
    value => "interactions" in value && value.interactions.length > 0);
  assert("interactions" in request);
  const interaction = request.interactions[0];
  assert(interaction?.execution);
  assert.equal(interaction.kind, "confirm");
  assert.equal(interaction.execution.lifetime, "once");
  return interaction;
}

test("受限命令真实完成，扩大权限等待、拒绝和取消均不执行，单次授权不改变默认策略", async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.client.call("execution.inspect", { spaceId: f.space.id })).policy, restricted);
  const plain = execution(await f.finished((await f.run("printf 'ordinary-output'; printf 'saved' > ordinary.txt")).requestId));
  assert.equal(plain.status, "completed", JSON.stringify(plain));
  assert.equal(plain.output, "ordinary-output");
  assert.equal(await readFile(path.join(f.directory, "ordinary.txt"), "utf8"), "saved");
  await assert.rejects(f.client.call("settings.set", {
    scope: { kind: "space", spaceId: f.space.id }, namespace: "execution", key: "default",
    value: { mode: "full-access" }, base: "unset",
  }), fault("configuration"));
  const outside = path.join(f.root, "outside.txt");
  const access = { policy: { mode: "full-access" as const }, reason: "本次写入已选外部文件" };
  const denied = await f.run(`printf denied > ${quote(outside)}`, access);
  const denial = await question(f, denied.requestId);
  assert(!existsSync(outside));
  assert.equal(denial.execution?.command, `printf denied > ${quote(outside)}`);
  assert.equal((await f.client.call("execution.inspect", { spaceId: f.space.id })).active[0]?.status, "authorizing");
  await f.client.call("interaction.reply", { responseId: randomUUID(), spaceId: f.space.id, id: denial.id, value: false });
  assert.equal(execution(await f.finished(denied.requestId)).error?.code, "permission_denied");
  assert(!existsSync(outside));
  const cancelled = await f.run(`printf cancelled > ${quote(outside)}`, access);
  const late = await question(f, cancelled.requestId);
  await f.client.call("request.cancel", { spaceId: f.space.id, requestId: cancelled.requestId });
  const terminal = await f.finished(cancelled.requestId);
  assert.equal(terminal.status, "cancelled");
  assert.equal(execution(terminal).status, "cancelled");
  await assert.rejects(f.client.call("interaction.reply", { responseId: randomUUID(), spaceId: f.space.id, id: late.id, value: true }), fault("interaction_expired"));
  assert(!existsSync(outside));
  const allowed = await f.run(`printf once > ${quote(outside)}`, access);
  const approval = await question(f, allowed.requestId);
  await f.client.call("interaction.reply", { responseId: randomUUID(), spaceId: f.space.id, id: approval.id, value: true });
  assert.equal(execution(await f.finished(allowed.requestId)).status, "completed");
  assert.equal(await readFile(outside, "utf8"), "once");
  assert.deepEqual((await f.client.call("execution.inspect", { spaceId: f.space.id })).policy, restricted);
  await f.finished((await f.run(`printf forbidden > ${quote(outside)}`)).requestId);
  const noGrant = execution(await f.finished((await f.run(`cat ${quote(outside)}`)).requestId));
  assert.equal(noGrant.status, "failed", JSON.stringify(noGrant));
  assert.equal(await readFile(outside, "utf8"), "once");
});

test("公开 Full Access 调用使用登录配置中的工具与用户目录", async (t) => {
  const f = await fixture(t);
  const bin = path.join(f.home, "bin");
  await mkdir(bin);
  await writeFile(path.join(f.home, "tool.conf"), "user-configuration\n");
  await writeFile(path.join(f.home, ".bash_profile"), 'export PATH="$HOME/bin:$PATH"\n');
  const tool = path.join(bin, "repa-user-tool");
  await writeFile(tool, '#!/bin/sh\ncat "$HOME/tool.conf"\npwd\n');
  await chmod(tool, 0o755);
  await f.setPolicy({ mode: "full-access" });

  const result = execution(await f.finished((await f.run("repa-user-tool")).requestId));
  assert.equal(result.status, "completed", result.output);
  assert.equal(result.output, `user-configuration\n${f.directory}\n`);
});

test("Full Access 无额外交互，输出事件与重连快照归属父请求，取消和策略收回等待进程收尾", async (t) => {
  const f = await fixture(t);
  await f.setPolicy({ mode: "full-access" });
  const changes: Change[] = [];
  const watch = await f.client.watch({ spaceId: f.space.id }, (_snapshot, delivery) => {
    if (delivery.type === "changes") changes.push(...delivery.changes);
  });
  const params = { spaceId: f.space.id, requestId: randomUUID(), command: "printf 'started\n'; sleep 30" };
  const accepted = await f.client.call("execution.run", params);
  const active = await until(() => f.client.call("execution.inspect", { spaceId: f.space.id }), state => state.active[0]?.status === "running");
  assert.equal(active.active[0]?.requestId, accepted.requestId);
  assert.equal(active.active[0]?.source.kind, "client");
  assert.equal((await f.client.call("execution.run", params)).requestId, accepted.requestId);
  assert.equal((await f.client.call("execution.inspect", { spaceId: f.space.id })).active.length, 1);
  await until(() => changes, values => values.some(change => change.type === "execution_output" && change.text.includes("started")));
  const resumed = await RepaClient.connect(f.server.connection, { hostKey: f.client.hostKey });
  t.after(() => resumed.close());
  const snapshot = await resumed.call("state.get", { scope: { spaceId: f.space.id } });
  assert.equal(snapshot.execution?.[0]?.id, active.active[0]?.id);
  assert.match(snapshot.execution?.[0]?.output ?? "", /started/);
  assert.deepEqual((await f.client.call("state.get", { scope: f.key })).execution, []);
  await f.client.call("request.cancel", { spaceId: f.space.id, requestId: accepted.requestId });
  const cancelled = await f.finished(accepted.requestId);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(execution(cancelled).status, "cancelled");
  assert.match(execution(cancelled).output, /started/);
  assert.deepEqual((await f.client.call("execution.inspect", { spaceId: f.space.id })).active, []);
  const revoked = await f.run("printf 'revoke\n'; sleep 30");
  await until(() => f.client.call("execution.inspect", { spaceId: f.space.id }), state => state.active[0]?.status === "running");
  await f.setPolicy(restricted);
  assert.deepEqual((await f.client.call("execution.inspect", { spaceId: f.space.id })).active, []);
  assert.equal(execution(await f.finished(revoked.requestId)).error?.code, "permission_revoked");
  await watch.stop();
});

test("原请求重传、后端重启和空间复制不再次执行命令，截断输出资源仍可读取", async (t) => {
  const f = await fixture(t);
  const params = { spaceId: f.space.id, requestId: randomUUID(), command: "printf x >> executions.txt; seq 1 12000" };
  await f.client.call("execution.run", params);
  const completed = await f.finished(params.requestId);
  const result = execution(completed);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.truncated, true);
  assert(result.fullOutput);
  assert.deepEqual(completed.result?.resources, [result.fullOutput]);
  assert.match(await (await f.client.resource(result.fullOutput)).text(), /^1\n2\n/);
  assert.deepEqual(await f.client.call("execution.run", params), completed);
  await f.reopen();
  assert.deepEqual(await f.client.call("execution.run", params), completed);
  assert.equal(await readFile(path.join(f.directory, "executions.txt"), "utf8"), "x");
  const destination = path.join(f.root, "copied-space");
  await f.client.call("space.copy", { operationId: randomUUID(), spaceId: f.space.id, destination });
  const copied = await f.client.call("space.open", { path: destination });
  const replay = await f.client.call("execution.run", { ...params, spaceId: copied.id });
  const historical = execution(replay);
  assert.equal(replay.status, "completed");
  assert.equal(historical.spaceId, copied.id);
  assert.equal(historical.cwd, f.directory);
  assert.equal(historical.fullOutput?.spaceId, copied.id);
  assert.equal(await readFile(path.join(destination, "executions.txt"), "utf8"), "x");
  assert(historical.fullOutput);
  assert.match(await (await f.client.resource(historical.fullOutput)).text(), /^1\n2\n/);
});

test("真实 Pi Agent 使用受归属 bash 工具，确认后执行且会话关闭取消尚在运行的命令", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, "agent-output.txt");
  await writeFile(path.join(f.home, ".bash_profile"), "export REPA_TEST_PROFILE=agent\n");
  let declared = false;
  f.faux.setResponses([context => {
    declared = getCurrentTools(context.messages).some(tool => tool.name === "bash");
    return fauxAssistantMessage(fauxToolCall("bash", {
      command: `printf '%s' "$REPA_TEST_PROFILE" > ${quote(outside)}`, access: { policy: { mode: "full-access" }, reason: "用户选定文件" },
    }), { stopReason: "toolUse" });
  }, fauxAssistantMessage("执行完成")]);
  const request = await f.client.call("session.submit", {
    target: f.key, requestId: randomUUID(), input: { parts: [{ kind: "text", text: "执行所选命令" }] }, dispatch: { kind: "start" },
  });
  const interaction = await until(() => f.client.call("session.get", f.key), view => view.interactions.length > 0);
  const approval = interaction.interactions[0];
  assert(approval?.execution);
  assert.equal(declared, true);
  assert(!existsSync(outside));
  const active = (await f.client.call("execution.inspect", { spaceId: f.space.id })).active[0];
  assert(active?.source.kind === "agent");
  assert.equal(active.source.requestId, request.requestId);
  assert.equal(active.source.sessionId, f.key.sessionId);
  assert.equal((await f.client.call("state.get", { scope: f.key })).execution?.[0]?.id, active.id);
  const other = await f.client.call("session.create", { spaceId: f.space.id });
  assert.deepEqual((await f.client.call("state.get", { scope: { spaceId: f.space.id, sessionId: other.sessionId } })).execution, []);
  await f.client.call("interaction.reply", { responseId: randomUUID(), ...f.key, id: approval.id, value: true });
  await until(() => f.client.call("request.get", { spaceId: f.space.id, requestId: request.requestId }), value => value.status === "completed");
  assert.equal(await readFile(outside, "utf8"), "agent");
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("bash", { command: "printf 'agent-running\n'; sleep 30" }), { stopReason: "toolUse" })]);
  const running = await f.client.call("session.submit", {
    target: f.key, requestId: randomUUID(), input: { parts: [{ kind: "text", text: "执行持续命令" }] }, dispatch: { kind: "start" },
  });
  await until(() => f.client.call("execution.inspect", { spaceId: f.space.id }), view => view.active[0]?.status === "running");
  await f.client.call("session.close", f.key);
  const cancelled = await f.client.call("request.get", { spaceId: f.space.id, requestId: running.requestId });
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual((await f.client.call("execution.inspect", { spaceId: f.space.id })).active, []);
});

test("失败和取消的截断输出仍保留在父结果，关闭后端等待活动命令退出", async (t) => {
  const f = await fixture(t);
  const failed = execution(await f.finished((await f.run("seq 1 12000; exit 7")).requestId));
  assert.equal(failed.status, "failed");
  assert.equal(failed.exitCode, 7);
  assert(failed.fullOutput);
  assert.match(await (await f.client.resource(failed.fullOutput)).text(), /^1\n2\n/);
  assert(!failed.output.includes("/tmp/pi-bash-"));
  const changes: Change[] = [];
  const watch = await f.client.watch({ spaceId: f.space.id }, (_snapshot, delivery) => {
    if (delivery.type === "changes") changes.push(...delivery.changes);
  });
  const request = await f.run("seq 1 12000; printf 'ready-for-cancel\n'; sleep 30");
  await until(() => changes, values => values.some(value => value.type === "execution_output" && value.text.includes("ready-for-cancel")));
  await f.client.call("request.cancel", { spaceId: f.space.id, requestId: request.requestId });
  const cancelled = await f.finished(request.requestId);
  const result = execution(cancelled);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(result.status, "cancelled");
  assert(result.fullOutput);
  assert.deepEqual(cancelled.result?.resources, [result.fullOutput]);
  assert.match(await (await f.client.resource(result.fullOutput)).text(), /ready-for-cancel/);
  assert(!result.output.includes("/tmp/pi-bash-"));
  await watch.stop();
  const stopping = await f.run("printf 'shutdown-running\n'; sleep 30");
  await until(() => f.client.call("execution.inspect", { spaceId: f.space.id }), state => state.active[0]?.status === "running");
  await f.server.close("cancel");
  const record: unknown = JSON.parse(await readFile(path.join(f.directory, ".repa/runtime/processing", `${stopping.requestId}.json`), "utf8"));
  assert(record !== null && typeof record === "object" && "request" in record);
  const saved = record.request;
  assert(saved !== null && typeof saved === "object" && "status" in saved);
  assert.equal(saved.status, "cancelled");
});

test("前端关联的外部材料进入精确只读路径，符号链接替换不继承旧授权", async (t) => {
  const f = await fixture(t);
  const external = path.join(f.root, "external-material.txt");
  const replacement = path.join(f.root, "unapproved.txt");
  await writeFile(external, "authorized-material");
  await writeFile(replacement, "unapproved-material");
  await f.client.call("content.associate", {
    spaceId: f.space.id, operationId: randomUUID(), location: { kind: "external", path: external }, role: "material",
  });
  const policy = (await f.client.call("execution.inspect", { spaceId: f.space.id })).policy;
  assert(policy.mode === "restricted");
  assert.deepEqual(policy.readPaths, [external]);
  const read = execution(await f.finished((await f.run(`cat ${quote(external)}`)).requestId));
  assert.equal(read.status, "completed", JSON.stringify(read));
  assert.equal(read.output, "authorized-material");
  await rm(external);
  await symlink(replacement, external);
  const changed = (await f.client.call("execution.inspect", { spaceId: f.space.id })).policy;
  assert(changed.mode === "restricted");
  assert.deepEqual(changed.readPaths, []);
  await rm(replacement);
  const dangling = (await f.client.call("execution.inspect", { spaceId: f.space.id })).policy;
  assert(dangling.mode === "restricted");
  assert.deepEqual(dangling.readPaths, []);
});

test("可信能力的执行服务绑定能力请求和空间，应用作用域不暴露命令入口", async (t) => {
  const EmptySchema = object({});
  const AvailableSchema = object({ available: Type.Boolean() });
  const run: CapabilityDefinition<typeof ExecutionInputSchema, typeof ExecutionViewSchema, RepaCapabilityServices> = {
    contract: { id: "fixture.execution.run", version: "1" }, implementationId: "plain",
    inputSchema: ExecutionInputSchema, outputSchema: ExecutionViewSchema, scopes: ["space"], execution: "background",
    tool: { name: "capability_bash", description: "Run a command through the trusted capability." },
    outputResources: result => result.fullOutput ? [result.fullOutput] : [],
    invoke: async (input, context) => {
      assert(context.services?.execution);
      return context.services.execution.run(input);
    },
  };
  const available: CapabilityDefinition<typeof EmptySchema, typeof AvailableSchema, RepaCapabilityServices> = {
    contract: { id: "fixture.execution.available", version: "1" }, implementationId: "plain",
    inputSchema: EmptySchema, outputSchema: AvailableSchema, scopes: ["application"], execution: "inline",
    invoke: (_input, context) => ({ available: context.services?.execution !== undefined }),
  };
  let loaded = 0;
  const f = await fixture(t, [{ id: "execution-fixture", enabled: true, factory: () => {
    loaded++;
    return { capabilities: [run, available] };
  } }]);
  await f.client.call("settings.get", { scope: { kind: "application" }, namespace: "execution" });
  await f.setPolicy(restricted);
  assert.equal(loaded, 0);
  const app = await f.client.call("capability.invoke", {
    scope: { kind: "application" }, requestId: randomUUID(), contract: available.contract, input: {},
  });
  assert(app.kind === "inline");
  assert.deepEqual(app.result, { available: false });
  const requestId = randomUUID();
  const accepted = await f.client.call("capability.invoke", {
    scope: { kind: "space", spaceId: f.space.id }, requestId, contract: run.contract,
    input: { command: "printf capability > capability.txt" },
  });
  assert(accepted.kind === "background");
  const completed = await f.finished(requestId);
  assert(completed.result?.value.kind === "inline");
  assert(Check(ExecutionViewSchema, completed.result.value.data));
  const result = completed.result.value.data;
  assert.equal(result.requestId, requestId);
  assert.equal(result.spaceId, f.space.id);
  assert.equal(result.source.kind, "client");
  assert.equal(result.cwd, f.directory);
  assert.equal(result.status, "completed");
  assert.equal(await readFile(path.join(f.directory, "capability.txt"), "utf8"), "capability");
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("capability_bash", { command: "seq 1 12000" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("能力工具输出已保存"),
  ]);
  const agent = await f.client.call("session.submit", {
    target: f.key, requestId: randomUUID(), input: { parts: [{ kind: "text", text: "运行能力工具" }] }, dispatch: { kind: "start" },
  });
  await until(() => f.client.call("request.get", { spaceId: f.space.id, requestId: agent.requestId }), value => value.status === "completed");
  const history = await f.client.call("session.get", f.key);
  const message = history.messages.find(item => item.role === "tool" && item.name === "capability_bash");
  assert(Check(RepresentationSchema, message?.details));
  assert.equal(message.details.resources.length, 1);
  const resource = message.details.resources[0];
  assert(resource);
  await f.client.call("resource.collect", { spaceId: f.space.id });
  assert.match(await (await f.client.resource(resource)).text(), /^1\n2\n/);
  await f.client.call("session.remove", f.key);
  await f.client.call("resource.collect", { spaceId: f.space.id });
  assert(!existsSync(path.join(f.directory, ".repa/content/blobs", resource.id)));
});

test("失败 bash 的完整输出以标准工具结果保存，分页读取和分支在删除原会话后继续使用", async (t) => {
  const f = await fixture(t);
  let resource: ResourceRef | undefined;
  const text = (content: unknown): string => {
    if (!Array.isArray(content)) return "";
    return content.map((item: unknown) => item !== null && typeof item === "object" && "text" in item && typeof item.text === "string" ? item.text : "").join("\n");
  };
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "seq 1 12000; exit 7" }), { stopReason: "toolUse" }),
    context => {
      const message = context.messages.findLast(item => item.role === "toolResult");
      assert(message?.role === "toolResult");
      assert.equal(message.isError, true);
      assert(Check(RepresentationSchema, message.details));
      assert(message.details.value.kind === "inline");
      assert(Check(ExecutionViewSchema, message.details.value.data));
      const execution = message.details.value.data;
      assert.equal(execution.status, "failed");
      assert.equal(execution.exitCode, 7);
      assert(execution.fullOutput);
      resource = execution.fullOutput;
      assert.deepEqual(message.details.resources, [resource]);
      assert.match(text(message.content), new RegExp(`repa:resource/${resource.id}`));
      return fauxAssistantMessage(fauxToolCall("read", { path: `repa:resource/${resource.id}`, offset: 11999, limit: 2 }), { stopReason: "toolUse" });
    },
    context => {
      const message = context.messages.findLast(item => item.role === "toolResult");
      assert(message?.role === "toolResult");
      assert.equal(message.toolName, "read");
      assert.equal(message.isError, false);
      assert.match(text(message.content), /11999\n12000/);
      return fauxAssistantMessage("已读取命令末尾");
    },
  ]);
  const accepted = await f.client.call("session.submit", {
    target: f.key, requestId: randomUUID(), input: { parts: [{ kind: "text", text: "读取失败命令的完整输出" }] }, dispatch: { kind: "start" },
  });
  const finished = await until(() => f.client.call("request.get", { spaceId: f.space.id, requestId: accepted.requestId }),
    result => ["completed", "failed", "cancelled"].includes(result.status));
  assert.equal(finished.status, "completed", JSON.stringify(finished));
  assert(resource);
  const full = resource;
  const original = await f.client.call("session.get", f.key);
  const tool = original.messages.find(message => message.role === "tool" && message.name === "bash");
  assert(tool?.error);
  assert(Check(RepresentationSchema, tool.details));
  assert.deepEqual(tool.details.resources, [full]);
  const branch = await f.client.call("session.branch", { ...f.key, messageId: tool.id });
  const RetentionSchema = object({ version: Type.Literal(1), owners: Type.Record(Type.String(), Type.Array(Type.String())), leases: Type.Unknown() });
  const retentionFile = path.join(f.directory, ".repa/content/resources.json");
  await f.reopen(async () => {
    const saved: unknown = JSON.parse(await readFile(retentionFile, "utf8"));
    assert(Check(RetentionSchema, saved));
    // 模拟异常退出时仍存在的临时工具输出持有；恢复必须先读会话历史再清理它。
    saved.owners[`request:${accepted.requestId}`] = [full.id];
    await writeFile(retentionFile, JSON.stringify(saved));
  });
  await f.client.call("session.remove", f.key);
  await f.client.call("resource.collect", { spaceId: f.space.id });
  const retention: unknown = JSON.parse(await readFile(retentionFile, "utf8"));
  assert(Check(RetentionSchema, retention));
  assert(retention.owners[`session:${branch.sessionId}`]?.includes(full.id));
  assert.equal(retention.owners[`session:${f.key.sessionId}`], undefined);
  assert(!retention.owners[`request:${accepted.requestId}`]?.includes(full.id));
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: `repa:resource/${full.id}`, offset: 12000, limit: 1 }), { stopReason: "toolUse" }),
    context => {
      const message = context.messages.findLast(item => item.role === "toolResult");
      assert(message?.role === "toolResult");
      assert.equal(message.isError, false);
      assert.match(text(message.content), /12000/);
      return fauxAssistantMessage("分支保留的完整输出仍可读取");
    },
  ]);
  const continued = await f.client.call("session.submit", {
    target: { spaceId: f.space.id, sessionId: branch.sessionId }, requestId: randomUUID(),
    input: { parts: [{ kind: "text", text: "继续读取分支中的完整输出" }] }, dispatch: { kind: "start" },
  });
  const result = await until(() => f.client.call("request.get", { spaceId: f.space.id, requestId: continued.requestId }),
    value => ["completed", "failed", "cancelled"].includes(value.status));
  assert.equal(result.status, "completed", JSON.stringify(result));
  await f.client.call("session.remove", { spaceId: f.space.id, sessionId: branch.sessionId });
  const collected = await f.client.call("resource.collect", { spaceId: f.space.id });
  assert(collected.removed >= 1);
  assert(!existsSync(path.join(f.directory, ".repa/content/blobs", full.id)));
  await assert.rejects(f.client.resource(full));
});

test("保存不可生效的收紧策略仍停止各空间全部在途命令，修正设置后没有残留执行", async (t) => {
  const f = await fixture(t);
  await f.setPolicy({ mode: "full-access" });
  const second = await f.client.call("space.open", { path: path.join(f.root, "second-space") });
  const requests = await Promise.all([f.space.id, f.space.id, second.id].map(spaceId => f.client.call("execution.run", {
    spaceId, requestId: randomUUID(), command: "printf 'waiting-for-policy\n'; sleep 30",
  })));
  await until(async () => {
    const states = await Promise.all([f.space.id, second.id].map(spaceId => f.client.call("execution.inspect", { spaceId })));
    return states.flatMap(state => state.active);
  }, values => values.length === 3 && values.every(value => value.status === "running"));
  const invalid: ExecutionPolicy = { ...restricted, mode: "restricted", readPaths: [path.join(f.root, "missing-policy-path")] };
  await assert.rejects(f.setPolicy(invalid), fault("execution_policy_unavailable"));
  const scope = { kind: "application" as const };
  const view = await f.client.call("settings.get", { scope, namespace: "execution" });
  const saved = view.entries.find(entry => entry.key === "default");
  assert(saved);
  assert.deepEqual(saved.effective, invalid);
  for (const accepted of requests) {
    assert(accepted.spaceId);
    const finished = await f.client.call("request.get", { spaceId: accepted.spaceId, requestId: accepted.requestId });
    assert("operation" in finished);
    const result = execution(finished);
    assert.equal(result.status, "cancelled", JSON.stringify(result));
    assert.equal(result.error?.code, "permission_revoked");
    assert(result.finishedAt);
    assert(result.exitCode !== undefined);
    assert.notEqual(result.exitCode, 0);
  }
  await f.client.call("settings.reset", { scope, namespace: "execution", key: "default", base: saved.revision });
  for (const spaceId of [f.space.id, second.id]) {
    const state = await f.client.call("execution.inspect", { spaceId });
    assert.deepEqual(state.policy, restricted);
    assert.deepEqual(state.active, []);
  }
});

test("Pi 完整输出复制到新空间后无需打开原空间即可分页读取，最后会话删除后独立回收", async (t) => {
  const f = await fixture(t);
  const command = "seq 1 12000; exit 7";
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" }),
    fauxAssistantMessage("失败命令的完整输出已保存"),
  ]);
  const accepted = await f.client.call("session.submit", {
    target: f.key, requestId: randomUUID(), input: { parts: [{ kind: "text", text: "保存命令输出以供复制" }] }, dispatch: { kind: "start" },
  });
  const finished = await until(() => f.client.call("request.get", { spaceId: f.space.id, requestId: accepted.requestId }),
    value => ["completed", "failed", "cancelled"].includes(value.status));
  assert.equal(finished.status, "completed", JSON.stringify(finished));
  const original = await f.client.call("session.get", f.key);
  const sourceTool = original.messages.find(message => message.role === "tool" && message.name === "bash");
  assert(sourceTool?.error);
  assert(Check(RepresentationSchema, sourceTool.details));
  assert(sourceTool.details.value.kind === "inline");
  assert(Check(ExecutionViewSchema, sourceTool.details.value.data));
  const sourceExecution = sourceTool.details.value.data;
  assert(sourceExecution.fullOutput);
  const hash = sourceExecution.fullOutput.id;
  const destination = path.join(f.root, "copied-pi-output");
  await f.client.call("space.copy", { spaceId: f.space.id, operationId: randomUUID(), destination });
  const copied = await f.reopen(undefined, destination);
  assert.notEqual(copied.id, f.space.id);
  assert.deepEqual((await f.client.call("space.list", {})).map(space => space.id), [copied.id]);
  const key = { spaceId: copied.id, sessionId: f.key.sessionId };
  const history = await f.client.call("session.get", key);
  const tool = history.messages.find(message => message.id === sourceTool.id);
  assert(tool?.error);
  assert(Check(RepresentationSchema, tool.details));
  assert(tool.details.value.kind === "inline");
  assert(Check(ExecutionViewSchema, tool.details.value.data));
  const execution = tool.details.value.data;
  const resource = execution.fullOutput;
  assert(resource);
  assert.equal(execution.command, command);
  assert.equal(execution.cwd, f.directory);
  assert.equal(execution.spaceId, copied.id);
  assert(execution.source.kind === "agent");
  assert.equal(execution.source.spaceId, copied.id);
  assert.equal(resource.id, hash);
  assert.equal(resource.spaceId, copied.id);
  assert.deepEqual(tool.details.resources, [resource]);
  await f.client.call("resource.collect", { spaceId: copied.id });
  assert.match(await (await f.client.resource(resource)).text(), /^1\n2\n/);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: `repa:resource/${hash}`, offset: 11999, limit: 2 }), { stopReason: "toolUse" }),
    context => {
      const message = context.messages.findLast(item => item.role === "toolResult");
      assert(message?.role === "toolResult");
      assert.equal(message.toolName, "read");
      assert.equal(message.isError, false);
      const text = message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      assert.match(text, /11999\n12000/);
      return fauxAssistantMessage("新空间中的完整输出可读取");
    },
  ]);
  const resumed = await f.client.call("session.submit", {
    target: key, requestId: randomUUID(), input: { parts: [{ kind: "text", text: "读取复制后的完整输出末尾" }] }, dispatch: { kind: "start" },
  });
  const result = await until(() => f.client.call("request.get", { spaceId: copied.id, requestId: resumed.requestId }),
    value => ["completed", "failed", "cancelled"].includes(value.status));
  assert.equal(result.status, "completed", JSON.stringify(result));
  await f.client.call("session.remove", key);
  const collected = await f.client.call("resource.collect", { spaceId: copied.id });
  assert(collected.removed >= 1);
  assert(!existsSync(path.join(destination, ".repa/content/blobs", hash)));
  await assert.rejects(f.client.resource(resource));
  assert(existsSync(path.join(f.directory, ".repa/content/blobs", hash)));
});
