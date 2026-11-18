/**
 * 换用课程是一次先验证、后发布的操作：副本落盘、按副本建好新会话，再原子写 course.json；发布以后才按新内容补判，最后清理别的副本。
 * 换用一版删了题、改了 topic 组成的课，过去的结论与 XP 不变；只改答案时，符合条件的旧作答确实重判。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createSpace, openPluginHost, openSpace } from "@repa/base";
import { INTERACTION_CAPABILITIES, parse } from "@repa/base/protocol";
import { ModelTestDriver } from "@repa/base/testing";
import { parse as parseYaml, stringify } from "yaml";
import { connectLearning } from "../src/flow.js";
import { emptyFold, foldTask, taskEvidence } from "../src/flow-state.js";
import { createLearningPlugin } from "../src/plugin.js";
import { learningMethods, type LearningInput, type LearningMethod, type LearningResult, type LearnerResponse } from "../src/protocol.js";
import type { Fact } from "../src/records-schema.js";
import type { Replay } from "../src/replay.js";
import type { LearningSession } from "../src/session.js";
import { copyStats } from "../../base/dist/backup/copy.js";
import { withRecords } from "./fixtures/confirmations.js";
import { referenceAnswer, start } from "./fixtures/learning-session.js";

const EXAMPLE = fileURLToPath(new URL("../guides/example-course/", import.meta.url));
const DATA = path.join(".repa", "plugins", "learning");

/** 示例课写进空间的 course/，带上全部核对记录；经真实的插件宿主打开学习插件，调用工具与方法。fail 为真时新建的学习会话接不上教学方法。 */
async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-course-switch-")));
  const root = path.join(directory, "space");
  let space = await createSpace(root, { watch: false });
  await cp(EXAMPLE, path.join(root, "course"), { recursive: true });
  let session: LearningSession | undefined;
  const control = { fail: false };
  const plugin = createLearningPlugin({
    async connect(opened) {
      if (control.fail) throw new Error("接不上教学方法");
      session = opened;
      return connectLearning(opened, {});
    },
  });
  const models = new ModelTestDriver();
  const open = () => openPluginHost({ space, plugins: [plugin], now: () => start, models, backup: async () => {}, emit: () => {}, onError: (error) => { throw error; } });
  let host = await open();
  await host.call("learning", "settings.set", { autoExpand: false }, { capabilities: {} });
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
  /** 改写空间 course/ 里的一个 topic 并补上核对记录。 */
  const editTopic = async (id: string, change: (topic: Record<string, unknown>) => void) => {
    const file = path.join(root, "course", "topics", `${id}.yaml`);
    const value = parseYaml(await readFile(file, "utf8")) as Record<string, unknown>;
    delete value.verified;
    change(value);
    await writeFile(file, await withRecords(stringify(value, { aliasDuplicateObjects: false })));
  };
  // os02 在示例课里是轮廓；照 os01 写成完整的一节，课程里就有两节可学。
  const os01 = await readFile(path.join(root, "course", "topics", "os01.yaml"), "utf8");
  await writeFile(path.join(root, "course", "topics", "os02.yaml"), os01.replaceAll("os01", "os02").replace("title: 进程的三种基本状态", "title: 进程状态再练"));
  for (const id of ["os01", "os02"]) await editTopic(id, () => {});
  /** 上一节课：answer 给出某道题的作答，缺省按参考答案。 */
  const lesson = async (topic: string, answer?: (question: string) => LearnerResponse | undefined) => {
    let state = await call("state.get", {});
    const candidate = state.menu?.candidates.find((entry) => entry.kind === "lesson" && entry.topicIds[0] === topic);
    assert.ok(state.menu && candidate, `菜单里没有 ${topic}`);
    state = await call("menu.select", { menuId: state.menu.menuId, candidateId: candidate.id });
    for (let step = 0; step < 40 && state.task && state.task.phase.stage !== "completed"; step++) {
      const task = state.task;
      if (task.phase.stage === "awaiting_answer") {
        const delivery = task.deliveries.at(-1);
        assert.ok(delivery && session);
        const question = session.replay.delivery(Number(delivery.deliveryId.slice(1)))?.questionId ?? "";
        const response = answer?.(question) ?? await referenceAnswer(session, delivery);
        await call("submission.submit", { taskId: task.taskId, deliveryId: delivery.deliveryId, submissionId: delivery.submissionId, response: { ...response, item: delivery.item.id === response.item.id ? response.item : { id: delivery.item.id, version: delivery.item.version } } });
        state = await call("state.get", {});
      } else {
        state = await call("task.advance", { taskId: task.taskId, expectedStage: task.phase.stage, expectedRevision: state.revision });
      }
    }
    return state;
  };
  /** 关闭空间，在关着的时候改盘上的数据（action），再打开。 */
  const reopen = async (action: () => Promise<void> = async () => {}) => {
    await host.close();
    await space.close();
    await action();
    space = await openSpace(root, { watch: false });
    host = await open();
  };
  const facts = async () => (await readFile(path.join(root, DATA, "records.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Fact);
  const active = async () => (JSON.parse(await readFile(path.join(root, DATA, "course.json"), "utf8")) as { active: string }).active;
  const copies = async () => (await readdir(path.join(root, DATA, "courses"))).sort();
  return { root, control, call, tool, editTopic, lesson, reopen, facts, active, copies, session: () => session };
}

/** 每项任务的结论、每笔 XP 与学生模型。 */
function history(replay: Replay) {
  let fold = emptyFold();
  const outcomes = replay.tasks.map((task, index) => {
    const evidence = index === replay.tasks.length - 1 ? replay.currentEvidence() : taskEvidence(task, fold.lessons.get(task.topicIds[0] ?? ""));
    if (index < replay.tasks.length - 1 && evidence) fold = foldTask(fold, evidence);
    return [task.seq, evidence?.outcome ?? null];
  });
  return { outcomes, awards: replay.awards, student: replay.fold().student };
}

/** os01.k1.q2 的填空答“执行”：按示例课的答案是错的。 */
const wrongQ2 = (question: string): LearnerResponse | undefined =>
  question === "os01.k1.q2" ? { item: { id: "", version: "" }, answers: { state: { type: "text", text: "执行" } } } : undefined;

test("换用一版删了学过的题、去掉了一个知识点的课（版本号不变）：过去的结论、XP 与学生模型不变；之后的任务引用新的结构", async (t) => {
  const f = await fixture(t);
  assert.match(await f.tool("course_use"), /^已换用/u);
  const passed = await f.lesson("os01");
  assert.deepEqual(passed.task?.phase, { stage: "completed", outcome: "passed" });
  const session = f.session();
  assert.ok(session);
  const before = history(session.replay);
  const xp = passed.progress;

  // 删掉学过的 os01.k1.q2（换一道新题补足题量），去掉第二个知识点、换成一个新的：课程检查要求每个知识点至少三道练习、每节至少两个知识点。
  await f.editTopic("os01", (topic) => {
    const kps = topic.kps as Record<string, unknown>[];
    const first = kps[0] as { practice: { id: string }[] };
    const q1 = first.practice[0];
    assert.ok(q1);
    first.practice = [...first.practice.filter((question) => question.id !== "os01.k1.q2"), { ...structuredClone(q1), id: "os01.k1.q4" }];
    kps[1] = JSON.parse(JSON.stringify(kps[1]).replaceAll("os01.k2", "os01.k3")) as Record<string, unknown>;
  });
  assert.match(await f.tool("course_use"), /^已换用/u);
  const after = f.session();
  assert.ok(after && after !== session);
  assert.deepEqual(history(after.replay), before);
  const state = await f.call("state.get", {});
  assert.equal(state.progress.totalXp, xp.totalXp);
  assert.equal(state.progress.todayXp, xp.todayXp);

  // 新任务写下新的结构；之前的任务仍引用原来那一份。
  await f.lesson("os02");
  const facts = await f.facts();
  const structures = facts.filter((fact) => fact.type === "structure");
  const tasks = facts.filter((fact) => fact.type === "task");
  assert.equal(structures.length, 2);
  assert.deepEqual(tasks.map((fact) => fact.type === "task" && fact.structure), structures.map((fact) => fact.seq));
  await f.reopen();
  assert.deepEqual(history(f.session()?.replay as Replay).awards.slice(0, before.awards.length), before.awards);
});

test("只改答案的一版：学过的那份错答按新答案重判为对，在发布以后才写下判分", async (t) => {
  const f = await fixture(t);
  assert.match(await f.tool("course_use"), /^已换用/u);
  await f.lesson("os01", wrongQ2);
  const verdict = () => {
    const delivery = [...(f.session()?.replay.allDeliveries() ?? [])].find((entry) => entry.questionId === "os01.k1.q2");
    return delivery?.grades.at(-1)?.verdict;
  };
  assert.equal(verdict(), "incorrect");
  const old = await f.active();
  await f.editTopic("os01", (topic) => {
    const q2 = ((topic.kps as { practice: { id: string; slots: { key: string[] }[] }[] }[])[0]?.practice ?? []).find((question) => question.id === "os01.k1.q2");
    assert.ok(q2?.slots[0]);
    q2.slots[0].key = [...q2.slots[0].key, "执行"];
  });
  assert.match(await f.tool("course_use"), /^已换用/u);
  assert.notEqual(await f.active(), old);
  assert.equal(verdict(), "correct");
  assert.deepEqual(await f.copies(), [await f.active()]);
});

test("新会话建不起来：换用报错，course.json 不变、旧的课照常在用，没有写下任何判分；多存的副本在下一次换用成功后清掉", async (t) => {
  const f = await fixture(t);
  assert.match(await f.tool("course_use"), /^已换用/u);
  await f.lesson("os01", wrongQ2);
  const old = await f.active();
  const count = (await f.facts()).length;
  await f.editTopic("os01", (topic) => {
    const q2 = ((topic.kps as { practice: { id: string; slots: { key: string[] }[] }[] }[])[0]?.practice ?? []).find((question) => question.id === "os01.k1.q2");
    assert.ok(q2?.slots[0]);
    q2.slots[0].key = [...q2.slots[0].key, "执行"];
  });
  f.control.fail = true;
  await assert.rejects(f.tool("course_use"), { code: "course_switch_failed" });
  assert.equal(await f.active(), old);
  assert.equal((await f.facts()).length, count);
  assert.equal((await f.copies()).length, 2);
  const state = await f.call("state.get", {});
  assert.equal(state.task?.phase.stage, "completed");
  f.control.fail = false;
  assert.match(await f.tool("course_use"), /^已换用/u);
  assert.deepEqual(await f.copies(), [await f.active()]);
});

test("发布前、发布后中断：发布前重开仍是旧的课，不按新内容判分；发布后重开就是新的课，打开时按新内容补判", async (t) => {
  const f = await fixture(t);
  assert.match(await f.tool("course_use"), /^已换用/u);
  await f.lesson("os01", wrongQ2);
  const data = path.join(f.root, DATA);
  const old = await f.active();
  const saved = path.join(f.root, "..", "saved-copy");
  await cp(path.join(data, "courses", old), saved, { recursive: true });
  const log = await readFile(path.join(data, "records.jsonl"));
  await f.editTopic("os01", (topic) => {
    const q2 = ((topic.kps as { practice: { id: string; slots: { key: string[] }[] }[] }[])[0]?.practice ?? []).find((question) => question.id === "os01.k1.q2");
    assert.ok(q2?.slots[0]);
    q2.slots[0].key = [...q2.slots[0].key, "执行"];
  });
  assert.match(await f.tool("course_use"), /^已换用/u);
  const fresh = await f.active();
  // 盘上做成“发布之前断电”的样子：新的副本已落盘，course.json 仍指向旧的，学习记录里没有按新内容的判分。
  await f.reopen(async () => {
    await cp(saved, path.join(data, "courses", old), { recursive: true });
    await writeFile(path.join(data, "course.json"), `${JSON.stringify({ active: old })}\n`);
    await writeFile(path.join(data, "records.jsonl"), log);
  });
  assert.equal(await f.active(), old);
  assert.deepEqual(await readFile(path.join(data, "records.jsonl")), log);
  // 再做成“发布之后、补判之前断电”：course.json 指向新的，学习记录同上。
  await f.reopen(async () => {
    await writeFile(path.join(data, "course.json"), `${JSON.stringify({ active: fresh })}\n`);
  });
  const added = (await f.facts()).slice(log.toString("utf8").split("\n").filter(Boolean).length);
  assert.deepEqual(added.map((fact) => fact.type === "graded" && fact.verdict), ["correct"]);
});

test("副本改名就位之前，其中的课程文件和目录都已落盘", async (t) => {
  const f = await fixture(t);
  const before = copyStats().synced;
  assert.match(await f.tool("course_use"), /^已换用/u);
  const synced = [...copyStats().synced].filter(([file, count]) => count > (before.get(file) ?? 0)).map(([file]) => file.split(path.sep).join("/"));
  for (const name of ["course.yaml", "topics/os01.yaml", "topics/os02.yaml", "topics"]) {
    assert.ok(synced.some((file) => file.includes("/checks/") && file.endsWith(`/${name}`)), `${name} 没有落盘：${synced.join("、")}`);
  }
});

test("发布 course.json 出错：学习插件就此停下，不再按哪一门课服务，也不再换用，重开空间时从盘上读", async (t) => {
  const f = await fixture(t);
  assert.match(await f.tool("course_use"), /^已换用/u);
  await f.editTopic("os01", (topic) => { topic.minutes = 20; });
  const choice = path.join(f.root, DATA, "course.json");
  await rm(choice);
  await mkdir(choice);
  await assert.rejects(f.tool("course_use"), { code: "course_switch_failed" });
  assert.equal((await f.call("state.get", {})).course, null);
  await assert.rejects(f.call("progress.setGoal", { dailyGoalXp: 30 }), { code: "course_unavailable" });
  await assert.rejects(f.tool("course_use"), { code: "course_switch_failed" });
});
