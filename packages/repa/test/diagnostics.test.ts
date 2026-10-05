import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { RepaClient } from "../src/client.js";
import type { DiagnosticOptions, DiagnosticRecord } from "../src/diagnostics.js";
import { startRepaServer } from "../src/server.js";

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > deadline) assert.fail(`等待状态超时：${JSON.stringify(value)}`);
    await delay(10);
  }
}

async function fixture(t: TestContext, options: { diagnostics?: DiagnosticOptions; failure?: Error } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-diagnostics-"));
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"],
    packages: [fileURLToPath(new URL("./fixtures/repa-test-package", import.meta.url))],
    retry: { enabled: false }, compaction: { enabled: false },
  }));
  const faux = fauxProvider({
    api: `diagnostic-${randomUUID()}`, provider: `diagnostic-${randomUUID()}`,
    models: [{ id: "local", name: "本地诊断测试", reasoning: false, input: ["text"], contextWindow: 16384, maxTokens: 256 }],
    tokensPerSecond: 0,
  });
  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  });
  runtime.registerNativeProvider(faux.provider);
  const lines: string[] = [];
  const server = await startRepaServer({
    agentDir, appDirectory: path.join(root, "application"), trustExtensions: true,
    diagnostics: options.diagnostics ?? { level: "info", write: line => { lines.push(line); } },
    modelOverride: options.failure ? async () => { throw options.failure; } : { modelRuntime: runtime, model: faux.getModel() },
  });
  const client = await RepaClient.connect(server.connection);
  t.after(async () => {
    await server.close();
    await client.close();
    await rm(root, { recursive: true, force: true });
  });
  const space = await client.call("space.open", { path: path.join(root, "space") });
  const session = await client.call("session.create", { spaceId: space.id });
  const target = { spaceId: space.id, sessionId: session.sessionId };
  const submit = (text: string) => client.call("session.submit", {
    target, requestId: randomUUID(), input: { parts: [{ kind: "text", text }] }, dispatch: { kind: "start" },
  });
  const finish = (requestId: string) => until(
    () => client.call("request.get", { spaceId: space.id, requestId }),
    request => ["completed", "failed", "interrupted", "cancelled"].includes(request.status),
  );
  const logs = () => lines.map(line => JSON.parse(line) as DiagnosticRecord);
  return { root, server, client, target, faux, lines, logs, submit, finish };
}

test("诊断串联请求、工具、交互和运行时间点，正常级别不记录正文", async t => {
  const f = await fixture(t);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("fixture_question", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("MODEL_OUTPUT_PRIVATE_TEXT"),
  ]);
  const accepted = await f.submit("USER_INPUT_PRIVATE_TEXT");
  const waiting = await until(() => f.client.call("session.get", f.target), session => session.interactions.length > 0);
  const question = waiting.interactions[0];
  assert(question);
  assert(accepted.runId);
  const steer = await f.client.call("session.submit", {
    target: f.target, requestId: randomUUID(), input: { parts: [{ kind: "text", text: "STEER_PRIVATE_TEXT" }] },
    dispatch: { kind: "steer", expectedRunId: accepted.runId },
  });
  const missed = await f.client.call("session.submit", {
    target: f.target, requestId: randomUUID(), input: { parts: [{ kind: "text", text: "MISSED_PRIVATE_TEXT" }] },
    dispatch: { kind: "steer", expectedRunId: randomUUID() },
  });
  assert.equal(missed.status, "not_entered");
  await f.client.call("interaction.reply", {
    ...f.target, id: question.id, responseId: randomUUID(), value: "INTERACTION_PRIVATE_TEXT",
  });
  assert.equal((await f.finish(accepted.requestId)).status, "completed");
  await f.client.close();
  await until(async () => f.logs(), logs => logs.some(record => record.event === "connection.closed"));
  await f.server.close();

  const logs = f.logs();
  const records = logs.filter(record => record.requestId === accepted.requestId);
  for (const event of ["request.accepted", "run.started", "run.first_status", "tool.started", "tool.finished",
    "interaction.opened", "interaction.replied", "run.first_text", "run.finished"]) {
    assert(records.some(record => record.event === event), `缺少 ${event}`);
  }
  const started = records.find(record => record.event === "run.started");
  const status = records.find(record => record.event === "run.first_status");
  const text = records.find(record => record.event === "run.first_text");
  const finished = records.find(record => record.event === "run.finished");
  assert(started && status && text && finished && started.submittedAt !== undefined);
  assert(started.submittedAt <= started.time && started.time <= status.time && status.time <= text.time && text.time <= finished.time);
  assert(records.filter(record => record.event.startsWith("run.")).every(record => record.runId === accepted.runId));
  assert.equal(finished.firstStatusAt, status.time);
  assert.equal(finished.firstTextAt, text.time);
  assert.equal(finished.status, "completed");
  const steerStates = logs.filter(record => record.event === "request.state" && record.requestId === steer.requestId);
  assert.deepEqual(steerStates.map(record => record.status), ["running", "completed"]);
  assert(steerStates.every(record => record.runId === accepted.runId));
  const missedState = logs.find(record => record.event === "request.state" && record.requestId === missed.requestId);
  assert.equal(missedState?.status, "not_entered");
  assert.equal(missedState.runId, undefined);
  assert.equal(records.find(record => record.event === "request.accepted")?.textLength, "USER_INPUT_PRIVATE_TEXT".length);
  assert(logs.some(record => record.event === "connection.opened"));
  assert(logs.some(record => record.event === "connection.closed"));
  assert(!logs.some(record => record.level === "debug"));
  const output = f.lines.join("");
  for (const secret of ["USER_INPUT_PRIVATE_TEXT", "MODEL_OUTPUT_PRIVATE_TEXT", "INTERACTION_PRIVATE_TEXT",
    "STEER_PRIVATE_TEXT", "MISSED_PRIVATE_TEXT", f.server.connection.token])
    assert(!output.includes(secret));
});

test("运行失败和 RPC 错误保留定位编号与错误代码，不复制异常正文", async t => {
  const f = await fixture(t, { failure: new TypeError("SECRET_IN_UNEXPECTED_ERROR") });
  const accepted = await f.submit("触发本地运行失败");
  assert.equal((await f.finish(accepted.requestId)).status, "failed");
  await assert.rejects(f.client.call("space.browse", { path: path.join(f.root, "missing") }));
  const records = f.logs().filter(record => record.requestId === accepted.requestId);
  assert(records.some(record => record.event === "request.accepted"));
  assert(records.some(record => record.event === "run.started"));
  assert(records.some(record => record.event === "runtime.failed" && record.code === "runtime" && record.errorType === "TypeError"));
  assert(records.some(record => record.event === "run.finished" && record.status === "failed" && record.code === "runtime"));
  assert(f.logs().some(record => record.event === "rpc.failed" && record.method === "space.browse" && record.code === "not_found"));
  assert(!f.lines.join("").includes("SECRET_IN_UNEXPECTED_ERROR"));
});

test("关闭诊断或输出失败不改变正常运行结果", async t => {
  for (const kind of ["off", "sync", "async"] as const) {
    await t.test(kind, async t => {
      let writes = 0;
      const f = await fixture(t, { diagnostics: {
        level: kind === "off" ? "off" : "info",
        write: () => {
          writes++;
          if (kind === "async") return Promise.reject(new Error("异步输出不可用"));
          throw new Error("输出不可用");
        },
      } });
      f.faux.setResponses([fauxAssistantMessage("正常回复")]);
      const accepted = await f.submit("普通任务");
      assert.equal((await f.finish(accepted.requestId)).status, "completed");
      if (kind === "off") assert.equal(writes, 0);
      else assert(writes > 0);
    });
  }
});

test("独立后台处理的状态与交互可按请求编号查询，重复状态不生成结束记录", async t => {
  const f = await fixture(t);
  const requestId = randomUUID();
  await f.server.application.process({
    spaceId: f.target.spaceId, requestId, operation: "diagnostic.check", input: { parts: [{ kind: "text", text: "BACKGROUND_PRIVATE_BODY" }] },
  }, async (_input, context) => {
    await context.ask({ kind: "confirm", title: "BACKGROUND_PRIVATE_QUESTION" });
    return { format: { id: "diagnostic-result", version: "1" }, value: { kind: "inline", data: true }, sources: [], resources: [] };
  });
  const waiting = await until(() => f.client.call("request.get", { spaceId: f.target.spaceId, requestId }),
    request => "interactions" in request && request.interactions.length > 0);
  assert("interactions" in waiting);
  const question = waiting.interactions[0];
  assert(question);
  await f.client.call("interaction.reply", {
    spaceId: f.target.spaceId, id: question.id, responseId: randomUUID(), value: true,
  });
  assert.equal((await f.finish(requestId)).status, "completed");
  const records = f.logs().filter(record => record.requestId === requestId);
  assert.deepEqual(records.filter(record => record.event.startsWith("processing.")).map(record => record.event),
    ["processing.accepted", "processing.running", "processing.completed"]);
  assert(records.some(record => record.event === "interaction.opened"));
  assert(records.some(record => record.event === "interaction.replied"));
  assert(!f.lines.join("").includes("BACKGROUND_PRIVATE"));
});
