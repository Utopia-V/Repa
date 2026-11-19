/**
 * 课在空间里的身份与位置：登记里的键、courses/<名>/ 的文件夹、学习状态按“课的键加编号”、做课工具按课取缺省、
 * 每次运行带上这门课的要求、文件夹改名以后的接回。经真实的插件宿主打开学习插件，工具在模拟的运行里调用。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createSpace, openPluginHost, RepaFault } from "@repa/base";
import { ModelTestDriver } from "@repa/base/testing";
import { INTERACTION_CAPABILITIES, parse } from "@repa/base/protocol";
import { withRun } from "../../base/dist/run-context.js";
import { connectLearning } from "../src/flow.js";
import { createLearningPlugin } from "../src/plugin.js";
import { learningMethods, type LearningInput, type LearningMethod, type LearningResult } from "../src/protocol.js";
import type { Fact } from "../src/records-schema.js";
import type { LearningSession } from "../src/session.js";
import { withRecords } from "./fixtures/confirmations.js";
import { referenceAnswer, start } from "./fixtures/learning-session.js";

const EXAMPLE = fileURLToPath(new URL("../guides/example-course/", import.meta.url));
const DATA = path.join(".repa", "plugins", "learning");

/** 把示例课写到 directory：os02 照 os01 写成完整的一节，两节都可学；records 为真时补上核对记录。两份课的 topic 与题目编号完全相同。 */
async function writeExample(directory: string, records: boolean) {
  await cp(EXAMPLE, directory, { recursive: true });
  const os01 = await readFile(path.join(directory, "topics", "os01.yaml"), "utf8");
  await writeFile(path.join(directory, "topics", "os02.yaml"), os01.replaceAll("os01", "os02").replace("title: 进程的三种基本状态", "title: 进程状态再练"));
  if (!records) return;
  for (const id of ["os01", "os02"]) {
    const file = path.join(directory, "topics", `${id}.yaml`);
    await writeFile(file, await withRecords((await readFile(file, "utf8")).replace(/\nverified:[\s\S]*$/u, "\n")));
  }
}

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-course-identity-")));
  const bundled = path.join(directory, "bundled", "demo");
  await writeExample(bundled, false);
  const root = path.join(directory, "Repa");
  const space = await createSpace(root, { watch: false });
  let session: LearningSession | undefined;
  const plugin = createLearningPlugin({
    sources: [{ kind: "bundled", directory: bundled }],
    async connect(opened) {
      session = opened;
      return connectLearning(opened, {});
    },
  });
  const host = await openPluginHost({ space, plugins: [plugin], now: () => start, models: new ModelTestDriver(), backup: async () => {}, emit: () => {}, onError: (error) => { throw error; } });
  await host.call("learning", "settings.set", { autoExpand: false }, { capabilities: {} });
  t.after(async () => {
    await host.close();
    await space.close();
    await rm(directory, { recursive: true, force: true });
  });
  const capabilities = { interaction: { supports: [...INTERACTION_CAPABILITIES] } };
  const call = async <M extends LearningMethod>(method: M, input: LearningInput<M>) =>
    parse(learningMethods[method].result, await host.call("learning", method, input, { capabilities })) as LearningResult<M>;
  /** 调用做课工具；sessionId 给出时在那个会话的一次运行里调用，像做课对话里的 Agent 那样。 */
  const tool = async (name: string, input: Record<string, unknown> = {}, sessionId?: string) => {
    const found = host.tools().find((entry) => entry.name === name);
    assert.ok(found);
    const run = () => found.execute(input, { signal: new AbortController().signal, callId: randomUUID() });
    const result = sessionId === undefined ? await run() : await withRun({ runId: randomUUID(), ancestorRunIds: [], sessionId, agent: "general" }, run);
    return result.text;
  };
  /** 一次运行开始时取到的每次运行的说明（view）。 */
  const views = (sessionId: string) => withRun({ runId: randomUUID(), ancestorRunIds: [], sessionId, agent: "general" }, () => host.views());
  /** 上完一节课，作答都按参考答案。 */
  const lesson = async (topic: string, course?: string) => {
    let state = await call("state.get", {});
    const candidate = state.menu?.candidates.find((entry) => entry.kind === "lesson" && entry.topicIds[0] === topic && (course === undefined || entry.course === course));
    assert.ok(state.menu && candidate, `菜单里没有 ${topic}`);
    state = await call("menu.select", { menuId: state.menu.menuId, candidateId: candidate.id });
    for (let step = 0; step < 40 && state.task && state.task.phase.stage !== "completed"; step++) {
      const task = state.task;
      if (task.phase.stage === "awaiting_answer") {
        const delivery = task.deliveries.at(-1);
        assert.ok(delivery && session);
        const response = await referenceAnswer(session, delivery);
        await call("submission.submit", { taskId: task.taskId, deliveryId: delivery.deliveryId, submissionId: delivery.submissionId, response });
        state = await call("state.get", {});
      } else {
        state = await call("task.advance", { taskId: task.taskId, expectedStage: task.phase.stage, expectedRevision: state.revision });
      }
    }
    return state;
  };
  const facts = async () => (await readFile(path.join(root, DATA, "records.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Fact);
  const registry = async () => (JSON.parse(await readFile(path.join(root, DATA, "course.json"), "utf8")) as { courses: { key: string; location?: string; bundled?: string; copy?: string }[] }).courses;
  return { root, call, tool, views, lesson, facts, registry };
}

test("两门课的 topic 与题目编号完全相同：随包课里学过的 os01，在自己的课里仍是没学过的一节；两门课并存，任务记着课的键", async (t) => {
  const f = await fixture(t);
  await f.call("courses.useBundled", {});
  assert.equal((await f.lesson("os01")).task?.phase.stage, "completed");
  assert.equal((await f.call("state.get", {})).progress.completedTopics, 1);

  await writeExample(path.join(f.root, "courses", "操作系统", "course"), true);
  assert.match(await f.tool("course_use", { course: "courses/操作系统" }), /^已换用/u);
  const own = (await f.registry()).find((entry) => entry.location === "courses/操作系统")?.key;
  assert.ok(own && own !== "bundled-demo");
  // 随包的课没有被取代：两门课都在登记里，都可学。
  assert.deepEqual((await f.registry()).map((entry) => entry.key), ["bundled-demo", own]);
  const state = await f.call("state.get", {});
  // 同号的 os01 属于另一门课：自己的课一节也没学过，随包课学过的那一节照算。
  assert.deepEqual(state.courses.map((entry) => [entry.key, entry.completedTopics, entry.totalTopics]), [["bundled-demo", 1, 2], [own, 0, 2]]);
  assert.equal(state.progress.completedTopics, 1);
  assert.equal(state.progress.totalTopics, 4);
  // 菜单里自己的课给的是 os01 的新课，不是复习。
  assert.ok(state.menu?.candidates.some((entry) => entry.course === own && entry.kind === "lesson" && entry.topicIds[0] === "os01"));
  assert.ok(!state.menu?.candidates.some((entry) => entry.course === own && entry.kind === "review"));

  assert.equal((await f.lesson("os01", own)).task?.course, own);
  const tasks = (await f.facts()).filter((fact) => fact.type === "task");
  assert.deepEqual(tasks.map((fact) => fact.type === "task" && fact.course.key), ["bundled-demo", own]);
  const after = await f.call("state.get", {});
  assert.deepEqual(after.courses.map((entry) => entry.completedTopics), [1, 1]);
  assert.equal(after.progress.completedTopics, 2);
});

test("做课工具按位置取缺省：几门课时不写 course 就报错并列出有哪些；在一门课的做课运行里不写就是那门课，记进它自己的做课记录", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, "courses", "甲"), { recursive: true });
  await mkdir(path.join(f.root, "courses", "乙"), { recursive: true });
  await writeFile(path.join(f.root, "courses", "甲", "AGENTS.md"), "甲的要求：期中考试前学完。\n");
  await writeFile(path.join(f.root, "courses", "乙", "AGENTS.md"), "乙的要求：只学第三章。\n");

  await assert.rejects(f.tool("course_check"), (error: unknown) => error instanceof RepaFault && error.code === "course_required"
    && error.message.includes("courses/甲") && error.message.includes("courses/乙"));
  await assert.rejects(f.tool("course_check", { course: "courses/丙" }), (error: unknown) => error instanceof RepaFault && error.code === "course_not_found");

  // 乙的做课运行：第一次写明是乙，之后同一个会话不写也是乙。
  assert.match(await f.tool("course_check", { course: "courses/乙" }, "s-乙"), /courses\/乙\/course\/ 文件夹不存在/u);
  assert.match(await f.tool("course_check", {}, "s-乙"), /courses\/乙\/course\/ 文件夹不存在/u);
  assert.match(await f.tool("course_check", { course: "courses/甲/" }, "s-甲"), /courses\/甲\/course\/ 文件夹不存在/u);
  const registry = await f.registry();
  assert.deepEqual(registry.map((entry) => entry.location), ["courses/乙", "courses/甲"]);
  for (const entry of registry) {
    const record = JSON.parse(await readFile(path.join(f.root, DATA, "building", `${entry.key}.json`), "utf8")) as { sessions: string[] };
    assert.deepEqual(record.sessions, [entry.location === "courses/乙" ? "s-乙" : "s-甲"]);
  }

  // 每次运行的说明：乙的运行里有乙的文件夹与要求全文，没有甲的；不属于哪门课的运行没有这一段。
  const forB = (await f.views("s-乙")).map((entry) => entry.text).join("\n");
  assert.match(forB, /courses\/乙\//u);
  assert.match(forB, /乙的要求：只学第三章。/u);
  assert.doesNotMatch(forB, /甲的要求/u);
  const forA = (await f.views("s-甲")).map((entry) => entry.text).join("\n");
  assert.match(forA, /甲的要求：期中考试前学完。/u);
  assert.doesNotMatch(forA, /乙的要求/u);
  assert.doesNotMatch((await f.views("别的会话")).map((entry) => entry.text).join("\n"), /的要求/u);
});

test("课程文件夹改名：证据唯一时自动接回；另有一个不认识的文件夹时不猜，原来的位置标为不在，课照常能学", async (t) => {
  const f = await fixture(t);
  await writeExample(path.join(f.root, "courses", "操作系统", "course"), true);
  assert.match(await f.tool("course_use"), /^已换用/u);
  const [entry] = await f.registry();
  assert.ok(entry);

  await rename(path.join(f.root, "courses", "操作系统"), path.join(f.root, "courses", "操作系统原理"));
  const listed = await f.call("courses.list", {});
  assert.deepEqual(listed.courses.map((course) => [course.key, course.folder, course.missing]), [[entry.key, "courses/操作系统原理", false]]);
  assert.deepEqual(await f.registry(), [{ ...entry, location: "courses/操作系统原理" }]);

  await rename(path.join(f.root, "courses", "操作系统原理"), path.join(f.root, "courses", "甲"));
  await mkdir(path.join(f.root, "courses", "乙"));
  const unsure = await f.call("courses.list", {});
  assert.deepEqual(unsure.courses.map((course) => [course.folder, course.missing]), [["courses/操作系统原理", true]]);
  assert.equal((await f.call("state.get", {})).course?.id, "os-memory");
});

test("新建课程：courses/<名>/ 带一份空的要求，登记成草稿；可以建几门；同名的就是那一门；名字不能作文件夹名时拒绝", async (t) => {
  const f = await fixture(t);
  const created = await f.call("courses.create", { name: "线性代数" });
  assert.deepEqual(created.courses.map((course) => [course.folder, course.learnable, course.bundled]), [["courses/线性代数", false, false]]);
  assert.equal(created.canCreate, true);
  assert.equal(await readFile(path.join(f.root, "courses", "线性代数", "AGENTS.md"), "utf8"), "");
  const key = created.courses[0]?.key;
  const building = await f.call("building.get", { course: key });
  assert.deepEqual([building.key, building.folder, building.course], [key, "courses/线性代数", null]);
  const second = await f.call("courses.create", { name: "概率论" });
  assert.deepEqual(second.courses.map((course) => course.folder), ["courses/线性代数", "courses/概率论"]);
  // 两门自己的课时，不写课的方法拿不准是哪门。
  assert.equal((await f.call("building.get", {})).key, null);
  const again = await f.call("courses.create", { name: "线性代数" });
  assert.deepEqual(again.courses.map((course) => course.key), second.courses.map((course) => course.key));
  await assert.rejects(f.call("courses.create", { name: "a/b" }), (error: unknown) => error instanceof RepaFault && error.code === "invalid_name");
  await assert.rejects(access(path.join(f.root, "courses", "a")));
});

test("换课以后旧课的强制补救不再要求，也不挡新课的菜单；还在这门课里的照旧挡住", async () => {
  const { obligations, emptyFold } = await import("../src/flow-state.js");
  const { StructureIndex } = await import("../src/course-structure.js");
  const structure = new StructureIndex({ course: { id: "x", version: "1" }, topics: [{ id: "t01", status: "complete", minutes: 5, prerequisites: [], encompassings: [], kps: [] }] });
  const fold = { ...emptyFold(), forced: new Map<string, "review" | "lesson">([["旧课:t01", "review"], ["新课:t09", "lesson"], ["新课:t01", "review"]]) };
  const gate = obligations(fold, (key) => (key === "新课" ? structure : undefined));
  // 旧课不在空间里了，新课已经删掉了 t09：只有新课里还在的 t01 仍要求。
  assert.deepEqual([...gate.forced], [["新课:t01", "review"]]);
  assert.equal(obligations({ ...fold, forced: new Map([["新课:t01", "review"]]) }, () => structure).forced.size, 1);
});
