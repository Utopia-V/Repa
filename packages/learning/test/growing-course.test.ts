/**
 * 课随着学习长出来：先出轮廓，展开第一节，学习者学着前面的，后面的在后台展开。
 * 经真实的协议后端、通用 Agent 与课件插件，模型是离线的 faux，按脚本调用工具；先后由屏障控制。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, type FauxResponseFactory, type FauxResponseStep, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { startServer } from "@repa/base";
import { RepaClient, RpcError } from "@repa/base/client";
import { INTERACTION_CAPABILITIES, parse, type SessionUsage } from "@repa/base/protocol";
import materialsPlugin from "../../materials/dist/plugin.js";
import { createAgentRuntimeForTest } from "../../base/dist/agent/runtime.js";
import { connectLearning } from "../src/flow.js";
import { createLearningPlugin } from "../src/plugin.js";
import { learningMethods, type CourseBuilding, type LearningInput, type LearningMethod, type LearningResult } from "../src/protocol.js";
import type { LearningSession } from "../src/session.js";
import { TUTOR_AGENT } from "../src/tutor.js";
import { referenceAnswer } from "./fixtures/learning-session.js";

const EXAMPLE = fileURLToPath(new URL("../guides/example-course/", import.meta.url));
/** faux 模型的单价（美元每百万 token），花费按它折算。 */
const PRICE = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const fault = (code: string) => (error: unknown) => {
  assert.ok(error instanceof RpcError);
  assert.ok(error.data && typeof error.data === "object" && "code" in error.data);
  assert.equal(error.data.code, code);
  return true;
};

/** 模型这一次请求里收到的最后一个工具结果。 */
function lastToolResult(context: TranscriptContext): string {
  const message = context.messages.findLast((entry) => entry.role === "toolResult");
  assert.ok(message?.role === "toolResult");
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** 课程清单：topics 按学习的先后；来源是学习者放进 materials/ 的课件。 */
function manifest(version: string, topics: string[]): string {
  return [
    "id: os-memory",
    `version: ${version}`,
    "title: 进程管理",
    "language: zh-CN",
    "license: NOASSERTION",
    "sources:",
    "  slides: { title: 第二章课件, file: materials/第二章.md, version: 学习者提供, license: 学习者自用, permits: [reference] }",
    `topics: [${topics.join(", ")}]`,
    "",
  ].join("\n");
}

/** 轮廓里的一部分：名字、一句话范围、出处和估计的知识点。 */
function outline(id: string, title: string, prerequisites: string[], where: string): string {
  return [
    `id: ${id}`,
    `title: ${title}`,
    "status: outline",
    "minutes: 15",
    `summary: ${title}的范围。`,
    `prerequisites: [${prerequisites.join(", ")}]`,
    `sources: [{ source: slides, where: ${where}, use: reference }]`,
    "kps:",
    `  - { id: ${id}.k1, title: ${title}一 }`,
    `  - { id: ${id}.k2, title: ${title}二 }`,
    "",
  ].join("\n");
}

/** 展开以后的一部分：示例课里完整的 os01 换成这个 id、标题和先修。 */
async function complete(id: string, title: string, prerequisites: string[], where: string): Promise<string> {
  const text = (await readFile(path.join(EXAMPLE, "topics", "os01.yaml"), "utf8")).replaceAll("\r\n", "\n");
  return text
    .replaceAll("os01", id)
    .replace("title: 进程的三种基本状态", `title: ${title}`)
    .replace("prerequisites: []", `prerequisites: [${prerequisites.join(", ")}]`)
    .replace("where: 第 3–8 张", `where: ${where}`);
}

/** 两份用量相同：token 与请求数逐项相等，金额只差浮点加法的次序。 */
function sameUsage(actual: SessionUsage, expected: SessionUsage) {
  assert.deepEqual({ ...actual, cost: 0 }, { ...expected, cost: 0 });
  assert.ok(Math.abs(actual.cost - expected.cost) < 1e-9, `${actual.cost} ≠ ${expected.cost}`);
}

const write = (file: string, content: string) => fauxToolCall("write", { path: file, content });

/** 一直挂着、只在请求被中止时才结束的模型回答：用来确认取消确实停下了运行，而不是等它自己结束。 */
const hang: FauxResponseFactory = async (_context, options) => {
  const signal = options?.signal;
  assert.ok(signal);
  if (!signal.aborted) await new Promise((resolve) => { signal.addEventListener("abort", resolve, { once: true }); });
  return fauxAssistantMessage("", { stopReason: "aborted" });
};

interface FixtureOptions {
  /** faux 模型的单价；省略时为 PRICE。 */
  price?: typeof PRICE;
}

/** 经真实的协议后端打开学习插件与课件插件：通用 Agent 与辅导 Agent 都在，模型是离线的 faux。 */
async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-growing-course-")));
  const root = path.join(directory, "space");
  const home = path.join(directory, "home");
  const agentDir = path.join(home, "agent");
  await mkdir(path.join(root, "materials"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(root, "materials", "第二章.md"), "# 第二章 进程管理\n\n## 进程状态\n\n## 进程控制块\n\n## 进程调度\n");
  const faux = fauxProvider({
    api: `growing-${randomUUID()}`, provider: `growing-${randomUUID()}`,
    models: [{ id: "test", contextWindow: 65536, maxTokens: 512, cost: options.price ?? PRICE }], tokensPerSecond: 0,
  });
  const models = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"), modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false,
  });
  models.registerNativeProvider(faux.provider);
  const runtime = await createAgentRuntimeForTest({
    agentDir, modelRuntime: models, defaultModel: { provider: faux.getModel().provider, id: "test" }, now: () => 1_792_454_400_000,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
  });
  let current: LearningSession | undefined;
  const learning = createLearningPlugin({
    async connect(opened, host) {
      current = opened;
      return connectLearning(opened, { beforeRestricted: () => host.abortAgent(TUTOR_AGENT) });
    },
  });
  const server = await startServer({ home, runtime, plugins: [learning, materialsPlugin] });
  const client = await RepaClient.connect(server.connection, { capabilities: { interaction: { supports: [...INTERACTION_CAPABILITIES] } } });
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  /** 做课状态的每次变化：building.changed 事件。 */
  let changes = 0;
  const waiting = new Set<() => void>();
  client.on("plugin.event", ({ pluginId, event }) => {
    if (pluginId !== "learning" || (event as { type?: string }).type !== "building.changed") return;
    changes++;
    for (const wake of waiting) wake();
  });
  let { opening } = await client.call("space.open", { root });
  async function call<M extends LearningMethod>(method: M, input: LearningInput<M>): Promise<LearningResult<M>> {
    return parse(learningMethods[method].result, await client.call("plugin.call", {
      pluginId: "learning", method, input, opening,
    })) as LearningResult<M>;
  }
  const state = () => call("state.get", {});
  const building = () => call("building.get", {});
  /** 等做课状态满足条件：每次 building.changed 以后读一次，不按时间等。 */
  async function until(condition: (shown: CourseBuilding) => boolean): Promise<CourseBuilding> {
    for (;;) {
      const seen = changes;
      const woken = new Promise<void>((resolve) => {
        const wake = () => { waiting.delete(wake); resolve(); };
        waiting.add(wake);
      });
      const shown = await building();
      if (condition(shown)) return shown;
      if (changes === seen) await woken;
    }
  }
  async function select(topicId: string) {
    const shown = await state();
    const candidate = shown.menu?.candidates.find((entry) => entry.kind === "lesson" && entry.topicIds.includes(topicId));
    assert.ok(shown.menu && candidate, JSON.stringify(shown.menu));
    return call("menu.select", { menuId: shown.menu.menuId, candidateId: candidate.id });
  }
  async function step() {
    const shown = await state();
    const task = shown.task;
    assert.ok(task);
    if (task.phase.stage !== "awaiting_answer") {
      return call("task.advance", { taskId: task.taskId, expectedStage: task.phase.stage, expectedRevision: shown.revision });
    }
    const delivery = task.deliveries.at(-1);
    assert.ok(delivery && current);
    const response = await referenceAnswer(current, delivery);
    return call("submission.submit", { taskId: task.taskId, deliveryId: delivery.deliveryId, submissionId: delivery.submissionId, response });
  }
  async function toAnswer() {
    while ((await state()).task?.phase.stage !== "awaiting_answer") await step();
    return state();
  }
  async function finish() {
    for (let steps = 0; steps < 60; steps++) {
      const shown = await state();
      if (shown.task?.phase.stage === "completed") return shown;
      await step();
    }
    throw new Error("课没有在 60 步内上完");
  }
  /** 学习者在对话里吩咐通用 Agent；faux 按给定的步骤回答，回合结束才返回。 */
  async function chat(sessionId: string, text: string, steps: FauxResponseStep[]) {
    faux.appendResponses(steps);
    await client.call("session.send", { sessionId, text });
  }
  /** 全部会话（含后台展开的）的用量之和。一个会话的用量已含它起的子 Agent，所以只加没有父会话的。 */
  async function totalUsage(): Promise<SessionUsage> {
    const total: SessionUsage = { requests: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, unpriced: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    for (const session of await client.call("session.list", {})) {
      if (session.parent !== undefined) continue;
      const one = await client.call("session.usage", { sessionId: session.id });
      total.requests += one.requests;
      total.cost += one.cost;
      for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        total.usage[key] += one.usage[key];
        total.unpriced[key] += one.unpriced[key];
      }
    }
    return total;
  }
  return {
    root, faux, client, call, state, building, until, select, step, toAnswer, finish, chat, totalUsage,
    dataDir: path.join(root, ".repa", "plugins", "learning"),
    session: () => current,
    async reopen() {
      await client.call("space.close", {});
      ({ opening } = await client.call("space.open", { root }));
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** 做课的第一步：读课件目录，把整门课写成三部分轮廓，检查、换用，学习页上就有了轮廓。返回对话的会话。 */
async function outlineCourse(f: Fixture): Promise<string> {
  const { id } = await f.client.call("session.create", {});
  let checked = "";
  let used = "";
  await f.chat(id, "把 materials 里的课件做成课", [
    fauxAssistantMessage([fauxToolCall("materials_list", {})]),
    fauxAssistantMessage([
      write("course/course.yaml", manifest("1.0.0", ["os01", "os02", "os03"])),
      write("course/topics/os01.yaml", outline("os01", "进程状态", [], "第 1–4 张")),
      write("course/topics/os02.yaml", outline("os02", "进程控制块", ["os01"], "第 5–9 张")),
      write("course/topics/os03.yaml", outline("os03", "进程调度", ["os02"], "第 10–14 张")),
    ]),
    fauxAssistantMessage([fauxToolCall("course_check", {})]),
    (context) => {
      checked = lastToolResult(context);
      return fauxAssistantMessage([fauxToolCall("course_use", {})]);
    },
    (context) => {
      used = lastToolResult(context);
      return fauxAssistantMessage("轮廓有三部分：进程状态、进程控制块、进程调度。");
    },
  ]);
  assert.match(checked, /^course\/ 通过检查：课程 os-memory 1\.0\.0，完整 topic 0 个、骨架 3 个/mu);
  assert.match(used, /^已换用/u);
  return id;
}

/** 学习者认可轮廓以后，对话里的 Agent 展开第一节、检查、换用。 */
async function expandFirst(f: Fixture, id: string): Promise<void> {
  let used = "";
  await f.chat(id, "可以，先做第一节", [
    fauxAssistantMessage([write("course/topics/os01.yaml", await complete("os01", "进程状态", [], "第 1–4 张"))]),
    fauxAssistantMessage([fauxToolCall("course_check", {})]),
    fauxAssistantMessage([fauxToolCall("course_use", {})]),
    (context) => {
      used = lastToolResult(context);
      return fauxAssistantMessage("第一节可以学了。");
    },
  ]);
  assert.match(used, /^已换用/u);
}

/** 出轮廓，再展开第一节。返回对话的会话。 */
async function outlineThenFirst(f: Fixture): Promise<string> {
  const id = await outlineCourse(f);
  await expandFirst(f, id);
  return id;
}

/** 后台展开的脚本：等 gate 放行以后把这几部分写成完整的、升版本并换用。 */
async function expansionScript(parts: { id: string; title: string; prerequisites: string[]; where: string }[], version: string, topics: string[], gate?: Promise<void>): Promise<FauxResponseStep[]> {
  // 文件工具要先读过一个已有的文件才能整份改写它。
  const files = ["course/course.yaml", ...parts.map((part) => `course/topics/${part.id}.yaml`)];
  const writes = [write("course/course.yaml", manifest(version, topics))];
  for (const part of parts) writes.push(write(`course/topics/${part.id}.yaml`, await complete(part.id, part.title, part.prerequisites, part.where)));
  return [
    async () => {
      await gate;
      return fauxAssistantMessage(files.map((file) => fauxToolCall("read", { path: file })));
    },
    fauxAssistantMessage(writes),
    fauxAssistantMessage([fauxToolCall("course_check", {})]),
    fauxAssistantMessage([fauxToolCall("course_use", {})]),
    fauxAssistantMessage("展开好了。"),
  ];
}

test("整条路：出轮廓、展开第一节、换用；学习者上课时后台展开后两节，只增不改立即换用，进行中的课照常；学完接着学新的一节", async (t) => {
  const f = await fixture(t);
  const chatId = await outlineThenFirst(f);

  // 第一节展开、其余是轮廓；还没有展开在进行。花费是做课这段对话的用量。
  let shown = await f.building();
  assert.deepEqual(shown.course, { id: "os-memory", title: "进程管理", version: "1.0.0" });
  assert.deepEqual(shown.parts.map((part) => [part.topicId, part.status]), [["os01", "ready"], ["os02", "outline"], ["os03", "outline"]]);
  assert.deepEqual(shown.parts[1]?.sources, [{ title: "第二章课件", file: "materials/第二章.md", where: "第 5–9 张" }]);
  assert.equal(shown.expansion, null);
  sameUsage(shown.cost, await f.client.call("session.usage", { sessionId: chatId }));
  assert.ok(shown.cost.requests === 9 && shown.cost.cost > 0);

  // 学习者开始上第一节：已展开的只剩这一节没学，学习插件在后台展开后面两节。后台的第一次模型请求先挂住。
  const gate = deferred();
  f.faux.appendResponses(await expansionScript([
    { id: "os02", title: "进程控制块", prerequisites: ["os01"], where: "第 5–9 张" },
    { id: "os03", title: "进程调度", prerequisites: ["os02"], where: "第 10–14 张" },
  ], "1.1.0", ["os01", "os02", "os03"], gate.promise));
  await f.select("os01");
  shown = await f.until((state) => state.expansion?.sessionId !== null && state.expansion !== null);
  assert.deepEqual(shown.expansion?.topicIds, ["os02", "os03"]);
  const backgroundId = shown.expansion?.sessionId;
  assert.ok(backgroundId);

  // 展开在做的时候学习者照常上课，走到第一道练习题。
  const before = await f.toAnswer();
  const delivered = before.task?.deliveries.at(-1);
  assert.ok(delivered);

  // 放行：后台写好两节、换用。新的一版没改 os01，进行中的课照常，题面、作答位不变。
  gate.resolve();
  shown = await f.until((state) => state.expansion === null);
  assert.equal(shown.lastFailure, null);
  assert.deepEqual(shown.parts.map((part) => [part.topicId, part.status]), [["os01", "ready"], ["os02", "ready"], ["os03", "ready"]]);
  const during = await f.state();
  assert.equal(during.course?.version, "1.1.0");
  assert.equal(during.task?.taskId, before.task?.taskId);
  assert.deepEqual(during.task?.deliveries.at(-1), delivered);

  // 学完第一节，接着学刚展开的第二节。
  const done = await f.finish();
  assert.equal(done.task?.phase.stage === "completed" && done.task.phase.outcome, "passed");
  await f.select("os02");
  const second = await f.finish();
  assert.equal(second.task?.phase.stage === "completed" && second.task.phase.outcome, "passed");
  shown = await f.building();
  assert.deepEqual(shown.parts.map((part) => [part.topicId, part.status]), [["os01", "learned"], ["os02", "learned"], ["os03", "ready"]]);
  // 后面没有轮廓了，不再展开：模型没有多余的请求。
  assert.equal(shown.expansion, null);
  assert.equal(f.faux.getPendingResponseCount(), 0);

  // 花费是做课对话与后台展开两个会话之和，也等于每个会话各次请求之和。
  const chatUsage = await f.client.call("session.usage", { sessionId: chatId });
  const backgroundUsage = await f.client.call("session.usage", { sessionId: backgroundId });
  assert.equal(backgroundUsage.requests, 5);
  assert.equal(shown.cost.requests, chatUsage.requests + backgroundUsage.requests);
  sameUsage(shown.cost, await f.totalUsage());
});

test("前端分得清：没有可学的课、只有轮廓、轮廓之外有展开的部分；只有轮廓时后台不抢先展开", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, "course"));
  await f.reopen();
  const none = await f.building();
  assert.deepEqual({ course: none.course, parts: none.parts, expansion: none.expansion, lastFailure: none.lastFailure }, { course: null, parts: [], expansion: null, lastFailure: null });
  assert.equal(none.cost.requests, 0);
  await assert.rejects(f.call("building.expand", {}), fault("course_unavailable"));

  const chatId = await outlineCourse(f);
  const outlined = await f.building();
  assert.equal(outlined.course?.id, "os-memory");
  assert.deepEqual(outlined.parts.map((part) => [part.topicId, part.title, part.summary, part.status]), [
    ["os01", "进程状态", "进程状态的范围。", "outline"],
    ["os02", "进程控制块", "进程控制块的范围。", "outline"],
    ["os03", "进程调度", "进程调度的范围。", "outline"],
  ]);
  // 学习页只有轮廓：没有能开始的课；读状态也不在后台展开，第一段等对话里的 Agent。
  const calls = f.faux.state.callCount;
  assert.deepEqual((await f.state()).menu?.candidates, []);
  assert.equal((await f.building()).expansion, null);
  assert.equal(f.faux.state.callCount, calls);

  await f.call("settings.set", { autoExpand: false });
  await expandFirst(f, chatId);
  assert.deepEqual((await f.building()).parts.map((part) => part.status), ["ready", "outline", "outline"]);
});

test("轮廓随展开修正：学过的部分和它的学习记录不变，还没学的两部分合成一部分", async (t) => {
  const f = await fixture(t);
  await f.call("settings.set", { autoExpand: false });
  const chatId = await outlineThenFirst(f);
  await f.select("os01");
  await f.finish();
  const records = await readFile(path.join(f.dataDir, "records.jsonl"), "utf8");
  const learned = await f.state();
  assert.equal(learned.progress.completedTopics, 1);

  // 细读材料以后发现 os02 与 os03 是一回事：合成一部分，次序和先修随之改。os01 学过了，不动。
  let used = "";
  await f.chat(chatId, "第二、三部分其实是一回事", [
    fauxAssistantMessage([
      write("course/course.yaml", manifest("1.1.0", ["os01", "os02"])),
      write("course/topics/os02.yaml", outline("os02", "进程控制块与调度", ["os01"], "第 5–14 张")),
    ]),
    fauxAssistantMessage([fauxToolCall("course_use", {})]),
    (context) => {
      used = lastToolResult(context);
      return fauxAssistantMessage("合好了。");
    },
  ]);
  assert.match(used, /^已换用/u);
  const shown = await f.building();
  assert.deepEqual(shown.parts.map((part) => [part.topicId, part.title, part.status]), [["os01", "进程状态", "learned"], ["os02", "进程控制块与调度", "outline"]]);
  const after = await f.state();
  assert.equal(after.course?.version, "1.1.0");
  assert.equal(after.progress.completedTopics, 1);
  assert.deepEqual(after.progress, { ...learned.progress, totalTopics: 2, completionRate: 0.5 });
  // 学习记录一条没少：换用不改写它。
  assert.ok((await readFile(path.join(f.dataDir, "records.jsonl"), "utf8")).startsWith(records));
});

test("后台展开失败如实记下原因，学习照常，不自动重试；学习者要求时再做，卡住时可以取消", async (t) => {
  const f = await fixture(t);
  await outlineThenFirst(f);

  // 后台的模型请求出错：这次展开记为 run_failed，带上原因。
  f.faux.appendResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "服务暂时不可用" })]);
  await f.select("os01");
  let shown = await f.until((state) => state.lastFailure !== null);
  assert.equal(shown.expansion, null);
  assert.deepEqual(shown.lastFailure && { ...shown.lastFailure, at: 0 }, { topicIds: ["os02", "os03"], at: 0, code: "failed", message: "服务暂时不可用" });
  const calls = f.faux.state.callCount;

  // 学习照常：上完这一节；之间的调用都不再自动展开，因为学过的部分还没有变。
  const before = (await f.client.call("session.list", {})).length;
  await f.toAnswer();
  await f.call("settings.set", { autoExpand: true });
  assert.equal((await f.building()).expansion, null);
  assert.equal(f.faux.state.callCount, calls);
  assert.equal((await f.client.call("session.list", {})).length, before);

  // 学习者要求先做第二部分：这次展开挂住，学习者照常把课上完、问辅导，然后取消它。挂住的请求只在被中止时结束。
  f.faux.appendResponses([hang]);
  shown = await f.call("building.expand", { topicIds: ["os02"] });
  assert.deepEqual(shown.expansion?.topicIds, ["os02"]);
  await assert.rejects(f.call("building.expand", {}), fault("expansion_running"));
  const done = await f.finish();
  assert.equal(done.task?.phase.stage === "completed" && done.task.phase.outcome, "passed");
  const tutor = await f.client.call("session.create", { agent: TUTOR_AGENT });
  f.faux.appendResponses([fauxAssistantMessage("这节讲的是进程状态。")]);
  await f.client.call("session.send", { sessionId: tutor.id, text: "这节讲了什么？" });
  shown = await f.call("building.cancel", {});
  assert.equal(shown.expansion, null);
  assert.equal(shown.lastFailure?.code, "cancelled");
  assert.deepEqual(shown.parts.map((part) => part.status), ["learned", "outline", "outline"]);
});

test("后台运行结束了而那几部分仍是轮廓（没有换用）：记为 not_expanded", async (t) => {
  const f = await fixture(t);
  await outlineThenFirst(f);
  f.faux.appendResponses([fauxAssistantMessage("材料读不出来，没做。")]);
  await f.select("os01");
  const shown = await f.until((state) => state.lastFailure !== null);
  assert.equal(shown.lastFailure?.code, "not_expanded");
  assert.equal(shown.lastFailure?.message, undefined);
  // 重开空间以后记录还在，也不因为打开而重试。
  await f.reopen();
  await f.state();
  const reopened = await f.building();
  assert.equal(reopened.lastFailure?.code, "not_expanded");
  assert.equal(reopened.expansion, null);
  assert.equal(f.faux.getPendingResponseCount(), 0);
});

test("关掉自动展开：学习者学到尽头也没有模型请求，设置重开以后仍在；学习者明确要求时才展开", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.call("settings.get", {}), { autoExpand: true });
  await f.call("settings.set", { autoExpand: false });
  await outlineThenFirst(f);
  const calls = f.faux.state.callCount;
  const sessions = (await f.client.call("session.list", {})).length;
  await f.reopen();
  assert.deepEqual(await f.call("settings.get", {}), { autoExpand: false });
  await f.select("os01");
  await f.finish();
  await f.state();
  assert.equal(f.faux.state.callCount, calls);
  assert.equal((await f.client.call("session.list", {})).length, sessions);
  assert.equal((await f.building()).expansion, null);

  f.faux.appendResponses(await expansionScript([
    { id: "os02", title: "进程控制块", prerequisites: ["os01"], where: "第 5–9 张" },
    { id: "os03", title: "进程调度", prerequisites: ["os02"], where: "第 10–14 张" },
  ], "1.1.0", ["os01", "os02", "os03"]));
  await f.call("building.expand", {});
  const shown = await f.until((state) => state.expansion === null);
  assert.equal(shown.lastFailure, null);
  assert.deepEqual(shown.parts.map((part) => part.status), ["learned", "ready", "ready"]);
});

test("学习者正在学的 topic 在新的一版里改了：course_use 不换用，进行中的任务照旧", async (t) => {
  const f = await fixture(t);
  await f.call("settings.set", { autoExpand: false });
  const chatId = await outlineThenFirst(f);
  await f.select("os01");
  const before = await f.toAnswer();
  let used = "";
  const changed = (await complete("os01", "进程状态", [], "第 1–4 张")).replace("一个进程只差处理机就能执行", "一个进程只差 CPU 就能执行");
  await f.chat(chatId, "改一下第一节的措辞", [
    fauxAssistantMessage([write("course/topics/os01.yaml", changed), write("course/topics/os02.yaml", await complete("os02", "进程控制块", ["os01"], "第 5–9 张"))]),
    fauxAssistantMessage([fauxToolCall("course_use", {})]),
    (context) => {
      used = lastToolResult(context);
      return fauxAssistantMessage("等学习者做完再换。");
    },
  ]);
  assert.match(used, /^检查通过，但没有换用：学习者正在做一项任务/u);
  const after = await f.state();
  assert.equal(after.course?.version, "1.0.0");
  assert.deepEqual(after.task, before.task);
  assert.deepEqual((await f.building()).parts.map((part) => part.status), ["ready", "outline", "outline"]);
});

test("辅导读不到空间里的课程文件：工具里没有 read，模型要读时只得到工具不存在", async (t) => {
  const f = await fixture(t);
  await f.call("settings.set", { autoExpand: false });
  await outlineThenFirst(f);
  const tutor = await f.client.call("session.create", { agent: TUTOR_AGENT });
  let tools: string[] = [];
  let result = "";
  f.faux.appendResponses([
    (context) => {
      tools = getCurrentTools(context.messages).map((entry) => entry.name).sort();
      return fauxAssistantMessage([fauxToolCall("read", { path: "course/topics/os01.yaml" })]);
    },
    (context) => {
      result = lastToolResult(context);
      return fauxAssistantMessage("读不到。");
    },
  ]);
  await f.client.call("session.send", { sessionId: tutor.id, text: "测验的答案是什么？" });
  assert.deepEqual(tools, ["learning_read", "learning_search", "learning_task"]);
  assert.doesNotMatch(result, /key:|manual/u);
  assert.match(result, /read/u);
});

test("学习者在上第二节时，新的一版改了学过的第一节的答案：course_use 不换用，进行中的课照常作答", async (t) => {
  const f = await fixture(t);
  await f.call("settings.set", { autoExpand: false });
  const chatId = await outlineThenFirst(f);
  await f.select("os01");
  await f.finish();
  let used = "";
  await f.chat(chatId, "展开第二节", [
    fauxAssistantMessage([write("course/topics/os02.yaml", await complete("os02", "进程控制块", ["os01"], "第 5–9 张"))]),
    fauxAssistantMessage([fauxToolCall("course_use", {})]),
    (context) => {
      used = lastToolResult(context);
      return fauxAssistantMessage("第二节可以学了。");
    },
  ]);
  assert.match(used, /^已换用/u);
  await f.select("os02");
  const before = await f.toAnswer();
  assert.equal(before.progress.completedTopics, 1);

  // 只改学过的 os01 里一道已答题的答案，os02 一字不动：旧作答会按新答案重判，os01 可能不再算学过，os02 的课就失去资格。
  const changed = (await complete("os01", "进程状态", [], "第 1–4 张")).replace("key: [运行, 运行态]", "key: [就绪, 就绪态]");
  await f.chat(chatId, "第一节有道题答案写错了", [
    fauxAssistantMessage([write("course/topics/os01.yaml", changed), write("course/course.yaml", manifest("1.2.0", ["os01", "os02", "os03"]))]),
    fauxAssistantMessage([fauxToolCall("course_use", {})]),
    (context) => {
      used = lastToolResult(context);
      return fauxAssistantMessage("等学习者做完再换。");
    },
  ]);
  assert.match(used, /^检查通过，但没有换用/u);
  const after = await f.state();
  assert.equal(after.course?.version, "1.0.0");
  assert.deepEqual(after.task, before.task);
  assert.equal(after.progress.completedTopics, 1);
  const done = await f.finish();
  assert.equal(done.task?.phase.stage === "completed" && done.task.phase.outcome, "passed");
});

test("后台展开不属于学习者的连接：要确认的命令被拒绝、提问交回不可用，前端收不到确认和提问，展开照常结束", async (t) => {
  const f = await fixture(t);
  await f.call("settings.set", { autoExpand: false });
  await outlineThenFirst(f);
  const requests: string[] = [];
  f.client.on("confirm.request", () => requests.push("confirm"));
  f.client.on("ask.request", () => requests.push("ask"));
  const results: string[] = [];
  f.faux.appendResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "echo 写 > course/written.txt" })]),
    (context) => {
      results.push(lastToolResult(context));
      return fauxAssistantMessage([fauxToolCall("ask_user", { questions: [{ question: "先展开哪一节？", input: "text" }] })]);
    },
    (context) => {
      results.push(lastToolResult(context));
      return fauxAssistantMessage("没有人回答，先不做。");
    },
  ]);
  await f.call("building.expand", {});
  const shown = await f.until((state) => state.expansion === null);
  assert.equal(shown.lastFailure?.code, "not_expanded");
  assert.deepEqual(requests, []);
  assert.equal(results.length, 2);
  assert.match(results[0] ?? "", /确认/u);
  assert.match(results[1] ?? "", /没有可以作答的连接/u);
  await assert.rejects(readFile(path.join(f.root, "course", "written.txt")));
});

test("两次展开的要求同时到达：只有一次开始，另一次报 expansion_running", async (t) => {
  const f = await fixture(t);
  await f.call("settings.set", { autoExpand: false });
  await outlineThenFirst(f);
  f.faux.appendResponses([hang]);
  const outcomes = await Promise.allSettled([
    f.call("building.expand", { topicIds: ["os02"] }),
    f.call("building.expand", { topicIds: ["os03"] }),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const refused = outcomes.find((outcome) => outcome.status === "rejected");
  assert.ok(refused?.status === "rejected" && fault("expansion_running")(refused.reason));
  const shown = await f.call("building.cancel", {});
  assert.equal(shown.lastFailure?.code, "cancelled");
  assert.equal((await f.client.call("session.list", {})).filter((session) => session.parent === undefined).length, 2);
});

test("后台展开起了子 Agent：子 Agent 的请求也算进做课的花费，花费等于模型实际收到的请求", async (t) => {
  const f = await fixture(t);
  await f.call("settings.set", { autoExpand: false });
  await outlineThenFirst(f);
  f.faux.appendResponses([
    fauxAssistantMessage([fauxToolCall("subagent", { agent: "general", task: "读 materials 里的课件，列出第二、三部分的要点" })]),
    fauxAssistantMessage("要点：进程控制块、进程调度。"),
    ...await expansionScript([
      { id: "os02", title: "进程控制块", prerequisites: ["os01"], where: "第 5–9 张" },
      { id: "os03", title: "进程调度", prerequisites: ["os02"], where: "第 10–14 张" },
    ], "1.1.0", ["os01", "os02", "os03"]),
  ]);
  await f.call("building.expand", {});
  const shown = await f.until((state) => state.expansion === null);
  assert.equal(shown.lastFailure, null);
  assert.ok((await f.client.call("session.list", {})).some((session) => session.parent !== undefined));
  assert.equal(shown.cost.requests, f.faux.state.callCount);
  sameUsage(shown.cost, await f.totalUsage());
});

test("应用在展开中途关闭：这次展开记为取消，重开以后不重试", async (t) => {
  const f = await fixture(t);
  await f.call("settings.set", { autoExpand: false });
  await outlineThenFirst(f);
  const requested = deferred();
  f.faux.appendResponses([(...args) => {
    requested.resolve();
    return hang(...args);
  }]);
  await f.call("building.expand", {});
  await requested.promise;
  await f.reopen();
  const shown = await f.building();
  assert.equal(shown.expansion, null);
  assert.equal(shown.lastFailure?.code, "cancelled");
  assert.deepEqual(shown.parts.map((part) => part.status), ["ready", "outline", "outline"]);
});
