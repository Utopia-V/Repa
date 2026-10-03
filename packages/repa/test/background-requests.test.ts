import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Check } from "typebox/value";
import { ContentStore } from "../src/content/store.js";
import { RepaFault } from "../src/errors.js";
import { BackgroundRequests, type BackgroundRequestsOptions } from "../src/requests/background.js";
import {
  BackgroundInteractionSchema,
  SessionInteractionSchema,
  type BackgroundRequest,
  type Input,
  type ProcessingResult,
} from "../src/requests/schema.js";

const input: Input = { parts: [{ kind: "text", text: "本次处理输入" }] };
const inline = (data: unknown): ProcessingResult => ({
  format: { id: "example.result", version: "1" },
  value: { kind: "inline", data },
  sources: [],
  resources: [],
});
const fault = (code: string) => (error: unknown) => error instanceof RepaFault && error.code === code;

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-background-requests-"));
  const requests: BackgroundRequests[] = [];
  const contents: ContentStore[] = [];
  const applicationDirectory = path.join(root, "application", "processing");
  t.after(async () => {
    for (const processing of requests) processing.cancelAll();
    await Promise.all(requests.map((processing) => processing.settled()));
    await Promise.all(contents.map((content) => content.settled()));
    await rm(root, { recursive: true, force: true });
  });
  const open = (options: Partial<BackgroundRequestsOptions> = {}) => {
    const processing = new BackgroundRequests({
      directory: applicationDirectory,
      assertOwned() {},
      changed() {},
      ask: async () => null,
      ...options,
    });
    requests.push(processing);
    return processing;
  };
  const space = async (now: () => number = Date.now) => {
    const directory = path.join(root, "space");
    await mkdir(directory);
    const content = await ContentStore.open({ root: directory, spaceId: "space", now, preparationTtlMs: 10, assertOwned() {} });
    contents.push(content);
    return content;
  };
  return { root, applicationDirectory, open, space };
}

test("应用后台请求持久受理、交互和完成，重传沿用原绑定且不建立空间", async (t) => {
  const f = await fixture(t);
  const changes: BackgroundRequest[] = [];
  const processing = f.open({
    changed: (request) => { changes.push(structuredClone(request)); },
    async ask(requestId, _signal, dialog) {
      const question = { ...dialog, id: randomUUID(), requestId };
      assert(Check(BackgroundInteractionSchema, question));
      processing.interaction(requestId, question.id, question);
      assert.equal(processing.get(requestId).interactions[0]?.spaceId, undefined);
      processing.interaction(requestId, question.id, null);
      return "已确认";
    },
  });
  const submission = {
    requestId: randomUUID(), operation: "example.application", input,
    options: { implementationId: "chosen" }, configuration: { implementationId: "chosen", version: "1" },
  };
  let calls = 0;
  const accepted = processing.submit(submission, async (submitted, context) => {
    calls++;
    assert.deepEqual(submitted, input);
    assert.equal(context.content, undefined);
    context.progress("等待应用级确认");
    const answer = await context.ask({ kind: "confirm", title: "确认本次处理" });
    return inline(answer);
  });
  assert.equal(accepted.spaceId, undefined);
  assert.equal(Object.hasOwn(accepted, "spaceId"), false);
  await processing.settled(accepted.requestId);
  const completed = processing.get(accepted.requestId);
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.result, inline("已确认"));
  assert.equal(completed.progress, "等待应用级确认");
  assert.deepEqual(completed.interactions, []);
  assert(changes.some((request) => request.interactions.length === 1));
  assert(!Check(SessionInteractionSchema, { id: "question", kind: "confirm", title: "会话仍需空间", sessionId: "session", runId: "run" }));
  assert.deepEqual(processing.submit({ ...submission, configuration: { version: "2" } }, async () => { calls++; return inline("不应执行"); }), completed);
  assert.equal(calls, 1);
  assert.throws(() => processing.submit({ ...submission, options: { implementationId: "another" } }, async () => inline("不应执行")), fault("request_id_conflict"));
  const saved: unknown = JSON.parse(await readFile(path.join(f.applicationDirectory, `${accepted.requestId}.json`), "utf8"));
  assert.deepEqual(saved, { version: 1, request: completed });
  assert.deepEqual(f.open().get(accepted.requestId), completed);
  assert(!existsSync(path.join(f.root, "application", ".repa")));
  assert(!existsSync(path.join(f.root, "space")));
});

test("应用后台取消等待处理函数退出，进程中断后恢复为中断且不重放", async (t) => {
  const f = await fixture(t);
  const processing = f.open();
  const entered = deferred();
  const finish = deferred();
  let signal: AbortSignal | undefined;
  const accepted = processing.submit({ requestId: randomUUID(), operation: "example.cancel", input }, async (_submitted, context) => {
    signal = context.signal;
    entered.resolve();
    await finish.promise;
    context.signal.throwIfAborted();
    return inline("不应完成");
  });
  await entered.promise;
  let settled = false;
  const waiting = processing.settled(accepted.requestId).then(() => { settled = true; });
  try {
    assert.equal(processing.cancel(accepted.requestId).status, "cancelling");
    await Promise.resolve();
    assert.equal(signal?.aborted, true);
    assert.equal(settled, false);
  } finally { finish.resolve(); }
  await waiting;
  assert.equal(processing.get(accepted.requestId).status, "cancelled");
  assert.equal(processing.get(accepted.requestId).result, undefined);

  const directory = path.join(f.root, "interrupted", "processing");
  const interruptedId = randomUUID();
  const module = new URL("../src/requests/background.ts", import.meta.url).href;
  const script = `
    import { BackgroundRequests } from ${JSON.stringify(module)};
    const processing = new BackgroundRequests({ directory: process.argv[1], assertOwned() {}, changed() {}, ask: async () => null });
    setInterval(() => {}, 60000);
    processing.submit({ requestId: process.argv[2], operation: "example.interrupted", input: { parts: [{ kind: "text", text: "中断前的输入" }] } }, async () => {
      processing.recordModelAttempt(process.argv[2], {
        callId: "model-call", index: 0, status: "running", startedAt: Date.now(),
        binding: { modelId: "test-model", connection: { id: "test-connection", name: "测试连接", provider: "test",
          authMode: "none", authId: "test-auth", revision: "test-revision", authentication: { configured: true } } },
      });
      processing.interaction(process.argv[2], "pending-question", { id: "pending-question", kind: "input", title: "尚未回答", requestId: process.argv[2] });
      process.send({ requestId: process.argv[2], status: processing.get(process.argv[2]).status });
      await new Promise(() => {});
    });
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script, directory, interruptedId], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  assert(child.stderr);
  child.stderr.on("data", (bytes: Buffer) => { stderr += bytes.toString(); });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const started = await new Promise<unknown>((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
    child.once("exit", () => reject(new Error(`后台处理子进程提前退出：${stderr}`)));
  });
  assert.deepEqual(started, { requestId: interruptedId, status: "running" });
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  const restored = f.open({ directory });
  const interrupted = restored.get(interruptedId);
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.spaceId, undefined);
  assert.deepEqual(interrupted.interactions, []);
  assert.equal(interrupted.modelAttempts?.[0]?.status, "interrupted");
  assert.equal(interrupted.modelAttempts?.[0]?.finishedAt, undefined);
  assert.equal(typeof interrupted.finishedAt, "number");
  assert.equal(restored.active, false);
  let reruns = 0;
  assert.deepEqual(restored.submit({ requestId: interruptedId, operation: interrupted.operation, input: interrupted.input }, async () => {
    reruns++;
    return inline("不会重跑");
  }), interrupted);
  assert.equal(reruns, 0);
});

test("旧空间记录保持可读，输入与结果资源继续由空间后台请求独立持有", async (t) => {
  const f = await fixture(t);
  let now = 1000;
  const content = await f.space(() => now);
  const directory = path.join(content.options.root, ".repa", "runtime", "processing");
  await mkdir(directory, { recursive: true });
  // 固定为旧版空间处理记录的原有形状，不由当前 schema 生成。
  const legacy = {
    requestId: "legacy-processing", spaceId: "space", operation: "example.legacy",
    input: { parts: [{ kind: "text", text: "旧记录输入" }] },
    createdAt: 1, finishedAt: 2, status: "completed", interactions: [],
    result: inline("旧记录结果"),
  };
  await writeFile(path.join(directory, `${legacy.requestId}.json`), JSON.stringify({ version: 1, request: legacy }));
  const processing = f.open({ directory, spaceId: "space", content });
  assert.deepEqual(processing.get(legacy.requestId), legacy);
  const uploaded = await content.upload(Buffer.from("输入字节"), "text/plain", "uploader");
  const accepted = processing.submit({
    requestId: randomUUID(), operation: "example.transform",
    input: { parts: [{ kind: "resource", resource: uploaded.resource }] },
  }, async (_submitted, context) => {
    assert.equal(context.content, content);
    assert(context.content);
    const result = await context.content.upload(Buffer.from("结果字节"), "text/plain", "uploader");
    return { ...inline(null), value: { kind: "resource", resource: result.resource }, resources: [result.resource] };
  });
  await processing.settled(accepted.requestId);
  const completed = processing.get(accepted.requestId);
  assert.equal(completed.status, "completed", completed.error?.message);
  assert.equal(completed.spaceId, "space");
  assert(completed.result?.value.kind === "resource");
  const resultResource = completed.result.value.resource;
  now += 100;
  content.retention.releaseHost("uploader");
  await content.collectResources();
  assert.equal((await content.blobs.get(uploaded.resource.id)).toString(), "输入字节");
  assert.equal((await content.blobs.get(resultResource.id)).toString(), "结果字节");
  assert.deepEqual(f.open({ directory, spaceId: "space", content }).get(accepted.requestId), completed);
  content.retention.releaseOwner(`processing:${accepted.requestId}`);
  await content.collectResources();
  await assert.rejects(content.blobs.get(uploaded.resource.id));
  await assert.rejects(content.blobs.get(resultResource.id));
});

test("应用后台请求不能隐式持有空间资源，输入拒绝和结果失败都保留明确归属", async (t) => {
  const f = await fixture(t);
  const content = await f.space();
  const uploaded = await content.upload(Buffer.from("属于空间的资源"), "text/plain", "uploader");
  const processing = f.open();
  const rejectedId = randomUUID();
  let calls = 0;
  assert.throws(() => processing.submit({ requestId: rejectedId, operation: "example.resource", input: {
    parts: [{ kind: "resource", resource: uploaded.resource }],
  } }, async () => { calls++; return inline("不应执行"); }), fault("space_required"));
  assert.equal(calls, 0);
  assert.equal(processing.requests.has(rejectedId), false);
  assert(!existsSync(path.join(f.applicationDirectory, `${rejectedId}.json`)));
  const accepted = processing.submit({ requestId: randomUUID(), operation: "example.resource-result", input }, async (_submitted, context) => {
    assert.equal(context.content, undefined);
    return { ...inline(null), value: { kind: "resource", resource: uploaded.resource } };
  });
  await processing.settled(accepted.requestId);
  const failed = processing.get(accepted.requestId);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error?.code, "space_required");
  assert.equal(failed.spaceId, undefined);
  assert.equal(failed.result, undefined);
  assert(!existsSync(path.join(f.root, "application", ".repa")));
});
