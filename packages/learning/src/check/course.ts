import { RuntimeProblem } from "@repa/python-runner";
import type { Runtime as RunningRuntime } from "@repa/python-runner/protocol";
import type { RunTests } from "../code-tests.js";
import { Report, type Diagnostic } from "../format/diagnostics.js";
import { loadCourse } from "../format/load.js";
import { checkTopicCode, type CodeStats } from "./code.js";
import { PythonUnavailable, runtimeMismatches, sandboxPython, type CheckPython, type CheckRun } from "./python.js";
import type { ConfirmationScope } from "../format/schema.js";
import { checkConfirmations, checkReferences, type ConfirmationMode, type ConfirmationSummary } from "./questions.js";
import { checkRules, teachesPython, usesPython } from "./rules.js";
import { topicQuestions } from "./items.js";

/** checkCourse 的选项：是否运行代码核对、在哪里运行、离线包位置、问题里路径的显示基准，以及只核对哪些 topic 的代码。 */
export interface CheckOptions {
  /** 是否在 Pyodide 里运行核对与测试，缺省为 true。 */
  run?: boolean;
  /**
   * 能运行课程核对的几处，按顺序用第一处能用的；缺省只有 Linux 沙箱（命令行）。应用里是 Linux 沙箱，再是前端页面的 python.run。
   * 都用不了时报 python_unavailable，不运行。
   */
  python?: CheckPython[];
  /** 离线 Pyodide 包所在目录，缺省见 @repa/python-runner 的 defaultPackagesDirectory。 */
  packagesDirectory?: string;
  /** 问题里文件路径的显示基准，缺省为当前目录。 */
  base?: string;
  timeoutMs?: number;
  /** 只对这些 topic 运行代码核对；结构和交叉规则仍检查整门课。缺省核对全部 topic。 */
  topics?: string[];
  /** 按哪种范围要求模型核对记录，缺省 question-runtime-v1（随包课程）；空间里自制的课用 question-lesson-v1。 */
  scope?: ConfirmationScope;
  /**
   * 缺模型核对记录时：required（缺省）报错，要先运行 course:confirm；reported 只记进 summary.confirmations，不报错，
   * 用于应用里做课：course_check 照常通过，course_use 看到缺记录时不换用。
   */
  confirmations?: ConfirmationMode;
}

/** 一次课程检查的统计：topic 与题目数、要模型核对的题、代码核对是否运行，以及启动解释器等代价计数。 */
export interface CheckSummary {
  course?: { id: string; version: string };
  topics: { complete: number; outline: number };
  questions: number;
  /** 按检查的核对范围，要模型核对的题有多少、哪些缺当前记录；清单读不出时为空。 */
  confirmations: ConfirmationSummary;
  /** 课里有没有要在 Python 里运行的题（verify、代码题、带测试的排列题）；没有就不启动沙箱。 */
  python: boolean;
  /** 代码核对是否真的运行了。 */
  ran: boolean;
  /** 在哪里运行的：sandbox 是 Linux 沙箱，frontend 是前端页面的 Worker。 */
  where?: CheckRun["where"];
  /** Repa 的 Python 环境的版本。 */
  runtime?: RunningRuntime;
  /** 核对时测试引入、因而加载的包，按名字排序；只用标准库的课为空。 */
  loaded: string[];
  code: CodeStats;
}

/** 课程检查的结果：发现的全部问题和统计。 */
export interface CheckResult {
  diagnostics: Diagnostic[];
  summary: CheckSummary;
}

/** 检查一门课程：读取与 schema、交叉规则、标准答案自洽，课里有要运行 Python 的题时，最后在沙箱或前端页面里运行核对与测试。 */
export async function checkCourse(root: string, options: CheckOptions = {}): Promise<CheckResult> {
  const report = new Report();
  const code: CodeStats = { verifyJobs: 0, verifiedSlots: 0, testRuns: 0, interpreterStarts: 0 };
  const scope = options.scope ?? "question-runtime-v1";
  const summary: CheckSummary = {
    topics: { complete: 0, outline: 0 }, questions: 0, confirmations: { scope, questions: 0, missing: [] }, python: false, ran: false, loaded: [], code,
  };
  const loaded = await loadCourse(root, report, options.base);
  if (!loaded) return { diagnostics: report.diagnostics, summary };
  summary.course = { id: loaded.course.id, version: loaded.course.version };
  for (const { topic } of loaded.topics) {
    summary.topics[topic.status] += 1;
    summary.questions += topicQuestions(topic).length;
  }
  checkRules(loaded, report);
  await checkReferences(loaded, report);
  summary.confirmations = await checkConfirmations(loaded, report, scope, options.confirmations ?? "required");
  const topics = loaded.topics.map(({ topic }) => topic);
  summary.python = usesPython(topics);
  // 不用 Python 的课不启动沙箱。核对在 Repa 自己的 Python 环境里运行，只有 verify 的课不必写 runtime；
  // 有代码题的课没写 runtime 时，规则检查已报 runtime_missing，没有前导可用，不运行。
  const expected = loaded.course.runtime;
  if (options.run === false || !summary.python || (!expected && teachesPython(topics))) return { diagnostics: report.diagnostics, summary };
  // 问题挂在清单的 runtime 上；没写 runtime 的课挂在清单本身。
  const at = expected ? ["runtime"] : [];

  // 按顺序用第一处能用的 Python；离线包缺失或摘要不符是安装的问题，照常报告，不换下一处。
  const reasons: string[] = [];
  let running: CheckRun | undefined;
  for (const python of options.python ?? [sandboxPython]) {
    try {
      running = await python(options);
      break;
    } catch (error) {
      if (error instanceof RuntimeProblem) {
        report.error(error.code, error.message, loaded.file, at);
        return { diagnostics: report.diagnostics, summary };
      }
      if (!(error instanceof PythonUnavailable)) throw error;
      reasons.push(error.message);
    }
  }
  if (!running) {
    report.error("python_unavailable", `${reasons.join("；")}。课里的 verify 核对程序和代码题没能运行，所以没有核对`, loaded.file, at);
    return { diagnostics: report.diagnostics, summary };
  }
  const packages = new Set<string>();
  const run: RunTests = async (tests) => {
    const batch = await running.run(tests);
    for (const name of batch.loaded ?? []) packages.add(name);
    return batch;
  };
  try {
    summary.where = running.where;
    summary.runtime = running.runtime;
    const mismatches = expected ? runtimeMismatches(expected, running.runtime) : [];
    if (mismatches.length > 0) {
      report.error("runtime_mismatch", `课程清单的 runtime 与 Repa 的 Python 环境不一致：${mismatches.join("、")}`, loaded.file, at);
      return { diagnostics: report.diagnostics, summary };
    }
    summary.ran = true;
    for (const topic of loaded.topics) {
      if (options.topics && !options.topics.includes(topic.topic.id)) continue;
      await checkTopicCode(topic, run, report, code, expected?.prelude ?? "");
    }
  } catch (error) {
    // 前端页面在核对中途断开、没有回应或失败：已经得到的结论照常报告，其余没有核对，整个检查不算通过。
    if (!(error instanceof PythonUnavailable)) throw error;
    summary.ran = false;
    report.error("python_unavailable", `${error.message}。课里的 verify 核对程序和代码题没有全部运行，所以没有核对完`, loaded.file, at);
  } finally {
    summary.loaded = [...packages].sort();
    code.interpreterStarts = running.starts();
    await running.close();
  }
  return { diagnostics: report.diagnostics, summary };
}
