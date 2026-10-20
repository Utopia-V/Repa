import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { RepaFault, startServer } from "@repa/base";
import { RepaClient, RpcError } from "@repa/base/client";
import { INTERACTION_CAPABILITIES, parse } from "@repa/base/protocol";
import { stringify } from "yaml";
import { createAgentRuntimeForTest } from "../../base/dist/agent/runtime.js";
import { referenceResponse, topicQuestions } from "../src/check/items.js";
import { mapAnswer } from "../src/delivery.js";
import { createLearningPlugin } from "../src/plugin.js";
import { LearningEventSchema, learningMethods, type LearningEvent, type LearningInput, type LearningMethod, type LearningResult } from "../src/protocol.js";
import { LearningRecords } from "../src/records.js";
import { TUTOR_AGENT } from "../src/tutor.js";
import { requireReferenceAccess } from "../src/tutor-content.js";
import { recoveryTrace } from "./fixtures/learning-contract.js";
import type { Course, Topic } from "../src/format/schema.js";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const fault = (code: string) => (error: unknown) => {
  assert.ok(error instanceof RpcError);
  assert.ok(error.data && typeof error.data === "object" && "code" in error.data);
  assert.equal(error.data.code, code);
  return true;
};
async function fixture(t: TestContext, topics?: Topic[]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-tutor-"));
  let root = path.join(directory, "space");
  const home = path.join(directory, "home");
  const agentDir = path.join(home, "agent");
  await mkdir(root);
  await mkdir(agentDir, { recursive: true });
  const bundled = path.join(directory, "course");
  if (topics) {
    await mkdir(path.join(bundled, "topics"), { recursive: true });
    const course: Course = {
      id: "test", title: "测试课程", version: "1.0.0", language: "zh-CN", license: "Apache-2.0",
      runtime: { pyodide: "314.0.7", python: "3.14.2", packages: {} },
      sources: {}, topics: topics.map((entry) => entry.id),
    };
    await writeFile(path.join(bundled, "course.yaml"), stringify(course));
    for (const topic of topics) {
      await writeFile(path.join(bundled, "topics", `${topic.id}.yaml`), stringify(topic, { aliasDuplicateObjects: false }));
    }
  }
  const faux = fauxProvider({
    api: `tutor-${randomUUID()}`, provider: `tutor-${randomUUID()}`,
    models: [{ id: "test", contextWindow: 32768, maxTokens: 512 }], tokensPerSecond: 0,
  });
  const models = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"), modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false,
  });
  models.registerNativeProvider(faux.provider);
  const runtime = await createAgentRuntimeForTest({
    agentDir, modelRuntime: models, defaultModel: { provider: faux.getModel().provider, id: "test" },
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
  });
  let now = 1_792_454_400_000;
  let failAbort = false;
  const learning = createLearningPlugin({
    now: () => now,
    ...(topics ? { sources: [{ kind: "bundled", directory: bundled }] } : {}),
  });
  const server = await startServer({
    home, runtime, generalAgent: false, directAgents: [TUTOR_AGENT],
    plugins: [{
      ...learning,
      async open(host) {
        const instance = await learning.open({
          ...host,
          async abortAgent(agent) {
            if (failAbort) {
              failAbort = false;
              throw new RepaFault("abort_failed", "故障注入：中止暂时失败");
            }
            await host.abortAgent(agent);
          },
        });
        return {
          ...instance,
          methods: {
            ...instance.methods,
            "probe.tutor": {
              parameters: learningMethods["state.get"].input,
              async invoke() {
                const work = await host.models.runAgent({ agent: TUTOR_AGENT, text: "在模型请求前重新检查任务" });
                await work.result;
                return {};
              },
            },
          },
        };
      },
    }],
  });
  const client = await RepaClient.connect(server.connection, {
    capabilities: { interaction: { vocabulary: 1, supports: [...INTERACTION_CAPABILITIES] } },
  });
  const changes: LearningEvent[] = [];
  client.on("plugin.event", ({ pluginId, event }) => {
    if (pluginId === "learning") {
      changes.push(parse(LearningEventSchema, event));
    }
  });
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  await client.call("space.open", { root });
  const session = await client.call("session.create", { agent: TUTOR_AGENT });
  async function call<M extends LearningMethod>(method: M, input: LearningInput<M>): Promise<LearningResult<M>> {
    return parse(learningMethods[method].result, await client.call("plugin.call", {
      pluginId: "learning", method, input,
    })) as LearningResult<M>;
  }
  const state = () => call("state.get", {});
  const logFile = () => path.join(root, ".repa/plugins/learning/records.jsonl");
  async function log() {
    const records = await LearningRecords.open(logFile(), () => now);
    await records.close();
    return records;
  }
  async function select(kind: "lesson" | "review" = "lesson", topicId = topics?.[0]?.id ?? "py01") {
    const current = await state();
    const candidate = current.menu?.candidates.find((entry) => entry.kind === kind && entry.topicIds.includes(topicId));
    assert.ok(candidate, JSON.stringify(current.menu));
    assert.ok(current.menu);
    return call("menu.select", { menuId: current.menu.menuId, candidateId: candidate.id });
  }
  async function advance() {
    const current = await state();
    assert.ok(current.task);
    return call("task.advance", {
      taskId: current.task.taskId, expectedStage: current.task.phase.stage, expectedRevision: current.revision,
    });
  }
  async function submit() {
    const current = await state();
    const task = current.task;
    const delivery = task?.deliveries.at(-1);
    assert.ok(task && delivery);
    const records = await log();
    const snapshot = records.snapshot(records.current()?.deliveries[delivery.deliveryId] ?? "");
    assert.ok(snapshot);
    const question = topicQuestions(snapshot.topic).find((entry) => entry.question.id === snapshot.questionId)?.question;
    assert.ok(question);
    const response = referenceResponse(question, delivery.item);
    for (const slot of delivery.item.slots) {
      const answer = response.answers[slot.id];
      if (answer) {
        response.answers[slot.id] = mapAnswer(answer, slot, snapshot.idMap, true);
      }
    }
    return call("submission.submit", {
      taskId: task.taskId, deliveryId: delivery.deliveryId, submissionId: delivery.submissionId, response,
    });
  }
  async function finish() {
    for (let steps = 0; steps < 50; steps++) {
      const current = await state();
      if (current.task?.phase.stage === "completed") {
        return current;
      }
      if (current.task?.phase.stage === "awaiting_answer") {
        await submit();
      } else {
        await advance();
      }
    }
    throw new Error("学习任务未在 50 步内完成");
  }
  return {
    client, session, faux, call, state, select, advance, submit, finish, log, changes,
    time: (value: number) => { now = value; },
    now: () => now,
    failNextAbort: () => { failAbort = true; },
    async replaceTopic(topic: Topic) {
      await client.call("space.close", {});
      await writeFile(path.join(bundled, "topics", `${topic.id}.yaml`), stringify(topic, { aliasDuplicateObjects: false }));
      await client.call("space.open", { root });
    },
    async copyAndReopen() {
      const before = await state();
      const student = (await log()).current()?.student;
      await client.call("space.close", {});
      const bytes = await readFile(logFile());
      const destination = path.join(directory, "restored");
      await cp(root, destination, { recursive: true });
      const evidence = process.env.REPA_LEARNING_EVIDENCE;
      if (evidence) {
        await mkdir(evidence, { recursive: true });
        const saved = await mkdtemp(path.join(evidence, "tutor-restored-"));
        await cp(destination, saved, { recursive: true });
      }
      root = destination;
      await client.call("space.open", { root });
      assert.deepEqual(await readFile(logFile()), bytes);
      assert.deepEqual(await state(), before);
      assert.deepEqual((await log()).current()?.student, student);
      // Pi 1.1.0 按原 cwd 过滤会话；学习日志已恢复，聊天入口的迁址缺口留给底座处理。
      await assert.rejects(client.call("session.history", { sessionId: session.id }), fault("session_not_found"));
    },
  };
}

test("真实辅导请求只有学习工具，求助影响判分与下一轮 view，跨天复习后整空间复制恢复一致", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const agents = await f.client.call("agent.list", {});
  assert.deepEqual(agents.map((entry) => entry.id), [TUTOR_AGENT]);
  await f.select();
  await f.advance();
  await f.advance();
  const captures: TranscriptContext[] = [];
  f.faux.setResponses([(context) => {
    captures.push(structuredClone(context));
    return fauxAssistantMessage([
      fauxToolCall("learning_task", {}),
      fauxToolCall("learning_search", { query: "赋值" }),
    ]);
  }, fauxAssistantMessage("先看右边的值")]);
  await f.client.call("session.send", { sessionId: f.session.id, text: "赋值是什么意思？" });
  const first = captures[0];
  assert.ok(first);
  assert.deepEqual(getCurrentTools(first.messages).map((tool) => tool.name), ["learning_read", "learning_search", "learning_task"]);
  assert.match(getCurrentSystemPrompt(first.messages), /学习辅导老师/u);
  const history = await f.client.call("session.history", { sessionId: f.session.id });
  const taskRead = history.find((entry) => entry.type === "tool" && entry.text?.includes('"total"'));
  assert.ok(taskRead?.text);
  const result: unknown = JSON.parse(taskRead.text);
  assert.ok(result && typeof result === "object" && "text" in result && typeof result.text === "string");
  assert.match(result.text, /"delivery":\{/u);
  assert.match(result.text, /"submission":null/u);
  assert.match(JSON.stringify(first.messages), /agent:learning-tutor.*awaiting_answer/u);
  await f.submit();
  const after = await f.state();
  assert.equal(after.task?.kps[0]?.consecutiveCorrect, 0);
  const accepted = (await f.log()).records.find((entry) => entry.type === "accepted");
  assert.ok(accepted?.type === "accepted" && accepted.context.helpBefore.length >= 1);
  f.faux.setResponses([(context) => {
    captures.push(structuredClone(context));
    return fauxAssistantMessage("已经接受这份原答");
  }]);
  await f.client.call("session.send", { sessionId: f.session.id, text: "现在进度怎样？" });
  assert.match(JSON.stringify(captures.at(-1)?.messages), /feedback/u);
  const completed = await f.finish();
  assert.equal(completed.task?.phase.stage, "completed");
  const hits = await f.call("content.search", { query: "赋值", offset: 0, limit: 10 });
  const card = hits.hits.find((entry) => entry.ref.kind === "card");
  assert.ok(card);
  const pages = await f.call("content.read", { refs: [card.ref], offset: 0, limit: 8 });
  assert.equal(pages[0]?.origin.taskId, completed.task?.taskId);
  assert.equal(pages[0]?.origin.content.kind, "example");
  assert.ok(pages[0]);
  const original = await f.call("content.read", { refs: [pages[0].origin.content], offset: 0, limit: 8 });
  assert.equal(original[0]?.ref.kind, "example");
  await f.call("content.open", { ref: card.ref });
  assert.equal(f.changes.at(-1)?.revision, (await f.state()).revision);
  assert.ok((await f.log()).records.some((entry) => entry.type === "viewed" && entry.action === "card"));
  f.time(f.now() + 10 * 86_400_000);
  await f.select("review");
  await assert.rejects(f.call("content.read", { refs: [card.ref], offset: 0, limit: 8 }), fault("restricted"));
  await assert.rejects(f.call("content.open", { ref: card.ref }), fault("restricted"));
  await assert.rejects(f.client.call("session.send", { sessionId: f.session.id, text: "提示" }), fault("message_rejected"));
  await f.finish();
  await f.call("content.read", { refs: [card.ref], offset: 0, limit: 8 });
  await f.copyAndReopen();
});

test("复习 preparing 先拒收消息和内容，回复取消停稳后才计时，交卷后恢复辅导", { timeout: 30000 }, async (t) => {
  const release = deferred();
  t.after(() => release.resolve());
  const f = await fixture(t);
  await f.select();
  await f.finish();
  const { hits } = await f.call("content.search", { query: "赋值", offset: 0, limit: 10 });
  const ref = hits[0]?.ref;
  assert.ok(ref);
  f.time(f.now() + 10 * 86_400_000);
  const started = deferred();
  const cancelled = deferred();
  f.faux.setResponses([async (_context, options) => {
    started.resolve();
    await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
    cancelled.resolve();
    await release.promise;
    return fauxAssistantMessage("不应继续辅导");
  }]);
  const running = f.client.call("session.send", { sessionId: f.session.id, text: "复习前再讲讲" });
  await started.promise;
  const selecting = f.select("review");
  await Promise.race([cancelled.promise, selecting.then(() => { throw new Error("取消前已经交付"); })]);
  const preparing = await f.state();
  assert.equal(preparing.task?.phase.stage, "preparing");
  assert.equal(preparing.task?.startedAt, null);
  await assert.rejects(f.client.call("session.followUp", { sessionId: f.session.id, text: "继续提示" }), fault("cancelled"));
  await assert.rejects(f.call("content.search", { query: "", offset: 0, limit: 10 }), fault("restricted"));
  f.time(f.now() + 5000);
  release.resolve();
  const active = await selecting;
  await running.catch(() => undefined);
  assert.equal(active.task?.startedAt, f.now());
  const calls = f.faux.state.callCount;
  await assert.rejects(f.client.call("plugin.call", {
    pluginId: "learning", method: "probe.tutor", input: {},
  }), fault("restricted"));
  assert.equal(f.faux.state.callCount, calls);
  await f.finish();
  await f.call("content.read", { refs: [ref], offset: 0, limit: 8 });
  f.faux.setResponses([fauxAssistantMessage("可以回顾了")]);
  await f.client.call("session.send", { sessionId: f.session.id, text: "回顾" });
});

function topic(id: string): Topic {
  return {
    id, title: id, status: "complete", minutes: 5, prerequisites: [], sources: [],
    kps: Array.from({ length: 5 }, (_, index) => {
      const kpId = `${id}.k${index + 1}`;
      const question = {
        id: `${kpId}.q1`, body: "测试题", explanation: "未开放的私有题解",
        slots: [{ id: "answer", type: "text" as const, key: "私有答案" }],
      };
      return {
        id: kpId, title: kpId,
        lesson: index === 0
          ? Array.from({ length: 40 }, () => ({ type: "markdown" as const, text: "长内容。".repeat(100) }))
          : "短讲解",
        example: { ...question, id: `${kpId}.e1`, explanation: "可见例题解说" },
        card: {
          name: kpId, definition: "概念定义", conditions: ["适用条件"],
          example: { from: question.id, text: "概念的例子" },
        },
        practice: [{ ...question, body: index === 0 ? "当前题面。".repeat(800) : question.body }], review: [{ ...question, id: `${kpId}.r1` }],
      };
    }),
  };
}

test("检索稳定分页、批取和长块续取均可定位，卡片关联交付，猜未开放题解和未学内容被拒", async (t) => {
  const f = await fixture(t, [topic("t01"), topic("t02")]);
  await f.select();
  const search = () => f.call("content.search", { query: "", offset: 0, limit: 20 });
  const first = await search();
  assert.deepEqual(await search(), first);
  assert.ok(first.nextOffset !== null);
  const second = await f.call("content.search", { query: "", offset: first.nextOffset, limit: 20 });
  const hits = [...first.hits, ...second.hits];
  assert.equal(hits.length, 21);
  assert.equal(new Set(hits.map((entry) => entry.ref.id)).size, hits.length);
  assert.ok(hits.every((entry) => entry.ref.topicId === "t01"));
  assert.doesNotMatch(JSON.stringify(hits), /未开放的私有题解|私有答案/u);
  const refs = hits.filter((entry) => entry.ref.kind === "example" || entry.ref.kind === "card").slice(0, 8).map((entry) => entry.ref);
  assert.equal((await f.call("content.read", { refs, offset: 0, limit: 8 })).length, 8);
  const lesson = hits.find((entry) => entry.ref.kind === "lesson");
  assert.ok(lesson);
  let text = "";
  let offset = 0;
  for (;;) {
    const result = await f.call("content.read", { refs: [lesson.ref], offset, limit: 64 });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 16 * 1024);
    const page = result[0];
    assert.ok(page && page.blocks.length > 0);
    text += page.blocks.map((block) => block.type === "image" ? "" : block.text).join("");
    offset += page.blocks.length;
    if (offset >= page.total) {
      break;
    }
  }
  assert.equal(text, "长内容。".repeat(4000));
  await assert.rejects(f.call("content.read", { refs: [{ ...lesson.ref, id: "t01.k1.q1", kind: "explanation" }], offset: 0, limit: 8 }), fault("invalid_input"));
  await assert.rejects(f.call("content.read", { refs: [{ ...lesson.ref, topicId: "t02" }], offset: 0, limit: 8 }), fault("invalid_input"));
  await f.advance();
  await f.advance();
  const current = await f.state();
  f.faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("learning_task", { offset: 0, limit: 3000 }),
      fauxToolCall("learning_task", { offset: 3000, limit: 3000 }),
    ]),
    fauxAssistantMessage("已经读到当前题面"),
  ]);
  await f.client.call("session.send", { sessionId: f.session.id, text: "帮我看看当前题目" });
  const history = await f.client.call("session.history", { sessionId: f.session.id });
  const chunks = history.filter((entry) => entry.type === "tool").map((entry) => {
    const value: unknown = JSON.parse(entry.text ?? "null");
    assert.ok(value && typeof value === "object" && "text" in value && typeof value.text === "string");
    assert.ok("version" in value && typeof value.version === "string");
    assert.ok(Buffer.byteLength(entry.text ?? "") <= 16 * 1024);
    return { text: value.text, version: value.version };
  });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.version, chunks[1]?.version);
  const restored: unknown = JSON.parse(chunks.map((entry) => entry.text).join(""));
  assert.match(JSON.stringify(restored), /当前题面/u);
  const card = hits.find((entry) => entry.ref.id === "t01.k1.card");
  assert.ok(card);
  const [page] = await f.call("content.read", { refs: [card.ref], offset: 0, limit: 8 });
  assert.equal(page?.origin.deliveryId, current.task?.deliveries[0]?.deliveryId);
  await f.submit();
  assert.equal((await f.state()).task?.kps[0]?.consecutiveCorrect, 0);
  const explanations = await f.call("content.search", { query: "未开放的私有题解", offset: 0, limit: 10 });
  assert.equal(explanations.hits.length, 1);
  const changed = topic("t01");
  const kp = changed.kps[0];
  assert.ok(kp);
  kp.lesson = "修改后的讲解";
  await f.replaceTopic(changed);
  const retained = await f.call("content.read", { refs: [lesson.ref], offset: 0, limit: 1 });
  assert.match(JSON.stringify(retained), /长内容/u);
  const fresh = await f.call("content.search", { query: "修改后的讲解", offset: 0, limit: 10 });
  assert.ok(fresh.hits.some((entry) => entry.ref.version !== lesson.ref.version));
});

test("中止失败保留 preparing，整空间重开后显式继续同一个受限任务", async (t) => {
  const f = await fixture(t);
  await f.select();
  await f.finish();
  f.time(f.now() + 10 * 86_400_000);
  f.failNextAbort();
  await assert.rejects(f.select("review"), fault("abort_failed"));
  const before = await f.state();
  assert.equal(before.task?.phase.stage, "preparing");
  assert.equal(before.task?.startedAt, null);
  await f.copyAndReopen();
  assert.ok(before.task);
  const resumed = await f.call("task.resume", {
    taskId: before.task.taskId, expectedStage: "preparing", expectedRevision: before.revision,
  });
  assert.equal(resumed.task?.taskId, before.task.taskId);
  assert.equal(resumed.task?.phase.stage, "awaiting_answer");
  assert.equal(resumed.task?.startedAt, f.now());
});


test("沿公开测验轨迹，quiz 与 retake 的准备和进行阶段均关闭参考读取，结束后恢复", () => {
  for (const kind of ["quiz", "retake"] as const) {
    for (const state of recoveryTrace()) {
      if (state.task?.kind !== "quiz") {
        continue;
      }
      state.task.kind = kind;
      const current = { state, student: {}, deliveries: {} };
      if (["completed", "aborted"].includes(state.task.phase.stage)) {
        assert.equal(requireReferenceAccess(current), current);
      } else {
        assert.throws(() => requireReferenceAccess(current), (error: unknown) => {
          assert.ok(error instanceof RepaFault);
          assert.equal(error.code, "restricted");
          return true;
        });
      }
    }
  }
});
