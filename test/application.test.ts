import assert from "node:assert/strict";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import {
  getCurrentSystemPrompt,
  getCurrentTools,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type TranscriptContext as Context,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ConnectionError, RepaClient, RpcError } from "../src/client.js";
import { PiConversationHost, REPA_BASE_PROMPT } from "../src/pi-host.js";
import { ConfigStore } from "../src/configuration/store.js";
import { RepaFault } from "../src/errors.js";
import {
  isTerminal,
  type Change,
  type Delivery,
  type Run,
  type SessionKey,
  type Snapshot,
} from "../src/protocol.js";
import {
  startRepaServer,
  type Connection,
  type ServerOptions,
} from "../src/server.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixturePackage = path.join(testDirectory, "fixtures/repa-test-package");
const brokenPackage = path.join(testDirectory, "fixtures/repa-broken-package");
const fixtureSkillPath = path.join(
  fixturePackage,
  "skills/fixture-learning-skill/SKILL.md",
);
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function until<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeout = 8000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`等待状态超时：${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function textOf(message: { content: unknown }): string {
  if (typeof message.content === "string") return message.content;
  return Array.isArray(message.content)
    ? message.content
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("\n")
    : "";
}
function latest(context: Context, role: string): string {
  const message = context.messages.findLast((x) => x.role === role);
  return message ? textOf(message) : "";
}
const sessionText = (state: Snapshot) =>
  state.sessions.flatMap((session) => session.messages.map(textOf)).join("\n");

interface FixtureOptions extends ServerOptions {
  speed?: number;
  retry?: boolean;
  retryDelayMs?: number;
  smallContext?: boolean;
  packages?: string[];
}
async function files(t: TestContext, options: FixtureOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-test-"));
  const directory = path.join(root, "learning");
  const agentDir = path.join(root, "agent");
  await mkdir(path.join(directory, ".pi"), { recursive: true });
  await mkdir(agentDir);
  await writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      extensions: ["!**/*"],
      skills: ["!**/*"],
      prompts: ["!**/*"],
      themes: ["!**/*"],
    }),
  );
  await writeFile(
    path.join(directory, ".pi/settings.json"),
    JSON.stringify({
      packages: options.packages ?? [fixturePackage],
      retry: {
        enabled: options.retry ?? false,
        maxRetries: 2,
        baseDelayMs: options.retryDelayMs ?? 1,
      },
      compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 200 },
    }),
  );
  const cleanups: Array<() => void | Promise<void>> = [];
  t.after(async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    await rm(root, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, "测试资源清理失败。");
  });
  return {
    root,
    directory,
    agentDir,
    beforeCleanup: (cleanup: () => void | Promise<void>) => {
      cleanups.push(cleanup);
    },
  };
}
async function model(agentDir: string, options: FixtureOptions = {}) {
  const faux = fauxProvider({
    api: `repa-api-${randomUUID()}`,
    provider: `repa-provider-${randomUUID()}`,
    models: [
      {
        id: "test",
        name: "test",
        reasoning: false,
        input: ["text"],
        contextWindow: options.smallContext ? 1600 : 16384,
        maxTokens: options.smallContext ? 256 : 512,
      },
    ],
    tokensPerSecond: options.speed ?? 0,
    tokenSize: { min: 1, max: 1 },
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  return { faux, override: { modelRuntime, model: faux.getModel() } };
}
async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const spaceFiles = await files(t, options);
  const { faux, override } = await model(spaceFiles.agentDir, options);
  const server = await startRepaServer({
    ...options,
    agentDir: spaceFiles.agentDir,
    trustExtensions: options.trustExtensions ?? true,
    modelOverride: options.modelOverride ?? override,
  });
  const clients: RepaClient[] = [];
  const connect = async () => {
    const client = await RepaClient.connect(server.connection);
    clients.push(client);
    return client;
  };
  const client = await connect();
  spaceFiles.beforeCleanup(async () => {
    await server.close();
    await Promise.all(clients.map((x) => x.close()));
  });
  const space = await client.call("space.open", { path: spaceFiles.directory });
  const session = await client.call("session.create", { spaceId: space.id });
  const key: SessionKey = { spaceId: space.id, sessionId: session.sessionId };
  let state: Snapshot = { lifecycle: "running", spaces: [], sessions: [] };
  const changes: Change[] = [];
  const deliveries: Delivery[] = [];
  const watch = await client.watch(key, (snapshot, delivery) => {
    state = snapshot;
    deliveries.push(delivery);
    if (delivery.type === "changes") changes.push(...delivery.changes);
  });
  const finish = async (id: string): Promise<Run> => {
    const result = await until(
      () => client.call("run.get", { spaceId: space.id, requestId: id }),
      (value) => value.status !== "unknown" && isTerminal(value),
    );
    assert.notEqual(result.status, "unknown");
    return result as Run;
  };
  const send = async (text: string) => {
    const accepted = await client.call("run.submit", {
      ...key,
      requestId: randomUUID(),
      text,
    });
    assert.equal(accepted.status, "accepted");
    return finish(accepted.id);
  };
  return {
    ...spaceFiles,
    server,
    client,
    clients,
    connect,
    faux,
    key,
    space,
    session,
    watch,
    changes,
    deliveries,
    state: () => state,
    send,
    finish,
  };
}

test("公开协议支持两个客户端共享流式对话、受信任 prompt、skill 与结构化工具结果", async (t) => {
  const f = await fixture(t);
  const other = await f.connect();
  let otherState: Snapshot | undefined;
  await other.watch(f.key, (snapshot) => {
    otherState = snapshot;
  });
  f.faux.setResponses([
    (context) => {
      assert.match(latest(context, "user"), /FIXTURE_PROMPT_EXPANDED/u);
      assert.match(getCurrentSystemPrompt(context.messages) ?? "", /fixture-learning-skill/u);
      assert.match(
        getCurrentSystemPrompt(context.messages) ?? "",
        /You are Repa, a general learning Agent/u,
      );
      assert.doesNotMatch(
        getCurrentSystemPrompt(context.messages) ?? "",
        /expert coding assistant operating inside pi/iu,
      );
      return fauxAssistantMessage("流式回复");
    },
    fauxAssistantMessage(fauxToolCall("fixture_echo", { message: "hello" }), {
      stopReason: "toolUse",
    }),
    (context) => {
      assert.match(latest(context, "toolResult"), /fixture:hello/u);
      return fauxAssistantMessage("工具完成");
    },
    fauxAssistantMessage(fauxToolCall("read", { path: fixtureSkillPath }), {
      stopReason: "toolUse",
    }),
    (context) => {
      assert.match(
        latest(context, "toolResult"),
        /FULL_SKILL_INSTRUCTION_MARKER/u,
      );
      return fauxAssistantMessage("已读 skill");
    },
    fauxAssistantMessage(
      fauxToolCall("read", { path: path.join(fixturePackage, "package.json") }),
      { stopReason: "toolUse" },
    ),
    (context) => {
      assert.match(
        latest(context, "toolResult"),
        /尚未允许读取这个空间外文件/u,
      );
      return fauxAssistantMessage("读取范围正确");
    },
    fauxAssistantMessage(fauxToolCall("fixture_media", {}), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("媒体完成"),
  ]);
  for (const input of [
    "/fixture-prompt",
    "调用工具",
    "读取 skill",
    "越界读取",
    "返回媒体",
  ])
    assert.equal((await f.send(input)).status, "completed");
  await until(
    () => otherState,
    (x) => !!x && sessionText(x).includes("媒体完成"),
  );
  assert.equal(sessionText(otherState!), sessionText(f.state()));
  assert(f.changes.filter((x) => x.type === "delta").length > 5);
  assert(
    f.changes.some(
      (x) =>
        x.type === "tool" &&
        x.name === "fixture_echo" &&
        x.status === "completed",
    ),
  );
  const messages = f.state().sessions[0]!.messages;
  assert.equal(new Set(messages.map((x) => x.id)).size, messages.length);
  assert(messages.every((x) => !x.streaming));
  const media = messages.find(
    (x) => x.role === "tool" && textOf(x).includes("FIXTURE_MEDIA"),
  )!;
  assert.deepEqual(media.details, { answer: 42, sequence: [1, 2] });
  const resource = media.content.find((x) => x.type === "resource");
  assert.equal(resource?.type, "resource");
  const response = await other.resource(resource.resource);
  assert.equal(resource.resource.mediaType, "image/png");
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.equal(new Uint8Array(await response.arrayBuffer())[0], 137);
  const url = new URL(
    `/spaces/${resource.resource.spaceId}/resources/${resource.resource.id}`,
    f.server.connection.url.replace(/^ws/, "http"),
  );
  assert.equal((await fetch(url)).status, 401);
});

test("未授权扩展保持禁用；只读查看与新建会话不启动 Pi", async (t) => {
  let opened = 0;
  const data = await files(t);
  const provider = await model(data.agentDir);
  const f = await fixture(t, {
    trustExtensions: false,
    modelOverride: async () => {
      opened++;
      return provider.override;
    },
  });
  await f.client.call("session.get", f.key);
  await f.client.call("session.list", { spaceId: f.space.id });
  await f.client.call("session.create", { spaceId: f.space.id });
  assert.equal(opened, 0);
  provider.faux.setResponses([
    (context) => {
      assert.equal(latest(context, "user"), "/fixture-prompt");
      assert.doesNotMatch(
        getCurrentSystemPrompt(context.messages) ?? "",
        /fixture-learning-skill/u,
      );
      assert.deepEqual(
        getCurrentTools(context.messages)?.map((x) => x.name),
        ["read", "edit", "write", "apply_patch"],
      );
      return fauxAssistantMessage("普通输入");
    },
  ]);
  await f.send("/fixture-prompt");
  assert.equal(opened, 1);
  const summaries = await f.client.call("session.list", {
    spaceId: f.space.id,
  });
  assert.equal(summaries[0]?.sessionId, f.key.sessionId);
  assert(summaries.every((summary) => !Object.hasOwn(summary, "messages")));
});

test("Pi 重试成功后任务完成，中间错误不形成最终失败；真正失败后可继续", async (t) => {
  const f = await fixture(t, { retry: true });
  f.faux.setResponses([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "503 service unavailable",
    }),
    fauxAssistantMessage("重试成功"),
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "invalid request parameters",
    }),
    fauxAssistantMessage("失败后继续"),
  ]);
  const recovered = await f.send("触发暂时错误");
  assert.equal(recovered.status, "completed");
  assert(
    f.changes.some(
      (x) =>
        x.type === "run" &&
        x.run.id === recovered.id &&
        x.run.phase === "retry",
    ),
  );
  assert.deepEqual(
    f.changes
      .filter(
        (x) =>
          x.type === "run" && x.run.id === recovered.id && isTerminal(x.run),
      )
      .map((x) => x.type === "run" && x.run.status),
    ["completed"],
  );
  const failed = await f.send("触发永久错误");
  assert.equal(failed.status, "failed");
  assert.match(failed.error?.message ?? "", /invalid request/u);
  assert.equal((await f.send("继续")).status, "completed");
});

test("取消等待实际停止，多会话运行互不替换，重复提交只执行一次", async (t) => {
  const f = await fixture(t, { speed: 100 });
  const second = await f.client.call("session.create", { spaceId: f.space.id });
  let calls = 0;
  f.faux.setResponses([
    () => {
      calls++;
      return fauxAssistantMessage("A".repeat(1000));
    },
    () => {
      calls++;
      return fauxAssistantMessage("B".repeat(50));
    },
  ]);
  const request = { ...f.key, requestId: randomUUID(), text: "长回复" };
  const other = await f.connect();
  const results = await Promise.all([
    f.client.call("run.submit", request),
    other.call("run.submit", request),
  ]);
  assert.equal(results[0].id, results[1].id);
  await until(
    () => f.changes,
    (xs) => xs.some((x) => x.type === "delta"),
  );
  const b = await other.call("run.submit", {
    spaceId: f.space.id,
    sessionId: second.sessionId,
    requestId: randomUUID(),
    text: "另一个会话",
  });
  await f.client.call("session.get", {
    spaceId: f.space.id,
    sessionId: second.sessionId,
  });
  await assert.rejects(
    other.call("run.submit", { ...request, text: "另一个请求" }),
    (e) =>
      e instanceof RpcError &&
      (e.data as { code: string }).code === "request_conflict",
  );
  const cancelling = await f.client.call("run.cancel", {
    spaceId: f.space.id,
    requestId: request.requestId,
  });
  assert.equal(cancelling.status, "cancelling");
  assert.equal((await f.finish(request.requestId)).status, "cancelled");
  assert.equal((await f.finish(b.id)).status, "completed");
  assert.equal(calls, 2);
  assert.deepEqual(
    await f.client.call("run.get", {
      spaceId: f.space.id,
      requestId: "not-seen",
    }),
    { id: "not-seen", status: "unknown" },
  );
});

test("会话与任务跨后端恢复，空会话也持久保存，分支不更改原会话", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    fauxAssistantMessage("原始回复"),
    fauxAssistantMessage("分支回复"),
  ]);
  const run = await f.send("原始问题");
  const old = await f.client.call("session.get", f.key);
  const branch = await f.client.call("session.branch", {
    ...f.key,
    messageId: old.messages.at(-1)!.id,
  });
  assert.notEqual(branch.sessionId, old.sessionId);
  const branchedRun = await f.client.call("run.submit", {
    spaceId: f.space.id,
    sessionId: branch.sessionId,
    requestId: randomUUID(),
    text: "分支问题",
  });
  await f.finish(branchedRun.id);
  assert.deepEqual(
    (await f.client.call("session.get", f.key)).messages,
    old.messages,
  );
  const empty = await f.client.call("session.create", { spaceId: f.space.id });
  await f.server.close();
  let opened = 0;
  const next = await startRepaServer({
    agentDir: f.agentDir,
    modelOverride: async () => {
      opened++;
      throw new Error("读取历史不应启动模型");
    },
  });
  f.beforeCleanup(async () => next.close());
  const client = await RepaClient.connect(next.connection);
  f.beforeCleanup(async () => client.close());
  assert.equal(
    (await client.call("space.open", { path: f.directory })).id,
    f.space.id,
  );
  const restored = await client.call("session.get", f.key);
  assert.deepEqual(restored.messages, old.messages);
  assert.equal(
    (
      await client.call("session.get", {
        spaceId: f.space.id,
        sessionId: empty.sessionId,
      })
    ).messages.length,
    0,
  );
  assert.equal(
    (
      await client.call("run.submit", {
        ...f.key,
        requestId: run.id,
        text: run.text,
      })
    ).status,
    "completed",
  );
  assert.equal(opened, 0);
});

test("断线后按游标继续；事件缓存过期时重建快照", async (t) => {
  const f = await fixture(t, { eventBufferSize: 2 });
  let index = f.deliveries.length;
  await Promise.all([f.client.reconnect(), f.client.reconnect()]);
  assert.equal(f.deliveries.length, index + 1);
  assert.equal(f.deliveries[index]?.type, "changes");
  const dispose = f.client.onConnectionChange((connected) => {
    if (!connected)
      for (let i = 0; i < 3; i++)
        f.server.application.createSession(f.space.id);
  });
  index = f.deliveries.length;
  await f.client.reconnect();
  dispose();
  assert.equal(f.deliveries[index]?.type, "snapshot");
  assert.deepEqual(
    f.watch.snapshot,
    await f.client.call("state.get", { scope: f.key }),
  );
});

test("最后一个前端离开后等待既有交互，重新连接可回答并继续", async (t) => {
  const f = await fixture(t, { exitWhenDetached: true, disconnectGraceMs: 20 });
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("fixture_question", {}), {
      stopReason: "toolUse",
    }),
    (context) => {
      assert.match(latest(context, "toolResult"), /真实回答/u);
      return fauxAssistantMessage("交互完成");
    },
  ]);
  const run = await f.client.call("run.submit", {
    ...f.key,
    requestId: randomUUID(),
    text: "需要询问",
  });
  await until(f.state, (state) => state.sessions[0]?.interactions.length === 1);
  const pending = f.state().sessions[0]!.interactions[0]!;
  const second = await f.connect();
  await f.client.close();
  assert.equal(
    (await second.call("state.get", { scope: f.key })).lifecycle,
    "running",
  );
  await second.close();
  await until(
    () => f.server.application.snapshot(f.key),
    (state) => state.lifecycle === "draining",
  );
  assert.equal(
    f.server.application.getRun(f.space.id, run.id).status,
    "waiting",
  );
  const reopened = await f.connect();
  const snapshot = await reopened.call("state.get", { scope: f.key });
  assert.equal(snapshot.lifecycle, "running");
  assert.equal(snapshot.sessions[0]!.interactions[0]!.id, pending.id);
  await reopened.call("interaction.reply", {
    ...f.key,
    id: pending.id,
    value: "真实回答",
  });
  await until(
    () => reopened.call("run.get", { spaceId: f.space.id, requestId: run.id }),
    (value) => value.status === "completed",
  );
  await assert.rejects(
    reopened.call("interaction.reply", {
      ...f.key,
      id: pending.id,
      value: "再次回答",
    }),
    (e) => e instanceof RpcError,
  );
  await reopened.close();
  await f.server.closed;
  assert.equal(
    f.server.application.getRun(f.space.id, run.id).status,
    "completed",
  );
});

test("关闭最后客户端后完成已启动生成，完整退出则取消并保留记录", async (t) => {
  const f = await fixture(t, { exitWhenDetached: true, speed: 200 });
  f.faux.setResponses([fauxAssistantMessage("后台完成".repeat(10))]);
  const run = await f.client.call("run.submit", {
    ...f.key,
    requestId: randomUUID(),
    text: "后台任务",
  });
  await until(
    () => f.changes,
    (x) => x.some((e) => e.type === "delta"),
  );
  await f.client.close();
  await f.server.closed;
  assert.equal(
    f.server.application.getRun(f.space.id, run.id).status,
    "completed",
  );
  const cancel = await fixture(t, { speed: 100 });
  cancel.faux.setResponses([fauxAssistantMessage("未结束".repeat(500))]);
  const active = await cancel.client.call("run.submit", {
    ...cancel.key,
    requestId: randomUUID(),
    text: "停止任务",
  });
  await until(
    () => cancel.changes,
    (x) => x.some((e) => e.type === "delta"),
  );
  await cancel.client.call("shutdown", { mode: "cancel" });
  await cancel.server.closed;
  assert.equal(
    cancel.server.application.getRun(cancel.space.id, active.id).status,
    "cancelled",
  );
});

test("标准 Pi 压缩后仍通过同一协议继续，扩展故障有可观察诊断", async (t) => {
  const f = await fixture(t, {
    smallContext: true,
    packages: [fixturePackage, brokenPackage],
  });
  const script: FauxResponseStep = (context, _options, state) =>
    !(getCurrentSystemPrompt(context.messages) ?? "").includes(REPA_BASE_PROMPT)
      ? fauxAssistantMessage("COMPACTION_SUMMARY")
      : fauxAssistantMessage(
          `REPLY_${state.callCount}:` + "学习内容。".repeat(80),
        );
  f.faux.setResponses(Array.from({ length: 40 }, () => script));
  for (
    let i = 0;
    i < 10 &&
    !f.changes.some((x) => x.type === "run" && x.run.phase === "compaction");
    i++
  )
    await f.send("长请求".repeat(80));
  assert(
    f.changes.some((x) => x.type === "run" && x.run.phase === "compaction"),
  );
  assert.equal((await f.send("继续交流")).status, "completed");
  assert(
    f
      .state()
      .sessions[0]!.notices.some(
        (x) =>
          x.code === "extension" &&
          x.message.includes("BROKEN_EXTENSION_MARKER"),
      ),
  );
});

test("进程被强制终止后，已受理请求恢复为中断，重复提交不重放工具", async (t) => {
  const data = await files(t);
  const child = fork(
    path.join(testDirectory, "fixtures/server-worker.ts"),
    [data.agentDir],
    {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  data.beforeCleanup(() => {
    if (!child.signalCode && child.exitCode === null) child.kill("SIGKILL");
  });
  const [connection] = (await once(child, "message")) as [Connection];
  const client = await RepaClient.connect(connection);
  data.beforeCleanup(async () => client.close());
  const space = await client.call("space.open", { path: data.directory });
  const session = await client.call("session.create", { spaceId: space.id });
  const key = { spaceId: space.id, sessionId: session.sessionId };
  const params = { ...key, requestId: randomUUID(), text: "等待回答期间中断" };
  await client.call("run.submit", params);
  await until(
    () => client.call("session.get", key),
    (x) => x.interactions.length === 1,
  );
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  await client.close();
  let invoked = false;
  const server = await startRepaServer({
    agentDir: data.agentDir,
    modelOverride: async () => {
      invoked = true;
      throw new Error("不应自动恢复执行");
    },
  });
  data.beforeCleanup(async () => server.close());
  const restored = await RepaClient.connect(server.connection);
  data.beforeCleanup(async () => restored.close());
  await until(
    async () => {
      try {
        await restored.call("space.open", { path: data.directory });
        return true;
      } catch (error) {
        if (
          !(error instanceof RpcError) ||
          (error.data as { code: string }).code !== "space_in_use"
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
        return false;
      }
    },
    Boolean,
    16000,
  );
  assert.equal(
    (
      await restored.call("run.get", {
        spaceId: space.id,
        requestId: params.requestId,
      })
    ).status,
    "interrupted",
  );
  assert.equal(
    (await restored.call("run.submit", params)).status,
    "interrupted",
  );
  assert.equal(invoked, false);
});

test("JSON-RPC 认证、版本、参数、批处理与 HTTP 资源入口使用同一访问边界", async (t) => {
  const f = await fixture(t);
  const socket = new WebSocket(f.server.connection.url);
  f.beforeCleanup(() => socket.terminate());
  await once(socket, "open");
  const rpc = async (payload: unknown) => {
    const response = once(socket, "message");
    socket.send(
      typeof payload === "string" ? payload : JSON.stringify(payload),
    );
    return JSON.parse(String((await response)[0]));
  };
  assert.equal((await rpc("{")).error.code, -32700);
  assert.equal(
    (await rpc({ jsonrpc: "2.0", id: 1, method: "space.list" })).error.code,
    -32001,
  );
  assert.equal(
    (
      await rpc({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: { versions: [99], token: f.server.connection.token },
      })
    ).error.code,
    -32002,
  );
  assert.equal(
    (
      await rpc({
        jsonrpc: "2.0",
        id: 3,
        method: "initialize",
        params: { versions: [1], token: "incorrect" },
      })
    ).error.code,
    -32001,
  );
  assert.equal(
    (
      await rpc({
        jsonrpc: "2.0",
        id: 4,
        method: "initialize",
        params: { versions: [1], token: f.server.connection.token },
      })
    ).result.version,
    1,
  );
  const batch = await rpc([
    { jsonrpc: "2.0", id: "a", method: "space.list", params: {} },
    { jsonrpc: "2.0", method: "shutdown", params: { mode: "cancel" } },
    { jsonrpc: "2.0", id: "b", method: "session.get", params: { wrong: 1 } },
  ]);
  assert.equal(batch.length, 2);
  assert.equal(
    batch.find((x: { id: string }) => x.id === "b").error.code,
    -32602,
  );
  assert.equal(
    (await f.client.call("state.get", { scope: {} })).lifecycle,
    "running",
  );
  const url = new URL(
    "/protocol.json",
    f.server.connection.url.replace(/^ws/, "http"),
  );
  assert.equal((await fetch(url)).status, 401);
  const schema = (await (
    await fetch(url, {
      headers: { Authorization: `Bearer ${f.server.connection.token}` },
    })
  ).json()) as { methods: object };
  assert(Object.hasOwn(schema.methods, "run.submit"));
});

function collectProcess(child: ChildProcess) {
  let output = "";
  child.stdout?.on("data", (data) => {
    output += String(data);
  });
  child.stderr?.on("data", (data) => {
    output += String(data);
  });
  const exited = once(child, "exit");
  return { output: () => output, exited };
}

test("实际 TUI 通过公开客户端连接现有后端并完成对话", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("TUI_PROTOCOL_REPLY")]);
  const endpoint = path.join(f.root, "connection.json");
  await writeFile(
    endpoint,
    JSON.stringify({
      ...f.server.connection,
      pid: process.pid,
      trustExtensions: true,
      agentDir: f.agentDir,
    }),
    { mode: 0o600 },
  );
  const child = spawn(
    process.execPath,
    ["--import", "tsx", cliPath, f.directory, "--connect", endpoint],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const state = collectProcess(child);
  f.beforeCleanup(() => {
    if (!child.signalCode && child.exitCode === null) child.kill();
  });
  await until(state.output, (x) => x.includes("命令："));
  child.stdin.write("请回答\n");
  await until(state.output, (x) => x.includes("TUI_PROTOCOL_REPLY"));
  child.stdin.end();
  assert.equal((await state.exited)[0], 0, state.output());
});

test("默认 TUI 共享独立后端，关闭一个前端不退出另一个，最后离开清理连接文件", async (t) => {
  const data = await files(t);
  const runtime = path.join(data.root, "runtime");
  await mkdir(runtime);
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
  const args = [
    "--import",
    "tsx",
    cliPath,
    data.directory,
    "--agent-dir",
    data.agentDir,
  ];
  const first = spawn(process.execPath, args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const a = collectProcess(first);
  data.beforeCleanup(() => {
    if (!first.signalCode && first.exitCode === null) first.kill();
  });
  const second = spawn(process.execPath, [...args, "--new-session"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const b = collectProcess(second);
  data.beforeCleanup(() => {
    if (!second.signalCode && second.exitCode === null) second.kill();
  });
  await until(a.output, (x) => x.includes("命令："));
  const endpointFile = path.join(
    runtime,
    `repa-${process.getuid?.() ?? os.userInfo().username}`,
    "connection.json",
  );
  const connection = JSON.parse(
    await readFile(endpointFile, "utf8"),
  ) as Connection;
  data.beforeCleanup(async () => {
    try {
      const client = await RepaClient.connect(connection, {
        requestTimeoutMs: 500,
      });
      await client.call("shutdown", { mode: "cancel" });
      await client.close();
    } catch {}
  });
  await until(b.output, (x) => x.includes("命令："));
  first.stdin.end();
  assert.equal((await a.exited)[0], 0, a.output());
  assert.equal(second.exitCode, null);
  second.stdin.end();
  assert.equal((await b.exited)[0], 0, b.output());
  await until(async () => {
    try {
      await readFile(endpointFile);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }, Boolean);
});

test("已受理请求丢失应答后客户端不自动重发，可以按原请求标识核对", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  f.faux.setResponses([
    () => {
      calls++;
      return fauxAssistantMessage("仅执行一次");
    },
  ]);
  let reconnect: Promise<void> | undefined;
  const stop = f.server.application.watch(f.key, undefined, (delivery) => {
    if (
      !reconnect &&
      delivery.type === "changes" &&
      delivery.changes.some(
        (x) => x.type === "run" && x.run.status === "accepted",
      )
    )
      reconnect = f.client.reconnect();
  });
  const requestId = randomUUID();
  await assert.rejects(
    f.client.call("run.submit", { ...f.key, requestId, text: "受理后断开" }),
    ConnectionError,
  );
  await reconnect;
  stop();
  assert.equal((await f.finish(requestId)).status, "completed");
  assert.equal(calls, 1);
});

test("不同后端不能同时占用同一空间，释放后可由另一个后端接续", async (t) => {
  const f = await fixture(t);
  const server = await startRepaServer({ agentDir: f.agentDir });
  f.beforeCleanup(async () => server.close());
  const client = await RepaClient.connect(server.connection);
  f.beforeCleanup(async () => client.close());
  await assert.rejects(
    client.call("space.open", { path: f.directory }),
    (error) =>
      error instanceof RpcError &&
      (error.data as { code: string }).code === "space_in_use",
  );
  f.faux.setResponses([fauxAssistantMessage("原后端继续")]);
  assert.equal((await f.send("继续使用空间")).status, "completed");
  await f.server.close();
  assert.equal(
    (await client.call("space.open", { path: f.directory })).id,
    f.space.id,
  );
  assert.match(
    textOf((await client.call("session.get", f.key)).messages.at(-1)!),
    /原后端继续/u,
  );
  await server.close();
  await until(() => client.closed, Boolean);
});

test("在自动重试等待期间取消会结束本次任务，不再启动下一次模型调用", async (t) => {
  const f = await fixture(t, { retry: true, retryDelayMs: 1000 });
  let calls = 0;
  f.faux.setResponses([
    () => {
      calls++;
      return fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "503 service unavailable",
      });
    },
    () => {
      calls++;
      return fauxAssistantMessage("不应执行的重试");
    },
  ]);
  const run = await f.client.call("run.submit", {
    ...f.key,
    requestId: randomUUID(),
    text: "重试期间取消",
  });
  await until(
    f.state,
    (state) =>
      state.sessions[0]?.runs.some(
        (x) => x.id === run.id && x.phase === "retry",
      ) ?? false,
  );
  await f.client.call("run.cancel", { spaceId: f.space.id, requestId: run.id });
  assert.equal((await f.finish(run.id)).status, "cancelled");
  assert.equal(calls, 1);
});

test("TUI 重新打开时展示待回答问题，并通过原交互回复", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("fixture_question", {}), {
      stopReason: "toolUse",
    }),
    (context) => {
      assert.equal(latest(context, "toolResult"), "TUI_ANSWER");
      return fauxAssistantMessage("TUI_RESUMED");
    },
  ]);
  const run = await f.client.call("run.submit", {
    ...f.key,
    requestId: randomUUID(),
    text: "保留待回答问题",
  });
  await until(f.state, (state) => state.sessions[0]?.interactions.length === 1);
  const endpoint = path.join(f.root, "pending-connection.json");
  await writeFile(
    endpoint,
    JSON.stringify({
      ...f.server.connection,
      pid: process.pid,
      trustExtensions: true,
    }),
    { mode: 0o600 },
  );
  const child = spawn(
    process.execPath,
    ["--import", "tsx", cliPath, f.directory, "--connect", endpoint],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const output = collectProcess(child);
  f.beforeCleanup(() => {
    if (!child.signalCode && child.exitCode === null) child.kill();
  });
  await until(
    output.output,
    (value) => value.includes("FIXTURE_QUESTION") && value.includes("命令："),
  );
  child.stdin.write("TUI_ANSWER\n");
  await until(output.output, (value) => value.includes("TUI_RESUMED"));
  child.stdin.end();
  await output.exited;
  assert.equal((await f.finish(run.id)).status, "completed");
});

test("同一后端中的不同学习空间分别拥有任务标识与订阅范围", async (t) => {
  const f = await fixture(t);
  const other = await f.client.call("space.open", {
    path: path.join(f.root, "second-space"),
  });
  const second = await f.client.call("session.create", { spaceId: other.id });
  const requestId = randomUUID();
  const respond: FauxResponseStep = (context) =>
    fauxAssistantMessage(latest(context, "user"));
  f.faux.setResponses([respond, respond]);
  await Promise.all([
    f.client.call("run.submit", { ...f.key, requestId, text: "SPACE_A_ONLY" }),
    f.client.call("run.submit", {
      spaceId: other.id,
      sessionId: second.sessionId,
      requestId,
      text: "SPACE_B_ONLY",
    }),
  ]);
  await f.finish(requestId);
  await until(
    () => f.client.call("run.get", { spaceId: other.id, requestId }),
    (run) => run.status === "completed",
  );
  assert.match(sessionText(f.state()), /SPACE_A_ONLY/u);
  assert.doesNotMatch(sessionText(f.state()), /SPACE_B_ONLY/u);
  assert.equal(
    (
      await f.client.call("session.get", {
        spaceId: other.id,
        sessionId: second.sessionId,
      })
    ).runs[0]?.text,
    "SPACE_B_ONLY",
  );
  assert.equal((await f.client.call("space.list", {})).length, 2);
});

test("从历史消息建立分支不会替换正在等待回答的原会话运行", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    fauxAssistantMessage("可供分支的历史回复"),
    fauxAssistantMessage(fauxToolCall("fixture_question", {}), {
      stopReason: "toolUse",
    }),
    (context) => {
      assert.equal(latest(context, "user"), "在分支里继续");
      return fauxAssistantMessage("分支完成");
    },
    (context) => {
      assert.equal(latest(context, "toolResult"), "原会话的回答");
      return fauxAssistantMessage("原会话完成");
    },
  ]);
  await f.send("先形成历史");
  const before = await f.client.call("session.get", f.key);
  const original = await f.client.call("run.submit", {
    ...f.key,
    requestId: randomUUID(),
    text: "原会话等待回答",
  });
  await until(f.state, (state) => state.sessions[0]?.interactions.length === 1);
  const question = f.state().sessions[0]!.interactions[0]!;
  const branch = await f.client.call("session.branch", {
    ...f.key,
    messageId: before.messages.at(-1)!.id,
  });
  assert.deepEqual(branch.messages, before.messages);
  const forked = await f.client.call("run.submit", {
    spaceId: f.space.id,
    sessionId: branch.sessionId,
    requestId: randomUUID(),
    text: "在分支里继续",
  });
  assert.equal((await f.finish(forked.id)).status, "completed");
  assert.equal(
    (
      await f.client.call("run.get", {
        spaceId: f.space.id,
        requestId: original.id,
      })
    ).status,
    "waiting",
  );
  assert.equal(
    (await f.client.call("session.get", f.key)).interactions[0]?.id,
    question.id,
  );
  await f.client.call("interaction.reply", {
    ...f.key,
    id: question.id,
    value: "原会话的回答",
  });
  assert.equal((await f.finish(original.id)).status, "completed");
});

test("Agent 与编辑器共用实际保存和旧基准保护", async (t) => {
  const f = await fixture(t, { trustExtensions: false });
  const target = { kind: "file" as const, spaceId: f.space.id, location: { kind: "relative" as const, path: "notes.md" } };
  await f.client.call("content.write", { target, operationId: randomUUID(), base: { kind: "absent" }, value: { kind: "text", text: "问题\n答案待补\n后记\n" } });
  const opened = await f.client.readText(target);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("edit", { path: "notes.md", edits: [{ oldText: "答案待补", newText: "答案已补" }] }), { stopReason: "toolUse" }),
    fauxAssistantMessage("笔记已保存"),
  ]);
  const run = await f.send("补充答案");
  assert.equal(run.status, "completed", run.error?.message);
  assert.equal((await f.client.readText(target)).text, "问题\n答案已补\n后记\n");
  await assert.rejects(f.client.call("content.write", { target, operationId: randomUUID(), base: opened.content.bodyRevision!, value: { kind: "text", text: opened.text + "旧草稿修改" } }),
    (error: unknown) => error instanceof RpcError && (error.data as { code: string }).code === "revision_conflict");
  const tools = f.state().sessions[0]!.messages.filter((entry) => entry.role === "tool");
  const details = tools.at(-1)!.details as { operationId: string };
  assert.equal((await f.client.call("operation.get", { spaceId: f.space.id, operationId: details.operationId })).status, "committed");
});

test("提示配置在受理时固定，重传原请求不重新解析默认值", async (t) => {
  const config = await files(t);
  const provider = await model(config.agentDir);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.after(release);
  const f = await fixture(t, { trustExtensions: false, modelOverride: async () => { await gate; return provider.override; } });
  const scope = { kind: "session" as const, ...f.key };
  const before = await f.client.call("settings.get", { scope, namespace: "prompts" });
  const original = before.entries.find((entry) => entry.key === "base")!;
  const settings = await f.client.call("settings.set", { scope, namespace: "prompts", key: "base", base: original.revision, value: "受理时提示" });
  provider.faux.setResponses([(context) => {
    assert.match(getCurrentSystemPrompt(context.messages) ?? "", /受理时提示/);
    assert.doesNotMatch(getCurrentSystemPrompt(context.messages) ?? "", /后续提示/);
    return fauxAssistantMessage("完成");
  }]);
  const params = { ...f.key, requestId: randomUUID(), text: "开始" };
  const accepted = await f.client.call("run.submit", params);
  assert.equal(accepted.promptSettings?.base, "受理时提示");
  await f.client.call("settings.set", { scope, namespace: "prompts", key: "base", base: settings.entries.find((entry) => entry.key === "base")!.revision, value: "后续提示" });
  assert.equal((await f.client.call("run.submit", params)).promptSettings?.base, "受理时提示");
  release();
  const result = await f.finish(accepted.id);
  assert.equal(result.status, "completed", result.error?.message);
  const journal = await readFile(path.join(f.directory, ".repa/runtime/runs.jsonl"), "utf8");
  assert(journal.split("\n").filter(Boolean).every((line) => JSON.parse(line).request.promptSettings.base === "受理时提示"));
});

test("受理准备期间开始退出，不会在配置读取后启动新运行", async (t) => {
  const f = await fixture(t, { trustExtensions: false });
  const original = ConfigStore.prototype.prompts;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  t.mock.method(ConfigStore.prototype, "prompts", async function(this: ConfigStore, scope: Parameters<typeof original>[0]) {
    entered(); await gate; return original.call(this, scope);
  });
  const pending = f.server.application.submit({ ...f.key, text: "尚未受理", requestId: randomUUID() });
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof RepaFault && error.code === "shutting_down");
  await waiting;
  const closed = f.server.close("cancel");
  release();
  await rejected; await closed;
  assert.equal(f.faux.state.callCount, 0);
  assert.equal(f.server.application.getSession(f.key).runs.length, 0);
});

test("配置读取期间关闭会话，不在正在关闭的 Host 上受理新运行", async (t) => {
  const f = await fixture(t, { trustExtensions: false });
  f.faux.setResponses([fauxAssistantMessage("初始化完成")]);
  assert.equal((await f.send("初始化")).status, "completed");
  const originalSettings = ConfigStore.prototype.prompts;
  const originalClose = PiConversationHost.prototype.close;
  let releaseSettings!: () => void, settingsEntered!: () => void, releaseClose!: () => void, closeEntered!: () => void;
  const settingsGate = new Promise<void>((resolve) => { releaseSettings = resolve; });
  const settingsWaiting = new Promise<void>((resolve) => { settingsEntered = resolve; });
  const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
  const closeWaiting = new Promise<void>((resolve) => { closeEntered = resolve; });
  t.mock.method(ConfigStore.prototype, "prompts", async function(this: ConfigStore, scope: Parameters<typeof originalSettings>[0]) {
    settingsEntered(); await settingsGate; return originalSettings.call(this, scope);
  });
  t.mock.method(PiConversationHost.prototype, "close", async function(this: PiConversationHost) {
    closeEntered(); await closeGate; return originalClose.call(this);
  });
  const pending = f.server.application.submit({ ...f.key, text: "等待中的输入", requestId: randomUUID() });
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof RepaFault && error.code === "busy");
  await settingsWaiting;
  const closing = f.server.application.closeSession(f.key);
  try {
    await closeWaiting;
    releaseSettings();
    await rejected;
  } finally {
    releaseSettings(); releaseClose(); await closing;
  }
  assert.equal(f.faux.state.callCount, 1);
  assert.equal(f.server.application.getSession(f.key).runs.length, 1);
});

test("媒体经过会话分支、文档和展示持有后，删除任一消费者不会提前回收", async t => {
  const f = await fixture(t, { resources: { preparationTtlMs: 1 } });
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("fixture_media", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("媒体已保存"),
  ]);
  assert.equal((await f.send("生成媒体")).status, "completed");
  const session = await f.client.call("session.get", f.key);
  const media = session.messages.flatMap(message => message.content).find(part => part.type === "resource")!;
  assert.equal(media.type, "resource");
  const ref = media.resource;
  const copied = await f.client.call("space.copy", { spaceId: f.space.id, operationId: randomUUID(), destination: path.join(f.root, "media-copy") });
  assert.equal(copied.status, "completed", copied.error?.message);
  await f.client.call("space.open", { path: copied.destination });
  const copiedSession = await f.client.call("session.get", { spaceId: copied.spaceId, sessionId: f.key.sessionId });
  const copiedMedia = copiedSession.messages.flatMap(message => message.content).find(part => part.type === "resource")!;
  assert.equal(copiedMedia.type, "resource");
  assert.equal(copiedMedia.resource.spaceId, copied.spaceId);
  assert.equal(copiedSession.runs[0]!.spaceId, copied.spaceId);
  const branch = await f.client.call("session.branch", { ...f.key, messageId: session.messages.at(-1)!.id });
  const target = { kind: "file" as const, spaceId: f.space.id, location: { kind: "relative" as const, path: "saved.md" } };
  const created = await f.client.call("content.write", { target, base: { kind: "absent" }, operationId: randomUUID(), value: { kind: "text", text: "带媒体的文档" } });
  const associated = await f.client.call("content.associate", { spaceId: f.space.id, location: target.location, role: "document", operationId: randomUUID() });
  const document = associated.contents[0]!;
  const composed = await f.client.call("content.setComposition", { ref: document.ref!, base: document.revision!, operationId: randomUUID(), members: [], resources: [ref] });
  const hold = await f.client.call("resource.hold", { spaceId: f.space.id, id: randomUUID(), targets: [document.target] });
  const stranger = await f.connect();
  await assert.rejects(stranger.call("resource.release", { spaceId: f.space.id, id: hold.id }), error => error instanceof RpcError && (error.data as { code: string }).code === "permission_required");
  const hostKey = f.client.hostKey;
  await f.client.reconnect();
  assert.equal(f.client.hostKey, hostKey);
  assert.deepEqual((await f.client.call("resource.hold.get", { spaceId: f.space.id, id: hold.id })).resources, hold.resources);
  await f.client.call("session.remove", f.key);
  await f.client.call("resource.collect", { spaceId: f.space.id });
  assert.equal(new Uint8Array(await (await f.client.resource(ref)).arrayBuffer())[0], 137);
  await f.client.call("session.remove", { spaceId: f.space.id, sessionId: branch.sessionId });
  await f.client.call("resource.collect", { spaceId: f.space.id });
  assert.equal((await f.client.resource(ref)).status, 200);
  const removed = await f.client.call("content.remove", { target: document.target, base: created.contents[0]!.bodyRevision!, operationId: randomUUID() });
  await f.client.call("operation.prune", { spaceId: f.space.id, operationIds: [created.operationId, associated.operationId, composed.operationId, removed.operationId] });
  await f.client.call("resource.collect", { spaceId: f.space.id });
  assert.equal((await f.client.resource(ref)).status, 200);
  await f.client.call("resource.release", { spaceId: f.space.id, id: hold.id });
  await f.client.call("resource.collect", { spaceId: f.space.id });
  await assert.rejects(f.client.resource(ref));
  assert.equal((await f.client.resource(copiedMedia.resource)).status, 200);
});
