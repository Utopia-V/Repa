import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createSpace, openPluginHost, openSpace, startServer } from "@repa/base";
import { RepaClient, RpcError } from "@repa/base/client";
import { INTERACTION_CAPABILITIES, parse } from "@repa/base/protocol";
import { ModelTestDriver } from "@repa/base/testing";
import { parse as parseYaml, stringify } from "yaml";
import { createAgentRuntimeForTest } from "../../base/dist/agent/runtime.js";
import { checkCourse } from "../src/check/course.js";
import { COURSE_GUIDE } from "../src/course-tools.js";
import { connectLearning } from "../src/flow.js";
import { createLearningPlugin } from "../src/plugin.js";
import { learningMethods, type LearningInput, type LearningMethod, type LearningResult } from "../src/protocol.js";
import type { LearningSession } from "../src/session.js";
import { TUTOR_AGENT } from "../src/tutor.js";
import { runtimeUnavailable } from "./demo-course.js";
import { skipUnavailableEnvironment } from "./environment.js";
import { referenceAnswer, start } from "./fixtures/learning-session.js";

/** 写课说明里的完整例子：不含代码题，也是这里的示例课。 */
const EXAMPLE = fileURLToPath(new URL("../guides/example-course/", import.meta.url));

const fault = (code: string) => (error: unknown) => {
  assert.ok(error instanceof RpcError);
  assert.ok(error.data && typeof error.data === "object" && "code" in error.data);
  assert.equal(error.data.code, code);
  return true;
};

/** 模型这一次请求里实际收到的最后一个工具结果。 */
function lastToolResult(context: TranscriptContext): string {
  const message = context.messages.findLast((entry) => entry.role === "toolResult");
  assert.ok(message?.role === "toolResult");
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** 改写空间 course/ 里的一个 topic 文件。 */
async function editTopic(root: string, id: string, change: (topic: Record<string, unknown>) => void) {
  const file = path.join(root, "course", "topics", `${id}.yaml`);
  const value = parseYaml(await readFile(file, "utf8")) as Record<string, unknown>;
  change(value);
  await writeFile(file, stringify(value, { aliasDuplicateObjects: false }));
}

/** topic 里某个知识点的某个题池。 */
function pool(topic: Record<string, unknown>, kp: number, name: string): Record<string, unknown>[] {
  const questions = (topic.kps as Record<string, unknown>[])[kp]?.[name];
  assert.ok(Array.isArray(questions));
  return questions as Record<string, unknown>[];
}

/** 写课说明里的 yaml 例子，按出现顺序。 */
async function guideExamples(): Promise<unknown[]> {
  const text = await readFile(COURSE_GUIDE, "utf8");
  return [...text.matchAll(/^```yaml\n([\s\S]*?)^```$/gmu)].map((match) => parseYaml(match[1] ?? ""));
}

/** 写课说明里照抄的 runtime。 */
async function guideRuntime(): Promise<unknown> {
  const found = (await guideExamples()).find((entry) => typeof entry === "object" && entry !== null && "runtime" in entry);
  assert.ok(found);
  return (found as { runtime: unknown }).runtime;
}

/** 等条件成立；到截止时间还不成立就失败。 */
async function until(condition: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    if (Date.now() > deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface FixtureOptions {
  /** course_check 用的离线 Pyodide 包目录。 */
  packagesDirectory?: string;
}

/** 经真实的协议后端打开学习插件：通用 Agent 与辅导 Agent 都在，模型是本地的 faux，课程用随包的缺省。 */
async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-space-course-")));
  const root = path.join(directory, "space");
  const home = path.join(directory, "home");
  const agentDir = path.join(home, "agent");
  await mkdir(root);
  await mkdir(agentDir, { recursive: true });
  const faux = fauxProvider({
    api: `course-${randomUUID()}`, provider: `course-${randomUUID()}`,
    models: [{ id: "test", contextWindow: 65536, maxTokens: 512 }], tokensPerSecond: 0,
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
    ...(options.packagesDirectory ? { packagesDirectory: options.packagesDirectory } : {}),
    async connect(opened, host) {
      current = opened;
      return connectLearning(opened, { beforeRestricted: () => host.abortAgent(TUTOR_AGENT) });
    },
  });
  const server = await startServer({ home, runtime, plugins: [learning] });
  const client = await RepaClient.connect(server.connection, { capabilities: { interaction: { supports: [...INTERACTION_CAPABILITIES] } } });
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  let { opening } = await client.call("space.open", { root });
  let general = await client.call("session.create", {});
  async function call<M extends LearningMethod>(method: M, input: LearningInput<M>): Promise<LearningResult<M>> {
    return parse(learningMethods[method].result, await client.call("plugin.call", {
      pluginId: "learning", method, input, opening,
    })) as LearningResult<M>;
  }
  const state = () => call("state.get", {});
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
  async function finish() {
    for (let steps = 0; steps < 60; steps++) {
      const shown = await state();
      if (shown.task?.phase.stage === "completed") return shown;
      await step();
    }
    throw new Error("课没有在 60 步内上完");
  }
  /** 让通用 Agent 调用一次工具，返回模型下一次请求里实际收到的工具结果和那次请求本身。 */
  async function tool(name: string, input: Parameters<typeof fauxToolCall>[1] = {}) {
    let received: TranscriptContext | undefined;
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(name, input)]),
      (context) => {
        received = structuredClone(context);
        return fauxAssistantMessage("好的");
      },
    ]);
    await client.call("session.send", { sessionId: general.id, text: "做课" });
    assert.ok(received);
    return { text: lastToolResult(received), context: received };
  }
  return {
    root, faux, client, call, state, select, step, finish, tool,
    dataDir: path.join(root, ".repa", "plugins", "learning"),
    /** 把示例课复制成空间里的 course/，模拟做课的 Agent 写好的课。 */
    writeExample: () => cp(EXAMPLE, path.join(root, "course"), { recursive: true }),
    editTopic: (id: string, change: (topic: Record<string, unknown>) => void) => editTopic(root, id, change),
    async reopen() {
      await client.call("space.close", {});
      ({ opening } = await client.call("space.open", { root }));
      general = await client.call("session.create", {});
    },
  };
}

test("空间里没有 course/ 时学的是随包的 Python 课", async (t) => {
  const f = await fixture(t);
  const shown = await f.state();
  assert.equal(shown.course?.id, "python");
  assert.ok(shown.menu && shown.menu.candidates.length > 0);
});

test("course/ 在而还没有换用过课：插件照常打开，状态里没有课，开始任务、读内容和辅导提问都说课还没有做好", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, "course"));
  await f.reopen();
  const shown = await f.state();
  assert.equal(shown.course, null);
  assert.equal(shown.task, null);
  assert.equal(shown.menu, null);
  assert.equal(shown.restrictions.tutorAllowed, false);
  assert.equal(shown.progress.totalTopics, 0);
  await assert.rejects(f.call("menu.select", { menuId: "menu-0", candidateId: "c1" }), fault("course_unavailable"));
  await assert.rejects(f.call("content.search", { query: "", offset: 0, limit: 10 }), fault("course_unavailable"));
  const tutor = await f.client.call("session.create", { agent: TUTOR_AGENT });
  await assert.rejects(f.client.call("session.send", { sessionId: tutor.id, text: "怎么学？" }), fault("message_rejected"));
  const checked = await f.tool("course_check");
  assert.match(checked.text, /没有通过检查/u);
  assert.match(checked.text, /course\/course\.yaml.*\[course_missing\]/u);
  assert.match(checked.text, /学习者现在学的：还没有可学的课/u);
});

test("不含代码题的示例课：course_check 通过且不启动沙箱，course_use 换用后经真实的学习流程上完一节课，重开空间仍是这一版", async (t) => {
  const f = await fixture(t);
  await f.writeExample();
  const checked = await f.tool("course_check");
  assert.match(checked.text, /^course\/ 通过检查：课程 os-memory 1\.0\.0，完整 topic 1 个、骨架 1 个，题目 12 道。$/mu);
  assert.match(checked.text, /没有启动沙箱/u);
  assert.match(checked.text, /复习和测验题里有 4 个作答位列在 manual 里，没有经过独立核对/u);
  // 只检查不换用：学的仍是随包的课。
  assert.equal((await f.state()).course?.id, "python");

  const used = await f.tool("course_use");
  assert.match(used.text, /^已换用/u);
  const shown = await f.state();
  assert.deepEqual(shown.course, { id: "os-memory", title: "进程的基本概念", version: "1.0.0" });
  // 骨架 topic 不进菜单；先修是它的 os01 是唯一能开始的课。
  assert.deepEqual(shown.menu?.candidates.map((entry) => entry.topicIds), [["os01"]]);
  await f.select("os01");
  const done = await f.finish();
  assert.equal(done.task?.phase.stage === "completed" && done.task.phase.outcome, "passed");

  await f.reopen();
  const reopened = await f.state();
  assert.equal(reopened.course?.id, "os-memory");
  assert.equal(reopened.progress.completedTopics, 1);
});

test("course/ 写坏时 course_check 逐处写明文件、行和改法，分页并说明还有多少；course_use 不换用，学的仍是上一版", async (t) => {
  const f = await fixture(t);
  await f.writeExample();
  await f.tool("course_use");
  // 把每道题的 manual 删掉，再写错一个字段：每个作答位都要报“既没有 verify 也没有列进 manual”。
  await f.editTopic("os01", (topic) => {
    const kps = topic.kps as Record<string, unknown>[];
    for (const kp of kps) {
      for (const pool of ["example", "practice", "review", "quiz"]) {
        const questions = kp[pool] === undefined ? [] : [kp[pool]].flat() as Record<string, unknown>[];
        for (const question of questions) delete question.manual;
      }
    }
    const first = kps[0];
    assert.ok(first);
    first.practise = first.practice;
  });
  const page = await f.tool("course_check");
  assert.match(page.text, /没有通过检查：错误 \d+ 处/u);
  assert.match(page.text, /course\/topics\/os01\.yaml:\d+:\d+: 错误 \[schema\] kps\[0\]：不认识的字段 practise；这里能写的字段是 [^\n]*practice/u);
  await f.editTopic("os01", (topic) => {
    const first = (topic.kps as Record<string, unknown>[])[0];
    assert.ok(first);
    delete first.practise;
  });
  const unverified = await f.tool("course_check");
  assert.match(unverified.text, /\[unverified_slot\] 作答位 state 既没有 verify 程序核对，也没有列进 manual：[^\n]*列进这道题的 manual/u);

  // 问题多到一页放不下：分页列出，末尾写明下一页的 offset。
  const draft = path.join(f.root, "course", "topics");
  for (let index = 3; index < 50; index++) {
    await writeFile(path.join(draft, `x${index}.yaml`), "id: x\n");
  }
  const first = await f.tool("course_check");
  const count = Number(/共 (\d+) 处/u.exec(first.text)?.[1]);
  assert.ok(count > 40);
  assert.match(first.text, /第 1–40 处/u);
  assert.match(first.text, new RegExp(`还有 ${count - 40} 处，用 course_check 加 offset: 40 接着看`, "u"));
  const second = await f.tool("course_check", { offset: 40 });
  assert.match(second.text, new RegExp(`第 41–${count} 处`, "u"));

  const choice = await readFile(path.join(f.dataDir, "course.json"), "utf8");
  const refused = await f.tool("course_use");
  assert.match(refused.text, /^没有换用。/u);
  assert.match(refused.text, /学习者现在学的：course\/ 换用过的那一版，课程 os-memory 1\.0\.0/u);
  assert.equal((await f.state()).course?.id, "os-memory");
  assert.equal(await readFile(path.join(f.dataDir, "course.json"), "utf8"), choice);
  await f.reopen();
  assert.equal((await f.state()).course?.id, "os-memory");
});

test("学习者上课到一半时 course_use 不换用；重开空间仍是这节课和原来的题面，上完以后再 course_use 才换成新的一版", async (t) => {
  const f = await fixture(t);
  await f.writeExample();
  await f.tool("course_use");
  await f.select("os01");
  // 走到第一道练习题。
  while ((await f.state()).task?.phase.stage !== "awaiting_answer") await f.step();
  const before = await f.state();
  const delivered = before.task?.deliveries.at(-1);
  assert.ok(delivered);

  // 做课的 Agent 改了正在出的这道题的题面，并升了版本。
  const manifest = path.join(f.root, "course", "course.yaml");
  await writeFile(manifest, (await readFile(manifest, "utf8")).replace("version: 1.0.0", "version: 1.1.0"));
  await f.editTopic("os01", (topic) => {
    for (const question of pool(topic, 0, "practice")) question.body = `${String(question.body)}（改过）`;
  });
  const used = await f.tool("course_use");
  assert.match(used.text, /^检查通过，但没有换用：学习者正在做一项任务/u);

  for (const reopen of [false, true]) {
    if (reopen) await f.reopen();
    const during = await f.state();
    assert.equal(during.course?.version, "1.0.0");
    assert.deepEqual(during.task?.deliveries.at(-1), delivered);
  }
  const done = await f.finish();
  assert.equal(done.task?.phase.stage === "completed" && done.task.phase.outcome, "passed");
  assert.equal((await f.state()).course?.version, "1.0.0");

  assert.match((await f.tool("course_use")).text, /^已换用/u);
  const after = await f.state();
  assert.equal(after.course?.version, "1.1.0");
  // 学习记录没有丢：上完的这节课照算。
  assert.equal(after.progress.completedTopics, 1);
  const choice = JSON.parse(await readFile(path.join(f.dataDir, "course.json"), "utf8")) as { active: string };
  assert.deepEqual(Object.keys(choice), ["active"]);
  // 不再用的副本已删掉，只留正在用的一份。
  assert.deepEqual(await readdir(path.join(f.dataDir, "courses")), [choice.active]);
});

test("建了 course/ 时随包课还有做到一半的任务：course_use 不换用，重开空间仍学随包课、任务照旧", async (t) => {
  const f = await fixture(t);
  const shown = await f.state();
  const candidate = shown.menu?.candidates[0];
  assert.ok(shown.menu && candidate);
  await f.call("menu.select", { menuId: shown.menu.menuId, candidateId: candidate.id });
  while ((await f.state()).task?.phase.stage !== "awaiting_answer") await f.step();
  const before = await f.state();

  await f.writeExample();
  assert.match((await f.tool("course_use")).text, /^检查通过，但没有换用/u);
  await f.reopen();
  const after = await f.state();
  assert.equal(after.course?.id, "python");
  assert.deepEqual(after.task, before.task);
});

test("course 是一个指向自己的符号链接：学习插件照常打开，状态里没有课", async (t) => {
  if (process.platform === "win32") return t.skip("Windows 上建符号链接要管理员权限");
  const f = await fixture(t);
  await symlink("course", path.join(f.root, "course"));
  await f.reopen();
  const shown = await f.state();
  assert.equal(shown.course, null);
  assert.equal(shown.menu, null);
});

test("换用时旧的一版还在补判一份作答：等它写完再按新的一版打开，按改过的 rubric 重判", async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-space-course-")));
  const root = path.join(directory, "space");
  let space = await createSpace(root, { watch: false });
  await cp(EXAMPLE, path.join(root, "course"), { recursive: true });
  // 第一道练习改成开放作答，由模型按 rubric 判分。
  const rubric = (label: string) => editTopic(root, "os01", (topic) => {
    const question = pool(topic, 0, "practice")[0];
    assert.ok(question);
    question.slots = [{ id: "reason", type: "text", rubric: [{ id: "why", label }] }];
    delete question.manual;
  });
  await rubric("说出只差处理机");
  const models = new ModelTestDriver();
  let session: LearningSession | undefined;
  const plugin = createLearningPlugin({
    async connect(opened) {
      session = opened;
      return connectLearning(opened, {});
    },
  });
  const open = () => openPluginHost({
    space, plugins: [plugin], now: () => start, models, emit: () => {},
    onError: (error) => { throw error; },
  });
  let host = await open();
  t.after(async () => {
    await host.close();
    await space.close();
    await rm(directory, { recursive: true, force: true });
  });
  const capabilities = { interaction: { supports: [...INTERACTION_CAPABILITIES] } };
  const call = async <M extends LearningMethod>(method: M, input: LearningInput<M>) =>
    parse(learningMethods[method].result, await host.call("learning", method, input, { capabilities })) as LearningResult<M>;
  const tool = async (name: string) => {
    const found = host.tools().find((entry) => entry.name === name);
    assert.ok(found);
    return (await found.execute({}, { signal: new AbortController().signal, callId: randomUUID() })).text;
  };
  const structured = () => models.calls.filter((entry) => entry.kind === "structured").length;

  assert.match(await tool("course_use"), /^已换用/u);
  let shown = await call("state.get", {});
  const candidate = shown.menu?.candidates[0];
  assert.ok(shown.menu && candidate);
  await call("menu.select", { menuId: shown.menu.menuId, candidateId: candidate.id });
  shown = await call("state.get", {});
  while (shown.task?.phase.stage !== "awaiting_answer") {
    assert.ok(shown.task);
    shown = await call("task.advance", { taskId: shown.task.taskId, expectedStage: shown.task.phase.stage, expectedRevision: shown.revision });
  }
  const delivery = shown.task.deliveries.at(-1);
  assert.ok(delivery && session);
  const seq = Number(delivery.deliveryId.slice(1));
  assert.equal(session.replay.delivery(seq)?.questionId, "os01.k1.q1");
  // 第一次判分时模型服务失败：作答留下，没有判分。随后中止这节课，学习者没有进行中的任务。
  models.expectStructured().fail(new Error("模型服务暂时不可用"));
  const response = await referenceAnswer(session, delivery);
  await call("submission.submit", {
    taskId: shown.task.taskId, deliveryId: delivery.deliveryId, submissionId: delivery.submissionId, response,
  });
  shown = await call("state.get", {});
  assert.ok(shown.task);
  await call("task.abort", { taskId: shown.task.taskId, expectedStage: shown.task.phase.stage, expectedRevision: shown.revision });

  // 重开空间后的第一次调用在后台补判，模型的回答先不给。
  await host.close();
  await space.close();
  space = await openSpace(root, { watch: false });
  host = await open();
  const held = models.expectStructured();
  await call("state.get", {});
  await held.requested;
  const old = session;

  // 补判还没返回时，做课的 Agent 改了这道题的 rubric 并换用。
  await rubric("说出只差处理机，并说明为什么不是运行");
  const using = tool("course_use");
  const copies = path.join(root, ".repa", "plugins", "learning", "courses");
  await until(async () => (await readdir(copies)).length === 2, "新的一版没有存成副本");
  // 给换用一点时间：若它不等旧的一版补判写完，新的一版此时已经打开。
  for (let waited = 0; waited < 300 && session === old; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
  held.succeed({ verdict: "correct", reason: "按旧 rubric" });
  assert.match(await using, /^已换用/u);
  assert.ok(session && session !== old);

  // 旧的一版按旧 rubric 写下的判分不是新的一版的结论：下一次调用按新 rubric 重判。
  const regrade = models.expectStructured();
  await call("state.get", {});
  await until(() => structured() === 3, "新的一版没有按改过的 rubric 重判");
  regrade.succeed({ verdict: "incorrect", reason: "按新 rubric" });
  await session.idle();
  const versions = await session.course.versionsOf("os01.k1.q1");
  assert.equal(session.replay.delivery(seq)?.grades.at(-1)?.version, versions?.question);
});

test("换用的副本坏了：学习插件和空间照常打开，状态里没有课", async (t) => {
  const f = await fixture(t);
  await f.writeExample();
  await f.tool("course_use");
  const choice = JSON.parse(await readFile(path.join(f.dataDir, "course.json"), "utf8")) as { active: string };
  await writeFile(path.join(f.dataDir, "courses", choice.active, "course.yaml"), "id: [\n");
  await f.reopen();
  const shown = await f.state();
  assert.equal(shown.course, null);
  const status = await f.tool("course_check");
  assert.match(status.text, /学习者现在学的：换用的课打不开/u);
  // 改好以后重新换用，照常能学。
  const used = await f.tool("course_use");
  assert.match(used.text, /^已换用/u);
  assert.equal((await f.state()).course?.id, "os-memory");
});

test("要运行 Python 的课在核对没能运行时如实说明原因，不算通过，也不换用", async (t) => {
  const empty = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-space-course-packages-")));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const f = await fixture(t, { packagesDirectory: empty });
  await f.writeExample();
  const manifest = path.join(f.root, "course", "course.yaml");
  const original = await readFile(manifest, "utf8");
  await f.editTopic("os01", (topic) => {
    const question = pool(topic, 0, "practice")[1];
    assert.ok(question);
    delete question.manual;
    question.verify = 'answers = {"state": "运行"}';
  });
  // runtime 少写了核对环境要的包：沙箱里的 Pyodide 起不来，或这台机器建不了沙箱，两种都写明各自怎样处理。
  await writeFile(manifest, `${original}runtime: { pyodide: "314.0.7", python: "3.14.2", packages: {} }\n`);
  const startup = await f.tool("course_check");
  assert.match(startup.text, /没有通过检查/u);
  assert.match(startup.text, /课里要运行 Python 的部分（verify、代码题、带 tests 的排列题）没有运行，也就没有核对/u);
  assert.match(startup.text, /\[sandbox_unavailable\][\s\S]*Pyodide 启动失败时，把清单的 runtime 照写课说明改/u);
  // 照写课说明写 runtime，但这台机器缺离线包。
  await writeFile(manifest, `${original}${stringify({ runtime: (await guideRuntime()) })}`);
  const checked = await f.tool("course_check");
  assert.match(checked.text, /没有运行，也就没有核对/u);
  assert.match(checked.text, /\[runtime_packages\]/u);
  assert.match((await f.tool("course_use")).text, /^没有换用。/u);
  assert.equal((await f.state()).course?.id, "python");
});

test("写课说明里的 runtime 与随包课一致，照说明写的 verify 例题在沙箱里核对通过", async (t) => {
  const bundled = parseYaml(await readFile(new URL("../courses/python/course.yaml", import.meta.url), "utf8")) as { runtime: Record<string, unknown> };
  const environment = { ...bundled.runtime };
  delete environment.prelude;
  assert.deepEqual(await guideRuntime(), environment);
  const reason = await runtimeUnavailable();
  if (reason) return skipUnavailableEnvironment(t, reason);
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-space-course-guide-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(EXAMPLE, path.join(directory, "course"), { recursive: true });
  const manifest = path.join(directory, "course", "course.yaml");
  await writeFile(manifest, `${await readFile(manifest, "utf8")}${stringify({ runtime: await guideRuntime() })}`);
  const example = (await guideExamples()).find((entry) => Array.isArray(entry) && "verify" in (entry[0] as object)) as Record<string, unknown>[];
  await editTopic(directory, "os01", (topic) => pool(topic, 0, "practice").push(...example));
  const root = path.join(directory, "course");
  const result = await checkCourse(root, { base: root, confirmations: "reported" });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.summary.code.verifyJobs, 1);
});

test("通用 Agent 的提示说明指向随包的写课说明，并有 course_check 与 course_use；写课说明和示例都在安装包的文件清单里", async (t) => {
  const f = await fixture(t);
  const { context } = await f.tool("course_check");
  assert.ok(getCurrentSystemPrompt(context.messages).includes(`先用 read 读 ${COURSE_GUIDE}`));
  const names = getCurrentTools(context.messages).map((entry) => entry.name);
  assert.ok(names.includes("course_check") && names.includes("course_use"));
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { files: string[] };
  assert.ok(manifest.files.includes(path.basename(path.dirname(COURSE_GUIDE))));
  await readFile(COURSE_GUIDE, "utf8");
});

test("辅导 Agent 的工具里没有做课的工具", async (t) => {
  const f = await fixture(t);
  const tutor = await f.client.call("session.create", { agent: TUTOR_AGENT });
  let tools: string[] = [];
  f.faux.setResponses([(context) => {
    tools = getCurrentTools(context.messages).map((entry) => entry.name).sort();
    return fauxAssistantMessage("好");
  }]);
  await f.client.call("session.send", { sessionId: tutor.id, text: "你好" });
  assert.deepEqual(tools, ["learning_read", "learning_search", "learning_task", "read"]);
});

test("不用 Python 的课不写 runtime 也能通过完整检查，写了也不启动解释器；命令行缺省仍要求模型核对记录", async (t) => {
  const result = await checkCourse(EXAMPLE, { base: EXAMPLE, confirmations: "reported" });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.summary.python, false);
  assert.equal(result.summary.code.interpreterStarts, 0);
  // 写了 runtime 而没有要运行 Python 的题，同样不启动解释器，也不要离线包。
  const empty = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-space-course-runtime-")));
  t.after(() => rm(empty, { recursive: true, force: true }));
  await cp(EXAMPLE, empty, { recursive: true });
  await writeFile(path.join(empty, "course.yaml"), `${await readFile(path.join(empty, "course.yaml"), "utf8")}${stringify({ runtime: await guideRuntime() })}`);
  const declared = await checkCourse(empty, { base: empty, confirmations: "reported", packagesDirectory: path.join(empty, "packages") });
  assert.deepEqual(declared.diagnostics, []);
  assert.equal(declared.summary.code.interpreterStarts, 0);
  // 命令行缺省仍要求复习和测验题的 manual 作答位有模型核对记录，随包课程的规矩不变。
  const strict = await checkCourse(EXAMPLE, { base: EXAMPLE });
  assert.deepEqual([...new Set(strict.diagnostics.map((diagnostic) => diagnostic.code))], ["manual_unconfirmed"]);
});
