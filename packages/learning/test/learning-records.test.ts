import assert from "node:assert/strict";
import { fork, execFile } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { createSpace, openPluginHost, openSpace, RepaFault } from "@repa/base";
import { ModelTestDriver } from "@repa/base/testing";
import { DEFAULT_MODEL_CONFIG } from "@repa/learning-model";
import { contentVersion } from "@repa/base/protocol";
import { LearningRecords } from "../src/records.js";
import { createLearningPlugin } from "../src/plugin.js";
import { loadCourseSources } from "../src/course-sources.js";
import { chooseTasks, updateStudent } from "../src/student-model.js";
import { advance, answer, clock, graph, judged, setup, topic } from "./fixtures/learning-records.js";
import { now, page } from "./fixtures/learning-contract.js";

const exec = promisify(execFile);
const fault = (code: string) => (error: unknown) => error instanceof RepaFault && error.code === code;
async function directory(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-learning-records-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function fixture(t: TestContext) {
  const root = await directory(t);
  const file = path.join(root, "records.jsonl");
  const log = await LearningRecords.open(file, clock);
  t.after(() => log.close());
  await setup(log);
  return { root, file, log, input: answer(log) };
}

for (const stage of ["accepted", "returned", "persisted"]) {
  test(`在 ${stage} 边界杀进程，重放和显式恢复保留唯一原答与唯一推进`, { timeout: 30_000 }, async (t) => {
    const root = await directory(t);
    const file = path.join(root, "records.jsonl");
    const child = fork(new URL("./fixtures/learning-crash.ts", import.meta.url), [file, stage], {
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
    const records = await LearningRecords.open(file, clock);
    t.after(() => records.close());
    const input = answer(records);
    const submission = records.submission(input.submissionId);
    assert.ok(submission);
    assert.deepEqual(submission.response, input.response);
    assert.equal(records.records.filter((record) => record.type === "accepted").length, 1);
    assert.equal(submission.processing.status, stage === "persisted" ? "completed" : "interrupted");
    if (stage !== "persisted") {
      assert.deepEqual(submission.processing, { status: "interrupted", reason: "restart" });
      assert.equal(records.current()?.state.task?.phase.stage, "recovery");
    }
    assert.deepEqual(await readFile(file), before);
    assert.deepEqual(await records.submit(input), { status: "recorded", submission });
    await assert.rejects(records.submit(answer(records, "3")), fault("submission_conflict"));
    let calls = 0;
    const judge = async (entry: typeof submission) => {
      calls++;
      return judged(entry);
    };
    const results = await Promise.all([
      records.grade(input.submissionId, judge, advance),
      records.grade(input.submissionId, judge, advance),
    ]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(calls, stage === "persisted" ? 0 : 1);
    assert.equal(records.current()?.state.task?.kps[0]?.attempts, 1);
    assert.equal(records.records.filter((record) => record.type === "graded").length, 1);
    assert.equal(records.records.filter((record) => record.type === "accepted").length, 1);
    assert.equal(records.submission(input.submissionId)?.gradeRevision, 1);
  });
}

test("同载荷并发提交只接受一次，判分等待释放入口，失败后沿原身份继续", async (t) => {
  const { log, input, file } = await fixture(t);
  const receipts = await Promise.all([log.submit(input), log.submit(input)]);
  assert.deepEqual(receipts[0], receipts[1]);
  assert.equal(log.records.filter((record) => record.type === "accepted").length, 1);
  let release: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let started: (() => void) | undefined;
  const requested = new Promise<void>((resolve) => { started = resolve; });
  const work = log.grade(input.submissionId, async () => {
    started?.();
    await barrier;
    throw new Error("服务断线");
  }, advance);
  const failed = assert.rejects(work, /服务断线/);
  await requested;
  await log.viewed({ taskId: input.taskId, deliveryId: input.deliveryId, action: "help_after", ref: page.ref });
  assert.equal(log.submission(input.submissionId)?.processing.status, "accepted");
  release?.();
  await failed;
  assert.equal(log.records.some((record) => record.type === "graded"), false);
  await log.grade(input.submissionId, async (entry) => judged(entry), advance);
  const completed = log.current();
  await log.close();
  const reopened = await LearningRecords.open(file, clock);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.current(), completed);
  assert.deepEqual(reopened.records.find((record) => record.type === "accepted")?.type, "accepted");
});

test("结构拒绝、错身份与截止后新答不落盘，已接受的重交仍可查询", async (t) => {
  const { log, input } = await fixture(t);
  const revision = log.revision;
  const bad = await log.submit({ ...input, response: { ...input.response, answers: {} } });
  assert.equal(bad.status, "rejected");
  assert.equal(log.revision, revision);
  await assert.rejects(log.submit({ ...input, submissionId: "another" }), fault("stale_state"));
  await log.checkpoint(log.revision, (current, decisionNow) => {
    assert.ok(current?.state.task);
    current.state.task.deadlineAt = clock();
    return { projection: current, decision: { policyVersion: "deadline", now: decisionNow, seed: 1, candidates: [], selected: null, scores: {} } };
  });
  await assert.rejects(log.submit(input), fault("stale_state"));
  assert.equal(log.submission(input.submissionId), undefined);
});

test("写入失败使请求失败并阻止继续追加，重开按真实文件确定是否接受", async (t) => {
  const { log, input, file } = await fixture(t);
  const backup = `${file}.saved`;
  await rename(file, backup);
  await mkdir(file);
  await assert.rejects(log.submit(input), { code: "EISDIR" });
  assert.equal(log.submission(input.submissionId), undefined);
  await assert.rejects(log.submit(input), fault("learning_log_blocked"));
  await log.close();
  await rm(file, { recursive: true });
  await rename(backup, file);
  const reopened = await LearningRecords.open(file, clock);
  t.after(() => reopened.close());
  assert.equal(reopened.submission(input.submissionId), undefined);
  assert.equal((await reopened.submit(input)).status, "recorded");
});

test("恢复命令保留残缺原文件并写出逐字节前缀，完整坏行和活动空间均拒绝", { timeout: 30_000 }, async (t) => {
  const root = await directory(t);
  const space = await createSpace(path.join(root, "space"), { watch: false });
  const file = path.join(await space.pluginDataDir("learning"), "records.jsonl");
  const log = await LearningRecords.open(file, clock);
  await setup(log);
  const input = answer(log);
  await log.submit(input);
  await log.close();
  const cli = new URL("../src/cli.ts", import.meta.url);
  const destination = path.join(root, "recovered.jsonl");
  t.after(() => space.close());
  await assert.rejects(exec(process.execPath, ["--import", "tsx", cli.pathname, "recover-log", space.root, destination]));
  await space.close();
  const prefix = await readFile(file);
  await appendFile(file, Buffer.from('{"v":1,"残缺":"中文').subarray(0, -1));
  const original = await readFile(file);
  const partial = await LearningRecords.open(file, clock);
  assert.equal(partial.incompleteTail, true);
  assert.ok(partial.submission(input.submissionId));
  await assert.rejects(partial.viewed({ taskId: input.taskId, action: "kp", ref: page.ref }), fault("learning_log_blocked"));
  await partial.close();
  await exec(process.execPath, ["--import", "tsx", cli.pathname, "recover-log", space.root, destination]);
  assert.deepEqual(await readFile(file), original);
  assert.deepEqual(await readFile(destination), prefix);
  const recovered = await LearningRecords.open(destination, clock);
  await recovered.grade(input.submissionId, async (entry) => judged(entry), advance);
  assert.equal(recovered.submission(input.submissionId)?.processing.status, "completed");
  await recovered.close();
  await writeFile(file, Buffer.concat([prefix, Buffer.from("{}\n")]));
  await assert.rejects(LearningRecords.open(file), fault("invalid_learning_log"));
  await assert.rejects(exec(process.execPath, ["--import", "tsx", cli.pathname, "recover-log", space.root, path.join(root, "bad.jsonl")]));
});

test("快照按摘要只存一次，旧题与服务端时间、帮助和模型事前状态一同保留", async (t) => {
  const { log, file, input } = await fixture(t);
  const snapshotRecord = log.records.find((record) => record.type === "snapshot");
  assert.ok(snapshotRecord?.type === "snapshot");
  assert.equal(await log.saveSnapshot(snapshotRecord.snapshot), snapshotRecord.digest);
  assert.equal(log.records.filter((record) => record.type === "snapshot").length, 1);
  const copy = log.snapshot(snapshotRecord.digest);
  assert.ok(copy);
  copy.topic.title = "以后修改的课程";
  assert.notEqual(log.snapshot(snapshotRecord.digest)?.topic.title, copy.topic.title);
  await log.viewed({ taskId: input.taskId, deliveryId: input.deliveryId, action: "help_before", ref: page.ref });
  await log.submit(input);
  const accepted = log.records.find((record) => record.type === "accepted");
  assert.ok(accepted?.type === "accepted");
  assert.equal(accepted.submission.processing.status, "accepted");
  assert.equal(accepted.context.submittedAt, clock());
  assert.deepEqual(accepted.context.model.before, log.current()?.student);
  assert.deepEqual(accepted.context.model.config, DEFAULT_MODEL_CONFIG);
  assert.equal(accepted.context.helpBefore.length, 1);
  assert.equal(accepted.context.submitOffsetMs, 0);
  await log.close();
  const reopened = await LearningRecords.open(file, clock);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.snapshot(snapshotRecord.digest), snapshotRecord.snapshot);
  assert.deepEqual(reopened.records.find((record) => record.type === "accepted"), accepted);
});

test("插件经真实宿主重开，课程覆盖进历史、撤回不撤作答且查询不启动模型", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-learning-host-"));
  let space = await createSpace(path.join(root, "space"), { watch: false });
  const models = new ModelTestDriver();
  const events: unknown[] = [];
  let records: LearningRecords | undefined;
  const sources = [
    { kind: "bundled" as const, directory: new URL("../courses/python/", import.meta.url).pathname },
    { kind: "overlay" as const, file: "courses/py01.json" },
  ] as const;
  const bundled = await loadCourseSources([sources[0]], space.files);
  assert.equal(bundled.topics.length, 48);
  const originalTopic = bundled.topics[0];
  assert.ok(originalTopic);
  const modified = { ...originalTopic, title: "空间覆盖标题" };
  await space.files.write(sources[1].file, JSON.stringify({ courseId: bundled.course.id, basedOn: bundled.course.version, topic: modified }));
  await space.flush();
  const loadedVersions: unknown[] = [];
  const plugin = createLearningPlugin({ sources: [...sources], async connect(log, resolved) {
    records = log;
    loadedVersions.push({ topic: resolved.topics[0], origin: resolved.origins[modified.id] });
    if (!log.current()) await setup(log, resolved);
    return {};
  } });
  let host = await openPluginHost({ space, plugins: [plugin], models, emit: (_id, event) => events.push(event), onError: (error) => { throw error; } });
  t.after(async () => {
    try {
      await host.close();
      await space.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  assert.ok(records);
  const input = answer(records);
  const beforeAnswer = await space.history.list();
  await host.call("learning", "submission.submit", input);
  assert.deepEqual(await space.history.list(), beforeAnswer);
  const result = await host.call("learning", "submission.get", { submissionId: input.submissionId });
  assert.ok(JSON.stringify(result).includes('"accepted"'));
  assert.equal(models.calls.length, 0);
  assert.equal(events.length, 1);
  const projection = records.current();
  const snapshotId = projection?.deliveries[input.deliveryId];
  assert.ok(snapshotId);
  const frozen = records.snapshot(snapshotId);
  await space.files.write(sources[1].file, JSON.stringify({ courseId: bundled.course.id, basedOn: bundled.course.version, topic: { ...modified, title: "修订后的覆盖标题" } }));
  await space.flush();
  await host.close();
  await space.close();
  space = await openSpace(path.join(root, "space"), { watch: false });
  host = await openPluginHost({ space, plugins: [plugin], models, emit: () => {}, onError: (error) => { throw error; } });
  assert.equal(loadedVersions.length, 2);
  assert.deepEqual(records.snapshot(snapshotId), frozen);
  const after = await loadCourseSources([...sources], space.files);
  assert.equal(after.topics[0]?.title, "修订后的覆盖标题");
  assert.deepEqual(after.origins[modified.id], { source: sources[1].file, basedOn: bundled.course.version });
  assert.deepEqual(records.current()?.student, projection?.student);
  assert.equal(records.current()?.state.task?.phase.stage, "recovery");
  const reopenedResult = await host.call("learning", "submission.get", { submissionId: input.submissionId });
  assert.ok(JSON.stringify(reopenedResult).includes('"restart"'));
  assert.equal(models.calls.length, 0);
  await space.files.write("note.md", "撤回这次文件改动");
  await space.flush();
  const revision = (await space.history.list()).find((entry) => entry.parent !== null);
  assert.ok(revision);
  await space.history.undo(revision.id);
  assert.ok(records.submission(input.submissionId));
});

test("覆盖层拒绝版本不符和多重来源，更新与选择只保留直接复习", async () => {
  const bundled = { kind: "bundled" as const, directory: new URL("../courses/python/", import.meta.url).pathname };
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

test("待判时保存任务并重开，原始接受记录不被恢复显示覆盖", async (t) => {
  const { log, file, input } = await fixture(t);
  await log.submit(input);
  const save = async (records: LearningRecords) => records.checkpoint(records.revision, (current, decisionNow) => {
    assert.ok(current);
    return { projection: current, decision: { policyVersion: "saved", now: decisionNow, seed: 1, candidates: [], selected: null, scores: {} } };
  });
  await save(log);
  await log.close();
  const reopened = await LearningRecords.open(file, clock);
  assert.equal(reopened.submission(input.submissionId)?.processing.status, "interrupted");
  await save(reopened);
  await reopened.close();
  const second = await LearningRecords.open(file, clock);
  t.after(() => second.close());
  assert.equal(second.current()?.state.task?.phase.stage, "recovery");
  await second.grade(input.submissionId, async (entry) => judged(entry), advance);
  const accepted = second.records.find((record) => record.type === "accepted");
  assert.ok(accepted?.type === "accepted");
  assert.equal(accepted.submission.processing.status, "accepted");
});

test("替换已交付题面、伪造原答和未完成判分均不能推进，完整行语义损坏停止重放", async (t) => {
  const { log, file, input, root } = await fixture(t);
  const save = (change: (projection: NonNullable<ReturnType<LearningRecords["current"]>>) => void) => log.checkpoint(log.revision, (current, decisionNow) => {
    assert.ok(current);
    change(current);
    return { projection: current, decision: { policyVersion: "bad", now: decisionNow, seed: 1, candidates: [], selected: null, scores: {} } };
  });
  const original = await readFile(file);
  await assert.rejects(save((projection) => {
    const delivery = projection.state.task?.deliveries[0];
    assert.ok(delivery);
    delivery.item.body = [{ type: "markdown", text: "换掉原题" }];
  }), fault("invalid_learning_log"));
  await log.submit(input);
  await assert.rejects(save((projection) => {
    assert.ok(projection.state.task);
    projection.state.task.submissions = [];
  }), fault("invalid_learning_log"));
  await assert.rejects(log.grade(input.submissionId, async (entry) => ({ ...judged(entry), feedback: { item: entry.response.item, verdict: "pending" } }), advance), fault("invalid_grade"));
  assert.equal(log.current()?.state.task?.kps[0]?.attempts, 0);
  const first = log.records[0];
  assert.ok(first?.type === "snapshot");
  first.snapshot.topic.title = "损坏但仍是完整 JSON";
  const damaged = path.join(root, "damaged.jsonl");
  await writeFile(damaged, `${JSON.stringify(first)}\n${original.toString("utf8")}`);
  await assert.rejects(LearningRecords.open(damaged), fault("invalid_learning_log"));
});

test("采用判分可先私有保存，再由任务保存释放同一反馈，重开保持释放结果", async (t) => {
  const { log, file, input } = await fixture(t);
  await log.submit(input);
  await log.grade(input.submissionId, async (entry) => judged(entry), (current, submission, grade) => {
    const next = advance(current, submission, grade);
    const result = next.state.task?.submissions[0];
    assert.ok(result);
    delete result.feedback;
    return next;
  });
  assert.equal(log.submission(input.submissionId)?.feedback, undefined);
  await log.checkpoint(log.revision, (current, decisionNow) => {
    const result = current?.state.task?.submissions[0];
    assert.ok(current && result);
    result.feedback = judged(result).feedback;
    result.explanation = [{ type: "markdown", text: "现在释放解析。" }];
    return { projection: current, decision: { policyVersion: "release", now: decisionNow, seed: 1, candidates: [], selected: null, scores: {} } };
  });
  const released = log.submission(input.submissionId);
  await log.close();
  const reopened = await LearningRecords.open(file, clock);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.submission(input.submissionId), released);
  const original = reopened.records.find((record) => record.type === "graded");
  assert.ok(original?.type === "graded");
  assert.equal(original.projection.state.task?.submissions[0]?.feedback, undefined);
  assert.equal(original.grade.feedback.verdict, "correct");
});
