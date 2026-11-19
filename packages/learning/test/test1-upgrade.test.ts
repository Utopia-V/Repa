/**
 * 首次用记录课程结构的版本打开测试版 v0.1.0-test.1 的空间：先等一次备份成功，再在学习记录末尾追加旧日志基线，原有的行逐字节不动；
 * 基线记下测试版当时用来解释整段日志的那一份结构。读数与测试版相同由 test1-fixtures.test.ts 核对，这里核对基线本身和几种故障。
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, cp, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openPluginHost, openSpace } from "@repa/base";
import { INTERACTION_CAPABILITIES } from "@repa/base/protocol";
import { ModelTestDriver } from "@repa/base/testing";
import { StructureIndex } from "../src/course-structure.js";
import { emptyFold, foldTask, taskEvidence } from "../src/flow-state.js";
import { connectLearning } from "../src/flow.js";
import { createLearningPlugin } from "../src/plugin.js";
import type { LearningState } from "../src/protocol.js";
import type { Fact } from "../src/records-schema.js";
import { LearningRecords, recoverLearningLog } from "../src/records.js";
import { EMPTY_STRUCTURE, Replay } from "../src/replay.js";
import { recordedLegacy, type LearningSession } from "../src/session.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/test1/", import.meta.url));
const LOG = path.join(".repa", "plugins", "learning", "records.jsonl");
const capabilities = { interaction: { supports: [...INTERACTION_CAPABILITIES] }, services: [] };

/** 测试版的五个空间与丁换课前的快照，以及测试版当时解释它们用的课程。 */
const SPACES = [
  { source: "home/Repa/操作系统 走查", course: "verify-walk" },
  { source: "home/Repa/操作系统 复习", course: "os-review" },
  { source: "home/Repa/Python 入门", course: "python" },
  { source: "home/Repa/先学 Python 再学进程", course: "os-basics" },
  { source: "home/Repa/Python 测验", course: "python" },
  { source: "snapshots/先学 Python 再学进程/python-only", course: "python" },
];

/** 把固定数据里的一个空间复制到临时目录，经真实的插件宿主打开学习插件。backup 是宿主的备份；时钟停在最后一条事实之后一分钟。 */
async function fixture(t: TestContext, source: string, backup: () => Promise<void> = async () => {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-test1-upgrade-")));
  const root = path.join(directory, path.basename(source));
  await cp(path.join(FIXTURE, source), root, { recursive: true });
  const original = await readFile(path.join(root, LOG));
  const lines = original.toString("utf8").split("\n").filter(Boolean);
  const last = (JSON.parse(lines.at(-1) ?? "{}") as Fact).at;
  let now = last + 60_000;
  let session: LearningSession | undefined;
  const plugin = createLearningPlugin({ connect: async (opened) => { session = opened; return connectLearning(opened); } });
  let space: Awaited<ReturnType<typeof openSpace>> | undefined;
  let host: Awaited<ReturnType<typeof openPluginHost>> | undefined;
  const close = async () => {
    await host?.close();
    await space?.close();
    host = undefined;
    space = undefined;
  };
  const open = async () => {
    await close();
    session = undefined;
    space = await openSpace(root, { watch: false });
    host = await openPluginHost({ space, plugins: [plugin], now: () => now, models: new ModelTestDriver(), backup, emit: () => {}, onError: () => {} });
    return host;
  };
  t.after(async () => {
    await close();
    await rm(directory, { recursive: true, force: true });
  });
  const log = () => readFile(path.join(root, LOG));
  const facts = async () => (await log()).toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Fact);
  const state = async () => (await host?.call("learning", "state.get", {}, { capabilities })) as LearningState;
  /** 只留学习记录的前 count 行。 */
  const truncate = (count: number) => writeFile(path.join(root, LOG), lines.slice(0, count).map((line) => `${line}\n`).join(""));
  return {
    root, original, lines, open, close, log, facts, state, truncate,
    marker: async () => JSON.parse(await readFile(path.join(root, ".repa", "plugins", "learning", "format.json"), "utf8")) as unknown, session: () => session, host: () => host,
    /** 宿主的时钟停在 at。 */
    clock: (at: number) => { now = at; },
  };
}

for (const space of SPACES) {
  test(`测试版数据 ${space.source}：先备份，再追加一条基线，原有的行逐字节不动；基线是 ${space.course} 的结构，重开不再写`, async (t) => {
    const order: string[] = [];
    const f = await fixture(t, space.source, async () => { order.push(`备份时 ${(await f.log()).length} 字节`); });
    const host = await f.open();
    assert.deepEqual(host.disabled(), []);
    const after = await f.log();
    assert.deepEqual(after.subarray(0, f.original.length), f.original);
    assert.deepEqual(order, [`备份时 ${f.original.length} 字节`]);
    const facts = await f.facts();
    assert.equal(facts.length, f.lines.length + 1);
    const baseline = facts.at(-1);
    assert.ok(baseline?.type === "baseline");
    assert.equal(baseline.rules, "test1");
    assert.equal(baseline.structure?.course.id, space.course);
    assert.deepEqual(await f.marker(), { version: 4 });
    await f.open();
    assert.deepEqual(await f.log(), after);
    assert.equal(order.length, 1);
  });
}

test("升级前的备份失败：只停用学习插件并说明原因，学习记录一个字节也不改", async (t) => {
  const f = await fixture(t, "home/Repa/Python 入门", async () => { throw new Error("磁盘已满"); });
  const host = await f.open();
  const disabled = host.disabled();
  assert.equal(disabled.length, 1);
  assert.match(JSON.stringify(disabled[0]), /backup_failed/u);
  assert.match(JSON.stringify(disabled[0]), /磁盘已满/u);
  assert.deepEqual(await f.log(), f.original);
  assert.deepEqual(await f.marker(), { version: 3 });
});

test("旧日志末尾本来有半行：不写基线，完整的部分照测试版读出，开始新任务报 learning_log_blocked，文件不动", async (t) => {
  const f = await fixture(t, "home/Repa/Python 入门");
  await appendFile(path.join(f.root, LOG), "{\"seq\":104,\"at\":");
  const before = await f.log();
  const host = await f.open();
  assert.deepEqual(host.disabled(), []);
  const state = await f.state();
  assert.equal(state.revision, f.lines.length);
  const candidate = state.menu?.candidates[0];
  assert.ok(state.menu && candidate);
  await assert.rejects(host.call("learning", "menu.select", { menuId: state.menu.menuId, candidateId: candidate.id }, { capabilities }), { code: "learning_log_blocked" });
  assert.deepEqual(await f.log(), before);
  assert.deepEqual(await f.marker(), { version: 3 });
});

test("写基线时中断（基线只写了半行）：重开与日志本来有半行时相同；按恢复命令截掉半行以后，再打开重新写下完整的基线", async (t) => {
  const f = await fixture(t, "home/Repa/操作系统 走查");
  await f.open();
  const written = await f.log();
  const baseline = written.subarray(f.original.length);
  await f.close();
  // 断电时只落盘了基线的前一半。
  const file = path.join(f.root, LOG);
  await rm(file);
  await appendFile(file, Buffer.concat([f.original, baseline.subarray(0, Math.floor(baseline.length / 2))]));
  await f.open();
  assert.equal((await f.state()).revision, f.lines.length);
  assert.equal(f.session()?.records.baseline, undefined);
  await f.close();
  const recovered = path.join(f.root, `${randomUUID()}.jsonl`);
  await recoverLearningLog(file, recovered);
  await rename(recovered, file);
  assert.deepEqual(await f.log(), f.original);
  await f.open();
  assert.deepEqual(await f.log(), written);
});

test("只留 records.jsonl、移走课程文件以后，历史的结论、每笔 XP 与学生模型照样由学习记录算出", async (t) => {
  const f = await fixture(t, "home/Repa/先学 Python 再学进程");
  await f.open();
  const session = f.session();
  assert.ok(session);
  session.replay.settle(Date.now());
  const expected = history(session.replay);
  await f.close();
  // 只有学习记录：基线与结构事实里有计算所需的全部结构，当前的课用不着（它只决定新测验从哪里选题）。
  const records = await LearningRecords.open(path.join(f.root, LOG));
  const legacy = recordedLegacy(records);
  assert.ok(legacy && legacy.structure !== EMPTY_STRUCTURE);
  const replay = new Replay(EMPTY_STRUCTURE, undefined, legacy);
  for (const fact of records.facts) replay.apply(fact);
  replay.settle(Date.now());
  assert.deepEqual(history(replay), expected);
  assert.ok(expected.awards.length > 0 && Object.keys(expected.student).length > 0);
});

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

/** 换用要先运行课里的 Python 核对；测试里没有应用页面，只有 Linux 沙箱能运行。 */
const NEEDS_SANDBOX = { skip: process.platform === "linux" ? false : "换用要运行课里的 Python 核对，测试里只有 Linux 沙箱能运行" };

test("空间里有还没换用的 course/、随包课没有做到一半的任务：测试版不显示任何一门课，基线不带结构，升级以后同样没有可学的课；之后首次换用自制课，随包课那段成绩不补进 XP", NEEDS_SANDBOX, async (t) => {
  const f = await fixture(t, "snapshots/先学 Python 再学进程/python-only");
  await cp(path.join(FIXTURE, "home/Repa/先学 Python 再学进程/course"), path.join(f.root, "course"), { recursive: true });
  await f.open();
  const baseline = (await f.facts()).at(-1);
  assert.ok(baseline?.type === "baseline");
  assert.equal(baseline.structure, undefined);
  const state = await f.state();
  assert.equal(state.course, null);
  assert.equal(state.progress.totalXp, 0);
  assert.equal(state.started, true);
  const use = f.host()?.tools().find((tool) => tool.name === "course_use");
  assert.ok(use);
  const used = await use.execute({}, { signal: new AbortController().signal, callId: randomUUID() });
  assert.match(used.text, /^已换用/u);
  const switched = await f.state();
  assert.equal(switched.course?.id, "os-basics");
  assert.equal(switched.progress.totalXp, 0);
  assert.deepEqual(f.session()?.replay.awards, []);
});

test("基线之前的任务按基线的结构算，不随当前的课变：同一份记录换一个没有这些 topic 的当前结构，结论与 XP 不变", async (t) => {
  const f = await fixture(t, "home/Repa/Python 入门");
  await f.open();
  const records = f.session()?.records;
  assert.ok(records);
  const legacy = recordedLegacy(records);
  assert.ok(legacy);
  const replay = (current: StructureIndex) => {
    const result = new Replay(current, undefined, legacy);
    for (const fact of records.facts) result.apply(fact);
    return history(result);
  };
  assert.deepEqual(replay(EMPTY_STRUCTURE), replay(legacy.structure));
});

test("冻结的测试版随包课结构没有被改动：摘要与生成时记下的相同，测试版数据里出过的 Python 题都在其中", async () => {
  // Windows 上检出时换行可能变成 CRLF，内容没变：摘要按 LF 的文本算，与生成时记下的一致。
  const text = (await readFile(fileURLToPath(new URL("../legacy/test1-python.json", import.meta.url)), "utf8")).replaceAll("\r\n", "\n");
  assert.equal(createHash("sha256").update(text).digest("hex"), "2789be368efad2f4f28faa05be4a589381961d9140f8db734f43aaaf79ab5906");
  const index = new StructureIndex(JSON.parse(text));
  for (const source of ["home/Repa/Python 入门", "home/Repa/Python 测验"]) {
    const facts = (await readFile(path.join(FIXTURE, source, LOG), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Fact);
    for (const fact of facts) if (fact.type === "delivered") assert.ok(index.questions.has(fact.question), fact.question);
  }
});

test("丁只留第一项任务（Python 的课，换用的是自制课）：经宿主读得出状态，说明页过得了协议校验；中止以后回到菜单", async (t) => {
  const f = await fixture(t, "home/Repa/先学 Python 再学进程");
  const file = path.join(f.root, LOG);
  await writeFile(file, `${f.lines[0]}\n`);
  const host = await f.open();
  const state = await f.state();
  assert.equal(state.task?.phase.stage, "explanation");
  assert.ok(state.task);
  const aborted = await host.call("learning", "task.abort", { taskId: state.task.taskId, expectedRevision: state.revision, expectedStage: "explanation" }, { capabilities }) as LearningState;
  assert.equal(aborted.task?.phase.stage, "aborted");
  assert.ok((aborted.menu?.candidates.length ?? 0) > 0);
});

test("基线不推进学习时钟：戊进行中的测验，先在截止以后打开（写下基线）、再把时钟拨回截止之前打开，测验仍在进行，没有多结算一场超时", async (t) => {
  const f = await fixture(t, "home/Repa/Python 测验");
  await f.truncate(402);
  const last = (JSON.parse(f.lines[401] ?? "{}") as Fact).at;
  f.clock(last + 20 * 60_000);
  await f.open();
  assert.equal((await f.facts()).at(-1)?.type, "baseline");
  f.clock(last + 60_000);
  await f.open();
  const state = await f.state();
  assert.equal(state.task?.kind, "quiz");
  assert.notEqual(state.task?.phase.stage, "completed");
  assert.equal(state.progress.totalXp, 161);
});

test("活动副本读不出时不定基线，换用也拒绝并说明是副本坏了；副本修好以后，基线照旧取原来的课，学过的 XP 都在", NEEDS_SANDBOX, async (t) => {
  const f = await fixture(t, "home/Repa/操作系统 走查");
  const data = path.join(f.root, ".repa", "plugins", "learning");
  const active = (JSON.parse(await readFile(path.join(data, "course.json"), "utf8")) as { active: string }).active;
  const manifest = path.join(data, "courses", active, "course.yaml");
  const saved = await readFile(manifest);
  await rm(manifest);
  // 空间里的 course/ 换成另一门通过检查的课（丁的自制课）。
  await rm(path.join(f.root, "course"), { recursive: true });
  await cp(path.join(FIXTURE, "home/Repa/先学 Python 再学进程/course"), path.join(f.root, "course"), { recursive: true });
  const host = await f.open();
  assert.equal((await f.state()).course, null);
  const use = host.tools().find((tool) => tool.name === "course_use");
  assert.ok(use);
  await assert.rejects(use.execute({}, { signal: new AbortController().signal, callId: randomUUID() }), { code: "course_copy_broken" });
  assert.deepEqual(await f.log(), f.original);
  assert.equal((JSON.parse(await readFile(path.join(data, "course.json"), "utf8")) as { active: string }).active, active);
  await f.close();
  await writeFile(manifest, saved);
  await f.open();
  const baseline = (await f.facts()).at(-1);
  assert.ok(baseline?.type === "baseline");
  assert.equal(baseline.structure?.course.id, "verify-walk");
  assert.ok((await f.state()).progress.totalXp > 0);
});
