import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AttemptViewSchema, callLearning, startLearningServer, type AttemptView } from "@repa/learning";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { RepaClient } from "repa/client";
import type { ResourceRef, SessionKey } from "repa/protocol";

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) => part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "")
    .join("\n");
}

function toolText(context: TranscriptContext, name: string): string {
  const message = context.messages.findLast(item => item.role === "toolResult" && item.toolName === name);
  assert(message && message.role === "toolResult");
  assert.equal(message.isError, false, textOf(message.content));
  return textOf(message.content);
}

const tool = (name: string, input: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, input), { stopReason: "toolUse" });

const backgrounds = (context: TranscriptContext) => context.messages
  .map(message => textOf(message.content))
  .filter(text => text.includes("<repa_learning_context>"));

test("官方教学接续读取采用判断和固定依据，候选、更正与撤回不改原事实或触发复习评分", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-judgment-consumption-"));
  let closeServer = async () => {};
  let closeClient = async () => {};
  t.after(async () => {
    try {
      await closeServer();
    } finally {
      try {
        await closeClient();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
  const directory = path.join(root, "space");
  const agentDir = path.join(root, "agent");
  await mkdir(directory);
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: [],
    extensions: ["!**/*"],
    skills: ["!**/*"],
    prompts: ["!**/*"],
    themes: ["!**/*"],
    retry: { enabled: false },
    compaction: { enabled: false },
  }));
  const faux = fauxProvider({
    api: `judgment-${randomUUID()}`,
    provider: `judgment-${randomUUID()}`,
    models: [{
      id: "test",
      reasoning: false,
      input: ["text"],
      contextWindow: 32768,
      maxTokens: 1024,
    }],
    tokensPerSecond: 0,
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const options = {
    directory,
    agentDir,
    appDirectory: path.join(root, "app"),
    modelOverride: { modelRuntime, model: faux.getModel() },
  };
  let server = await startLearningServer(options);
  closeServer = () => server.close("cancel");
  let client = await RepaClient.connect(server.connection);
  closeClient = () => client.close();
  const space = await client.call("space.open", { path: directory });
  const scope = { kind: "space" as const, spaceId: space.id };
  const settings = await client.call("settings.get", { scope, namespace: "plugins" });
  const disabled = settings.entries.find(entry => entry.key === "disabled");
  assert(disabled);
  await client.call("settings.set", {
    scope,
    namespace: "plugins",
    key: "disabled",
    value: ["repa-review"],
    base: disabled.revision,
  });
  const responseText = "SYNTHETIC_RESPONSE: 2x^2+2x-6";
  const hintText = "USED_HINT: 相减时给g的所有项变号。";
  const materialText = "FIXED_PROBLEM: f=x^2+4x+1，g=-x^2+2x+7，求f-g。";
  const wrongBasisText = "OLD_REFERENCE: 2x+6（合成夹具的错误参考，不是原题答案）。";
  const correctedBasisText = "CORRECTED_REFERENCE: 2x^2+2x-6（固定题面下的修正参考）。";
  const candidateBasisText = "UNADOPTED_REFERENCE: 独立复核候选，仍需核对指定参考。";
  const upload = async (text: string) => (await client.uploadResource(space.id, Buffer.from(text), "text/plain")).resource;
  const [material, hint, wrongBasis, correctedBasis, candidateBasis] = await Promise.all([
    materialText, hintText, wrongBasisText, correctedBasisText, candidateBasisText,
  ].map(upload));
  assert(material && hint && wrongBasis && correctedBasis && candidateBasis);
  const saved = await callLearning(client, "attempt.record", {
    spaceId: space.id,
    operationId: randomUUID(),
    fact: {
      actor: { kind: "synthetic", label: "确定性教学消费夹具" },
      response: { kind: "text", text: responseText },
      materials: [{ resource: material, selector: "fixture:fixed-problem" }],
      initialConditions: { kind: "unknown" },
      assistance: {
        kind: "reported",
        text: hintText,
        sources: [{ resource: hint }],
      },
      provenance: "合成原回答、题面与已用提示；本测试只核对教学输入接续，不运行代数评分。",
    },
  });
  const ref = saved.contents.find(content => content.ref)?.ref;
  assert(ref);
  const get = () => callLearning(client, "attempt.get", { spaceId: space.id, ref });
  const original = await get();
  assert.equal(original.fact.actor.kind, "synthetic");
  assert.equal(original.fact.recordedBy.kind, "client");
  const factResource = { spaceId: space.id, id: original.factId, mediaType: "application/json" };
  const bytes = async (resource: ResourceRef) => Buffer.from(await (await client.resource(resource)).arrayBuffer());
  const originalFactBytes = await bytes(factResource);
  const basisTexts = new Map([
    [wrongBasis.id, wrongBasisText],
    [correctedBasis.id, correctedBasisText],
    [candidateBasis.id, candidateBasisText],
  ]);
  const saveJudgment = async (basis: ResourceRef, explanation: string, adopt: boolean, supersedes?: string) => {
    const before = await get();
    await callLearning(client, "attempt.judgment.save", {
      spaceId: space.id,
      operationId: randomUUID(),
      ref,
      base: before.base,
      judgment: {
        factId: before.factId,
        method: { kind: "human", name: "synthetic-fixture-judgment", version: "1" },
        basis: [{ resource: basis }],
        conclusions: [{
          criterion: "原回答与所指固定参考式代数等价",
          verdict: "undetermined",
          explanation,
        }],
        ...(supersedes ? {
          supersedes: {
            id: supersedes,
            reason: "合成参考更正保留历史",
          },
        } : {}),
      },
      ...(adopt ? {
        adopt: { reason: "夹具明确采用；不推断掌握度" },
      } : {}),
    });
    const after = await get();
    const judgment = after.judgments.find(item => !before.judgments.some(prior => prior.id === item.id));
    assert(judgment);
    return { view: after, id: judgment.id };
  };
  const select = async (id: string | null) => {
    const before = await get();
    await callLearning(client, "attempt.judgment.select", {
      spaceId: space.id,
      operationId: randomUUID(),
      ref,
      base: before.base,
      judgmentId: id,
      reason: id === null ? "撤回采用，保留原件" : "明确采用纠正候选",
    });
    return get();
  };
  const bound = await callLearning(client, "context.get", { spaceId: space.id });
  await callLearning(client, "context.set", {
    spaceId: space.id,
    operationId: randomUUID(),
    base: bound.revision,
    binding: { kind: "document", ref },
  });
  const first = await client.call("session.create", { spaceId: space.id });
  let key: SessionKey = { spaceId: space.id, sessionId: first.sessionId };
  let teachingMethod = "";
  let sends = 0;
  const seenViews: AttemptView[] = [];
  const seenIndexes: string[] = [];
  const consumedBasisIds: string[] = [];
  const consume = async (expected: AttemptView, readSkill = false, fresh = false) => {
    const index = await client.readText({ kind: "content", ref });
    const callbacks = [
      async (context: TranscriptContext) => {
        const current = backgrounds(context);
        assert(current.length >= 1);
        assert(current.at(-1)?.includes(index.text));
        for (const snapshot of current) {
          for (const marker of [responseText, hintText, wrongBasisText, correctedBasisText]) {
            assert(!snapshot.includes(marker));
          }
        }
        assert(getCurrentTools(context.messages).some(item => item.name === "get_learning_attempt"));
        assert(getCurrentTools(context.messages).every(item => !item.name.startsWith("review_")));
        if (fresh) {
          assert.equal(context.messages.filter(item => item.role === "toolResult" && item.toolName === "get_learning_attempt").length, 0);
        }
        if (readSkill) {
          const system = getCurrentSystemPrompt(context.messages);
          const location = /<name>learn-with-feedback<\/name>\s*<description>[\s\S]*?<\/description>\s*<location>([^<]+)<\/location>/u.exec(system)?.[1];
          assert(location);
          teachingMethod = await readFile(location, "utf8");
          return tool("read", { path: location });
        }
        if (sends >= 1 && !fresh) {
          assert(current.length >= 2, "更新后保留旧自动快照，最后一条是当前索引");
          const previousIndex = seenIndexes[0];
          const previousView = seenViews[0];
          assert(previousIndex && previousView);
          assert(current.some(snapshot => snapshot.includes(previousIndex)), "最初索引快照仍是历史，不假装已删除");
          assert(context.messages.some(item => item.role === "toolResult" && item.toolName === "get_learning_attempt" &&
            textOf(item.content) === JSON.stringify(previousView)), "旧完整view工具结果仍是历史");
        }
        return tool("get_learning_attempt", { contentId: ref.id });
      },
      ...(readSkill ? [(context: TranscriptContext) => {
        assert(toolText(context, "read").includes(teachingMethod));
        return tool("get_learning_attempt", { contentId: ref.id });
      }] : []),
      (context: TranscriptContext) => {
        const actual: unknown = JSON.parse(toolText(context, "get_learning_attempt"));
        assert(Check(AttemptViewSchema, actual));
        assert.deepEqual(actual, expected);
        assert.deepEqual(actual.fact, original.fact);
        seenViews.push(actual);
        if (actual.current === null) {
          return fauxAssistantMessage("已读到撤回采用，记录仍保留。");
        }
        const current = actual.judgments.find(item => item.id === actual.current);
        assert(current);
        const basis = current.basis[0]?.resource;
        assert(basis);
        assert(basisTexts.has(basis.id));
        consumedBasisIds.push(basis.id);
        return tool("read", { path: `repa:resource/${basis.id}` });
      },
      ...(expected.current !== null ? [(context: TranscriptContext) => {
        const basis = expected.judgments.find(item => item.id === expected.current)?.basis[0]?.resource;
        assert(basis);
        assert.equal(toolText(context, "read"), basisTexts.get(basis.id));
        return fauxAssistantMessage("已读取当前采用判断及其固定依据；这是数据接续回执。");
      }] : []),
    ];
    faux.setResponses(callbacks);
    const accepted = await client.call("session.submit", {
      target: key,
      requestId: randomUUID(),
      input: {
        parts: [{ kind: "text", text: "读取本次作答的当前采用判断及其固定依据。" }],
      },
      dispatch: { kind: "start" },
    });
    assert(accepted.runId);
    const deadline = Date.now() + 15000;
    for (;;) {
      const run = await client.call("run.get", { spaceId: space.id, runId: accepted.runId });
      if (["completed", "failed", "cancelled", "interrupted"].includes(run.status)) {
        assert.equal(run.status, "completed", JSON.stringify(run));
        break;
      }
      assert(Date.now() < deadline, JSON.stringify(run));
      await delay(10);
    }
    sends++;
    seenIndexes.push(index.text);
    assert.deepEqual(await bytes(factResource), originalFactBytes);
    assert.deepEqual((await get()).fact.assistance, original.fact.assistance);
    assert.equal(existsSync(path.join(directory, ".repa/plugins/repa-review/reviews.sqlite")), false);
  };
  const j0 = await saveJudgment(wrongBasis, "J0: 已采用的合成旧参考判断，具体结论不代表掌握状态。", true);
  assert.equal(j0.view.current, j0.id);
  await consume(j0.view, true, true);
  const j1 = await saveJudgment(correctedBasis, "J1: 修正参考后的候选，尚未采用。", false, j0.id);
  assert.equal(j1.view.current, j0.id);
  await consume(j1.view);
  const adopted = await select(j1.id);
  assert.equal(adopted.current, j1.id);
  const j2 = await saveJudgment(candidateBasis, "J2: 更晚保存但未采用的候选。", false);
  assert.equal(j2.view.current, j1.id);
  await consume(j2.view);
  const revoked = await select(null);
  assert.equal(revoked.current, null);
  await consume(revoked);
  const next = await client.call("session.create", { spaceId: space.id });
  key = { spaceId: space.id, sessionId: next.sessionId };
  await consume(await get(), false, true);
  await select(j1.id);
  await server.close("cancel");
  await client.close();
  server = await startLearningServer(options);
  client = await RepaClient.connect(server.connection);
  assert.equal((await client.call("space.open", { path: directory })).id, space.id);
  const resumed = await client.call("session.create", { spaceId: space.id });
  key = { spaceId: space.id, sessionId: resumed.sessionId };
  const final = await get();
  assert.equal(final.current, j1.id);
  assert.deepEqual(final.judgments.map(item => item.id), [j0.id, j1.id, j2.id]);
  assert.deepEqual(final.fact, original.fact);
  assert.deepEqual(final.judgments[0], j0.view.judgments[0]);
  assert.deepEqual(final.judgments[1], j1.view.judgments[1]);
  assert.deepEqual(final.judgments[2], j2.view.judgments[2]);
  await consume(final, false, true);
  assert.deepEqual(consumedBasisIds, [wrongBasis.id, wrongBasis.id, correctedBasis.id, correctedBasis.id]);
  assert.deepEqual(seenViews.map(view => view.current), [j0.id, j0.id, j1.id, null, null, j1.id]);
  assert.equal((await bytes(material)).toString("utf8"), materialText);
  assert.equal((await bytes(hint)).toString("utf8"), hintText);
  for (const [id, text] of basisTexts) {
    assert.equal((await bytes({ spaceId: space.id, id, mediaType: "text/plain" })).toString("utf8"), text);
  }
});
