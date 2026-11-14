import { readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RepaFault } from "@repa/base";
import { errorText } from "@repa/base/protocol";
import {
  checkFormat, currentRun, type AgentWork, type Host, type MessageDecision, type Plugin, type PluginInstance, type PluginMethod, type Tool,
} from "@repa/base/plugin";
import { completeTopics, EXPANSION_SIZE, expansionTask, openBuilding, outlineTopics, saveRecord, saveSettings, type BuildingRecord } from "./course-building.js";
import { COURSE_GUIDE, courseTools } from "./course-tools.js";
import { loadCourseSources, type CourseSource, type ResolvedCourse } from "./course-sources.js";
import { connectExport } from "./export.js";
import { connectLearning } from "./flow.js";
import { emptyProgress } from "./progress.js";
import { learningMethods, type CourseBuilding, type LearningInput, type LearningState } from "./protocol.js";
import { LearningRecords, RECORDS_FILE } from "./records.js";
import { LearningSession } from "./session.js";
import { CHECKS, CourseStore, hasSpaceCourse, keepsTask, readSpaceCourse, SPACE_COURSE } from "./space-course.js";
import { visibleLearningResponse } from "./submission-visibility.js";
import { connectTutor, TUTOR_AGENT, TUTOR_TOOLS, tutorAgent, type Tutor, type TutorHooks } from "./tutor.js";

/** 学习记录的格式版本：2 起只记事实，3 起每项任务带课程的标识与版本。此前版本的开发数据不转换，提示删除后重新打开。 */
export const LEARNING_FORMAT_VERSION = 3;

/** 时间一律取自底座的 host.now()，插件不另设时钟；测试通过宿主的 now 拨动时间。 */
export interface LearningPluginOptions {
  /** 空间里没有 course/ 时用的课程；缺省为随包的 Python 课。 */
  sources?: CourseSource[];
  /** course_check 运行 Python 核对时用的离线 Pyodide 包目录；缺省见 @repa/python-runner 的 defaultPackagesDirectory。 */
  packagesDirectory?: string;
  /** 默认装配教学流程；测试等自定义接入复用同一个学习会话。换用课程时为新的会话再调用一次。 */
  connect?: (session: LearningSession, host: Host) => Promise<Pick<PluginInstance, "methods" | "close">>;
}

/** 有一门可学的课：学习会话和绑在它上面的教学方法与辅导。space 为副本的摘要，课来自空间的 course/ 时才有。 */
interface Ready {
  kind: "ready";
  space?: string;
  course: ResolvedCourse;
  session: LearningSession;
  methods: Record<string, PluginMethod>;
  close?: () => Promise<void>;
  tutor: Tutor;
}
/** 空间里有 course/，但还没有换用过一门通过检查的课，或换用的副本打不开。 */
interface Unready {
  kind: "unready";
  reason: string;
}
type Current = Ready | Unready;

const NOT_BUILT = "这个空间的课还没有做好";

/**
 * 创建学习插件。打开时核对数据目录的格式标记，读入学习记录，再按空间决定学哪门课：换用过空间里的课，就学换用的那一份；
 * 空间里有 course/ 而还没有换用过，就没有可学的课；都没有时学随包的课程。方法的返回值和错误都经同一处按当前限制隐藏反馈。
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
      if (await checkFormat(format, LEARNING_FORMAT_VERSION) < LEARNING_FORMAT_VERSION) {
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

async function openLearning(host: Host, records: LearningRecords, options: LearningPluginOptions): Promise<PluginInstance> {
  const store = new CourseStore(host.space.dataDir, options.packagesDirectory === undefined ? {} : { packagesDirectory: options.packagesDirectory });
  const sources = options.sources ?? [{ kind: "bundled", directory: fileURLToPath(new URL("../courses/python/", import.meta.url)) }];

  async function build(course: ResolvedCourse, space?: string): Promise<Ready> {
    const session = await LearningSession.open(records, course, host);
    try {
      const connected = await (options.connect
        ? options.connect(session, host)
        : connectLearning(session, { beforeRestricted: () => host.abortAgent(TUTOR_AGENT) }));
      const tutor = await connectTutor(session);
      return {
        kind: "ready",
        ...(space === undefined ? {} : { space }),
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
  async function buildSpace(id: string): Promise<Current> {
    try {
      return await build(await store.load(id), id);
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

  /** 学习者学过的 topic：学生模型里有记录的，与进度里的 completedTopics 是同一个集合。 */
  function learnedTopics(session: LearningSession): Promise<Set<string>> {
    return session.records.serial(async () => {
      session.replay.settle(session.clock());
      return new Set(Object.keys(session.replay.fold().student));
    });
  }

  let current: Current;
  const active = await store.active();
  if (active) {
    current = await buildSpace(active);
  } else {
    current = await build(await loadCourseSources(sources, host.files));
    // 空间里有 course/ 而还没有换用过：没有可学的课。学习者在随包的课里还有做到一半的任务时，先让他做完，下次打开再说。
    if (await hasSpaceCourse(host.files) && (await taskTopics(current.session)) === undefined) {
      await retire(current);
      current = { kind: "unready", reason: NOT_BUILT };
    }
  }

  // 换用要在没有方法调用进行时进行：调用开始时取当前的课，换用等进行中的调用结束，换用期间新的调用等它完成。
  // 否则一次调用可能在“判定学习者不忙”之后按旧课开始任务。辅导的工具和提问前的判断只读不写学习记录，不必等；
  // 也不能等：开始作答的方法会中止辅导，辅导若在等换用就互相等住。
  let swapping: Promise<unknown> | undefined;
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
   * 换用检查过的这一份。学习者有做到一半的任务时，只有任务涉及的内容在新的一版里没有变（只增不改）才换，否则不换。
   * 旧会话先退下：等它在途的判分写完，再按新的一份打开，新会话读到这些判分，按改过的答案该重判的照常重判；
   * 进行中的任务从同样的记录和同样的内容重放出来，照常继续。
   */
  function switchTo(id: string, keep: () => Promise<void>, read: () => Promise<ResolvedCourse>): Promise<"unchanged" | "busy" | "switched"> {
    return exclusive(async () => {
      if (current.kind === "ready" && current.space === id) return "unchanged";
      if (current.kind === "ready") {
        const topics = await taskTopics(current.session);
        if (topics !== undefined && !keepsTask(current.course, await read(), topics)) return "busy";
      }
      await keep();
      if (current.kind === "ready") await retire(current);
      const next = await buildSpace(id);
      current = next;
      await store.activate(id);
      if (next.kind === "unready") {
        host.emit({ type: "learning.changed", revision: records.revision, taskId: null, menuId: null });
        announceBuilding();
        throw new RepaFault("course_switch_failed", `检查通过，但换用出错：${next.reason}`);
      }
      next.session.announce();
      announceBuilding();
      return "switched";
    });
  }

  function unreadyState(): LearningState {
    const now = host.now();
    const goal = records.facts.findLast((fact) => fact.type === "goal");
    return {
      revision: records.revision,
      serverNow: now,
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

  const building = await openBuilding(host.space.dataDir);
  const record: BuildingRecord = building.record;
  let settings = building.settings;
  // 记录整份写入；后发起的写入排在先发起的之后，盘上不会留下较旧的一份。
  let saving: Promise<void> = Promise.resolve();
  function save(): Promise<void> {
    const snapshot = structuredClone(record);
    const next = saving.then(() => saveRecord(host.space.dataDir, snapshot));
    saving = next.catch(() => undefined);
    return next;
  }
  // 上次应用关掉时还在进行的展开已经停了：如实记为取消。
  if (record.last && record.last.endedAt === undefined) {
    record.last.endedAt = host.now();
    record.last.failure = { code: "cancelled" };
    await save();
  }

  function announceBuilding(): void {
    host.emit({ type: "building.changed" });
  }

  /** 插件自己发起、不属于任何方法调用的工作；关闭时等它们结束。 */
  const background = new Set<Promise<unknown>>();
  function track(work: Promise<unknown>): void {
    // 这些工作的失败已经写进做课记录（展开）或无关紧要（检查要不要展开时读学习记录失败，下一次调用再看）。
    const settled = work.catch(() => undefined);
    background.add(settled);
    void settled.finally(() => background.delete(settled));
  }

  /** 正在后台进行的展开；同一时刻只有一次。 */
  interface Expansion {
    topicIds: string[];
    startedAt: number;
    work?: AgentWork;
    cancelled: boolean;
    done: Promise<void>;
  }
  let expansion: Expansion | undefined;

  /** 记下做课的会话：调用 course_check、course_use 的运行所在的会话。花费按这些会话汇总。 */
  async function rememberSession(): Promise<void> {
    const run = currentRun();
    if (run === undefined || record.sessions.includes(run.sessionId)) return;
    record.sessions.push(run.sessionId);
    await save();
    announceBuilding();
  }

  /**
   * 在后台让通用 Agent 展开这几部分。失败如实记下原因，不重试。运行结束时看当前换用的那一版：
   * 这几部分（还在课里的）都已不是轮廓才算展开了；Agent 合并或删掉了某一部分，那一部分就不再计较。
   */
  function expand(ready: Ready, topicIds: string[], learned: Set<string>): Expansion {
    const entry: Expansion = { topicIds, startedAt: host.now(), cancelled: false, done: Promise.resolve() };
    const last: NonNullable<BuildingRecord["last"]> = { topicIds, learned: learned.size, startedAt: entry.startedAt };
    record.last = last;
    expansion = entry;
    entry.done = (async () => {
      let failure: NonNullable<BuildingRecord["last"]>["failure"];
      try {
        await save();
        announceBuilding();
        let work: AgentWork;
        try {
          work = await host.models.runAgent({ text: expansionTask(ready.course, topicIds, [...learned]) });
        } catch (error) {
          failure = { code: "start_failed", message: errorText(error) };
          return;
        }
        entry.work = work;
        last.sessionId = work.id;
        if (!record.sessions.includes(work.id)) record.sessions.push(work.id);
        await save();
        announceBuilding();
        if (entry.cancelled) await work.cancel();
        try {
          await work.result;
        } catch (error) {
          const cancelled = entry.cancelled || (error instanceof RepaFault && error.code === "cancelled");
          failure = { code: cancelled ? "cancelled" : "run_failed", message: errorText(error) };
          return;
        }
        // 取消以后 Pi 的运行可能照常结束，不报错；学习者取消的就记为取消。
        if (entry.cancelled) {
          failure = { code: "cancelled" };
          return;
        }
        const now = current;
        const left = topicIds.filter((id) => now.kind !== "ready" || now.course.topics.find((topic) => topic.id === id)?.status === "outline");
        if (left.length > 0) failure = { code: "not_expanded" };
      } finally {
        last.endedAt = host.now();
        if (failure) last.failure = failure;
        if (expansion === entry) expansion = undefined;
        await save();
        announceBuilding();
      }
    })();
    track(entry.done);
    return entry;
  }

  /**
   * 自动展开：已经展开过一段，学习者学到已展开部分只剩一节（或没有）没学，后面还有轮廓时，在后台展开接下来的部分。
   * 每个“学过几个 topic”只自动试一次，失败了不重试，等学习者再学完一节或明确要求；没有可用模型或关掉了自动展开时什么也不做。
   */
  let considering = false;
  async function maybeExpand(): Promise<void> {
    const ready = current;
    if (expansion || considering || !settings.autoExpand || ready.kind !== "ready" || ready.space === undefined) return;
    const outline = outlineTopics(ready.course);
    if (outline.length === 0 || host.models.defaultModel() === undefined) return;
    considering = true;
    try {
      const learned = await learnedTopics(ready.session);
      if (current !== ready || expansion) return;
      // 还一节都没有展开时，第一段由对话里的 Agent 在学习者认可轮廓以后展开，不在后台抢先做。
      const complete = completeTopics(ready.course);
      if (complete.length === 0 || complete.filter((id) => !learned.has(id)).length > 1) return;
      if (record.last?.learned === learned.size) return;
      expand(ready, outline.slice(0, EXPANSION_SIZE), learned);
    } finally {
      considering = false;
    }
  }

  async function buildingState(): Promise<CourseBuilding> {
    const ready = current.kind === "ready" ? current : undefined;
    const learned = ready ? await learnedTopics(ready.session) : new Set<string>();
    const parts: CourseBuilding["parts"] = [];
    for (const id of ready?.course.course.topics ?? []) {
      const topic = ready?.course.topics.find((entry) => entry.id === id);
      if (!ready || !topic) continue;
      parts.push({
        topicId: id,
        title: topic.title,
        ...(topic.summary === undefined ? {} : { summary: topic.summary }),
        status: topic.status === "outline" ? "outline" : learned.has(id) ? "learned" : "ready",
        sources: topic.sources.map((use) => {
          const source = ready.course.course.sources[use.source];
          const url = use.url ?? source?.url;
          return {
            title: source?.title ?? use.source,
            ...(source?.file === undefined ? {} : { file: source.file }),
            ...(url === undefined ? {} : { url }),
            where: use.where,
          };
        }),
      });
    }
    const last = record.last;
    return {
      course: ready ? { id: ready.course.course.id, title: ready.course.course.title, version: ready.course.course.version } : null,
      parts,
      expansion: expansion
        ? { topicIds: expansion.topicIds, startedAt: expansion.startedAt, sessionId: expansion.work?.id ?? null }
        : null,
      lastFailure: last?.failure && last.endedAt !== undefined
        ? { topicIds: last.topicIds, at: last.endedAt, code: last.failure.code, ...(last.failure.message === undefined ? {} : { message: last.failure.message }) }
        : null,
      cost: await host.models.usage(record.sessions),
    };
  }

  /** 学习者明确要求展开：不看自动展开的设置，也不受“每个学过数只试一次”的限制。 */
  async function requestExpansion(input: LearningInput<"building.expand">): Promise<CourseBuilding> {
    const ready = current;
    if (ready.kind !== "ready" || ready.space === undefined) throw new RepaFault("course_unavailable", "空间里还没有换用过一门自制的课");
    if (expansion) throw new RepaFault("expansion_running", "已经有一次展开在进行", { topicIds: expansion.topicIds });
    if (host.models.defaultModel() === undefined) throw new RepaFault("model_required", "请选择可用模型");
    const outline = outlineTopics(ready.course);
    const topicIds = input.topicIds ?? outline.slice(0, EXPANSION_SIZE);
    const unknown = topicIds.filter((id) => !outline.includes(id));
    if (unknown.length > 0) throw new RepaFault("not_outline", "这些部分不在课里，或已经展开了", { topicIds: unknown });
    if (topicIds.length === 0) throw new RepaFault("nothing_to_expand", "课里已经没有轮廓部分");
    expand(ready, topicIds, await learnedTopics(ready.session));
    return buildingState();
  }

  async function cancelExpansion(): Promise<CourseBuilding> {
    const entry = expansion;
    if (entry) {
      entry.cancelled = true;
      await entry.work?.cancel();
      await entry.done;
    }
    return buildingState();
  }

  const buildingMethods: Record<string, PluginMethod> = {
    "building.get": { parameters: learningMethods["building.get"].input, result: learningMethods["building.get"].result, invoke: () => buildingState() },
    "building.expand": {
      parameters: learningMethods["building.expand"].input,
      result: learningMethods["building.expand"].result,
      invoke: (input) => requestExpansion(input as LearningInput<"building.expand">),
    },
    "building.cancel": { parameters: learningMethods["building.cancel"].input, result: learningMethods["building.cancel"].result, invoke: () => cancelExpansion() },
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
    course: current.kind === "ready" ? { id: current.course.course.id, version: current.course.course.version } : null,
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

  const unavailable = (reason: string): MessageDecision => ({ status: "rejected", reason: "course_unavailable", message: reason });
  const hooks: TutorHooks = {
    beforeMessage: async (message) => (current.kind === "ready" ? current.tutor.hooks.beforeMessage(message) : unavailable(current.reason)),
    beforeRun: async () => (current.kind === "ready" ? current.tutor.hooks.beforeRun() : unavailable(current.reason)),
    view: async () => (current.kind === "ready" ? current.tutor.hooks.view() : undefined),
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

  /** 学习者现在学的是哪一份、学过哪些部分、后台是否正在展开，写给做课的 Agent。 */
  async function status(): Promise<string> {
    let text: string;
    if (current.kind === "unready") {
      text = current.reason === NOT_BUILT ? `还没有可学的课，${SPACE_COURSE}/ 还没有换用过一门通过检查的课` : current.reason;
    } else {
      const course = current.course.course;
      const origin = current.space ? `${SPACE_COURSE}/ 换用过的那一版` : "随包的课程";
      const learned = [...await learnedTopics(current.session)];
      text = `${origin}，课程 ${course.id} ${course.version}，topic ${current.course.topics.length} 个，其中轮廓 ${outlineTopics(current.course).length} 个`
        + `；学过的：${learned.length > 0 ? learned.join("、") : "还没有"}`;
    }
    if (expansion) text += `；后台正在展开 ${expansion.topicIds.join("、")}`;
    return `${text}。`;
  }

  const tools = [
    ...tutorTools,
    ...courseTools({
      async check() {
        await rememberSession();
        const files = await readSpaceCourse(host.files);
        return files && store.check(files, async (checked) => checked);
      },
      async use() {
        await rememberSession();
        const files = await readSpaceCourse(host.files);
        return files && store.check(files, async (checked, keep, read) => ({
          checked,
          outcome: checked.passed ? await switchTo(checked.id, keep, read) : "unchanged" as const,
        }));
      },
      status,
    }),
  ];

  return {
    instructions: () => [
      "学习插件按课程安排学习者的课、复习和测验。",
      `学习者要把放进 materials/ 的课件做成课时，先用 read 读 ${COURSE_GUIDE}，按其中的格式和顺序在 ${SPACE_COURSE}/ 里写课，用 course_check 检查，用 course_use 让学习者用上。`,
    ].join(""),
    tools: () => tools,
    agents: () => [tutorAgent(() => hooks)],
    methods,
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
