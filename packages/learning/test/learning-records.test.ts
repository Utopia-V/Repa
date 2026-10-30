import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { createSpace, openPluginHost, openSpace, RepaFault } from "@repa/base";
import { ModelTestDriver } from "@repa/base/testing";
import { contentVersion } from "@repa/base/protocol";
import { stringify } from "yaml";
import { loadCourseSources } from "../src/course-sources.js";
import { connectLearning } from "../src/flow.js";
import { createLearningPlugin } from "../src/plugin.js";
import type { LearningState, Submission } from "../src/protocol.js";
import { LearningRecords } from "../src/records.js";
import type { LearningSession } from "../src/session.js";
import { chooseTasks, updateStudent } from "../src/student-model.js";
import { now } from "./fixtures/learning-contract.js";
import { clock, course, graph, openSession, topic } from "./fixtures/learning-records.js";
import { learningFixture, start, topic as testTopic } from "./fixtures/learning-session.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const fault = (code: string) => (error: unknown) => error instanceof RepaFault && error.code === code;

async function directory(t: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-learning-records-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeCourse(root: string): Promise<string> {
  const target = path.join(root, "course");
  await mkdir(path.join(target, "topics"), { recursive: true });
  await writeFile(path.join(target, "course.yaml"), stringify(course));
  await writeFile(path.join(target, "topics", "py01.yaml"), stringify(topic));
  return target;
}

for (const stage of ["accepted", "returned", "persisted"]) {
  test(`在 ${stage} 边界杀进程：作答保留且不阻塞，补判只调用一次模型、只追加一次判分`, { timeout: 30_000 }, async (t) => {
    const root = await directory(t);
    const courseDirectory = await writeCourse(root);
    const file = path.join(root, "records.jsonl");
    const child = fork(new URL("./fixtures/learning-crash.ts", import.meta.url), [file, courseDirectory, stage], {
      execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let errors = "";
    child.stderr?.on("data", (data) => { errors += String(data); });
    const exited = once(child, "exit");
    t.after(async () => {
      child.kill("SIGKILL");
      await exited;
    });
    const reached = await Promise.race([
      once(child, "message").then(([message]) => message),
      exited.then(() => { throw new Error(`子进程提前退出：${errors}`); }),
    ]);
    assert.equal(reached, stage);
    child.kill("SIGKILL");
    const [, signal] = await exited;
    assert.equal(signal, "SIGKILL");
    const before = await readFile(file);
    const models = new ModelTestDriver();
    const { records, session, call } = await openSession(file, courseDirectory, models);
    t.after(() => records.close());
    assert.deepEqual(await readFile(file), before);
    const answered = records.facts.filter((fact) => fact.type === "answered");
    assert.equal(answered.length, 1);
    assert.deepEqual(answered[0]?.type === "answered" && answered[0].answers, { s1: { type: "text", text: "两个一合起来" } });
    // 先不经方法读取：方法调用会自动补判。
    const state = await session.state();
    const submission = state.task?.submissions[0];
    assert.ok(submission);
    if (stage === "persisted") {
      assert.equal(submission.processing.status, "completed");
    } else {
      // 没判出结果的作答是尚无证据：任务停在恢复阶段，可以继续下一题，也不计尝试。
      assert.deepEqual(submission.processing, { status: "interrupted", reason: "restart" });
      assert.equal(state.task?.phase.stage, "recovery");
      assert.equal(state.task?.kps[0]?.attempts, 0);
    }
    // 打开后的第一次方法调用自动补判一次（替身没有安排结果，判分失败）；显式恢复再判一次。
    await call("state.get", {});
    await session.idle();
    const automatic = models.calls.length;
    assert.equal(automatic, stage === "persisted" ? 0 : 1);
    if (stage !== "persisted") {
      models.expectStructured().succeed({ verdict: "correct", reason: "说明了相加的含义" });
    }
    const results = await Promise.all([
      call("submission.resume", { submissionId: submission.submissionId }),
      call("submission.resume", { submissionId: submission.submissionId }),
    ]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(models.calls.length, automatic + (stage === "persisted" ? 0 : 1));
    assert.equal(records.facts.filter((fact) => fact.type === "graded").length, 1);
    assert.equal(records.facts.filter((fact) => fact.type === "answered").length, 1);
    const resumed = (await call("submission.get", { submissionId: submission.submissionId })) as { submission: Submission };
    assert.equal(resumed.submission.gradeRevision, 1);
    assert.equal(((await call("state.get", {})) as LearningState).task?.kps[0]?.attempts, 1);
  });
}

test("同载荷并发提交只收一次，判分期间不占串行入口，失败后沿原身份继续", async (t) => {
  const definition = testTopic();
  const question = definition.kps[0]?.practice?.[0];
  assert.ok(question);
  question.slots = [{ id: "answer", type: "text", rubric: [{ id: "meaning", label: "说明相加含义。" }] }];
  const f = await learningFixture(t, [definition]);
  await f.select();
  await f.advance();
  await f.advance();
  const input = await f.input();
  const pending = f.models.expectStructured();
  const receipts = Promise.all([f.call("submission.submit", input), f.call("submission.submit", input)]);
  await pending.requested;
  // 判分在等模型时，其他写入照常进行。
  await f.call("progress.setGoal", { dailyGoalXp: 30 });
  assert.equal(f.session().records.facts.filter((fact) => fact.type === "answered").length, 1);
  pending.fail(new Error("服务断线"));
  const [first, second] = await receipts;
  assert.deepEqual(second, first);
  assert.ok(first.status === "recorded");
  assert.deepEqual(first.submission.processing, { status: "interrupted", reason: "service_failure" });
  assert.equal(f.models.calls.length, 1);
  assert.equal(f.session().records.facts.some((fact) => fact.type === "graded"), false);
  f.models.expectStructured().succeed({ verdict: "correct", reason: "符合" });
  await f.call("submission.resume", { submissionId: input.submissionId });
  const completed = await f.state();
  assert.equal(completed.task?.submissions[0]?.processing.status, "completed");
  await f.reopen();
  assert.deepEqual(await f.state(), completed);
});

test("结构拒绝、错身份与截止后新答不落盘，已收下的重交仍可查询", async (t) => {
  const f = await learningFixture(t);
  await f.select();
  await f.finishLesson();
  f.time(start + 86_400_000);
  await f.select("t01", "review");
  const input = await f.input();
  const revision = f.session().records.revision;
  const bad = await f.call("submission.submit", { ...input, response: { ...input.response, answers: {} } });
  assert.equal(bad.status, "rejected");
  assert.equal(f.session().records.revision, revision);
  await assert.rejects(f.call("submission.submit", { ...input, submissionId: "s999" }), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "stale_state");
  const deadline = (await f.state()).task?.deadlineAt;
  assert.ok(deadline);
  f.time(deadline);
  await assert.rejects(f.call("submission.submit", input), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "stale_state");
  assert.equal(f.session().records.revision, revision);
  assert.deepEqual(await f.call("submission.get", { submissionId: input.submissionId }), {
    status: "absent", submissionId: input.submissionId, revision,
  });
});

test("写入失败使请求失败并阻止继续追加，重开按真实文件确定写进了什么", async (t) => {
  const root = await directory(t);
  const file = path.join(root, "records.jsonl");
  const log = await LearningRecords.open(file, clock);
  await log.write(() => [{ type: "goal", xp: 30 }]);
  const backup = `${file}.saved`;
  await rename(file, backup);
  await mkdir(file);
  await assert.rejects(log.write(() => [{ type: "goal", xp: 40 }]), { code: "EISDIR" });
  assert.equal(log.revision, 1);
  await assert.rejects(log.write(() => [{ type: "goal", xp: 50 }]), fault("learning_log_blocked"));
  await log.close();
  await rm(file, { recursive: true });
  await rename(backup, file);
  const reopened = await LearningRecords.open(file, clock);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.facts.map((fact) => fact.type === "goal" && fact.xp), [30]);
  assert.equal((await reopened.write(() => [{ type: "goal", xp: 60 }]))[0]?.seq, 2);
});

test("恢复命令保留残缺原文件并写出逐字节前缀，完整坏行和活动空间均拒绝", { timeout: 30_000 }, async (t) => {
  const root = await directory(t);
  const space = await createSpace(path.join(root, "space"), { watch: false });
  const file = path.join(await space.pluginDataDir("learning"), "records.jsonl");
  const log = await LearningRecords.open(file, clock);
  await log.write(() => [{ type: "task", kind: "lesson", topics: ["py01"] }, { type: "delivered", task: 1, question: "py01.k1.q1", seed: 1 }]);
  await log.close();
  const destination = path.join(root, "recovered.jsonl");
  t.after(() => space.close());
  await assert.rejects(exec(process.execPath, ["--import", "tsx", cli, "recover-log", space.root, destination]));
  await space.close();
  const prefix = await readFile(file);
  await appendFile(file, Buffer.from('{"seq":3,"残缺":"中文').subarray(0, -1));
  const original = await readFile(file);
  const partial = await LearningRecords.open(file, clock);
  assert.equal(partial.incompleteTail, true);
  assert.equal(partial.revision, 2);
  await assert.rejects(partial.write(() => [{ type: "goal", xp: 20 }]), fault("learning_log_blocked"));
  await partial.close();
  await exec(process.execPath, ["--import", "tsx", cli, "recover-log", space.root, destination]);
  assert.deepEqual(await readFile(file), original);
  assert.deepEqual(await readFile(destination), prefix);
  const recovered = await LearningRecords.open(destination, clock);
  assert.equal((await recovered.write(() => [{ type: "goal", xp: 20 }]))[0]?.seq, 3);
  await recovered.close();
  await writeFile(file, Buffer.concat([prefix, Buffer.from("{}\n")]));
  await assert.rejects(LearningRecords.open(file), fault("invalid_learning_log"));
  await assert.rejects(exec(process.execPath, ["--import", "tsx", cli, "recover-log", space.root, path.join(root, "bad.jsonl")]));
});

test("引用错误和一题两答在写入前拒绝、不落盘；完整行引用损坏时停止重放", async (t) => {
  const root = await directory(t);
  const file = path.join(root, "records.jsonl");
  const log = await LearningRecords.open(file, clock);
  t.after(() => log.close());
  const seen = `sha256:${"0".repeat(64)}`;
  await log.write(() => [{ type: "task", kind: "lesson", topics: ["py01"] }, { type: "delivered", task: 1, question: "py01.k1.q1", seed: 1 }]);
  const bytes = await readFile(file);
  await assert.rejects(log.write(() => [{ type: "graded", delivery: 2, version: seen, verdict: "correct", slots: {} }]), fault("invalid_learning_log"));
  await assert.rejects(log.write(() => [
    { type: "answered", delivery: 2, seen, answers: {} },
    { type: "answered", delivery: 2, seen, answers: {} },
  ]), fault("invalid_learning_log"));
  await assert.rejects(log.write(() => [{ type: "delivered", task: 2, question: "py01.k1.q1", seed: 1 }]), fault("invalid_learning_log"));
  assert.deepEqual(await readFile(file), bytes);
  assert.equal(log.revision, 2);
  const damaged = path.join(root, "damaged.jsonl");
  await writeFile(damaged, `${bytes.toString("utf8")}${JSON.stringify({ seq: 3, at: now, type: "help", delivery: 1 })}\n`);
  await assert.rejects(LearningRecords.open(damaged), fault("invalid_learning_log"));
});

test("读取忽略事实顶层新增的可选字段，保留盘上原字节，写入仍拒绝未知字段", async (t) => {
  const root = await directory(t);
  const file = path.join(root, "records.jsonl");
  const log = await LearningRecords.open(file, clock);
  await log.write(() => [{ type: "task", kind: "lesson", topics: ["py01"] }, { type: "goal", xp: 25 }]);
  await log.close();
  const original = await readFile(file, "utf8");
  const extended = original.split("\n").filter(Boolean).map((line) => {
    const record: unknown = JSON.parse(line);
    assert.ok(record !== null && typeof record === "object");
    return JSON.stringify({ ...record, futureOptional: { note: "旧版本可忽略" } });
  }).join("\n") + "\n";
  await writeFile(file, extended);
  const reopened = await LearningRecords.open(file, clock);
  t.after(() => reopened.close());
  assert.equal(reopened.facts.some((fact) => "futureOptional" in fact), false);
  assert.deepEqual(reopened.facts.map((fact) => fact.type), ["task", "goal"]);
  assert.equal(await readFile(file, "utf8"), extended);
  await assert.rejects(reopened.write(() => [{ type: "goal", xp: 30, futureOptional: true } as never]), fault("invalid_input"));
});

test("插件经真实宿主重开：课程覆盖进历史，撤回文件不撤作答，查询不启动模型", { timeout: 30_000 }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-learning-host-")));
  const bundled = path.join(root, "course");
  await mkdir(path.join(bundled, "topics"), { recursive: true });
  const original = testTopic("t01");
  await writeFile(path.join(bundled, "course.yaml"), stringify({ ...course, id: "test", topics: ["t01"] }));
  await writeFile(path.join(bundled, "topics", "t01.yaml"), stringify(original, { aliasDuplicateObjects: false }));
  let space = await createSpace(path.join(root, "space"), { watch: false });
  const models = new ModelTestDriver();
  const events: unknown[] = [];
  let session: LearningSession | undefined;
  const overlay = "courses/t01.json";
  const sources = [{ kind: "bundled" as const, directory: bundled }, { kind: "overlay" as const, file: overlay }];
  await space.files.write(overlay, JSON.stringify({ courseId: "test", basedOn: course.version, topic: { ...original, title: "空间覆盖标题" } }));
  await space.flush();
  const plugin = createLearningPlugin({ sources, now: () => start, async connect(opened) {
    session = opened;
    return connectLearning(opened);
  } });
  const caller = { capabilities: { interaction: { supports: ["slot.text", "block.markdown"] }, services: [] } };
  let host = await openPluginHost({ space, plugins: [plugin], models, emit: (_id, event) => events.push(event), onError: (error) => { throw error; } });
  t.after(async () => {
    try {
      await host.close();
      await space.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const call = (method: string, input: unknown) => host.call("learning", method, input, caller);
  const state = async () => (await call("state.get", {})) as LearningState;
  const menu = (await state()).menu;
  assert.ok(menu?.candidates[0]);
  assert.equal(menu.candidates[0].title, "空间覆盖标题");
  await call("menu.select", { menuId: menu.menuId, candidateId: menu.candidates[0].id });
  for (let step = 0; step < 2; step++) {
    const current = await state();
    assert.ok(current.task);
    await call("task.advance", { taskId: current.task.taskId, expectedRevision: current.revision, expectedStage: current.task.phase.stage });
  }
  const task = (await state()).task;
  const delivery = task?.deliveries[0];
  assert.ok(task && delivery);
  const input = {
    taskId: task.taskId, deliveryId: delivery.deliveryId, submissionId: delivery.submissionId,
    response: { item: { id: delivery.item.id, version: delivery.item.version }, answers: { answer: { type: "text", text: "2" } } },
  };
  const beforeAnswer = await space.history.list();
  const eventsBefore = events.length;
  await call("submission.submit", input);
  assert.deepEqual(await space.history.list(), beforeAnswer);
  assert.equal(events.length, eventsBefore + 2);
  const result = await call("submission.get", { submissionId: input.submissionId });
  assert.ok(JSON.stringify(result).includes('"completed"'));
  assert.equal(models.calls.length, 0);
  const student = (await session?.view())?.student;
  await space.files.write(overlay, JSON.stringify({ courseId: "test", basedOn: course.version, topic: { ...original, title: "修订后的覆盖标题" } }));
  await space.flush();
  await host.close();
  await space.close();
  space = await openSpace(path.join(root, "space"), { watch: false });
  host = await openPluginHost({ space, plugins: [plugin], models, emit: () => {}, onError: (error) => { throw error; } });
  assert.equal(session?.course.topics.get("t01")?.title, "修订后的覆盖标题");
  assert.deepEqual((await session?.view())?.student, student);
  const reopened = await call("submission.get", { submissionId: input.submissionId });
  assert.deepEqual(reopened, result);
  assert.equal(models.calls.length, 0);
  await space.files.write("note.md", "撤回这次文件改动");
  await space.flush();
  const revision = (await space.history.list()).find((entry) => entry.parent !== null);
  assert.ok(revision);
  await space.history.undo(revision.id);
  assert.deepEqual(await call("submission.get", { submissionId: input.submissionId }), reopened);
});

test("覆盖层拒绝版本不符和多重来源，更新与选择只保留直接复习", async () => {
  const bundled = { kind: "bundled" as const, directory: fileURLToPath(new URL("../courses/python/", import.meta.url)) };
  const files = { read: async () => JSON.stringify({ courseId: "python", basedOn: "999.0.0", topic }), write: async () => {}, list: async () => [] };
  await assert.rejects(loadCourseSources([bundled, { kind: "overlay", file: "topic.json" }], files), fault("course_version_conflict"));
  await assert.rejects(loadCourseSources([bundled, bundled], files), fault("ambiguous_course_source"));
  const initial = updateStudent(graph, {}, { topicId: "py01", outcome: "pass" }, now);
  const advanced = updateStudent(graph, initial, { topicId: "py02", outcome: "pass" }, now + 86_400_000);
  assert.deepEqual(advanced.py01, initial.py01);
  const failed = updateStudent(graph, advanced, { topicId: "py01", outcome: "fail" }, now + 2 * 86_400_000);
  assert.deepEqual(failed.py02, advanced.py02);
  assert.ok(chooseTasks(graph, advanced, now + 2 * 86_400_000).some((entry) => entry.topicId === "py01"));
  assert.throws(() => updateStudent(graph, advanced, { topicId: "py01", outcome: "pass" }, now - 1), fault("model_time_conflict"));
  assert.equal(await contentVersion({ b: 2, a: 1 }), await contentVersion({ a: 1, b: 2 }));
  assert.throws(() => chooseTasks(graph, advanced, now - 1), fault("model_time_conflict"));
});
