import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { ContentChangeResultSchema, RepaClient, RpcError, type ContentChangeResult, type ResourceRef } from "repa";
import { callLearning } from "@repa/learning/client";
import { startLearningServer } from "@repa/learning/product";
import { AttemptRecordSchema, AttemptViewSchema, type AttemptFactInput, type AttemptView, type JudgmentInput } from "@repa/learning/protocol";

const fault = (code: string) => (error: unknown) => error instanceof RpcError &&
  error.data !== null && typeof error.data === "object" && "code" in error.data && error.data.code === code;

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= deadline) assert.fail(`等待作答工具运行超时：${JSON.stringify(value)}`);
    await delay(10);
  }
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-attempt-capabilities-"));
  const agentDir = path.join(root, "agent");
  const directory = path.join(root, "space");
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: [], extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"],
    retry: { enabled: false }, compaction: { enabled: false },
  }));
  const faux = fauxProvider({
    api: `attempt-api-${randomUUID()}`, provider: `attempt-provider-${randomUUID()}`,
    models: [{ id: "test", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 2048 }],
    tokensPerSecond: 0,
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const options = { agentDir, appDirectory: path.join(root, "app"), modelOverride: { modelRuntime, model: faux.getModel() } };
  let server = await startLearningServer(options);
  let client = await RepaClient.connect(server.connection);
  t.after(async () => {
    await server.close("cancel");
    await client.close();
    await rm(root, { recursive: true, force: true });
  });
  const space = await client.call("space.open", { path: directory });
  const { resource } = await client.uploadResource(space.id, Buffer.from("题目：2 + 2 = ?\r\n答题依据：整数加法。\n"), "text/plain");
  const reopen = async () => {
    await server.close("cancel");
    await client.close();
    server = await startLearningServer(options);
    client = await RepaClient.connect(server.connection);
    assert.equal((await client.call("space.open", { path: directory })).id, space.id);
  };
  return { root, directory, space, resource, faux, reopen, get client() { return client; } };
}

async function submit(client: RepaClient, target: { spaceId: string; sessionId: string }, text: string) {
  const requestId = randomUUID();
  const accepted = await client.call("session.submit", {
    target, requestId, input: { parts: [{ kind: "text", text }] }, dispatch: { kind: "start" },
  });
  assert(accepted.runId);
  const runId = accepted.runId;
  const run = await until(() => client.call("run.get", { spaceId: target.spaceId, runId }),
    value => ["completed", "failed", "cancelled", "interrupted"].includes(value.status));
  assert.equal(run.status, "completed", JSON.stringify(run));
  return { requestId, runId };
}

function fact(resource: ResourceRef): AttemptFactInput {
  return {
    actor: { kind: "synthetic", label: "本地接入样本" },
    response: { kind: "text", text: "4；保留字符 e\u0301 与 🌊。\r\n" },
    materials: [{ resource, selector: "第 1 行", source: "固定题目 v1" }],
    initialConditions: { kind: "unknown" }, assistance: { kind: "unknown" },
  };
}

function judgment(view: AttemptView, resource: ResourceRef): JudgmentInput {
  return {
    factId: view.factId,
    method: { kind: "program", name: "fixture-integer-addition", version: "1" },
    basis: [{ resource, source: "固定判据 v1" }],
    conclusions: [{ criterion: "integer-addition", verdict: "met", explanation: "样本答案为 4。" }],
  };
}

function attemptRef(result: ContentChangeResult) {
  const ref = result.contents.find(content => content.role === "document")?.ref;
  assert(ref, "公开保存结果应返回作答文档引用");
  return ref;
}

function toolValue(context: TranscriptContext, name: string): unknown {
  const message = context.messages.findLast(message => message.role === "toolResult" && message.toolName === name);
  assert(message && message.role === "toolResult", `真实 provider 应收到 ${name} 结果`);
  const text = message.content.map(part => part.type === "text" ? part.text : "").join("\n");
  assert.equal(message.isError, false, text);
  return JSON.parse(text);
}

function toolView(context: TranscriptContext): AttemptView {
  const value = toolValue(context, "get_learning_attempt");
  assert(Check(AttemptViewSchema, value));
  return value;
}

function toolSaved(context: TranscriptContext, name: string): ContentChangeResult {
  const value = toolValue(context, name);
  assert(Check(ContentChangeResultSchema, value));
  return value;
}

test("公开作答能力区分候选与采用，拒绝旧版本和伪造来源，重开后新请求重传不重复事实及历史", async t => {
  const f = await fixture(t);
  const input = { spaceId: f.space.id, operationId: randomUUID(), fact: fact(f.resource) };
  const recorded = await callLearning(f.client, "attempt.record", input);
  assert.deepEqual(await callLearning(f.client, "attempt.record", input), recorded);
  const ref = attemptRef(recorded);
  const first = await callLearning(f.client, "attempt.get", { spaceId: f.space.id, ref });
  assert.equal(first.fact.recordedBy.kind, "client");
  assert.equal(first.fact.actor.kind, "synthetic");
  assert.equal(first.current, null);
  assert.deepEqual(first.judgments, []);

  const replayRequestId = randomUUID();
  const replay = await f.client.call("capability.invoke", {
    scope: { kind: "space", spaceId: f.space.id }, requestId: replayRequestId,
    contract: { id: "repa.attempt.record", version: "1" },
    input: { operationId: input.operationId, fact: input.fact },
  });
  assert.equal(replay.kind, "inline");
  assert(replay.kind === "inline");
  assert.deepEqual(replay.result, recorded);
  const replayRequest = await f.client.call("request.get", { spaceId: f.space.id, requestId: replayRequestId });
  assert("input" in replayRequest);
  const submitted = replayRequest.input.parts[0];
  assert(submitted?.kind === "data");
  assert.deepEqual(submitted.representation.resources, [f.resource], "声明的事实输入证据随真实请求保留");
  assert("result" in replayRequest && replayRequest.result);
  assert.deepEqual(replayRequest.result.resources, first.resources, "保存结果交付作答所属资源");

  const saveInput = {
    spaceId: f.space.id, operationId: randomUUID(), ref, base: first.base,
    judgment: judgment(first, f.resource),
  };
  const saved = await callLearning(f.client, "attempt.judgment.save", saveInput);
  const candidate = await callLearning(f.client, "attempt.get", { spaceId: f.space.id, ref });
  const candidateId = candidate.judgments[0]?.id;
  assert(candidateId);
  assert.equal(candidate.current, null, "保存候选不隐式采用");
  assert.deepEqual(candidate.selections, []);
  await assert.rejects(callLearning(f.client, "attempt.judgment.select", {
    spaceId: f.space.id, operationId: randomUUID(), ref, base: first.base,
    judgmentId: candidateId, reason: "过期页面的选择",
  }), fault("revision_conflict"));
  await assert.rejects(callLearning(f.client, "attempt.judgment.save", {
    ...saveInput, operationId: randomUUID(),
  }), fault("revision_conflict"));
  const selectInput = {
    spaceId: f.space.id, operationId: randomUUID(), ref, base: candidate.base,
    judgmentId: candidateId, reason: "明确采用固定判据的候选",
  };
  const selected = await callLearning(f.client, "attempt.judgment.select", selectInput);
  const adopted = await callLearning(f.client, "attempt.get", { spaceId: f.space.id, ref });
  assert.equal(adopted.current, candidateId);
  assert.equal(adopted.selections.length, 1);
  const revoked = await callLearning(f.client, "attempt.judgment.select", {
    spaceId: f.space.id, operationId: randomUUID(), ref, base: adopted.base,
    judgmentId: null, reason: "等待人工核对，撤销当前采用",
  });
  assert(attemptRef(revoked));
  const beforeReopen = await callLearning(f.client, "attempt.get", { spaceId: f.space.id, ref });
  assert.equal(beforeReopen.current, null);
  assert.deepEqual(beforeReopen.selections.map(item => [item.from, item.to]), [[null, candidateId], [candidateId, null]]);

  await assert.rejects(f.client.call("capability.invoke", {
    scope: { kind: "space", spaceId: f.space.id }, requestId: randomUUID(),
    contract: { id: "repa.attempt.record", version: "1" },
    input: { operationId: randomUUID(), fact: { ...input.fact, recordedBy: { kind: "client", hostId: "forged" } } },
  }), fault("invalid_capability_input"));

  const readRequestId = randomUUID();
  await f.client.call("capability.invoke", {
    scope: { kind: "space", spaceId: f.space.id }, requestId: readRequestId,
    contract: { id: "repa.attempt.get", version: "1" }, input: { ref },
  });
  const readRequest = await f.client.call("request.get", { spaceId: f.space.id, requestId: readRequestId });
  assert.equal(readRequest.status, "completed");
  assert("result" in readRequest && readRequest.result);
  assert.deepEqual(readRequest.result.resources, beforeReopen.resources, "inline 读取也交付所属能力声明的资源");

  await f.reopen();
  // callLearning 每次生成新的 capability requestId，业务 operationId 保持不变。
  assert.deepEqual(await callLearning(f.client, "attempt.record", input), recorded);
  assert.deepEqual(await callLearning(f.client, "attempt.judgment.save", saveInput), saved);
  assert.deepEqual(await callLearning(f.client, "attempt.judgment.select", selectInput), selected);
  assert.deepEqual(await callLearning(f.client, "attempt.get", { spaceId: f.space.id, ref }), beforeReopen,
    "既有事实、时间、来源和已撤销的采用历史保持原样");
});

test("真实Pi从工具正文读取事实与正文版本，再保存候选和显式采用，声明回答者不替代真实录入来源", async t => {
  const f = await fixture(t);
  const session = await f.client.call("session.create", { spaceId: f.space.id });
  const key = { spaceId: f.space.id, sessionId: session.sessionId };
  let recorded: ContentChangeResult | undefined;
  let candidateId: string | undefined;
  let finalView: AttemptView | undefined;
  f.faux.setResponses([
    context => {
      const tools = getCurrentTools(context.messages);
      for (const name of ["get_learning_attempt", "record_learning_attempt", "save_learning_judgment", "select_learning_judgment"]) {
        const tool = tools.find(item => item.name === name);
        assert(tool, `${name} 应进入真实 SDK provider 请求`);
        assert(!JSON.stringify(tool.parameters).includes('"operationId"'));
        assert(!JSON.stringify(tool.parameters).includes('"recordedBy"'));
      }
      const get = tools.find(item => item.name === "get_learning_attempt");
      assert(get && Check(get.parameters, { contentId: "observed-content" }));
      assert(!Check(get.parameters, { ref: { spaceId: f.space.id, id: "invented" } }));
      return fauxAssistantMessage(fauxToolCall("record_learning_attempt", { fact: fact(f.resource) }), { stopReason: "toolUse" });
    },
    context => {
      recorded = toolSaved(context, "record_learning_attempt");
      return fauxAssistantMessage(fauxToolCall("get_learning_attempt", { contentId: attemptRef(recorded).id }), { stopReason: "toolUse" });
    },
    context => {
      const view = toolView(context);
      assert.equal(view.fact.actor.kind, "synthetic");
      assert.equal(view.fact.recordedBy.kind, "agent");
      assert.equal(view.current, null);
      return fauxAssistantMessage(fauxToolCall("save_learning_judgment", {
        contentId: view.ref.id, base: view.base,
        judgment: { ...judgment(view, f.resource), method: { kind: "model", name: "local-faux-flow", version: "1" } },
      }), { stopReason: "toolUse" });
    },
    context => {
      const saved = toolSaved(context, "save_learning_judgment");
      return fauxAssistantMessage(fauxToolCall("get_learning_attempt", { contentId: attemptRef(saved).id }), { stopReason: "toolUse" });
    },
    context => {
      const view = toolView(context);
      candidateId = view.judgments[0]?.id;
      assert(candidateId);
      assert.equal(view.current, null);
      assert.equal(view.judgments.length, 1);
      assert.equal(view.judgments[0]?.factId, view.factId);
      return fauxAssistantMessage(fauxToolCall("select_learning_judgment", {
        contentId: view.ref.id, base: view.base, judgmentId: candidateId, reason: "接入样本显式采用",
      }), { stopReason: "toolUse" });
    },
    context => {
      const selected = toolSaved(context, "select_learning_judgment");
      return fauxAssistantMessage(fauxToolCall("get_learning_attempt", { contentId: attemptRef(selected).id }), { stopReason: "toolUse" });
    },
    context => {
      finalView = toolView(context);
      assert.equal(finalView.current, candidateId);
      return fauxAssistantMessage("已保存接入样本和候选，并记录显式采用。");
    },
  ]);
  const { requestId, runId } = await submit(f.client, key, "录入合成作答样本，保存候选，再显式采用。");
  assert(recorded && finalView && candidateId);
  const source = { kind: "agent", spaceId: f.space.id, sessionId: session.sessionId, runId, requestId };
  assert.deepEqual(finalView.fact.recordedBy, source);
  assert.deepEqual(finalView.judgments[0]?.recordedBy, source);
  assert.deepEqual(finalView.selections[0]?.recordedBy, source);
  assert.equal(finalView.fact.actor.kind, "synthetic");
  assert.deepEqual(await callLearning(f.client, "attempt.get", { spaceId: f.space.id, ref: attemptRef(recorded) }), finalView);
  assert.equal(f.faux.state.callCount, 7, "只验证真实 SDK 的工具链与数据传递");
});

test("复制空间保留原事实与候选字节和历史来源，当前资源映射到副本且更正不改变原件", async t => {
  const f = await fixture(t);
  let recorded: ContentChangeResult | undefined;
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("record_learning_attempt", { fact: fact(f.resource) }), { stopReason: "toolUse" }),
    context => {
      recorded = toolSaved(context, "record_learning_attempt");
      return fauxAssistantMessage("原空间作答样本已录入。");
    },
  ]);
  const session = await f.client.call("session.create", { spaceId: f.space.id });
  const { requestId, runId } = await submit(f.client, { spaceId: f.space.id, sessionId: session.sessionId }, "录入空间复制用的合成作答。");
  assert(recorded);
  const ref = attemptRef(recorded);
  const first = await callLearning(f.client, "attempt.get", { spaceId: f.space.id, ref });
  await callLearning(f.client, "attempt.judgment.save", {
    spaceId: f.space.id, operationId: randomUUID(), ref, base: first.base,
    judgment: judgment(first, f.resource), adopt: { reason: "原件已确认的选择" },
  });
  const original = await callLearning(f.client, "attempt.get", { spaceId: f.space.id, ref });
  const info = await f.client.call("content.get", { target: { kind: "content", ref } });
  const indexBytes = await readFile(path.join(f.directory, info.location.path));
  const index: unknown = JSON.parse(indexBytes.toString("utf8"));
  assert(Check(AttemptRecordSchema, index));
  const oldResources = [index.fact, ...index.judgments.map(item => item.resource)];
  const originalBytes = await Promise.all(oldResources.map(async resource => {
    const bytes = Buffer.from(await (await f.client.resource({ ...resource, spaceId: f.space.id })).arrayBuffer());
    assert.equal(createHash("sha256").update(bytes).digest("hex"), resource.id);
    return bytes;
  }));
  const copied = await f.client.call("space.copy", {
    spaceId: f.space.id, destination: path.join(f.root, "copy"), operationId: randomUUID(),
  });
  assert.equal(copied.status, "completed", copied.error?.message);
  const space = await f.client.call("space.open", { path: copied.destination });
  assert.notEqual(space.id, f.space.id);
  const copyRef = { ...ref, spaceId: space.id };
  const copy = await callLearning(f.client, "attempt.get", { spaceId: space.id, ref: copyRef });
  assert.equal(copy.factId, original.factId);
  assert.equal(copy.base, original.base);
  assert.deepEqual(copy.fact, original.fact);
  assert.deepEqual(copy.fact.recordedBy, {
    kind: "agent", spaceId: f.space.id, sessionId: session.sessionId, runId, requestId,
  }, "历史录入来源仍指向原空间的实际运行");
  assert.deepEqual(copy.judgments, original.judgments);
  assert.deepEqual(copy.selections, original.selections);
  assert.equal(copy.current, original.current);
  assert.deepEqual(copy.resources, original.resources.map(resource => ({ ...resource, spaceId: space.id })));
  assert.deepEqual(await readFile(path.join(copied.destination, info.location.path)), indexBytes);
  for (const [position, resource] of oldResources.entries()) {
    assert.deepEqual(Buffer.from(await (await f.client.resource({ ...resource, spaceId: space.id })).arrayBuffer()), originalBytes[position]);
  }

  const previousId = copy.judgments[0]?.id;
  assert(previousId);
  await callLearning(f.client, "attempt.judgment.save", {
    spaceId: space.id, operationId: randomUUID(), ref: copyRef, base: copy.base,
    judgment: {
      ...judgment(copy, { ...f.resource, spaceId: space.id }),
      conclusions: [{ criterion: "integer-addition", verdict: "undetermined", explanation: "副本等待复核。" }],
      supersedes: { id: previousId, reason: "副本独立更正" },
    }, adopt: { reason: "采用副本的新候选" },
  });
  const corrected = await callLearning(f.client, "attempt.get", { spaceId: space.id, ref: copyRef });
  assert.equal(corrected.judgments.length, 2);
  const correction = corrected.judgments[1];
  assert(correction);
  assert.equal(corrected.current, correction.id);
  assert.deepEqual(correction.supersedes, { id: previousId, reason: "副本独立更正" });
  assert.deepEqual(corrected.fact, original.fact);
  assert.deepEqual(corrected.judgments[0], original.judgments[0]);
  assert.deepEqual(await callLearning(f.client, "attempt.get", { spaceId: f.space.id, ref }), original);
  assert.deepEqual(await readFile(path.join(f.directory, info.location.path)), indexBytes);
});
