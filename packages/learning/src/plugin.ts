import { readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RepaFault } from "@repa/base";
import { checkFormat, type Host, type MessageDecision, type Plugin, type PluginInstance, type PluginMethod, type Tool } from "@repa/base/plugin";
import { COURSE_GUIDE, courseTools } from "./course-tools.js";
import { loadCourseSources, type CourseSource, type ResolvedCourse } from "./course-sources.js";
import { connectExport } from "./export.js";
import { connectLearning } from "./flow.js";
import { DEFAULT_DAILY_GOAL_XP } from "./parameters.js";
import { dayFormat } from "./progress.js";
import { learningMethods, type LearningState } from "./protocol.js";
import { LearningRecords, RECORDS_FILE } from "./records.js";
import { LearningSession } from "./session.js";
import { CHECKS, CourseStore, hasSpaceCourse, readSpaceCourse, SPACE_COURSE } from "./space-course.js";
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

  const choice = await store.choice();
  let current: Current;
  if (choice.active) {
    current = await buildSpace(choice.active);
  } else if (await hasSpaceCourse(host.space.root)) {
    current = { kind: "unready", reason: NOT_BUILT };
  } else {
    current = await build(await loadCourseSources(sources, host.files));
  }

  // 换用要在没有方法调用进行时进行：调用开始时取当前的课，换用等进行中的调用结束，换用期间新的调用等它完成。
  // 辅导的工具和提问前的判断只读不写学习记录，不必等；也不能等：开始作答的方法会中止辅导，辅导若在等换用就互相等住。
  let pending = choice.pending !== undefined;
  let swapping: Promise<void> | undefined;
  let closing = false;
  let swapError: string | undefined;
  const active = new Set<Promise<unknown>>();
  const background = new Set<Promise<unknown>>();
  const track = (work: Promise<unknown>) => {
    background.add(work);
    void work.finally(() => background.delete(work));
  };

  /** 学习者有做到一半的任务：课、复习或测验开始了还没结束。 */
  function busy(session: LearningSession): Promise<boolean> {
    return session.records.serial(async () => {
      session.replay.settle(session.clock());
      const evidence = session.replay.currentEvidence();
      return evidence !== undefined && evidence.outcome === undefined;
    });
  }

  /** 有检查通过、等着换用的课，而且学习者没有做到一半的任务时，换用它，再通知前端重新读取状态。 */
  function applyPending(): Promise<void> {
    swapping ??= (async () => {
      try {
        while (active.size > 0) await Promise.allSettled([...active]);
        let previous: Ready | undefined;
        let switched = false;
        await store.apply(async (id) => {
          if (closing || (current.kind === "ready" && await busy(current.session))) return false;
          previous = current.kind === "ready" ? current : undefined;
          current = await buildSpace(id);
          switched = true;
          return true;
        });
        pending = (await store.choice()).pending !== undefined;
        swapError = undefined;
        if (!switched) return;
        if (current.kind === "ready") {
          current.session.announce();
        } else {
          host.emit({ type: "learning.changed", revision: records.revision, taskId: null, menuId: null });
        }
        // 旧会话等在途判分写完再停止跟随学习记录；两个会话判同一份作答时，后写的一方在串行入口里发现已经判过而不写。
        if (previous) track(retire(previous));
      } catch (error) {
        swapError = error instanceof Error ? error.message : String(error);
      } finally {
        swapping = undefined;
      }
    })();
    return swapping;
  }

  async function use<T>(action: (state: Current) => Promise<T>): Promise<T> {
    while (swapping) await swapping;
    const work = action(current);
    active.add(work);
    try {
      return await work;
    } finally {
      active.delete(work);
      if (pending && active.size === 0 && !closing) track(applyPending());
    }
  }

  function unreadyState(): LearningState {
    const now = host.now();
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const goal = records.facts.findLast((fact) => fact.type === "goal");
    return {
      revision: records.revision,
      serverNow: now,
      course: null,
      task: null,
      menu: null,
      restrictions: { kind: "none", tutorAllowed: false, referenceContentAllowed: false },
      progress: {
        day: dayFormat(timeZone).format(now),
        timeZone,
        dailyGoalXp: goal?.type === "goal" ? goal.xp : DEFAULT_DAILY_GOAL_XP,
        todayXp: 0,
        totalXp: 0,
        completedTopics: 0,
        totalTopics: 0,
        completionRate: 0,
        etaDate: null,
      },
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

  const exported = connectExport(host, () => ({
    recordsFormat: LEARNING_FORMAT_VERSION,
    course: current.kind === "ready" ? { id: current.course.course.id, version: current.course.course.version } : null,
  }));
  const methods: Record<string, PluginMethod> = { ...exported.methods };
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

  /** 学习者现在学的是哪一份，写给做课的 Agent。 */
  function status(): string {
    let text: string;
    if (current.kind === "unready") {
      text = current.reason === NOT_BUILT ? `还没有可学的课，${SPACE_COURSE}/ 还没有换用过一门通过检查的课` : current.reason;
    } else {
      const course = current.course.course;
      const origin = current.space ? `${SPACE_COURSE}/ 换用过的那一版` : "随包的课程";
      text = `${origin}，课程 ${course.id} ${course.version}，topic ${current.course.topics.length} 个`;
    }
    if (pending) text += "；检查通过的新一版等学习者做完当前任务再换用";
    if (swapError) text += `；上一次换用出错：${swapError}`;
    return `${text}。`;
  }

  const tools = [
    ...tutorTools,
    ...courseTools({
      async check() {
        const files = await readSpaceCourse(host.files);
        return files && store.check(files);
      },
      async use() {
        const files = await readSpaceCourse(host.files);
        if (!files) return undefined;
        const checked = await store.propose(files);
        if (!checked.passed) return { checked, outcome: "unchanged" };
        if ((await store.choice()).pending !== checked.id) return { checked, outcome: "unchanged" };
        pending = true;
        while (swapping) await swapping;
        await applyPending();
        const after = await store.choice();
        if (after.pending === checked.id) return { checked, outcome: "deferred" };
        if (swapError) throw new RepaFault("course_switch_failed", `检查通过，但换用出错：${swapError}`);
        return { checked, outcome: "switched" };
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
      closing = true;
      while (swapping) await swapping;
      while (background.size > 0) await Promise.allSettled([...background]);
      try {
        if (current.kind === "ready") await retire(current);
      } finally {
        await records.close();
      }
    },
  };
}
