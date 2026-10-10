import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { defineTool, ModelRuntime, SettingsManager, type ExtensionFactory, type ToolExecutionEndEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAgentRuntimeForTest } from "../src/agent/runtime.js";
import type { AgentSpaceOptions } from "../src/agent.js";
import type { AgentEvent, Confirmation } from "../src/schema.js";

const parentToolName = "test_nested_bash";
const command = "printf 'permission granted\\n' > permission-effect.txt";
const fileContent = "permission granted\n";
type CallKind = "direct" | "nested";
type ToolEnd = Pick<ToolExecutionEndEvent, "toolCallId" | "toolName" | "parentToolCallId" | "isError" | "durationMs">;

async function fixture(t: TestContext, kind: CallKind, options: Pick<AgentSpaceOptions, "confirm"> & Partial<Pick<AgentSpaceOptions, "commandPolicy">>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-pi-permissions-"));
  let runtime: Awaited<ReturnType<typeof createAgentRuntimeForTest>> | undefined;
  t.after(async () => {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  });
  const agentDir = path.join(root, "app", "agent");
  await mkdir(agentDir, { recursive: true });
  const faux = fauxProvider({
    api: `repa-permissions-api-${randomUUID()}`,
    provider: `repa-permissions-provider-${randomUUID()}`,
    models: [{ id: "test", contextWindow: 16384, maxTokens: 512 }],
    tokensPerSecond: 0,
  });
  const models = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  models.registerNativeProvider(faux.provider);
  const toolEnds: ToolEnd[] = [];
  const extension: ExtensionFactory = pi => {
    pi.on("tool_execution_end", event => {
      toolEnds.push({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        parentToolCallId: event.parentToolCallId,
        isError: event.isError,
        durationMs: event.durationMs,
      });
    });
    if (kind === "nested") {
      // 只在测试中登记父工具，嵌套 bash 仍经过 Pi 和 Repa 的真实权限链。
      pi.registerTool(defineTool({
        name: parentToolName,
        label: "嵌套命令测试",
        description: "通过 SDK executeTool 执行 bash",
        parameters: Type.Object({ command: Type.String() }),
        async execute(_callId, input, _signal, _onUpdate, ctx) {
          const outcome = await ctx.executeTool("bash", { command: input.command });
          return { ...outcome.result, isError: outcome.isError };
        },
      }));
    }
  };
  runtime = await createAgentRuntimeForTest({
    agentDir,
    modelRuntime: models,
    defaultModel: { provider: faux.getModel().provider, id: "test" },
    settingsManager: SettingsManager.inMemory({
      retry: { enabled: false },
      compaction: { enabled: false },
      cacheWarming: "off",
    }),
    extensionFactories: [extension],
    toolNames: kind === "nested" ? [parentToolName] : [],
  });
  const events: AgentEvent[] = [];
  const confirmations: Confirmation[] = [];
  const space = await runtime.openSpace({
    root,
    sessionsDir: path.join(root, ".repa", "sessions"),
    instructions: () => [],
    tools: () => [],
    views: async () => [],
    overrides: async () => ({ app: {}, space: {} }),
    commandPolicy: options.commandPolicy ?? (() => "ask"),
    record: async (_id, action) => action(),
    onEvent: event => events.push(event),
    confirm: async (request, signal) => {
      confirmations.push(request);
      return options.confirm(request, signal);
    },
  });
  const session = await space.create();
  const call = fauxToolCall(kind === "nested" ? parentToolName : "bash", { command });
  faux.setResponses([
    fauxAssistantMessage(call),
    fauxAssistantMessage("命令调用已经结束"),
  ]);
  return { root, session, events, confirmations, toolEnds, call };
}

function assertConfirmation(confirmations: Confirmation[]) {
  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0]?.kind, "command");
  assert.equal(confirmations[0]?.message, command);
}

function assertBashResult(f: Awaited<ReturnType<typeof fixture>>, kind: CallKind, isError: boolean) {
  const bash = f.toolEnds.filter(event => event.toolName === "bash");
  assert.equal(bash.length, 1);
  const result = bash[0];
  assert(result);
  assert.equal(result.isError, isError);
  if (kind === "nested") {
    assert.equal(result.parentToolCallId, f.call.id);
    assert.equal(result.toolCallId, `${f.call.id}/1`);
    assert.equal(f.toolEnds.find(event => event.toolName === parentToolName)?.isError, isError);
  } else {
    assert.equal(result.parentToolCallId, undefined);
    assert.equal(result.toolCallId, f.call.id);
  }
  if (isError) assert.equal(result.durationMs, undefined);
}

async function assertNoEffect(root: string) {
  await assert.rejects(readFile(path.join(root, "permission-effect.txt")), { code: "ENOENT" });
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>(complete => {
    resolve = complete;
  });
  return { promise, resolve };
}

for (const kind of ["direct", "nested"] as const) {
  const label = kind === "direct" ? "普通 bash" : "父工具嵌套 bash";

  test(`${label} 允许确认后才产生文件`, { timeout: 10000 }, async t => {
    const started = deferred<void>();
    const answer = deferred<boolean>();
    t.after(() => answer.resolve(false));
    const f = await fixture(t, kind, {
      confirm: async () => {
        started.resolve();
        return answer.promise;
      },
    });
    const run = f.session.send("执行测试命令");
    await started.promise;
    await assertNoEffect(f.root);
    answer.resolve(true);
    await run;
    assertConfirmation(f.confirmations);
    assert.equal(await readFile(path.join(f.root, "permission-effect.txt"), "utf8"), fileContent);
    assertBashResult(f, kind, false);
  });

  test(`${label} 拒绝确认后返回工具错误且没有副作用`, { timeout: 10000 }, async t => {
    const f = await fixture(t, kind, { confirm: async () => false });
    await f.session.send("执行测试命令");
    assertConfirmation(f.confirmations);
    await assertNoEffect(f.root);
    assertBashResult(f, kind, true);
  });

  test(`${label} 确认服务抛错时返回工具错误且没有副作用`, { timeout: 10000 }, async t => {
    const f = await fixture(t, kind, {
      confirm: async () => {
        throw new Error("测试确认服务不可用");
      },
    });
    await f.session.send("执行测试命令");
    assertConfirmation(f.confirmations);
    await assertNoEffect(f.root);
    assertBashResult(f, kind, true);
  });

  test(`${label} 在 fullAccess 下直接执行而不询问`, { timeout: 10000 }, async t => {
    const f = await fixture(t, kind, {
      commandPolicy: () => "fullAccess",
      confirm: async () => {
        throw new Error("fullAccess 不应调用确认服务");
      },
    });
    await f.session.send("执行测试命令");
    assert.equal(f.confirmations.length, 0);
    assert.equal(await readFile(path.join(f.root, "permission-effect.txt"), "utf8"), fileContent);
    assertBashResult(f, kind, false);
  });

  test(`${label} 正在确认时取消，即使随后允许也不执行`, { timeout: 10000 }, async t => {
    const started = deferred<void>();
    const aborted = deferred<void>();
    const answer = deferred<boolean>();
    t.after(() => answer.resolve(false));
    const f = await fixture(t, kind, {
      confirm: async (_request, signal) => {
        assert(signal);
        signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        started.resolve();
        return answer.promise;
      },
    });
    const run = f.session.send("执行测试命令");
    // 取消可以使 send 抛出 cancelled，也可以以 SDK aborted 终态结束。
    const settled = run.then(() => undefined, error => {
      assert(error !== null && typeof error === "object" && "code" in error);
      assert.equal(error.code, "cancelled");
    });
    await started.promise;
    await assertNoEffect(f.root);
    const cancel = f.session.abort();
    await aborted.promise;
    answer.resolve(true);
    await cancel;
    await settled;
    assertConfirmation(f.confirmations);
    await assertNoEffect(f.root);
    assertBashResult(f, kind, true);
    assert(f.events.some(event => event.type === "runEnd" && event.data !== null && typeof event.data === "object" && "status" in event.data && event.data.status === "aborted"));
  });
}
