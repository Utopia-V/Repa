/**
 * 测试版固定数据（test/fixtures/test1/）的对照读数。产品不读测试版的数据；这里只为检查重放的重构：把测试版写下的学习记录
 * 在测试一侧直接重放，取学习会话给出的状态与重放出的学习状态，存成按含义命名、与协议形状无关的字段，与测试版自己算出的标准答案比较。
 * 学生模型改成按知识点时，连同这份固定数据一起退役。
 *
 * 课程取这个空间当时用的那一门：换用过的副本（course.json 的 active），没有换用过就是随包的课，用冻结的测试版那一份结构
 * （test1/python-structure.json）与现在随包的课程内容。全部任务按这份结构解释（Replay 的 Legacy），与测试版一样。
 * 学习记录只读：会话的写入一律拒绝，读数期间不会写下任何事实。
 *
 * 经 test1-read.ts 以子进程运行：时区要在进程启动时定下，学习插件按进程的时区算本地日期。
 */
import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RepaFault } from "@repa/base";
import type { Host } from "@repa/base/plugin";
import { ModelTestDriver } from "@repa/base/testing";
import type { ClientCapabilities } from "@repa/base/protocol";
import { scoped, unscoped } from "../../src/course-key.js";
import { loadCourseSources, type ResolvedCourse } from "../../src/course-sources.js";
import { courseStructure, StructureIndex, type CourseStructure } from "../../src/course-structure.js";
import { emptyFold, foldTask, taskEvidence, type TaskEvidence } from "../../src/flow-state.js";
import { STUDENT_MODEL } from "../../src/parameters.js";
import { CourseStore } from "../../src/space-course.js";
import type { LearningState, Submission } from "../../src/protocol.js";
import type { LearningRecords } from "../../src/records.js";
import { LearningSession } from "../../src/session.js";
import { DAY_MS, topicDue, topicMemory } from "../../src/student-model.js";
import type { Fact } from "../../src/records-schema.js";

/** 取数时前端声明的能力：与 apps/web 的 interactionCapabilities 和 app.tsx 声明的服务相同。 */
export const WEB_CAPABILITIES: ClientCapabilities = {
  interaction: { supports: ["slot.choice", "slot.text", "slot.order", "slot.table", "slot.code", "block.markdown", "block.code", "markdown.math"] },
  services: ["python.run"],
};
/** 取数时进程的时区：试用者在中国。 */
export const TIME_ZONE = "Asia/Shanghai";

/** 测试版 v0.1.0-test.1 随包的 Python 课的结构，冻结在固定数据里；摘要见 test1/README.md。 */
export const TEST1_PYTHON = fileURLToPath(new URL("./test1/python-structure.json", import.meta.url));
const BUNDLED = fileURLToPath(new URL("../../courses/python/", import.meta.url));

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
    const evidence = taskEvidence(task, fold.lessons.get(scoped(task.course, task.topicIds[0] ?? "")));
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
    return [unscoped(ORACLE_KEY, id) ?? `?${id}`, {
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
    // 学习事实的条数；课程结构事实记的是怎样解释学习记录，不是学习者做过的事，不计（测试版的数据里没有）。
    factCount: session.records.facts.filter((fact) => fact.type !== "structure").length,
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
    lessonProgress: bare(fold.lessons),
    lessonFailures: bare(fold.failures),
    reviewFailures: bare(fold.reviewFailures),
    remediation: bare(fold.forced),
    consecutiveReviews: fold.consecutiveReviews,
    quiz: {
      started: replay.consumed,
      pending: replay.pending ? { n: replay.pending.n, atXp: replay.pending.atXp, topics: replay.pending.topicIds } : null,
      current: quizTask ? { task: seqOf(quizTask.taskId), kind: quizTask.kind, topics: quizTask.topics.map((topic) => topic.id), startedAt: quizTask.startedAt, deadlineAt: quizTask.deadlineAt } : null,
    },
  };
}


/**
 * 只读的学习记录：测试版写下的事实原样交给会话（不经现在的格式校验，那些任务还没有结构引用），任何写入都拒绝。
 * 尾部按残缺处理，会话打开时的补判也就不写。
 */
function frozenRecords(facts: Fact[]): LearningRecords {
  const refuse = () => Promise.reject(new RepaFault("learning_log_blocked", "对照用的学习记录只读"));
  return {
    file: "",
    facts,
    revision: facts.length,
    incompleteTail: true,
    fact: (seq: number) => facts[seq - 1],
    listen: () => () => {},
    serial: <T>(action: () => Promise<T>) => action(),
    write: refuse,
    close: async () => {},
  } as unknown as LearningRecords;
}

/** 空间当时学的课（每个空间读一次）：换用过的副本与它的结构，没有换用过就是现在随包的课程内容与冻结的测试版结构。 */
const courses = new Map<string, Promise<{ resolved: ResolvedCourse; structure: CourseStructure }>>();
function spaceCourse(root: string): Promise<{ resolved: ResolvedCourse; structure: CourseStructure }> {
  let found = courses.get(root);
  if (!found) {
    found = loadSpaceCourse(root);
    courses.set(root, found);
  }
  return found;
}

async function loadSpaceCourse(root: string): Promise<{ resolved: ResolvedCourse; structure: CourseStructure }> {
  const dataDir = path.join(root, ".repa", "plugins", "learning");
  let active: string | undefined;
  try {
    active = (JSON.parse(await readFile(path.join(dataDir, "course.json"), "utf8")) as { active?: string }).active;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (active !== undefined) {
    const resolved = await new CourseStore(dataDir).load(active);
    return { resolved, structure: courseStructure(resolved) };
  }
  const files = { read: () => Promise.reject(new Error("不读空间文件")), write: () => Promise.reject(new Error("不写")), list: async () => [] };
  return {
    resolved: await loadCourseSources([{ kind: "bundled", directory: BUNDLED }], files),
    structure: JSON.parse(await readFile(TEST1_PYTHON, "utf8")) as CourseStructure,
  };
}

/**
 * 对照时这门课的键。测试版的任务没有记课的键，全部归它；学习状态的键因此带上“oracle:”，取数时去掉（见 bare），
 * 学习者看不到这些键，标准答案里是测试版的裸编号。
 */
const ORACLE_KEY = "oracle";

/** 学习状态的键去掉对照的课的键，得到测试版的裸编号。 */
function bare<T>(map: Map<string, T> | Record<string, T>): Map<string, T> {
  const entries = map instanceof Map ? [...map] : Object.entries(map);
  return new Map(entries.map(([key, value]) => [unscoped(ORACLE_KEY, key) ?? `?${key}`, value]));
}

/** 一份对照用的学习会话：facts 是学习记录，时钟由 clock.now 给出，model 为假时没有可用的模型（与试用者删掉了 key 时相同）。 */
async function oracle(root: string, facts: Fact[], clock: { now: number }, model: boolean) {
  const { resolved, structure } = await spaceCourse(root);
  const models = new ModelTestDriver();
  if (!model) models.setDefaultModel(undefined);
  // 会话只用宿主的时钟、模型、通知与前端服务；前端服务（运行 Python）这里没有。
  const host = {
    now: () => clock.now,
    emit: () => {},
    models,
    services: { call: () => Promise.reject(new RepaFault("service_unavailable", "没有前端")) },
  } as unknown as Host;
  return LearningSession.open(frozenRecords(facts), resolved, host, ORACLE_KEY, { upTo: facts.length, structure: new StructureIndex(structure), key: ORACLE_KEY });
}

/** 一个空间学习记录的全部事实。 */
async function spaceFacts(root: string): Promise<Fact[]> {
  const file = path.join(root, ".repa", "plugins", "learning", "records.jsonl");
  return (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Fact);
}

/** 一次取数：按含义命名的读数。 */
export interface Reading {
  meaning: unknown;
}

/**
 * 在 now 读一个空间。取法与测试版经插件方法取数相同：每次方法调用先按调用方的能力在后台补判，再取状态；有可用模型时假模型判不了，
 * 这份作答显示为判分失败。做课的状态与设置（building.get、settings.get）是插件一层的读数，产品不再为测试版的数据打开插件，不在其中。
 */
export async function readSpace(root: string, now: number, model = true): Promise<Reading> {
  const clock = { now };
  const session = await oracle(root, await spaceFacts(root), clock, model);
  try {
    session.autoGrade(WEB_CAPABILITIES);
    const state = await session.state(WEB_CAPABILITIES);
    session.autoGrade(WEB_CAPABILITIES);
    const progress = (await session.state(WEB_CAPABILITIES)).progress;
    await session.view(WEB_CAPABILITIES);
    const meaning = learningMeaning(session, state, progress);
    await session.idle();
    return { meaning: plain(meaning) };
  } finally {
    await session.retire();
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
 * 对一个空间学习记录的每个前缀（0 行到全部）取读数，课程取这个空间当时用的那一门。读数直接取自学习会话的 view，
 * 不经插件方法，所以也不触发按调用方能力的后台补判。
 */
export async function readPrefixes(root: string, model = true): Promise<PrefixReading[]> {
  const facts = await spaceFacts(root);
  const results: PrefixReading[] = [];
  for (let count = 0; count <= facts.length; count++) {
    const start = facts[Math.max(0, count - 1)]?.at ?? 0;
    const clock = { now: start };
    const session = await oracle(root, facts.slice(0, count), clock, model);
    // 换课以后用新课读旧前缀时，可能停在新课里没有的知识点上，测试版此时读不出状态；报错也是读数。
    const read = async (): Promise<Record<string, unknown>> => {
      try {
        const view = await session.view(WEB_CAPABILITIES);
        return plain(learningMeaning(session, view.state, view.state.progress)) as Record<string, unknown>;
      } catch (error) {
        return { error: error instanceof RepaFault ? `${error.code}: ${error.message}` : String(error) };
      }
    };
    const at = await read();
    clock.now = start + PREFIX_LATER_MS;
    const later = await read();
    await session.retire();
    results.push({ facts: count, at, later });
  }
  return results;
}
