/**
 * 测试版固定数据（test/fixtures/test1/）的读数：在给定时刻打开一个空间，取学习插件给出的结果和学习状态，
 * 存成按含义命名、与协议形状无关的字段。标准答案是 v0.1.0-test.1 的代码运行这一份文件得出的；
 * test1-fixtures.test.ts 用现在的代码运行它，逐项比较。
 *
 * 读数有两个来源：插件方法的返回值（state.get、progress.get、building.get、settings.get，调用方的能力与桌面端的 Web 前端相同），
 * 以及方法不直接给出、升级后也不能变的学习状态（每项任务的结论、每笔 XP、学生模型、补救、测验），后者取自学习会话的内部结构。
 * 以后协议或内部结构改了，这里的取法跟着改，标准答案不改。
 *
 * 经 test1-read.ts 以子进程运行：时区要在进程启动时定下，学习插件按进程的时区算本地日期。
 */
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openPluginHost, openSpace, RepaFault } from "@repa/base";
import { ModelTestDriver } from "@repa/base/testing";
import type { ClientCapabilities } from "@repa/base/protocol";
import { connectLearning } from "../../src/flow.js";
import { emptyFold, foldTask, taskEvidence, type TaskEvidence } from "../../src/flow-state.js";
import { STUDENT_MODEL } from "../../src/parameters.js";
import { createLearningPlugin, legacyBaseline, test1Python } from "../../src/plugin.js";
import { CourseStore } from "../../src/space-course.js";
import type { CourseBuilding, LearningState, LearningSettings, Submission } from "../../src/protocol.js";
import { LearningRecords } from "../../src/records.js";
import { LearningSession, needsBaseline } from "../../src/session.js";
import { DAY_MS, topicDue, topicMemory } from "../../src/student-model.js";
import type { Fact } from "../../src/records-schema.js";

/** 取数时前端声明的能力：与 apps/web 的 interactionCapabilities 和 app.tsx 声明的服务相同。 */
export const WEB_CAPABILITIES: ClientCapabilities = {
  interaction: { supports: ["slot.choice", "slot.text", "slot.order", "slot.table", "slot.code", "block.markdown", "block.code", "markdown.math"] },
  services: ["python.run"],
};
/** 取数时进程的时区：试用者在中国。 */
export const TIME_ZONE = "Asia/Shanghai";

/** 把固定数据里的一个空间复制到 target；facts 给出时只留学习记录的前这么多行，即当时盘上的样子（学习记录只追加）。 */
export async function copySpace(source: string, target: string, facts?: number): Promise<void> {
  await cp(source, target, { recursive: true });
  if (facts !== undefined) {
    const file = path.join(target, ".repa", "plugins", "learning", "records.jsonl");
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    if (lines.length < facts) throw new Error(`学习记录只有 ${lines.length} 行，不够 ${facts} 行`);
    await writeFile(file, lines.slice(0, facts).map((line) => `${line}\n`).join(""));
  }
}

/** Map 换成按键排序的对象，undefined 去掉，得到可以写成 JSON、可以逐项比较的值。 */
function plain(value: unknown): unknown {
  if (value instanceof Map) {
    return Object.fromEntries([...value.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([key, entry]) => [key, plain(entry)]));
  }
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, plain(entry)]));
  }
  return value;
}

/** 公开编号（t12、d13、s13）里的事实序号。 */
const seqOf = (id: string) => Number(id.slice(1));

/** 每项任务的结论与得出结论的时刻：已结束的任务按重放时的叠加顺序重算证据（与 Replay.before 相同），最后一项取当前证据。 */
function tasks(session: LearningSession) {
  const { replay } = session;
  const evidences: TaskEvidence[] = [];
  let fold = emptyFold();
  for (const task of replay.tasks.slice(0, -1)) {
    const evidence = taskEvidence(task, fold.lessons.get(task.topicIds[0] ?? ""));
    evidences.push(evidence);
    fold = foldTask(fold, evidence, STUDENT_MODEL);
  }
  const current = replay.currentEvidence();
  if (current) evidences.push(current);
  return evidences.map(({ task, outcome, at, kps }) => ({
    task: task.seq,
    kind: task.kind,
    topics: task.topicIds,
    selectedAt: task.at,
    // 主动结束（中止或交卷）的时刻；被下一项任务取代的，记下一项开始的时刻。
    endedAt: task.endedAt ?? null,
    supersededAt: task.nextAt ?? null,
    retakes: task.retakes ?? null,
    outcome: outcome ?? null,
    outcomeAt: at,
    kps: kps.map((kp) => ({ kp: kp.kpId, attempts: kp.attempts, consecutiveCorrect: kp.consecutiveCorrect, completed: kp.completed })),
    answers: task.answered.map((delivery) => ({
      delivery: delivery.seq,
      question: delivery.questionId,
      dontKnow: delivery.answer?.dontKnow === true,
      verdict: delivery.grades.at(-1)?.verdict ?? null,
      gradedAt: delivery.grades.at(-1)?.at ?? null,
      grades: delivery.grades.length,
    })),
  }));
}

/** 学生模型里每个已学 topic 的各项量、此刻的 memory 与是否到期，以及按这些量推出的到期时刻（memory 降到到期线的那一刻）。 */
function student(fold: ReturnType<LearningSession["replay"]["fold"]>, now: number) {
  const model = fold.student;
  return Object.fromEntries(Object.keys(model).sort().map((id) => {
    const state = model[id]!;
    const dueDay = state.lastRepetitionDay + state.interval * Math.log2(state.memory / STUDENT_MODEL.dueMemory);
    return [id, {
      repNum: state.repNum, memory: state.memory, speed: state.speed, lastRepetitionDay: state.lastRepetitionDay, interval: state.interval,
      memoryNow: topicMemory(model, id, now), dueNow: topicDue(model, id, now), dueAt: Math.round(dueDay * DAY_MS),
    }];
  }));
}

function submission(entry: Submission) {
  return {
    delivery: seqOf(entry.deliveryId),
    acceptedAt: entry.acceptedAt,
    dontKnow: entry.response.dontKnow === true,
    processing: entry.processing.status,
    interruption: entry.processing.status === "interrupted" ? entry.processing.reason : null,
    gradeRevision: entry.gradeRevision,
    verdictShown: entry.feedback?.verdict ?? null,
  };
}

/** 当前任务的公开画面：阶段、结论、各知识点进度、出过的题与作答。 */
function currentTask(state: LearningState, session: LearningSession) {
  const task = state.task;
  if (!task) return null;
  const phase = task.phase;
  return {
    task: seqOf(task.taskId),
    kind: task.kind,
    topics: task.topics.map((topic) => ({ topic: topic.id, title: topic.title })),
    stage: phase.stage,
    outcome: phase.stage === "completed" ? phase.outcome : null,
    abortReason: phase.stage === "aborted" ? phase.reason : null,
    awaitingDelivery: phase.stage === "awaiting_answer" ? seqOf(phase.deliveryId) : null,
    submissionInFocus: "submissionId" in phase ? seqOf(phase.submissionId) : null,
    pageShown: "page" in phase ? { kind: phase.page.ref.kind, id: phase.page.ref.id } : null,
    startedAt: task.startedAt,
    deadlineAt: task.deadlineAt,
    kps: task.kps.map((kp) => ({ kp: kp.kpId, title: kp.title, attempts: kp.attempts, consecutiveCorrect: kp.consecutiveCorrect, completed: kp.completed })),
    deliveries: task.deliveries.map((delivery) => ({
      delivery: seqOf(delivery.deliveryId),
      question: session.replay.delivery(seqOf(delivery.deliveryId))?.questionId ?? null,
      topic: delivery.topicId,
      kp: delivery.kpId,
      mode: delivery.mode,
      repeated: delivery.repeated,
      requiresServices: delivery.requiresServices,
    })),
    submissions: task.submissions.map(submission),
  };
}

function menu(state: LearningState) {
  if (!state.menu) return null;
  return {
    candidates: state.menu.candidates.map((entry) => ({
      kind: entry.kind, topics: entry.topicIds, title: entry.title, retakes: entry.originalTaskId === undefined ? null : seqOf(entry.originalTaskId),
    })),
    // 测试版的菜单有这项说明，#173 起由界面给出，协议里已没有它；这份文件也要在标签上运行，所以照旧取。
    unavailableReason: (state.menu as { unavailableReason?: string }).unavailableReason ?? null,
    availableAt: state.menu.availableAt ?? null,
  };
}

function building(entry: CourseBuilding) {
  return {
    course: entry.course,
    parts: entry.parts.map((part) => ({ topic: part.topicId, title: part.title, status: part.status, sources: part.sources })),
    expansion: entry.expansion,
    lastFailure: entry.lastFailure === null ? null : { topics: entry.lastFailure.topicIds, at: entry.lastFailure.at, code: entry.lastFailure.code, message: entry.lastFailure.message ?? null },
    conversation: entry.sessionId,
  };
}

/** 一次取数：插件方法的原样返回值（只用来核对进程内与后端给出的一致，不进标准答案），以及按含义命名的读数。 */
export interface Reading {
  raw: { state: unknown; progress: unknown; building: unknown; settings: unknown };
  meaning: unknown;
}

/**
 * 学习状态的读数：插件方法给出的状态与进度，以及取自学习会话内部结构的重放结果。调用前已按读数时刻 settle 过（view 会做）。
 * 做课的状态与设置不在其中，由 readSpace 另取。
 */
function learningMeaning(session: LearningSession, state: LearningState, progress: LearningState["progress"]) {
  const { replay } = session;
  const fold = replay.fold();
  const quizTask = state.task && (state.task.kind === "quiz" || state.task.kind === "retake") ? state.task : null;
  return {
    serverNow: state.serverNow,
    // 学习事实的条数。首次打开测试版数据时插件追加一条旧日志基线，新任务之前还可能有课程结构事实：它们记的是怎样解释学习记录，
    // 不是学习者做过的事，所以不计；其余各项读数照常包括基线之后的全部事实。
    factCount: session.records.facts.filter((fact) => fact.type !== "baseline" && fact.type !== "structure").length,
    course: state.course,
    progress,
    restriction: state.restrictions,
    currentTask: currentTask(state, session),
    menu: menu(state),
    dailyGoal: replay.goal ?? null,
    tasks: tasks(session),
    awards: replay.awards.map((award) => ({ task: award.task, xp: award.xp, at: award.at, quiz: award.quiz })),
    xp: { total: replay.total, quizTrigger: replay.trigger },
    student: student(fold, state.serverNow),
    lessonProgress: fold.lessons,
    lessonFailures: fold.failures,
    reviewFailures: fold.reviewFailures,
    remediation: fold.forced,
    consecutiveReviews: fold.consecutiveReviews,
    quiz: {
      started: replay.consumed,
      pending: replay.pending ? { n: replay.pending.n, atXp: replay.pending.atXp, topics: replay.pending.topicIds } : null,
      current: quizTask ? { task: seqOf(quizTask.taskId), kind: quizTask.kind, topics: quizTask.topics.map((topic) => topic.id), startedAt: quizTask.startedAt, deadlineAt: quizTask.deadlineAt } : null,
    },
  };
}

/** model 为假时没有可用的模型，与试用者删掉了 key 时相同：开放题不出，也不补判。 */
export async function readSpace(root: string, now: number, model = true): Promise<Reading> {
  let session: LearningSession | undefined;
  const plugin = createLearningPlugin({
    connect: async (opened) => {
      session = opened;
      return connectLearning(opened);
    },
  });
  const models = new ModelTestDriver();
  if (!model) models.setDefaultModel(undefined);
  const space = await openSpace(root, { watch: false });
  const errors: unknown[] = [];
  // 升级测试版数据之前插件要等一次备份成功；这里是取数用的副本，备份什么也不做。
  const host = await openPluginHost({ space, plugins: [plugin], now: () => now, models, backup: async () => {}, emit: () => {}, onError: (error) => errors.push(error) });
  try {
    const disabled = host.disabled();
    if (disabled.length > 0) throw new Error(`插件被停用：${JSON.stringify(disabled)}`);
    const call = (method: string) => host.call("learning", method, {}, { capabilities: WEB_CAPABILITIES });
    const state = await call("state.get") as LearningState;
    const progress = await call("progress.get") as { serverNow: number; progress: LearningState["progress"] };
    const built = await call("building.get") as CourseBuilding;
    // 花费由宿主汇总会话的用量，换了宿主就不同，不是学习插件的读数。
    const { cost: _cost, ...buildingRaw } = built;
    const settings = await call("settings.get") as LearningSettings;
    if (!session) throw new Error("学习会话没有打开");
    await session.view(WEB_CAPABILITIES);
    const meaning = {
      ...learningMeaning(session, state, progress.progress),
      building: building(built),
      autoExpand: settings.autoExpand,
    };
    await session.idle();
    // 读数不应写下任何事实：取数之前已没有待判的作答，或者待判的作答此刻判不了。
    if (session.records.revision !== state.revision) throw new Error(`读数期间写下了事实：${state.revision} → ${session.records.revision}`);
    if (errors.length > 0) throw errors[0];
    return { raw: plain({ state, progress, building: buildingRaw, settings }) as Reading["raw"], meaning: plain(meaning) };
  } finally {
    await host.close();
    await space.close();
  }
}

/**
 * 逐前缀取数的空间：五个空间，以及丁换课前的快照（它的前缀用随包课读，丁的同一段前缀用换用后的自制课读，两者都是测试版的读数）。
 * 都按有可用模型取数。
 */
export const PREFIX_SPACES = [
  { id: "a", source: "home/Repa/操作系统 走查", model: true },
  { id: "b", source: "home/Repa/操作系统 复习", model: true },
  { id: "c", source: "home/Repa/Python 入门", model: true },
  { id: "d-python-only", source: "snapshots/先学 Python 再学进程/python-only", model: true },
  { id: "d", source: "home/Repa/先学 Python 再学进程", model: true },
  { id: "e", source: "home/Repa/Python 测验", model: true },
] as const;

/** 逐前缀取数时，每个前缀除了在最后一条事实的时刻读一次，还在这么久以后再读一次：跨过本地日期，也跨过进行中测验的截止时间。 */
export const PREFIX_LATER_MS = 25 * 3_600_000;

/** 一个前缀的两次读数（读不出状态时为 { error }）：在最后一条事实的时刻（空前缀取第一条事实的时刻），以及 PREFIX_LATER_MS 以后，其间没有新的事实。 */
export interface PrefixReading {
  facts: number;
  at: Record<string, unknown>;
  later: Record<string, unknown>;
}

/**
 * 对一个空间学习记录的每个前缀（0 行到全部）取读数，课程取这个空间打开时实际用的那一门。前缀之后的学习记录当作还没写下：
 * 每个前缀单独写一份学习记录，末尾加一段不完整的行，学习记录就只读不写（与测试版读到半行时相同），打开时的补判不会写进去，
 * 读到的就是这个前缀本身。读数直接取自学习会话的 view，不经插件方法，所以也不触发按调用方能力的后台补判。
 */
export async function readPrefixes(root: string, model = true, baseline = false): Promise<PrefixReading[]> {
  const file = path.join(root, ".repa", "plugins", "learning", "records.jsonl");
  const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
  const facts = lines.map((line) => JSON.parse(line) as Fact);
  let session: LearningSession | undefined;
  let now = facts.at(-1)?.at ?? 0;
  const plugin = createLearningPlugin({
    connect: async (opened) => {
      session = opened;
      return connectLearning(opened);
    },
  });
  const models = new ModelTestDriver();
  if (!model) models.setDefaultModel(undefined);
  const space = await openSpace(root, { watch: false });
  const errors: unknown[] = [];
  // 升级测试版数据之前插件要等一次备份成功；这里是取数用的副本，备份什么也不做。
  const host = await openPluginHost({ space, plugins: [plugin], now: () => now, models, backup: async () => {}, emit: () => {}, onError: (error) => errors.push(error) });
  const scratch = await mkdtemp(path.join(os.tmpdir(), "repa-test1-prefix-"));
  try {
    const disabled = host.disabled();
    if (disabled.length > 0) throw new Error(`插件被停用：${JSON.stringify(disabled)}`);
    if (!session) throw new Error("学习会话没有打开");
    const opened = session;
    const results: PrefixReading[] = [];
    for (let count = 0; count <= lines.length; count++) {
      const prefix = path.join(scratch, `${count}.jsonl`);
      const start = facts[Math.max(0, count - 1)]?.at ?? now;
      let written = lines.slice(0, count);
      if (baseline) {
        // 真实的基线选择：与插件首次打开时调用同一个 legacyBaseline，把它选出的基线接在前缀后面，按插件写入的样子。
        // 末尾仍加半行，学习记录只读不写，打开时的补判不会写进去。
        await writeFile(prefix, written.map((line) => `${line}\n`).join(""));
        const complete = await LearningRecords.open(prefix);
        if (needsBaseline(complete)) {
          const choice = await legacyBaseline({
            records: complete, store: new CourseStore(path.join(root, ".repa", "plugins", "learning")), files: opened.host.files, now: start, bundled: test1Python,
          });
          if (choice !== "broken") {
            written = [...written, JSON.stringify({ seq: count + 1, at: start, type: "baseline", rules: "test1", ...(choice.structure ? { structure: choice.structure } : {}) })];
          }
        }
        await complete.close();
      }
      await writeFile(prefix, `${written.map((line) => `${line}\n`).join("")}{`);
      const records = await LearningRecords.open(prefix);
      if (baseline && records.revision !== count && records.baseline === undefined) throw new Error(`第 ${count} 个前缀的基线没有读出来`);
      now = start;
      const prefixSession = await LearningSession.open(records, opened.course.course, opened.host);
      // 换课以后用新课读旧前缀时，可能停在新课里没有的知识点上，测试版此时读不出状态；报错也是读数。
      const read = async (): Promise<Record<string, unknown>> => {
        try {
          const view = await prefixSession.view(WEB_CAPABILITIES);
          return plain(learningMeaning(prefixSession, view.state, view.state.progress)) as Record<string, unknown>;
        } catch (error) {
          return { error: error instanceof RepaFault ? `${error.code}: ${error.message}` : String(error) };
        }
      };
      const at = await read();
      now = start + PREFIX_LATER_MS;
      const later = await read();
      await prefixSession.retire();
      if (records.revision !== written.length) throw new Error(`取数期间写下了事实：${written.length} → ${records.revision}`);
      results.push({ facts: count, at, later });
    }
    if (errors.length > 0) throw errors[0];
    return results;
  } finally {
    await rm(scratch, { recursive: true, force: true });
    await host.close();
    await space.close();
  }
}

/**
 * 升级以后再收到同一笔合法的补判：先在最后一条事实的时刻打开（插件写下旧日志基线）取一次读数，关闭后把补判 line 追加到学习记录末尾
 * （序号接在基线之后，引用的作答不变），再在补判的时刻打开取一次。用来与测试版收到同一笔补判前后的读数比较。
 */
export async function readRegrade(root: string, line: string, model = true): Promise<[Reading, Reading]> {
  const file = path.join(root, ".repa", "plugins", "learning", "records.jsonl");
  const facts = (await readFile(file, "utf8")).split("\n").filter(Boolean).map((entry) => JSON.parse(entry) as Fact);
  const before = await readSpace(root, facts.at(-1)?.at ?? 0, model);
  const written = (await readFile(file, "utf8")).split("\n").filter(Boolean).length;
  const fact = { ...(JSON.parse(line) as Fact), seq: written + 1 };
  await writeFile(file, `${await readFile(file, "utf8")}${JSON.stringify(fact)}\n`);
  return [before, await readSpace(root, fact.at, model)];
}
