import { randomBytes } from "node:crypto";
import { readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RepaFault } from "@repa/base";
import { errorText, modelFailureOf } from "@repa/base/protocol";
import {
  checkFormat, currentRun, type AgentWork, type Host, type MessageDecision, type Plugin, type PluginInstance, type PluginMethod, type Tool,
} from "@repa/base/plugin";
import { parse as parseYaml } from "yaml";
import { localDate, mergeConfirmations } from "./check/confirm.js";
import { frontendPython, sandboxPython, type CheckPython } from "./check/python.js";
import {
  beginText, completeTopics, EXPANSION_SIZE, expansionTask, openRecord, openSettings, outlineTopics, saveRecord, saveSettings, type BuildingRecord,
} from "./course-building.js";
import { bundledKey, unscoped } from "./course-key.js";
import { COURSE_EXAMPLE, COURSE_GUIDE, CONFIRM_CONCURRENCY, CONFIRM_REQUESTS, courseTools, type Missing } from "./course-tools.js";
import { loadCourseSources, type CourseSource, type ResolvedCourse } from "./course-sources.js";
import { expansionBrief } from "./expansion-brief.js";
import { connectExport } from "./export.js";
import { connectLearning } from "./flow.js";
import { COURSE_FILE, TOPICS_DIRECTORY } from "./format/load.js";
import { emptyProgress } from "./progress.js";
import {
  learningMethods, type BuildingEvent, type CourseBuilding, type LearningCourses, type LearningInput, type LearningResult, type LearningState,
} from "./protocol.js";
import { LearningRecords, RECORDS_FILE } from "./records.js";
import { LearningSession } from "./session.js";
import {
  CHECKS, courseFolder, CourseStore, COURSES_FOLDER, inLocation, onlyAdds, readSpaceCourse, type CourseEntry,
} from "./space-course.js";
import { visibleLearningResponse } from "./submission-visibility.js";
import { connectTutor, TUTOR_AGENT, TUTOR_TOOLS, tutorAgent, type Tutor, type TutorHooks } from "./tutor.js";

/**
 * 学习记录的格式版本：2 起只记事实，3 起每项任务带课程的标识与版本，4 起学习记录带课程结构，5 起每项任务都引用开始时的那一份结构、
 * 记着课在空间里的键，课有登记（course.json），做课的记录按课存。在有真实用户之前，格式改动只升版本：此前版本的数据（含测试版）
 * 不读、不升级、不迁移，提示删除后重新打开。
 */
export const LEARNING_FORMAT_VERSION = 5;

/** 时间一律取自底座的 host.now()，插件不另设时钟；测试通过宿主的 now 拨动时间。 */
export interface LearningPluginOptions {
  /** 随包的课；缺省为随包的 Python 课。学习者选了它，它才是空间里的一门课。 */
  sources?: CourseSource[];
  /** course_check 运行 Python 核对时用的离线 Pyodide 包目录；缺省见 @repa/python-runner 的 defaultPackagesDirectory。 */
  packagesDirectory?: string;
  /**
   * course_check 能运行 Python 的几处，按顺序用第一处能用的。缺省先是 Linux 沙箱，再是前端页面的 python.run；
   * 测试等自定义接入可以只给其中一处，例如在有沙箱的机器上走没有沙箱的路。
   */
  python?: (host: Host) => CheckPython[];
  /** 默认装配教学流程；测试等自定义接入复用同一个学习会话。换用课程时为新的会话再调用一次。 */
  connect?: (session: LearningSession, host: Host) => Promise<Pick<PluginInstance, "methods" | "close">>;
}

/** 有一门可学的课：它在登记里的那一项、学习会话和绑在它上面的教学方法与辅导。 */
interface Ready {
  kind: "ready";
  key: string;
  entry: CourseEntry;
  course: ResolvedCourse;
  session: LearningSession;
  methods: Record<string, PluginMethod>;
  close?: () => Promise<void>;
  tutor: Tutor;
}
/** 空间里还没有课、有课而还没有换用过一门通过检查的，或换用的副本打不开。 */
interface Unready {
  kind: "unready";
  reason: string;
}
type Current = Ready | Unready;

const NOT_BUILT = "这个空间的课还没有做好";

/**
 * 创建学习插件。打开时核对数据目录的格式标记，读入学习记录，再按课的登记决定学哪门课：登记里换用过的自制课，或学习者选了的随包课。
 * 方法的返回值和错误都经同一处按当前限制隐藏反馈。
 */
export function createLearningPlugin(options: LearningPluginOptions = {}): Plugin {
  return {
    id: "learning",
    async open(host) {
      const format = path.join(host.space.dataDir, "format.json");
      const entries = await readdir(host.space.dataDir);
      if (entries.length === 0) {
        await writeFile(format, `${JSON.stringify({ version: LEARNING_FORMAT_VERSION })}\n`, { flag: "wx", mode: 0o600 });
      } else if (!entries.includes("format.json")) {
        throw new RepaFault("unknown_data_format", "学习插件的数据没有格式标记，可能是旧的开发数据；删除 .repa/plugins/learning/ 后重新打开空间");
      }
      // 更新的版本由 checkFormat 拒绝；更早的版本（含测试版）不读。
      const version = await checkFormat(format, LEARNING_FORMAT_VERSION);
      if (version < LEARNING_FORMAT_VERSION) {
        throw new RepaFault("unknown_data_format", "学习记录是旧格式的开发数据，不再读取；删除 .repa/plugins/learning/ 后重新打开空间");
      }
      // 上次检查中途退出留下的临时副本；打开时还没有检查在进行。
      await rm(path.join(host.space.dataDir, CHECKS), { recursive: true, force: true });
      const records = await LearningRecords.open(path.join(host.space.dataDir, RECORDS_FILE), () => host.now());
      try {
        return await openLearning(host, records, options);
      } catch (error) {
        await records.close();
        throw error;
      }
    },
  };
}
export default createLearningPlugin();

/**
 * 核对先用 Linux 沙箱；建不起来时（Windows、macOS 和缺少 Landlock 的 Linux）经开着的应用页面运行。后台展开没有自己的连接，
 * host.services 交给任何一个声明了 python.run 的连接；应用窗口都关着时两处都没有，检查如实报告没有运行。
 */
function defaultPython(host: Host): CheckPython[] {
  return [sandboxPython, frontendPython(host.services)];
}

/** 课的文件夹名：能作为三个系统上的文件夹名，不以点开头。 */
function validFolderName(name: string): boolean {
  return name.length > 0 && name.length <= 100 && name.trim() === name && !name.startsWith(".")
    && !/[<>:"/\\|?*\u0000-\u001f]/u.test(name) && !/[. ]$/u.test(name);
}

/** 工具参数里写的课的文件夹，规范成登记里的位置：去掉开头的 ./ 与末尾的 /，写到 course/ 的也认。 */
function locationOf(written: string): string {
  const location = written.trim().replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
  return location.endsWith("/course") ? location.slice(0, -"/course".length) : location;
}

async function openLearning(host: Host, records: LearningRecords, options: LearningPluginOptions): Promise<PluginInstance> {
  const store = new CourseStore(host.space.dataDir, {
    python: options.python ? options.python(host) : defaultPython(host),
    ...(options.packagesDirectory === undefined ? {} : { packagesDirectory: options.packagesDirectory }),
  });
  const sources = options.sources ?? [{ kind: "bundled", directory: fileURLToPath(new URL("../courses/python/", import.meta.url)) }];
  // 随包的课：包内标识是课程目录名，键由它定。
  const bundledSource = sources.find((source) => source.kind === "bundled");
  const bundledName = bundledSource ? path.basename(bundledSource.directory) : "python";
  const BUNDLED = bundledKey(bundledName);

  /** 按一门课建好学习会话与教学方法。只读：补判由调用方在这门课发布以后调用 session.catchUp 写下。 */
  async function build(course: ResolvedCourse, entry: CourseEntry): Promise<Ready> {
    const session = await LearningSession.open(records, course, host, entry.key);
    try {
      const connected = await (options.connect
        ? options.connect(session, host)
        : connectLearning(session, { beforeRestricted: () => host.abortAgent(TUTOR_AGENT) }));
      const tutor = await connectTutor(session);
      return {
        kind: "ready",
        key: entry.key,
        entry,
        course,
        session,
        methods: { ...connected.methods, ...tutor.methods },
        ...(connected.close ? { close: connected.close } : {}),
        tutor,
      };
    } catch (error) {
      await session.retire();
      throw error;
    }
  }

  /** 空间里的课出了问题只让这门课用不了：副本读不出、会话建不起来，都记成没有可学的课并写明原因。 */
  async function buildSpace(entry: CourseEntry & { copy: string }): Promise<Current> {
    try {
      return await build(await store.load(entry.copy), entry);
    } catch (error) {
      return { kind: "unready", reason: `换用的课打不开：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async function retire(ready: Ready): Promise<void> {
    try {
      await ready.close?.();
    } finally {
      await ready.session.retire();
    }
  }

  /** 学习者做到一半的任务（课、复习或测验开始了还没结束）涉及的 topic；没有这样的任务时为 undefined。 */
  function taskTopics(session: LearningSession): Promise<string[] | undefined> {
    return session.records.serial(async () => {
      session.replay.settle(session.clock());
      const evidence = session.replay.currentEvidence();
      return evidence !== undefined && evidence.outcome === undefined ? evidence.task.topicIds : undefined;
    });
  }

  /** 学习者在这门课里学过的 topic：学生模型里这门课有记录的，与进度里的 completedTopics 数的是同一些（只数还在课里的）。 */
  function learnedTopics(ready: Ready): Promise<Set<string>> {
    const { session } = ready;
    return session.records.serial(async () => {
      session.replay.settle(session.clock());
      return new Set(Object.keys(session.replay.fold().student).flatMap((id) => {
        const topic = unscoped(ready.key, id);
        return topic === undefined ? [] : [topic];
      }));
    });
  }

  // ---------------------------------------------------------------------------
  // 课的登记：空间里有哪几门课、各在哪里、换用的是哪一份
  // ---------------------------------------------------------------------------

  /** 登记里第一门可学的课：换用过的自制课，或随包的课。这一步一个空间同时只学一门。 */
  async function learnable(entries: CourseEntry[]): Promise<Current> {
    for (const entry of entries) {
      if (entry.copy !== undefined) return buildSpace({ ...entry, copy: entry.copy });
      if (entry.bundled !== undefined) return build(await loadCourseSources(sources, host.files), entry);
    }
    return { kind: "unready", reason: NOT_BUILT };
  }

  /** 空间里的课，按加入的先后。 */
  let entries = await store.read();
  let current = await learnable(entries);
  // 正在用的课已经是发布了的：按它补判规则题。
  if (current.kind === "ready") await current.session.catchUp();

  /** 写下课的登记。调用方保证同一时刻只有一次。 */
  async function persist(next: CourseEntry[]): Promise<void> {
    await store.publish(next);
    entries = next;
  }

  /** courses/ 下的文件夹（相对空间根）。只读目录，不经空间的文件接口：要分得出文件夹与文件。 */
  async function courseFolders(): Promise<string[]> {
    try {
      const found = await readdir(path.join(host.space.root, COURSES_FOLDER), { withFileTypes: true });
      return found.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => `${COURSES_FOLDER}/${entry.name}`).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return [];
      throw error;
    }
  }

  /** 这个位置的文件夹在不在。 */
  async function present(location: string): Promise<boolean> {
    try {
      await host.files.list(location);
      return true;
    } catch {
      return false;
    }
  }

  /** 一个位置的课程清单里声明的 id；读不出时为 undefined。 */
  async function declaredId(location: string): Promise<string | undefined> {
    try {
      const value = parseYaml(await host.files.read(`${courseFolder(location)}/${COURSE_FILE}`)) as { id?: unknown };
      return typeof value.id === "string" ? value.id : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 空间里自己的课：登记里有位置的，以及 courses/ 下还没登记的文件夹（新的草稿，key 为空）。
   * 课程文件夹被改名或移走时，只在证据唯一时自动接回：恰有一门登记的课位置不在，又恰有一个未登记的文件夹，且它清单的 id
   * 与那门课换用的副本的 id 相同。其余情形照实列出（位置不在的标 missing），不猜。
   */
  let reconciling: Promise<unknown> = Promise.resolve();
  function ownCourses(): Promise<{ key?: string; location: string; missing: boolean }[]> {
    const work = reconciling.then(async () => {
      const own = entries.filter((entry): entry is CourseEntry & { location: string } => entry.location !== undefined);
      const known = new Set(own.map((entry) => entry.location));
      const loose = (await courseFolders()).filter((location) => !known.has(location));
      const gone: (CourseEntry & { location: string })[] = [];
      for (const entry of own) if (!await present(entry.location)) gone.push(entry);
      const [lost] = gone;
      const [found] = loose;
      if (gone.length === 1 && loose.length === 1 && lost?.copy !== undefined && found !== undefined) {
        const copied = (await store.load(lost.copy).catch(() => undefined))?.course.id;
        if (copied !== undefined && copied === await declaredId(found)) {
          await persist(entries.map((entry) => (entry.key === lost.key ? { ...entry, location: found } : entry)));
          return ownCourses();
        }
      }
      const missing = new Set(gone.map((entry) => entry.key));
      return [
        ...own.map((entry) => ({ key: entry.key, location: entry.location, missing: missing.has(entry.key) })),
        ...loose.map((location) => ({ location, missing: false })),
      ];
    });
    reconciling = work.catch(() => undefined);
    return work;
  }

  /** 新的键：不与登记里已有的、保留的键相同。 */
  function newKey(): string {
    for (;;) {
      const key = `c${randomBytes(5).toString("hex")}`;
      if (!entries.some((entry) => entry.key === key)) return key;
    }
  }

  /** 登记一门新的草稿课：第一次需要它的键时（做课工具、建课）。 */
  async function register(location: string): Promise<CourseEntry & { location: string }> {
    const entry = { key: newKey(), location };
    await persist([...entries, entry]);
    return entry;
  }

  /** 列出空间里有哪些自己的课，写进要求参数的错误里。 */
  async function courseList(): Promise<string> {
    const own = await ownCourses();
    return own.length === 0 ? "空间里还没有自己的课" : `空间里的课：${own.map((entry) => entry.location).join("、")}`;
  }

  // ---------------------------------------------------------------------------
  // 做课的记录：每门课一份
  // ---------------------------------------------------------------------------

  const records_ = new Map<string, BuildingRecord>();
  const saving = new Map<string, Promise<void>>();
  /** 一门课的做课记录；第一次用到时从盘上读。 */
  async function recordOf(key: string): Promise<BuildingRecord> {
    let record = records_.get(key);
    if (!record) {
      record = await openRecord(host.space.dataDir, key);
      records_.set(key, records_.get(key) ?? record);
    }
    return records_.get(key) ?? record;
  }
  for (const entry of entries) if (entry.location !== undefined) await recordOf(entry.key);
  let settings = await openSettings(host.space.dataDir);
  /** 记录整份写入；同一门课后发起的写入排在先发起的之后，盘上不会留下较旧的一份。 */
  function save(key: string): Promise<void> {
    const record = records_.get(key);
    if (!record) return Promise.resolve();
    const snapshot = structuredClone(record);
    const next = (saving.get(key) ?? Promise.resolve()).then(async () => {
      await saveRecord(host.space.dataDir, key, snapshot);
    });
    saving.set(key, next.catch(() => undefined));
    return next;
  }
  function announceBuilding(): void {
    host.emit({ type: "building.changed" } satisfies BuildingEvent);
  }

  /** 这个会话在做哪门课：它是那门课的做课对话、调用过那门课的做课工具，或是那门课的后台展开。 */
  function courseOfSession(sessionId: string): string | undefined {
    if (expansion?.work?.id === sessionId) return expansion.key;
    for (const [key, record] of records_) {
      if (record.conversation === sessionId || record.sessions.includes(sessionId) || record.last?.sessionId === sessionId) return key;
    }
    return undefined;
  }

  /**
   * 工具与方法要操作的那门自己的课：写了位置就按位置；没写时，这次运行在某门课的做课对话或后台展开里就是那门课，
   * 空间里只有一门自己的课时也是它；别的情形报错并列出有哪些课。未登记的文件夹第一次用到时登记成草稿。
   */
  async function target(written: string | undefined): Promise<{ key: string; location: string }> {
    const own = await ownCourses();
    let found: { key?: string; location: string } | undefined;
    if (written !== undefined) {
      const location = locationOf(written);
      found = own.find((entry) => entry.location === location);
      if (!found) {
        throw new RepaFault("course_not_found", `空间里没有 ${written} 这门课；新课放在 ${COURSES_FOLDER}/<名>/ 下。${await courseList()}。`);
      }
    } else {
      const run = currentRun();
      const key = run === undefined ? undefined : courseOfSession(run.sessionId);
      found = key === undefined ? (own.length === 1 ? own[0] : undefined) : own.find((entry) => entry.key === key);
      if (!found) {
        throw new RepaFault("course_required", own.length === 0
          ? `空间里还没有自己的课：新课放在 ${COURSES_FOLDER}/<名>/ 下，写在其中的 course/ 里。`
          : `要用 course 写明是哪门课。${await courseList()}。`);
      }
    }
    if (found.key !== undefined) return { key: found.key, location: found.location };
    return register(found.location);
  }

  // 换用要在没有方法调用进行时进行：调用开始时取当前的课，换用等进行中的调用结束，换用期间新的调用等它完成。
  // 否则一次调用可能在“判定学习者不忙”之后按旧课开始任务。辅导的工具和提问前的判断只读不写学习记录，不必等；
  // 也不能等：开始作答的方法会中止辅导，辅导若在等换用就互相等住。
  let swapping: Promise<unknown> | undefined;
  /** 换用发布出错以后，学习插件停下的原因；重开空间之前不再换用。 */
  let stopped: string | undefined;
  const running = new Set<Promise<unknown>>();

  async function use<T>(action: (state: Current) => Promise<T>): Promise<T> {
    while (swapping) await Promise.allSettled([swapping]);
    const work = action(current);
    running.add(work);
    try {
      return await work;
    } finally {
      running.delete(work);
      // 学习状态可能变了：看看是不是该在后台展开下一段。不等它，方法照常返回。
      track(maybeExpand());
    }
  }

  async function exclusive<T>(action: () => Promise<T>): Promise<T> {
    while (swapping) await Promise.allSettled([swapping]);
    const work = (async () => {
      while (running.size > 0) await Promise.allSettled([...running]);
      return action();
    })();
    swapping = work;
    try {
      return await work;
    } finally {
      swapping = undefined;
    }
  }

  /**
   * 把 next 发布为课的登记并让 ready 成为学的课，先验证、后发布。次序：旧会话在途的判分写完；按内容只读地建好新会话（重放全部记录、接上教学方法），
   * 建不起来就报错，旧的课照常在用；原子写 course.json 发布；旧会话退下；新会话这时才按新的内容补判；最后删掉没有引用的副本。
   * 发布之前中断，重开仍是旧的课；发布之后中断，重开就是新的课，补判在打开时做。没有发布的课不会写下判分。
   */
  async function adopt(next: CourseEntry[], entry: CourseEntry, read: () => Promise<ResolvedCourse>): Promise<void> {
    if (current.kind === "ready") await current.session.idle();
    let ready: Ready;
    try {
      ready = await build(await read(), entry);
    } catch (error) {
      throw new RepaFault("course_switch_failed", `检查通过，但换用出错，学的仍是原来的课：${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await persist(next);
    } catch (error) {
      // course.json 写到一半出错，盘上指向哪一份说不准：学习插件就此停下，不再按哪一门课写学习记录，重开空间时从盘上读。
      stopped = `换用时写 course.json 出错，学习插件已停下，请重新打开空间：${error instanceof Error ? error.message : String(error)}`;
      await retire(ready);
      if (current.kind === "ready") await retire(current);
      current = { kind: "unready", reason: stopped };
      throw new RepaFault("course_switch_failed", stopped);
    }
    const previous = current;
    current = ready;
    if (previous.kind === "ready") await retire(previous);
    await ready.session.catchUp();
    await store.prune(entries);
    ready.session.announce();
    announceBuilding();
  }

  /**
   * 换用一门自己的课检查过的这一份。学习者有做到一半的任务时，只有同一门课的新的一版只增不改（已展开的部分一字不差）才换，否则不换。
   * 这一步空间里同时只学一门，已经在学另一门课（自己的或随包的）时不换用。
   * 进行中的任务从同样的记录和同样的内容重放出来，照常继续。
   */
  function switchTo(key: string, location: string, id: string, keep: () => Promise<void>, read: () => Promise<ResolvedCourse>): Promise<"unchanged" | "busy" | "switched"> {
    return exclusive(async () => {
      if (stopped !== undefined) throw new RepaFault("course_switch_failed", stopped);
      if (current.kind === "ready" && current.key === key && current.entry.copy === id) return "unchanged";
      if (current.kind === "ready" && current.key !== key) {
        throw new RepaFault("second_course", `学习者正在学 ${current.entry.location ?? "随包"}的课，一个空间同时学几门课还没有做好，这一版没有换用。`);
      }
      const candidate = await read();
      if (current.kind === "ready" && await taskTopics(current.session) !== undefined && !onlyAdds(current.course, candidate)) return "busy";
      await keep();
      const entry: CourseEntry = { key, location, copy: id };
      const next = entries.some((item) => item.key === key) ? entries.map((item) => (item.key === key ? entry : item)) : [...entries, entry];
      await adopt(next, entry, () => store.load(id));
      return "switched";
    });
  }

  function unreadyState(): LearningState {
    const now = host.now();
    const goal = records.facts.findLast((fact) => fact.type === "goal");
    return {
      revision: records.revision,
      serverNow: now,
      started: records.facts.some((fact) => fact.type === "task"),
      course: null,
      task: null,
      menu: null,
      restrictions: { kind: "none", tutorAllowed: false, referenceContentAllowed: false },
      progress: emptyProgress(goal?.type === "goal" ? goal.xp : undefined, now, Intl.DateTimeFormat().resolvedOptions().timeZone),
    };
  }

  /** 没有可学的课时：状态与进度如实给出没有课（course 为 null），导出照常，其余方法以 course_unavailable 拒绝。 */
  function unreadyMethod(name: string, reason: string): unknown {
    if (name === "state.get") return unreadyState();
    if (name === "progress.get") {
      const state = unreadyState();
      return { serverNow: state.serverNow, progress: state.progress };
    }
    throw new RepaFault("course_unavailable", reason);
  }

  // ---------------------------------------------------------------------------
  // 做课：记下做课的会话、后台展开下一段、给前端整门课的状态与花费
  // ---------------------------------------------------------------------------

  /** 插件自己发起、不属于任何方法调用的工作；关闭时等它们结束。 */
  const background = new Set<Promise<unknown>>();
  function track(work: Promise<unknown>): void {
    // 这些工作的失败已经写进做课记录（展开）或无关紧要（检查要不要展开时读学习记录失败，下一次调用再看）。
    const settled = work.catch(() => undefined);
    background.add(settled);
    void settled.finally(() => background.delete(settled));
  }

  /**
   * 整门课里哪些部分学过取自学习记录，学完一节写的是学习记录，不经过做课。所以每写一条学习记录都看一次：
   * 学过的部分与最近一次交给前端的不同，就发 building.changed。前端还没读过做课的状态时不必发。
   * 看的时候排在这次写入之后（learnedTopics 走记录的串行入口），读到的是写完的状态。
   */
  let reportedLearned: string | undefined;
  const learnedKey = (learned: Set<string>) => [...learned].sort().join("\n");
  records.listen(() => {
    const ready = current;
    if (reportedLearned === undefined || ready.kind !== "ready" || ready.entry.location === undefined) return;
    track((async () => {
      const learned = learnedKey(await learnedTopics(ready));
      if (current !== ready || learned === reportedLearned) return;
      reportedLearned = learned;
      announceBuilding();
    })());
  });

  /**
   * 正在后台进行的展开；同一时刻只有一次。cancelled：在拿到运行的句柄之前就被要求取消。started 在拿到句柄（或没能开始）时兑现：
   * 后台运行开始时取每次运行的说明（view），要先知道它是哪门课的展开。
   */
  interface Expansion {
    key: string;
    topicIds: string[];
    startedAt: number;
    work?: AgentWork;
    cancelled: boolean;
    started: Promise<void>;
    done: Promise<void>;
  }
  let expansion: Expansion | undefined;

  /** 记下做课的会话：调用 course_check、course_confirm、course_use 的运行所在的会话。花费按这些会话（连同其中模型调用的子会话）汇总。 */
  async function rememberSession(key: string): Promise<void> {
    const run = currentRun();
    const record = await recordOf(key);
    if (run === undefined || record.sessions.includes(run.sessionId)) return;
    record.sessions.push(run.sessionId);
    await save(key);
    announceBuilding();
  }

  /** 展开没能进行或运行出错：记下原文，模型请求失败时连同底座的分类。 */
  function failed(error: unknown): NonNullable<NonNullable<BuildingRecord["last"]>["failure"]> {
    const failure = modelFailureOf(error);
    return { code: "failed", message: errorText(error), ...(failure === undefined ? {} : { failure }) };
  }

  /**
   * 在后台让通用 Agent 展开这几部分。失败如实记下原因，不重试。运行结束时看当前换用的那一版：
   * 这几部分（还在课里的）都已不是轮廓才算展开了；Agent 合并或删掉了某一部分，那一部分就不再计较。
   */
  function expand(ready: Ready & { entry: { location: string } }, record: BuildingRecord, topicIds: string[], learned: Set<string>): Expansion {
    let begun = () => {};
    const entry: Expansion = {
      key: ready.key, topicIds, startedAt: host.now(), cancelled: false, done: Promise.resolve(), started: new Promise((resolve) => { begun = resolve; }),
    };
    const last: NonNullable<BuildingRecord["last"]> = { topicIds, learned: learned.size, startedAt: entry.startedAt };
    record.last = last;
    expansion = entry;
    entry.done = (async () => {
      let failure: NonNullable<BuildingRecord["last"]>["failure"];
      try {
        await save(ready.key);
        announceBuilding();
        let work: AgentWork;
        try {
          work = await host.models.runAgent({ text: expansionTask(ready.course, ready.entry.location, topicIds, [...learned]) });
        } catch (error) {
          failure = failed(error);
          return;
        } finally {
          begun();
        }
        entry.work = work;
        last.sessionId = work.id;
        if (!record.sessions.includes(work.id)) record.sessions.push(work.id);
        await save(ready.key);
        announceBuilding();
        if (entry.cancelled) await work.cancel();
        try {
          await work.result;
        } catch (error) {
          // 取消过的运行（学习者取消，或应用关闭时宿主取消）以 cancelled 拒绝。
          failure = error instanceof RepaFault && error.code === "cancelled" ? { code: "cancelled" } : failed(error);
          return;
        }
        const now = current;
        const left = topicIds.filter((id) => now.kind !== "ready" || now.key !== ready.key || now.course.topics.find((topic) => topic.id === id)?.status === "outline");
        if (left.length > 0) failure = { code: "not_expanded" };
      } finally {
        begun();
        last.endedAt = host.now();
        if (failure) last.failure = failure;
        if (expansion === entry) expansion = undefined;
        await save(ready.key);
        announceBuilding();
      }
    })();
    track(entry.done);
    return entry;
  }

  /** 正在学的是一门自己的课（不是随包的课）时就是它。 */
  function ownReady(): (Ready & { entry: { location: string } }) | undefined {
    return current.kind === "ready" && current.entry.location !== undefined ? current as Ready & { entry: { location: string } } : undefined;
  }

  /**
   * 自动展开：已经展开过一段，学习者学到已展开部分只剩一节（或没有）没学，后面还有轮廓时，在后台展开接下来的部分。
   * 每个“学过几个 topic”只自动试一次，失败了不重试，等学习者再学完一节或明确要求；没有可用模型或关掉了自动展开时什么也不做。
   */
  let considering = false;
  async function maybeExpand(): Promise<void> {
    const ready = ownReady();
    if (expansion || considering || !settings.autoExpand || !ready) return;
    const outline = outlineTopics(ready.course);
    if (outline.length === 0 || host.models.defaultModel() === undefined) return;
    considering = true;
    try {
      const learned = await learnedTopics(ready);
      const record = await recordOf(ready.key);
      if (current !== ready || expansion) return;
      // 还一节都没有展开时，第一段由对话里的 Agent 在学习者认可轮廓以后展开，不在后台抢先做。
      const complete = completeTopics(ready.course);
      if (complete.length === 0 || complete.filter((id) => !learned.has(id)).length > 1) return;
      if (record.last?.learned === learned.size) return;
      expand(ready, record, outline.slice(0, EXPANSION_SIZE), learned);
    } finally {
      considering = false;
    }
  }

  /** 前端说的是哪门课：写了键就按键；没写时是正在学的那门自己的课，或空间里唯一的一门自己的课。 */
  function making(key: string | undefined): (CourseEntry & { location: string }) | undefined {
    const own = entries.filter((entry): entry is CourseEntry & { location: string } => entry.location !== undefined);
    if (key !== undefined) {
      const found = own.find((entry) => entry.key === key);
      if (!found) throw new RepaFault("course_not_found", "空间里没有这门课", { course: key });
      return found;
    }
    const ready = ownReady();
    return ready ? own.find((entry) => entry.key === ready.key) : own.length === 1 ? own[0] : undefined;
  }

  async function buildingState(key?: string): Promise<CourseBuilding> {
    const entry = making(key);
    // 随包的课不是在这个空间里做的，不算做课的状态。
    const ready = ownReady();
    const shown = ready && entry && ready.key === entry.key ? ready : undefined;
    const learned = shown ? await learnedTopics(shown) : new Set<string>();
    if (shown) reportedLearned = learnedKey(learned);
    const parts: CourseBuilding["parts"] = [];
    for (const id of shown?.course.course.topics ?? []) {
      const topic = shown?.course.topics.find((item) => item.id === id);
      if (!shown || !topic) continue;
      parts.push({
        topicId: id,
        title: topic.title,
        ...(topic.summary === undefined ? {} : { summary: topic.summary }),
        status: topic.status === "outline" ? "outline" : learned.has(id) ? "learned" : "ready",
        sources: topic.sources.map((use) => {
          const source = shown.course.course.sources[use.source];
          const url = use.url ?? source?.url;
          return {
            title: source?.title ?? use.source,
            // 课件的位置相对课的文件夹写；交给前端的是空间里的路径。
            ...(source?.file === undefined ? {} : { file: inLocation(shown.entry.location, source.file) }),
            ...(url === undefined ? {} : { url }),
            where: use.where,
          };
        }),
      });
    }
    const record = entry ? await recordOf(entry.key) : { sessions: [] } as BuildingRecord;
    const last = record.last;
    const running = expansion && entry && expansion.key === entry.key ? expansion : undefined;
    return {
      key: entry?.key ?? null,
      folder: entry?.location ?? null,
      course: shown ? { id: shown.course.course.id, title: shown.course.course.title, version: shown.course.course.version } : null,
      parts,
      expansion: running
        ? { topicIds: running.topicIds, startedAt: running.startedAt, sessionId: running.work?.id ?? null }
        : null,
      lastFailure: last?.failure && last.endedAt !== undefined
        ? { topicIds: last.topicIds, at: last.endedAt, ...last.failure }
        : null,
      cost: await host.models.usage(record.sessions),
      sessionId: record.conversation ?? null,
    };
  }

  /** 新建一门课：courses/<名>/，带一份空的要求（AGENTS.md），登记成草稿。这一步只在还没有课的空间里建第一门。 */
  async function createCourse(name: string): Promise<CourseEntry & { location: string }> {
    if (!validFolderName(name)) throw new RepaFault("invalid_name", "〔待写〕", { name });
    if (entries.length > 0 || (await courseFolders()).length > 0) {
      throw new RepaFault("course_exists", "〔待写〕");
    }
    const location = `${COURSES_FOLDER}/${name}`;
    await host.files.write(inLocation(location, "AGENTS.md"), "");
    const entry = await register(location);
    await recordOf(entry.key);
    announceBuilding();
    return entry;
  }

  /**
   * 记下学习者与之对话做课的会话，换掉以前的那一个（以前的仍算在花费里）。前端没有写课时是正在做的那门；空间里还没有课时
   * 先以空间的文件夹名新建一门（例如选已有的空文件夹作为空间时）。
   */
  async function begin(input: LearningInput<"building.begin">): Promise<LearningResult<"building.begin">> {
    const entry = making(input.course) ?? (entries.length === 0 ? await createCourse(path.basename(host.space.root)) : undefined);
    if (!entry) throw new RepaFault("course_required", "〔待写〕");
    const record = await recordOf(entry.key);
    record.conversation = input.sessionId;
    if (!record.sessions.includes(input.sessionId)) record.sessions.push(input.sessionId);
    await save(entry.key);
    announceBuilding();
    return { text: beginText(input.materials, input.request, entry.location) };
  }

  /**
   * 学习者明确要求展开：不看自动展开的设置，也不受“每个学过数只试一次”的限制。
   * 先读完学过的部分，此后到开始展开之间不再等待，两次同时到达的要求只有一次能开始。
   */
  async function requestExpansion(input: LearningInput<"building.expand">): Promise<CourseBuilding> {
    const before = ownReady();
    const learned = before ? await learnedTopics(before) : undefined;
    const record = before ? await recordOf(before.key) : undefined;
    const ready = ownReady();
    if (!ready || ready !== before || learned === undefined || record === undefined || (input.course !== undefined && input.course !== ready.key)) {
      throw new RepaFault("course_unavailable", "空间里还没有换用过一门自制的课");
    }
    if (expansion) throw new RepaFault("expansion_running", "已经有一次展开在进行", { topicIds: expansion.topicIds });
    if (host.models.defaultModel() === undefined) throw new RepaFault("model_required", "请选择可用模型");
    const outline = outlineTopics(ready.course);
    const topicIds = input.topicIds ?? outline.slice(0, EXPANSION_SIZE);
    const unknown = topicIds.filter((id) => !outline.includes(id));
    if (unknown.length > 0) throw new RepaFault("not_outline", "这些部分不在课里，或已经展开了", { topicIds: unknown });
    if (topicIds.length === 0) throw new RepaFault("nothing_to_expand", "课里已经没有轮廓部分");
    expand(ready, record, topicIds, learned);
    return buildingState(ready.key);
  }

  async function cancelExpansion(input: LearningInput<"building.cancel">): Promise<CourseBuilding> {
    const entry = expansion;
    if (entry && (input.course === undefined || input.course === entry.key)) {
      entry.cancelled = true;
      await entry.work?.cancel();
      await entry.done;
    }
    return buildingState(input.course);
  }

  /** 空间里的课：登记里的，正在学的那门带清单里的标题。canCreate：能不能在这里新建一门课（这一步只建第一门）。 */
  async function coursesState(): Promise<LearningCourses> {
    const own = await ownCourses();
    const missing = new Set(own.filter((entry) => entry.missing && entry.key !== undefined).map((entry) => entry.key));
    return {
      courses: entries.map((entry) => ({
        key: entry.key,
        folder: entry.location ?? null,
        bundled: entry.bundled !== undefined,
        title: current.kind === "ready" && current.key === entry.key ? current.course.course.title : null,
        learnable: entry.copy !== undefined || entry.bundled !== undefined,
        missing: missing.has(entry.key),
      })),
      canCreate: entries.length === 0 && own.length === 0,
    };
  }

  /**
   * 学习者选了随包的课：它成为空间里的一门课。这一步一个空间同时只学一门，已有可学的课时不再加。
   */
  function chooseBundled(): Promise<void> {
    return exclusive(async () => {
      if (stopped !== undefined) throw new RepaFault("course_switch_failed", stopped);
      if (current.kind === "ready" && current.key === BUNDLED) return;
      if (current.kind === "ready") throw new RepaFault("course_exists", "〔待写〕");
      const entry: CourseEntry = { key: BUNDLED, bundled: bundledName };
      await adopt([...entries, entry], entry, () => loadCourseSources(sources, host.files));
    });
  }

  const buildingMethods: Record<string, PluginMethod> = {
    "building.get": {
      parameters: learningMethods["building.get"].input,
      result: learningMethods["building.get"].result,
      invoke: (input) => buildingState((input as LearningInput<"building.get">).course),
    },
    "building.expand": {
      parameters: learningMethods["building.expand"].input,
      result: learningMethods["building.expand"].result,
      invoke: (input) => requestExpansion(input as LearningInput<"building.expand">),
    },
    "building.begin": {
      parameters: learningMethods["building.begin"].input,
      result: learningMethods["building.begin"].result,
      invoke: (input) => begin(input as LearningInput<"building.begin">),
    },
    "building.cancel": {
      parameters: learningMethods["building.cancel"].input,
      result: learningMethods["building.cancel"].result,
      invoke: (input) => cancelExpansion(input as LearningInput<"building.cancel">),
    },
    "courses.list": { parameters: learningMethods["courses.list"].input, result: learningMethods["courses.list"].result, invoke: () => coursesState() },
    "courses.create": {
      parameters: learningMethods["courses.create"].input,
      result: learningMethods["courses.create"].result,
      async invoke(input) {
        await createCourse((input as LearningInput<"courses.create">).name);
        return coursesState();
      },
    },
    "courses.useBundled": {
      parameters: learningMethods["courses.useBundled"].input,
      result: learningMethods["courses.useBundled"].result,
      async invoke() {
        await chooseBundled();
        return coursesState();
      },
    },
    "settings.get": { parameters: learningMethods["settings.get"].input, result: learningMethods["settings.get"].result, invoke: async () => settings },
    "settings.set": {
      parameters: learningMethods["settings.set"].input,
      result: learningMethods["settings.set"].result,
      async invoke(input) {
        settings = { ...(input as LearningInput<"settings.set">) };
        await saveSettings(host.space.dataDir, settings);
        track(maybeExpand());
        return settings;
      },
    },
  };

  const exported = connectExport(host, () => ({
    recordsFormat: LEARNING_FORMAT_VERSION,
    courses: current.kind === "ready" ? [{ key: current.key, id: current.course.course.id, version: current.course.course.version }] : [],
  }));
  const methods: Record<string, PluginMethod> = { ...exported.methods, ...buildingMethods };
  for (const name of Object.keys(learningMethods) as (keyof typeof learningMethods)[]) {
    if (Object.hasOwn(methods, name)) continue;
    methods[name] = {
      parameters: learningMethods[name].input,
      result: learningMethods[name].result,
      invoke: (input, context) => use(async (state) => {
        if (state.kind === "unready") return unreadyMethod(name, state.reason);
        const method = Object.hasOwn(state.methods, name) ? state.methods[name] : undefined;
        if (!method) throw new RepaFault("plugin_method_not_found", "插件方法不存在", { pluginId: "learning", methodName: name });
        try {
          const result = await method.invoke(input, context);
          return visibleLearningResponse(result, !state.session.restricted());
        } catch (error) {
          if (error instanceof RepaFault) {
            throw new RepaFault(error.code, error.message, visibleLearningResponse(error.details, !state.session.restricted()));
          }
          throw error;
        }
      }),
    };
  }

  /**
   * 对一门课的要求：它的文件夹里 AGENTS.md 的全文，连同这门课在哪个文件夹。空间根的 AGENTS.md（对所有学习的要求）底座已经交给每次运行。
   * 交给在做这门课的运行和讲这门课的辅导，别的课的要求不放；每次运行都带着，不靠模型自己去读，压缩以后也不丢。
   */
  async function requirements(location: string): Promise<string> {
    let text = "";
    try {
      text = await host.files.read(inLocation(location, "AGENTS.md"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof RepaFault && error.code === "not_found")) throw error;
    }
    return [
      `这次在做的是 ${location}/ 这门课：${courseFolder(location)}/ 是课程，${inLocation(location, "materials")}/ 是课件，${inLocation(location, "AGENTS.md")} 是学习者对这门课的要求。`,
      text.trim() === "" ? `${inLocation(location, "AGENTS.md")} 现在是空的。` : `${inLocation(location, "AGENTS.md")} 的全文：\n\n${text.trim()}`,
    ].join("\n\n");
  }

  const unavailable = (reason: string): MessageDecision => ({ status: "rejected", reason: "course_unavailable", message: reason });
  const hooks: TutorHooks = {
    beforeMessage: async (message) => (current.kind === "ready" ? current.tutor.hooks.beforeMessage(message) : unavailable(current.reason)),
    beforeRun: async () => (current.kind === "ready" ? current.tutor.hooks.beforeRun() : unavailable(current.reason)),
    async view() {
      if (current.kind !== "ready") return undefined;
      const view = await current.tutor.hooks.view();
      // 辅导讲的是这门课的题：带上这门课的要求。随包的课没有文件夹，也就没有另外的要求。
      const location = current.entry.location;
      if (location === undefined) return view;
      return [view, await requirements(location)].filter((part) => part !== undefined).join("\n\n");
    },
  };
  const tutorTools: Tool[] = TUTOR_TOOLS.map((spec) => ({
    ...spec,
    async execute(input, context) {
      if (current.kind === "unready") return { text: `还没有可学的课：${current.reason}。` };
      const tool = current.tutor.tools.find((entry) => entry.name === spec.name);
      if (!tool) throw new RepaFault("tool_not_found", `缺少工具 ${spec.name}`);
      return tool.execute(input, context);
    },
  }));

  /** 学习者现在学的是这门课的哪一份、学过哪些部分、后台是否正在展开，写给做课的 Agent。 */
  async function status(written: string | undefined): Promise<string> {
    let text: string;
    let key: string | undefined;
    try {
      ({ key } = await target(written));
    } catch {
      key = undefined;
    }
    const entry = entries.find((item) => item.key === key);
    const folder = entry?.location === undefined ? "这门课的 course" : courseFolder(entry.location);
    if (current.kind === "unready") {
      text = current.reason === NOT_BUILT ? `还没有可学的课，${folder}/ 还没有换用过一门通过检查的课` : current.reason;
    } else if (key !== undefined && current.key !== key) {
      text = `学习者现在学的不是这门课，${folder}/ 还没有换用过一门通过检查的课`;
    } else {
      const course = current.course.course;
      const origin = current.entry.location === undefined ? "随包的课程" : `${courseFolder(current.entry.location)}/ 换用过的那一版`;
      const learned = [...await learnedTopics(current)];
      text = `${origin}，课程 ${course.id} ${course.version}，topic ${current.course.topics.length} 个，其中轮廓 ${outlineTopics(current.course).length} 个`
        + `；学过的：${learned.length > 0 ? learned.join("、") : "还没有"}`;
    }
    if (expansion) text += `；后台正在展开 ${expansion.topicIds.join("、")}`;
    return `${text}。`;
  }

  /** 一门课的 course/ 的文件；还没有 course/ 时如实说明是哪个文件夹。 */
  async function courseFiles(written: string | undefined) {
    const { key, location } = await target(written);
    await rememberSession(key);
    const files = await readSpaceCourse(host.files, location);
    return { key, location, files, missing: { missing: courseFolder(location) } satisfies Missing };
  }

  const tools = [
    ...tutorTools,
    ...courseTools({
      async check(written) {
        const { location, files, missing } = await courseFiles(written);
        return files ? store.check(files, location, async (checked) => checked) : missing;
      },
      async use(written) {
        const { key, location, files, missing } = await courseFiles(written);
        if (!files) return missing;
        return store.check(files, location, async (checked, keep, read) => {
          if (!checked.passed) return { checked, outcome: "unchanged" as const };
          // 学习者只学每道由程序判分的题都核对过的课。
          if (checked.result.summary.confirmations.missing.length > 0) return { checked, outcome: "unconfirmed" as const };
          return { checked, outcome: await switchTo(key, location, checked.id, keep, read) };
        });
      },
      async confirm(written, topicIds, signal) {
        const { location, files, missing } = await courseFiles(written);
        const model = host.models.defaultModel();
        if (model === undefined) throw new RepaFault("model_required", "请选择可用模型");
        if (!files) return missing;
        // 请求经 host.models 在这次工具调用里发出，是做课会话的子会话，花费计入 building.get 的 cost。
        // 运行被中止时，还没发的请求立即以 cancelled 失败，已经一致的照样记下。
        const result = await store.confirm(files, location, {
          complete: (request) => host.models.complete({ system: request.system, prompt: request.prompt, model, signal }),
          model: `${model.provider}/${model.id}`,
          maxRequests: CONFIRM_REQUESTS,
          concurrency: CONFIRM_CONCURRENCY,
          topics: topicIds,
          date: localDate(host.now()),
          // 记录并进写入那一刻空间里的 topic 文件，经空间的文件接口写，归属这次运行。
          async save(topic, changed) {
            const file = `${courseFolder(location)}/${TOPICS_DIRECTORY}/${topic.topic.id}.yaml`;
            await host.files.write(file, mergeConfirmations(await host.files.read(file), file, changed));
          },
        });
        return { folder: courseFolder(location), result };
      },
      status,
      async brief(written, topicIds) {
        const { key, location } = await target(written);
        const ready = current;
        if (ready.kind !== "ready" || ready.key !== key) {
          return `学习者还没有可学的课，${courseFolder(location)}/ 还没有换用过一门通过检查的课，前面没有讲过的概念。`;
        }
        const unknown = topicIds.filter((id) => !ready.course.topics.some((topic) => topic.id === id));
        if (unknown.length > 0) {
          throw new RepaFault("invalid_input", `学习者现在学的这一版里没有 ${unknown.join("、")}；新加的部分先用 course_use 换用，再取它的轮廓`);
        }
        return expansionBrief(ready.course, location, topicIds, await learnedTopics(ready));
      },
    }),
  ];

  return {
    instructions: () => [
      "学习插件按课程安排学习者的课、复习和测验。",
      "每门课在空间里有自己的文件夹：其中 course/ 是课程，materials/ 是学习者放的课件，AGENTS.md 是学习者对这门课的要求；空间根的 AGENTS.md 是对所有学习的要求。",
      `课的文件夹是 ${COURSES_FOLDER}/<名>/。`,
      `学习者要把课件做成课，或者没有课件、只说了想学什么时，先用 read 读 ${COURSE_GUIDE}（它引用的示例课在 ${COURSE_EXAMPLE}），按其中的格式和顺序在这门课的 course/ 里写课，`
        + "用 course_check 检查，用 course_confirm 核对题目，用 course_use 让学习者用上；这几项工具的 course 写课的文件夹，在这门课的做课对话里可以不写。",
    ].join(""),
    tools: () => tools,
    agents: () => [tutorAgent(() => hooks)],
    methods,
    /**
     * 每次运行的说明：这次运行在做哪门课（它的做课对话、调用过它的做课工具，或它的后台展开），就给出那门课的文件夹与要求。
     * 后台展开刚开始、还不知道它的会话时，先等它拿到句柄。
     */
    async view() {
      const run = currentRun();
      if (run === undefined) return undefined;
      if (expansion && expansion.work === undefined) await expansion.started;
      const key = courseOfSession(run.sessionId);
      const location = entries.find((entry) => entry.key === key)?.location;
      return location === undefined ? undefined : requirements(location);
    },
    async close() {
      while (swapping) await Promise.allSettled([swapping]);
      // 宿主已经取消并等完后台展开的模型工作；这里等它把结局写进做课记录。
      while (background.size > 0) await Promise.allSettled([...background]);
      try {
        if (current.kind === "ready") await retire(current);
      } finally {
        await records.close();
      }
    },
  };
}
