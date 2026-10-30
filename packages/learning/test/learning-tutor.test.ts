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
import { memoryAt } from "@repa/learning-model";
import { PYTHON_BATCH, PythonBatchInputSchema, type PythonTest } from "@repa/python-runner/protocol";
import { stringify } from "yaml";
import { createAgentRuntimeForTest } from "../../base/dist/agent/runtime.js";
import { connectLearning } from "../src/flow.js";
import { createLearningPlugin } from "../src/plugin.js";
import {
  LearningEventSchema, learningMethods,
  type Delivery, type LearnerResponse, type LearningEvent, type LearningInput, type LearningMethod, type LearningResult,
} from "../src/protocol.js";
import type { LearningSession } from "../src/session.js";
import { DAY_MS } from "../src/student-model.js";
import { TUTOR_AGENT } from "../src/tutor.js";
import { requireReferenceAccess } from "../src/tutor-content.js";
import { recoveryTrace } from "./fixtures/learning-contract.js";
import { referenceAnswer } from "./fixtures/learning-session.js";
import type { Course, Question, Topic } from "../src/format/schema.js";

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

/** 模型这一次请求里实际收到的最后一个工具结果。 */
function lastToolResult(context: TranscriptContext): { text: string; isError: boolean } {
  const message = context.messages.findLast((entry) => entry.role === "toolResult");
  assert.ok(message?.role === "toolResult");
  return { text: message.content.map((part) => (part.type === "text" ? part.text : "")).join(""), isError: message.isError };
}

/** 模型这一次请求里实际收到的视图文字。 */
function viewTexts(context: TranscriptContext): string[] {
  return context.messages.flatMap((message) => {
    if (message.role !== "user" || typeof message.content === "string") {
      return typeof message.content === "string" && message.content.includes("<repa-view") ? [message.content] : [];
    }
    return message.content.flatMap((part) => (part.type === "text" && part.text.includes("<repa-view") ? [part.text] : []));
  });
}

interface FixtureOptions {
  /** python.run 的替身：不运行 Python，按每个测试给出程序打印的内容。省略时前端不声明 python.run。 */
  python?: (job: PythonTest) => string;
}

async function fixture(t: TestContext, topics?: Topic[], options: FixtureOptions = {}) {
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
  // 插件的时间取自底座：运行时的 now 经协议宿主交给插件，测试在这里拨动时间。
  let now = 1_792_454_400_000;
  const runtime = await createAgentRuntimeForTest({
    agentDir, modelRuntime: models, defaultModel: { provider: faux.getModel().provider, id: "test" }, now: () => now,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
  });
  let failAbort = false;
  let current: LearningSession | undefined;
  const learning = createLearningPlugin({
    ...(topics ? { sources: [{ kind: "bundled", directory: bundled }] } : {}),
    async connect(opened, host) {
      current = opened;
      return connectLearning(opened, { beforeRestricted: () => host.abortAgent(TUTOR_AGENT) });
    },
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
    capabilities: {
      interaction: { supports: [...INTERACTION_CAPABILITIES] },
      ...(options.python ? { services: ["python.run"] } : {}),
    },
  });
  const python = options.python;
  if (python) {
    client.on("service.request", ({ id, service, input }) => {
      assert.equal(service, "python.run");
      const tests = parse(PythonBatchInputSchema, input).tests.map((job) => ({
        id: job.id, status: "completed" as const,
        result: { stdout: python(job), error: null, captures: {}, doctest: [] },
      }));
      void client.call("service.reply", {
        id, result: { protocol: PYTHON_BATCH, runtime: { pyodide: "314.0.7", python: "3.14.2", packages: {} }, tests },
      });
    });
  }
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
  const chat = await client.call("session.create", { agent: TUTOR_AGENT });
  async function call<M extends LearningMethod>(method: M, input: LearningInput<M>): Promise<LearningResult<M>> {
    return parse(learningMethods[method].result, await client.call("plugin.call", {
      pluginId: "learning", method, input,
    })) as LearningResult<M>;
  }
  const state = () => call("state.get", {});
  const logFile = () => path.join(root, ".repa/plugins/learning/records.jsonl");
  const session = () => {
    assert.ok(current);
    return current;
  };
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
  async function abort() {
    const current = await state();
    assert.ok(current.task);
    return call("task.abort", {
      taskId: current.task.taskId, expectedStage: current.task.phase.stage, expectedRevision: current.revision,
    });
  }
  /** 交当前这道题；answers 按这次交付的题目写出作答，省略时用标准答案，返回 undefined 表示说“不会”。 */
  async function submit(answers?: (delivery: Delivery) => LearnerResponse["answers"] | undefined) {
    const current = await state();
    const task = current.task;
    const delivery = task?.deliveries.at(-1);
    assert.ok(task && delivery);
    let response = await referenceAnswer(session(), delivery);
    if (answers) {
      const given = answers(delivery);
      response = given ? { ...response, answers: given } : { item: response.item, answers: {}, dontKnow: true };
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
  /** 让模型调用一次工具，返回模型下一次请求里实际收到的工具结果。 */
  async function toolResult(name: string, input: Parameters<typeof fauxToolCall>[1]) {
    let received: { text: string; isError: boolean } | undefined;
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(name, input)]),
      (context) => {
        received = lastToolResult(context);
        return fauxAssistantMessage("好的");
      },
    ]);
    await client.call("session.send", { sessionId: chat.id, text: "帮我看看" });
    assert.ok(received);
    return received;
  }
  return {
    client, chat, faux, call, state, select, advance, abort, submit, finish, session, changes, toolResult,
    root: () => root,
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
      const student = (await session().view()).student;
      const history = await client.call("session.history", { sessionId: chat.id });
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
      assert.deepEqual((await session().view()).student, student);
      assert.deepEqual(await client.call("session.history", { sessionId: chat.id }), history);
    },
  };
}

test("真实辅导请求只有学习工具和续取用的 read，求助影响判分与下一轮视图，跨天复习后整空间复制恢复一致", { timeout: 30000 }, async (t) => {
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
  await f.client.call("session.send", { sessionId: f.chat.id, text: "赋值是什么意思？" });
  const first = captures[0];
  assert.ok(first);
  assert.deepEqual(getCurrentTools(first.messages).map((tool) => tool.name).sort(), ["learning_read", "learning_search", "learning_task", "read"]);
  assert.match(getCurrentSystemPrompt(first.messages), /学习辅导老师[^]*repa:concept\/知识点编号/u);
  const history = await f.client.call("session.history", { sessionId: f.chat.id });
  const taskRead = history.find((entry) => entry.type === "tool" && entry.text?.includes("## 题目"));
  assert.ok(taskRead?.text);
  assert.match(taskRead.text, /^课「给数据起名，再按顺序读」\n知识点 py01\.k1「[^」]+」\n学习者还没有提交这道题。\n\n## 题目\n/u);
  assert.doesNotMatch(taskRead.text, /deliveryId|submissionId|"item"|\{"/u);
  const views = viewTexts(first);
  assert.equal(views.length, 1);
  assert.match(views[0] ?? "", /^<repa-view source="agent:learning-tutor">\n当前任务：课「给数据起名，再按顺序读」，学习者正在作答一道题\n知识点「[^」]+」：已答 0 题，连续独立答对 0 题\n<\/repa-view>$/u);
  await f.submit();
  const after = await f.state();
  assert.equal(after.task?.kps[0]?.consecutiveCorrect, 0);
  // 作答之前的提问记成一条求助事实，排在作答之前；同一道题只记一次。
  const facts = f.session().records.facts;
  const answered = facts.find((entry) => entry.type === "answered");
  assert.ok(answered?.type === "answered");
  const help = facts.filter((entry) => entry.type === "help" && entry.delivery === answered.delivery);
  assert.equal(help.length, 1);
  assert.ok((help[0]?.seq ?? Infinity) < answered.seq);
  f.faux.setResponses([(context) => {
    captures.push(structuredClone(context));
    return fauxAssistantMessage("已经接受这份原答");
  }]);
  await f.client.call("session.send", { sessionId: f.chat.id, text: "现在进度怎样？" });
  const latest = captures.at(-1);
  assert.ok(latest);
  assert.match(viewTexts(latest).at(-1) ?? "", /学习者在看判分结果\n知识点「[^」]+」：已答 1 题，连续独立答对 0 题/u);
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
  // 题目之外打开卡片不是作答前的求助，不写事实。
  const revision = f.session().records.revision;
  await f.call("content.open", { ref: card.ref });
  assert.equal(f.session().records.revision, revision);
  assert.equal(f.changes.at(-1)?.revision, (await f.state()).revision);
  f.time(f.now() + 10 * 86_400_000);
  await f.select("review");
  await assert.rejects(f.call("content.read", { refs: [card.ref], offset: 0, limit: 8 }), fault("restricted"));
  await assert.rejects(f.call("content.open", { ref: card.ref }), fault("restricted"));
  await assert.rejects(f.client.call("session.send", { sessionId: f.chat.id, text: "提示" }), fault("message_rejected"));
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
  const running = f.client.call("session.send", { sessionId: f.chat.id, text: "复习前再讲讲" });
  await started.promise;
  const selecting = f.select("review");
  await Promise.race([cancelled.promise, selecting.then(() => { throw new Error("取消前已经交付"); })]);
  const preparing = await f.state();
  assert.equal(preparing.task?.phase.stage, "preparing");
  assert.equal(preparing.task?.startedAt, null);
  await assert.rejects(f.client.call("session.followUp", { sessionId: f.chat.id, text: "继续提示" }), fault("cancelled"));
  await assert.rejects(f.call("content.search", { query: "", offset: 0, limit: 10 }), fault("restricted"));
  f.time(f.now() + 5000);
  release.resolve();
  const active = await selecting;
  await running.catch(() => undefined);
  assert.equal(active.task?.startedAt, f.now());
  const calls = f.faux.state.callCount;
  await assert.rejects(f.client.call("plugin.call", {
    pluginId: "learning", method: "probe.tutor", input: {},
  }), fault("message_rejected"));
  const preview = await f.client.call("prompt.preview", { agent: TUTOR_AGENT });
  assert.equal(preview.views.length, 1);
  assert.match(preview.views[0]?.text ?? "", /^当前任务：复习「给数据起名，再按顺序读」，学习者正在作答一道题$/u);
  assert.equal(f.faux.state.callCount, calls);
  await f.finish();
  await f.call("content.read", { refs: [ref], offset: 0, limit: 8 });
  f.faux.setResponses([fauxAssistantMessage("可以回顾了")]);
  await f.client.call("session.send", { sessionId: f.chat.id, text: "回顾" });
});

/** 测试用的 topic：五个知识点，k1 的讲解有 40 块长文字，k1 的练习题面有三个各 1,000 行的代码块。 */
function topic(id: string): Topic {
  const code = (block: number) => ({
    type: "code" as const, language: "python",
    text: Array.from({ length: 1000 }, (_, line) => `v${block * 1000 + line + 1} = ${line}`).join("\n"),
  });
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
        practice: [{ ...question, body: index === 0 ? [{ type: "markdown" as const, text: "当前题面。" }, code(0), code(1), code(2)] : question.body }],
        review: [{ ...question, id: `${kpId}.r1` }],
      };
    }),
  };
}

test("前端的检索稳定分页、批取和长块续取均可定位，卡片关联交付，猜未开放题解和未学内容被拒", async (t) => {
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
  // 只提供当前课程里的内容：课程换版以后，旧版本的引用按不存在处理。
  await assert.rejects(f.call("content.read", { refs: [lesson.ref], offset: 0, limit: 1 }), fault("invalid_input"));
  const fresh = await f.call("content.search", { query: "修改后的讲解", offset: 0, limit: 10 });
  assert.ok(fresh.hits.some((entry) => entry.ref.version !== lesson.ref.version));
});

test("当前题目超过底座的输出上限时，模型收到开头、结尾和全文位置，再用 read 按行续取中间部分", async (t) => {
  const f = await fixture(t, [topic("t01")]);
  await f.select();
  await f.advance();
  await f.advance();
  let shown = "";
  let continued = "";
  let offset = 0;
  f.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("learning_task", {})]),
    (context) => {
      shown = lastToolResult(context).text;
      const file = /全文在 (\S+)，可用 read 工具按行读取/u.exec(shown)?.[1];
      assert.ok(file);
      // 开头按整行截取，下一行就是省略部分的第一行。
      offset = (shown.slice(0, shown.indexOf("\n[中间省略")).match(/\n/gu)?.length ?? 0) + 1;
      return fauxAssistantMessage([fauxToolCall("read", { path: file, offset, limit: 20 })]);
    },
    (context) => {
      continued = lastToolResult(context).text;
      return fauxAssistantMessage("读到了中间的代码");
    },
  ]);
  await f.client.call("session.send", { sessionId: f.chat.id, text: "这道题太长了" });
  const file = /全文在 (\S+)，/u.exec(shown)?.[1];
  assert.ok(file);
  const full = await readFile(path.join(f.root(), file), "utf8");
  // 全文是写给模型的分行文字：题面三个代码块的 3,000 行原样分行写出。
  assert.match(full, /^课「t01」\n知识点 t01\.k1「t01\.k1」\n学习者还没有提交这道题。\n\n## 题目\n当前题面。\n\n```python\nv1 = 0\n/u);
  assert.match(full, /\nv3000 = 999\n```\n\n填写文字。$/u);
  const [head = "", rest = ""] = shown.split(/\n\[中间省略 \d+ 字节、\d+ 行；全文在 \S+，可用 read 工具按行读取\]\n/u);
  assert.ok(full.startsWith(head) && full.endsWith(rest));
  assert.ok(head.length + rest.length < full.length);
  assert.doesNotMatch(shown, /\nv1500 = 499\n/u);
  const lines = full.split("\n");
  assert.equal(continued.split("\n").slice(0, 20).join("\n"), lines.slice(offset - 1, offset + 19).join("\n"));
});

/** 只有一个知识点的 topic，练习就是给定的这一道题。 */
function lessonWith(id: string, question: Omit<Question, "id">): Topic {
  const kpId = `${id}.k1`;
  return {
    id, title: `${id} 的课`, status: "complete", minutes: 5, prerequisites: [], sources: [],
    kps: [{
      id: kpId, title: `${id} 的知识点`, lesson: "先算右边，再让左边的名字指向结果。",
      example: { id: `${kpId}.e1`, body: "例题", explanation: "例题解说", slots: [{ id: "answer", type: "text", key: "1" }] },
      practice: [{ ...question, id: `${kpId}.q1` }],
    }],
  };
}

const CHOICE: Omit<Question, "id"> = {
  body: "阅读下面的程序。\n\n```python startLine=1\nsamples = 6\nreserve = 2\nusable = samples - reserve\n```",
  slots: [
    { id: "output", type: "text", format: "integer", prompt: "`usable` 是多少？", key: 4 },
    {
      id: "source", type: "choice", prompt: "`usable` 的值是怎样来的？", key: "computed",
      options: [
        { id: "computed", content: "`samples` 减 `reserve` 算出的结果" },
        { id: "literal", content: "程序里直接写下的数字 4" },
        { id: "printed", content: "```python\nprint(usable)\nprint(4)\n```" },
      ],
    },
  ],
  explanation: "第三行先算 6 - 2 得到 4，再让 `usable` 指向 4。",
};
const CODE: Omit<Question, "id"> = {
  body: "列表 `nums` 已经准备好了。写代码打印 `nums` 里所有数的和。",
  slots: [{
    id: "code", type: "code", language: "python", starter: "# 在下面写代码\n", solution: "print(sum(nums))\n",
    tests: [
      { name: "三个数", setup: "nums = [1, 2, 3]", stdout: "6\n" },
      { name: "一个数", hidden: true, setup: "nums = [3]", stdout: "3\n" },
    ],
  }],
  explanation: "`sum(nums)` 求和，再用 `print` 显示。",
};
const OPEN: Omit<Question, "id"> = {
  body: "下面的程序显示什么？\n\n```python\nx = 1\nx = x + 1\nprint(x)\n```",
  slots: [{
    id: "why", type: "text", lines: 4, prompt: "说出显示的值，并说明原因。",
    rubric: [{ id: "value", label: "说出显示 2" }, { id: "reason", label: "说明先算右边再赋值" }],
  }],
  explanation: "显示 2：第二行先算右边的 x + 1 得到 2，再让 x 指向 2。",
};

/** 选项在这次交付里的序号（从 1 起，按学习者看到的顺序）和不透明编号。 */
function option(delivery: Delivery, slotId: string, text: string): { number: number; id: string } {
  const slot = delivery.item.slots.find((entry) => entry.id === slotId);
  assert.ok(slot?.type === "choice");
  const index = slot.options.findIndex((entry) => JSON.stringify(entry.content).includes(text));
  const found = slot.options[index];
  assert.ok(found);
  return { number: index + 1, id: found.id };
}

test("模型读到的当前题目是分行文字：选择题、代码题和开放题判分前后各读一次", { timeout: 30000 }, async (t) => {
  // python.run 的替身不运行 Python：学习者的 print(len(nums) * 3) 在第一个测试里打印 9，在第二个测试里打印 3。
  const f = await fixture(t, [lessonWith("c01", CHOICE), lessonWith("c02", CODE), lessonWith("c03", OPEN)], {
    python: (job) => (job.setup === "nums = [1, 2, 3]" ? "9\n" : "3\n"),
  });
  await f.select("lesson", "c01");
  assert.equal((await f.toolResult("learning_task", {})).text, [
    "课「c01 的课」",
    "知识点 c01.k1「c01 的知识点」",
    "学习者在读这个知识点的讲解，还没开始做这个知识点的题。",
    "",
    "## 讲解",
    "先算右边，再让左边的名字指向结果。",
  ].join("\n"));
  await f.advance();
  await f.advance();
  const delivery = (await f.state()).task?.deliveries.at(-1);
  assert.ok(delivery);
  const right = option(delivery, "source", "算出的结果");
  const wrong = option(delivery, "source", "直接写下");
  const printed = option(delivery, "source", "print(4)");
  const choiceBefore = (await f.toolResult("learning_task", {})).text;
  assert.ok(choiceBefore.startsWith([
    "课「c01 的课」",
    "知识点 c01.k1「c01 的知识点」",
    "学习者还没有提交这道题。",
    "",
    "## 题目",
    "阅读下面的程序。",
    "",
    "```python",
    "1 | samples = 6",
    "2 | reserve = 2",
    "3 | usable = samples - reserve",
    "```",
    "",
    "### 第 1 问",
    "`usable` 是多少？",
    "填一个整数。",
    "",
    "### 第 2 问",
    "`usable` 的值是怎样来的？",
    "单选，选项按学习者看到的顺序：",
  ].join("\n")), choiceBefore);
  assert.ok(choiceBefore.includes(`\n${right.number}. \`samples\` 减 \`reserve\` 算出的结果\n`) || choiceBefore.endsWith(`\n${right.number}. \`samples\` 减 \`reserve\` 算出的结果`));
  assert.ok(choiceBefore.includes(`${printed.number}.\n  \`\`\`python\n  print(usable)\n  print(4)\n  \`\`\``), choiceBefore);
  assert.doesNotMatch(choiceBefore, /学习者的作答|判分|## 题解|第三行先算|\bo[0-9a-f]{16}\b|\b[tds]\d+\b|\{"/u);
  await f.submit(() => ({ output: { type: "text", text: "4" }, source: { type: "choice", selected: [wrong.id] } }));
  const choiceAfter = (await f.toolResult("learning_task", {})).text;
  assert.ok(choiceAfter.startsWith([
    "课「c01 的课」",
    "知识点 c01.k1「c01 的知识点」",
    "学习者已提交这道题，判分结果：部分正确。作答前问过辅导或读过参考内容，这次不算独立完成。",
    "",
    "## 题目",
  ].join("\n")), choiceAfter);
  assert.ok(choiceAfter.includes("`usable` 是多少？\n填一个整数。\n学习者的作答：4\n判分：正确\n\n### 第 2 问"), choiceAfter);
  assert.ok(choiceAfter.endsWith([
    `学习者的作答：选 ${wrong.number}`,
    "判分：错误",
    `正确答案：选 ${right.number}`,
    "",
    "## 题解",
    "第三行先算 6 - 2 得到 4，再让 `usable` 指向 4。",
  ].join("\n")), choiceAfter);
  await f.abort();

  await f.select("lesson", "c02");
  await f.advance();
  await f.advance();
  const codeQuestion = [
    "## 题目",
    "列表 `nums` 已经准备好了。写代码打印 `nums` 里所有数的和。",
    "",
    "写代码，起始代码：",
    "```python",
    "# 在下面写代码",
    "```",
  ];
  assert.equal((await f.toolResult("learning_task", {})).text, [
    "课「c02 的课」",
    "知识点 c02.k1「c02 的知识点」",
    "学习者还没有提交这道题。",
    "",
    ...codeQuestion,
  ].join("\n"));
  await f.submit(() => ({ code: { type: "code", code: "# 在下面写代码\nprint(len(nums) * 3)\n" } }));
  assert.equal((await f.toolResult("learning_task", {})).text, [
    "课「c02 的课」",
    "知识点 c02.k1「c02 的知识点」",
    "学习者已提交这道题，判分结果：错误。作答前问过辅导或读过参考内容，这次不算独立完成。",
    "",
    ...codeQuestion,
    "学习者的作答：",
    "```python",
    "# 在下面写代码",
    "print(len(nums) * 3)",
    "```",
    "判分：错误",
    "测试：",
    "- 「三个数」：没通过",
    "- 「一个数」（隐藏）：通过",
    "正确答案：",
    "```python",
    "print(sum(nums))",
    "```",
    "",
    "## 题解",
    "`sum(nums)` 求和，再用 `print` 显示。",
  ].join("\n"));
  await f.abort();

  await f.select("lesson", "c03");
  await f.advance();
  await f.advance();
  const openQuestion = [
    "## 题目",
    "下面的程序显示什么？",
    "",
    "```python",
    "x = 1",
    "x = x + 1",
    "print(x)",
    "```",
    "",
    "说出显示的值，并说明原因。",
    "填写文字。",
  ];
  assert.equal((await f.toolResult("learning_task", {})).text, [
    "课「c03 的课」",
    "知识点 c03.k1「c03 的知识点」",
    "学习者还没有提交这道题。",
    "",
    ...openQuestion,
  ].join("\n"));
  // 开放题由隔离的模型按评分要点判分。
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall("submit_result", { verdict: "partial", reason: "说出了 2，但没有说明先算右边再赋值。" })])]);
  await f.submit(() => ({ why: { type: "text", text: "显示 2。\n因为 x 加了 1。" } }));
  assert.equal((await f.toolResult("learning_task", {})).text, [
    "课「c03 的课」",
    "知识点 c03.k1「c03 的知识点」",
    "学习者已提交这道题，判分结果：部分正确（由模型按评分要点判）。作答前问过辅导或读过参考内容，这次不算独立完成。",
    "",
    ...openQuestion,
    "学习者的作答：",
    "```",
    "显示 2。",
    "因为 x 加了 1。",
    "```",
    "判分：部分正确",
    "判分理由：说出了 2，但没有说明先算右边再赋值。",
    "",
    "## 题解",
    "显示 2：第二行先算右边的 x + 1 得到 2，再让 x 指向 2。",
  ].join("\n"));
});

test("模型搜索和读取学过的内容：每条结果一行编号与名称，按编号读全文，编号不可读时告诉模型怎样查找", async (t) => {
  const f = await fixture(t, [topic("t01"), topic("t02")]);
  await f.select();
  const search = await f.toolResult("learning_search", { query: "概念定义", limit: 2 });
  assert.equal(search.text, [
    "- `t01.k1.card` 知识点 t01.k1「t01.k1」的概念卡「t01.k1」，课「t01」",
    "  概念定义 适用条件 概念的例子",
    "- `t01.k2.card` 知识点 t01.k2「t01.k2」的概念卡「t01.k2」，课「t01」",
    "  概念定义 适用条件 概念的例子",
    "还有更多结果，用 offset=2 继续。",
  ].join("\n"));
  assert.equal((await f.toolResult("learning_search", { query: "没有这个词" })).text, "学过的内容里没有找到「没有这个词」。");
  const read = await f.toolResult("learning_read", { ids: ["t01.k2.card", "t01.k2.example"] });
  assert.equal(read.text, [
    "# `t01.k2.card` 知识点 t01.k2「t01.k2」的概念卡「t01.k2」，课「t01」",
    "",
    "概念定义",
    "",
    "适用条件",
    "",
    "概念的例子",
    "",
    "# `t01.k2.example` 知识点 t01.k2「t01.k2」的例题，课「t01」",
    "",
    "测试题",
    "",
    "可见例题解说",
  ].join("\n"));
  // 未学的 topic 和猜出来的题解编号都不可读；模型收到的是怎样查找的说明。
  const missing = await f.toolResult("learning_read", { ids: ["t02.k1.card", "d3.explanation"] });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /没有编号为 t02\.k1\.card、d3\.explanation 的内容，或者还没学到；用 learning_search 查找能读的内容/u);
});

test("视图按学生模型的时间排先修：时钟回拨到最近一次更新之前，记忆的强弱不因回拨颠倒", async (t) => {
  const start = 1_792_454_400_000;
  const third: Topic = { ...topic("t03"), prerequisites: ["t01", "t02"] };
  const f = await fixture(t, [topic("t01"), topic("t02"), third]);
  // 第 0 天学完 t01，第 1 天按时复习 t01（理想间隔变长），再学 t02 并答错一题（记忆比 t01 弱、间隔较短）。
  await f.select("lesson", "t01");
  await f.finish();
  f.time(start + DAY_MS);
  await f.select("review", "t01");
  await f.finish();
  await f.select("lesson", "t02");
  await f.advance();
  await f.advance();
  await f.submit(() => undefined);
  await f.finish();
  // 时钟回拨两天后选 t03 的课：最后一条事实早于两个先修最近一次更新的时间。
  f.time(start - DAY_MS);
  await f.select("lesson", "t03");
  const { student } = await f.session().view();
  const t01 = student.t01;
  const t02 = student.t02;
  assert.ok(t01 && t02);
  assert.ok(t02.memory < t01.memory && t02.interval < t01.interval);
  // 用最后一条事实的原始时间算，间隔短的 t02 被回拨抬得更高，排序就会颠倒；学生模型的时间不倒退，t02 仍是较弱的那个。
  const raw = (f.session().records.facts.at(-1)?.at ?? 0) / DAY_MS;
  assert.ok(memoryAt(t01, raw) < memoryAt(t02, raw));
  const preview = await f.client.call("prompt.preview", { agent: TUTOR_AGENT });
  assert.match(preview.views[0]?.text ?? "", /\n学过的直接先修，学生模型估计的记忆由弱到强：「t02」「t01」$/u);
});

test("中止失败保留 preparing，整空间重开后显式继续同一个受限任务", async (t) => {
  const f = await fixture(t);
  await f.select();
  await f.finish();
  f.faux.setResponses([fauxAssistantMessage("已完成本轮学习")]);
  await f.client.call("session.send", { sessionId: f.chat.id, text: "回顾本轮学习" });
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
      const current = { state, student: {} };
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
