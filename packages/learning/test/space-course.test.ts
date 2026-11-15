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
import { COURSE_EXAMPLE, COURSE_GUIDE } from "../src/course-tools.js";
import { connectLearning } from "../src/flow.js";
import { frontendPython } from "../src/check/python.js";
import { createLearningPlugin, type LearningPluginOptions } from "../src/plugin.js";
import { onlyAdds } from "../src/space-course.js";
import type { Course } from "../src/format/schema.js";
import { learningMethods, type LearningInput, type LearningMethod, type LearningResult } from "../src/protocol.js";
import type { LearningSession } from "../src/session.js";
import { TUTOR_AGENT } from "../src/tutor.js";
import { demoCourse, runtimeUnavailable, withoutLearnerCode } from "./demo-course.js";
import { skipUnavailableEnvironment } from "./environment.js";
import { referenceAnswer, start } from "./fixtures/learning-session.js";
import { PAGE_RUNTIME, pythonFrontend, verifiedAnswers } from "./fixtures/python-frontend.js";

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
  // Windows 检出的文本是 CRLF 换行。
  const text = (await readFile(COURSE_GUIDE, "utf8")).replaceAll("\r\n", "\n");
  return [...text.matchAll(/^```yaml\n([\s\S]*?)^```$/gmu)].map((match) => parseYaml(match[1] ?? ""));
}

/** 今天之前写课说明让模型照抄的 runtime，已有的自制课都写了它。 */
const OLD_GUIDE_RUNTIME = { pyodide: "314.0.7", python: "3.14.2", packages: { numpy: "2.4.6", pandas: "3.0.2" } };

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
  /** course_check 能运行 Python 的几处；省略时是插件的缺省（Linux 沙箱，再是前端页面）。 */
  python?: LearningPluginOptions["python"];
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
    ...(options.python ? { python: options.python } : {}),
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
  // 这里的测试只看换用：示例课上完第一节就满足自动展开的条件，后台展开会与测试里通用 Agent 的工具调用抢离线模型的回答，所以关掉。
  await call("settings.set", { autoExpand: false });
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
    root, faux, client, call, state, select, step, finish, tool, connection: server.connection,
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

test("不含代码题的示例课：course_check 通过且不运行 Python，course_use 换用后经真实的学习流程上完一节课，重开空间仍是这一版", async (t) => {
  const f = await fixture(t);
  await f.writeExample();
  const checked = await f.tool("course_check");
  assert.match(checked.text, /^course\/ 通过检查：课程 os-memory 1\.0\.0，完整 topic 1 个、骨架 1 个，题目 12 道。$/mu);
  assert.match(checked.text, /没有运行 Python/u);
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
  assert.match(used.text, /^检查通过，但没有换用：学习者正在做一项任务（课、复习或测验），而这一版改了展开过的部分/u);

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

// course 是指向自己的符号链接时，底座的空间监听在 Node 24 的 Linux 上抛出未捕获的 ELOOP（#145），这里改用指向空间之外的链接。
test("course 指向空间之外，读不了：学习插件照常打开，状态里没有课，course_check 说明原因", async (t) => {
  const f = await fixture(t);
  const outside = path.join(path.dirname(f.root), "outside");
  await mkdir(outside);
  // junction 只在 Windows 上起作用，那里建它不要管理员权限；别的系统上忽略这个参数，建的是普通符号链接。
  await symlink(outside, path.join(f.root, "course"), "junction");
  await f.reopen();
  const shown = await f.state();
  assert.equal(shown.course, null);
  assert.equal(shown.menu, null);
  assert.match((await f.tool("course_check")).text, /超出空间内容范围/u);
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
  // 清单不写 runtime；Node 一侧缺离线包，也没有前端提供 python.run：Linux 上沙箱因缺包用不了，这个目录不是源码仓库里的缓存，
  // 所以说安装不完整，不叫人运行 npm；别的系统上写明沙箱只在 Linux 上有。两种都写明没有应用页面能运行。
  const checked = await f.tool("course_check");
  assert.match(checked.text, /没有通过检查/u);
  assert.match(checked.text, /课里要运行 Python 的部分（verify、代码题、带 tests 的排列题）没有运行，也就没有核对/u);
  assert.match(checked.text, process.platform === "linux"
    ? /\[python_unavailable\] Linux 沙箱用不了：[^\n]* 里的 Pyodide 包不完整：缺少 [^\n]*Repa 的安装不完整[^\n]*；没有打开的应用页面能运行 Python/u
    : /\[python_unavailable\] Linux 沙箱用不了：沙箱只能在 Linux 上建立[^\n]*；没有打开的应用页面能运行 Python[^\n]*所以没有核对/u);
  assert.doesNotMatch(checked.text, /npm/u);
  assert.match((await f.tool("course_use")).text, /^没有换用。/u);
  assert.equal((await f.state()).course?.id, "python");
  // 应用页面开着：插件缺省的装配在沙箱用不了时改经页面运行。清单写了 runtime 而包写少了：与 Repa 的 Python 环境不一致，不通过，不运行核对。
  await writeFile(manifest, `${original}runtime: { pyodide: "314.0.7", python: "3.14.2", packages: {} }\n`);
  const page = await pythonFrontend(t, f.connection, verifiedAnswers({}));
  const fallback = await f.tool("course_check");
  assert.match(fallback.text, /\[runtime_mismatch\] 课程清单的 runtime 与 Repa 的 Python 环境不一致：numpy 2\.4\.6（清单里没有写）、pandas 3\.0\.2（清单里没有写）/u);
  assert.equal(page.requests.length, 1);
  assert.match((await f.tool("course_use")).text, /^没有换用。/u);
});

// 装好的应用里，Node 一侧的缺省离线包目录不存在（wheel 在应用目录的 pyodide/packages/ 里）；Windows 和 macOS 本来就建不了沙箱。
// 这时缺的只是沙箱这一处，插件缺省的装配接着经页面核对，页面自己带着 wheel。
test("Node 一侧没有离线包目录时，带 verify 的课经开着的应用页面核对，通过并换用", async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-space-course-packages-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = await fixture(t, { packagesDirectory: path.join(directory, "没有这个目录") });
  const script = await addGuideVerify(f);
  const page = await pythonFrontend(t, f.connection, verifiedAnswers({ [script]: { n: "4" } }));
  const checked = await f.tool("course_check");
  assert.match(checked.text, /^course\/ 通过检查/mu);
  assert.match(checked.text, /在应用页面的 Worker 里运行了 verify 核对程序 1 段/u);
  assert.ok(page.requests.length > 0);
  assert.match((await f.tool("course_use")).text, /^已换用/u);
  assert.equal((await f.state()).course?.id, "os-memory");
});

test("照写课说明写的 verify 例题，清单不写 runtime，在沙箱里核对通过，一个包也不加载；照旧说明写了 runtime 的课同样通过", async (t) => {
  const reason = await runtimeUnavailable();
  if (reason) return skipUnavailableEnvironment(t, reason);
  assert.ok((await guideExamples()).every((entry) => typeof entry !== "object" || entry === null || !("runtime" in entry)), "写课说明里不再有 runtime");
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-space-course-guide-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(EXAMPLE, path.join(directory, "course"), { recursive: true });
  const example = (await guideExamples()).find((entry) => Array.isArray(entry) && "verify" in (entry[0] as object)) as Record<string, unknown>[];
  await editTopic(directory, "os01", (topic) => pool(topic, 0, "practice").push(...example));
  const root = path.join(directory, "course");
  const result = await checkCourse(root, { base: root, confirmations: "reported" });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.summary.code.verifyJobs, 1);
  assert.deepEqual(result.summary.loaded, []);
  const manifest = path.join(root, "course.yaml");
  await writeFile(manifest, `${await readFile(manifest, "utf8")}${stringify({ runtime: OLD_GUIDE_RUNTIME })}`);
  const declared = await checkCourse(root, { base: root, confirmations: "reported" });
  assert.deepEqual(declared.diagnostics, []);
  assert.equal(declared.summary.code.verifyJobs, 1);
});

/** 写课说明里的 verify 例题（时间片 20 ms、运行 70 ms，调度 4 次），加进示例课 os01 的练习；清单照说明不写 runtime。 */
async function addGuideVerify(f: { root: string; writeExample: () => Promise<void> }): Promise<string> {
  await f.writeExample();
  const example = (await guideExamples()).find((entry) => Array.isArray(entry) && "verify" in (entry[0] as object)) as Record<string, unknown>[];
  await editTopic(f.root, "os01", (topic) => pool(topic, 0, "practice").push(...structuredClone(example)));
  const script = example[0]?.verify;
  assert.ok(typeof script === "string");
  return script;
}

/** 只经前端页面核对：在有沙箱的机器上走没有沙箱的那条路。timeoutMs 缩短每一段的时限，等页面回应的期限随之缩短。 */
const pageOnly = (timeoutMs?: number): LearningPluginOptions["python"] => (host) => [
  (options) => frontendPython(host.services)(timeoutMs === undefined ? options : { ...options, timeoutMs }),
];

test("没有 Linux 沙箱时经开着的应用页面核对：没有页面时如实报告；页面算出的与 key 一致才通过并换用，不一致或版本不符时不换用", async (t) => {
  const f = await fixture(t, { python: pageOnly() });
  const script = await addGuideVerify(f);

  // 还没有前端声明 python.run：没有地方运行，不算通过，不换用。
  const alone = await f.tool("course_check");
  assert.match(alone.text, /没有运行，也就没有核对/u);
  assert.match(alone.text, /\[python_unavailable\] 没有打开的应用页面能运行 Python/u);
  assert.match((await f.tool("course_use")).text, /^没有换用。/u);

  // 页面开着，但算出的是 5：报 answer_mismatch，不换用。
  const page = await pythonFrontend(t, f.connection, verifiedAnswers({ [script]: { n: "5" } }));
  const wrong = await f.tool("course_check");
  assert.match(wrong.text, /在应用页面的 Worker 里运行了 verify 核对程序 1 段/u);
  assert.match(wrong.text, /\[answer_mismatch\] n：程序算出 "5"，标准答案是 "4"/u);
  assert.match((await f.tool("course_use")).text, /^没有换用。/u);
  assert.equal((await f.state()).course?.id, "python");
  // 每次检查先发一批空的测试取得页面的版本，再把这一节的 verify 成批交给页面。
  assert.deepEqual(page.requests.slice(0, 2).map((input) => input.tests.map((test) => test.program)), [[], [script]]);
  assert.deepEqual(page.requests[1]?.tests[0]?.verify?.shape, { n: "text" });

  // 清单照旧说明写了 runtime，页面带的 pandas 与它不符：报 runtime_mismatch，不运行核对。
  const manifest = path.join(f.root, "course", "course.yaml");
  const original = await readFile(manifest, "utf8");
  await writeFile(manifest, `${original}${stringify({ runtime: OLD_GUIDE_RUNTIME })}`);
  const before = page.requests.length;
  page.reply = verifiedAnswers({ [script]: { n: "4" } }, { ...PAGE_RUNTIME, packages: { ...PAGE_RUNTIME.packages, pandas: "2.2.0" } });
  const mismatch = await f.tool("course_check");
  assert.match(mismatch.text, /\[runtime_mismatch\] 课程清单的 runtime 与 Repa 的 Python 环境不一致：pandas 2\.2\.0/u);
  assert.equal(page.requests.length, before + 1);
  // 只有 verify 的课不写 runtime：不与页面的环境比较。
  await writeFile(manifest, original);

  // 算出 4：通过并换用。
  page.reply = verifiedAnswers({ [script]: { n: "4" } });
  assert.match((await f.tool("course_check")).text, /^course\/ 通过检查/mu);
  assert.match((await f.tool("course_use")).text, /^已换用/u);
  assert.equal((await f.state()).course?.id, "os-memory");
});

// 没有期限时检查会一直等下去；测试的时限让这种情况失败而不是挂住。
test("页面不回应、核对中途断开时，检查在期限内以 python_unavailable 结束，不算通过", { timeout: 30_000 }, async (t) => {
  // 每段 20 毫秒：等页面交回空批的期限是 0.24 秒，交回一个测试的是 0.3 秒。
  const f = await fixture(t, { python: pageOnly(20) });
  const script = await addGuideVerify(f);
  const page = await pythonFrontend(t, f.connection, () => undefined);
  const silent = await f.tool("course_check");
  assert.match(silent.text, /\[python_unavailable\] 应用页面在 0\.24 秒内没有交回 Python 的运行结果/u);
  assert.equal(page.requests.length, 1);

  // 交回了版本，verify 那一批却不回应。
  const answered = verifiedAnswers({ [script]: { n: "4" } });
  page.reply = (input) => (input.tests.length === 0 ? answered(input) : undefined);
  const stuck = await f.tool("course_check");
  assert.match(stuck.text, /没有通过检查/u);
  assert.match(stuck.text, /\[python_unavailable\] 应用页面在 0\.3 秒内没有交回 Python 的运行结果。课里的 verify 核对程序和代码题没有全部运行/u);

  // verify 那一批交给页面以后页面关掉了。
  page.reply = (input) => {
    if (input.tests.length === 0) return answered(input);
    void page.client.close();
    return undefined;
  };
  const closed = await f.tool("course_check");
  assert.match(closed.text, /\[python_unavailable\] 应用页面运行 Python 失败：提供服务的连接已断开/u);
  assert.match((await f.tool("course_use")).text, /^没有换用。/u);
});

test("通用 Agent 的提示说明指向随包的写课说明，并有 course_check 与 course_use；写课说明和示例都在安装包的文件清单里", async (t) => {
  const f = await fixture(t);
  const { context } = await f.tool("course_check");
  assert.ok(getCurrentSystemPrompt(context.messages).includes(`先用 read 读 ${COURSE_GUIDE}（它引用的示例课在 ${COURSE_EXAMPLE}）`));
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
  assert.deepEqual(tools, ["learning_read", "learning_search", "learning_task"]);
});

test("只增不改：只有 verify 的课新的一版可以去掉或改写 runtime；有代码题的课 runtime 要一字不差", () => {
  const demo = demoCourse();
  const { runtime, ...bare } = demo.course;
  const resolved = (course: Course, topics: typeof demo.topics) => ({ course, topics: Object.values(topics), origins: {} });
  const teaching = resolved(demo.course, demo.topics);
  assert.equal(onlyAdds(teaching, resolved(demo.course, demo.topics)), true);
  assert.equal(onlyAdds(teaching, resolved(bare, demo.topics)), false);
  assert.equal(onlyAdds(teaching, resolved({ ...bare, runtime: { ...runtime, prelude: "BONUS = 1" } }, demo.topics)), false);
  // verify 只在检查时运行，判分用不到 runtime：照旧说明写了 runtime 的课，新的一版照新说明去掉它，仍是只增不改。
  const verifyTopics = withoutLearnerCode(demo.topics);
  const computing = resolved(demo.course, verifyTopics);
  assert.equal(onlyAdds(computing, resolved(bare, verifyTopics)), true);
  assert.equal(onlyAdds(resolved(bare, verifyTopics), computing), true);
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
  await writeFile(path.join(empty, "course.yaml"), `${await readFile(path.join(empty, "course.yaml"), "utf8")}${stringify({ runtime: OLD_GUIDE_RUNTIME })}`);
  const declared = await checkCourse(empty, { base: empty, confirmations: "reported", packagesDirectory: path.join(empty, "packages") });
  assert.deepEqual(declared.diagnostics, []);
  assert.equal(declared.summary.code.interpreterStarts, 0);
  // 命令行缺省仍要求复习和测验题的 manual 作答位有模型核对记录，随包课程的规矩不变。
  const strict = await checkCourse(EXAMPLE, { base: EXAMPLE });
  assert.deepEqual([...new Set(strict.diagnostics.map((diagnostic) => diagnostic.code))], ["manual_unconfirmed"]);
});
