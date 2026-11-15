import { RuntimeProblem } from "@repa/python-runner";
import type { Runtime as RunningRuntime } from "@repa/python-runner/protocol";
import { Report, type Diagnostic } from "../format/diagnostics.js";
import { loadCourse } from "../format/load.js";
import { checkTopicCode, type CodeStats } from "./code.js";
import { PythonUnavailable, runtimeMismatches, sandboxPython, type CheckPython, type CheckRun } from "./python.js";
import { checkReferences, type ConfirmationMode } from "./questions.js";
import { checkRules, usesPython } from "./rules.js";
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
  /**
   * 复习和测验题里 manual 作答位的模型核对记录：required（缺省）缺了就报错，要先运行 course:confirm；
   * reported 只记进 summary.confirmationSlots，不报错，用于应用里做课，那里没有 course:confirm。
   */
  confirmations?: ConfirmationMode;
}

/** 一次课程检查的统计：topic 与题目数、要模型核对的作答位、代码核对是否运行，以及启动解释器等代价计数。 */
export interface CheckSummary {
  course?: { id: string; version: string };
  topics: { complete: number; outline: number };
  questions: number;
  /** 复习和测验题池里由模型核对的作答位，写成“题目 id/作答位 id”；缺少当前版本记录的另作为错误报告。 */
  confirmationSlots: string[];
  /** 课里有没有要在 Python 里运行的题（verify、代码题、带测试的排列题）；没有就不启动沙箱。 */
  python: boolean;
  /** 代码核对是否真的运行了。 */
  ran: boolean;
  /** 在哪里运行的：sandbox 是 Linux 沙箱，frontend 是前端页面的 Worker。 */
  where?: CheckRun["where"];
  runtime?: RunningRuntime;
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
  const summary: CheckSummary = { topics: { complete: 0, outline: 0 }, questions: 0, confirmationSlots: [], python: false, ran: false, code };
  const loaded = await loadCourse(root, report, options.base);
  if (!loaded) return { diagnostics: report.diagnostics, summary };
  summary.course = { id: loaded.course.id, version: loaded.course.version };
  for (const { topic } of loaded.topics) {
    summary.topics[topic.status] += 1;
    for (const { question, pool } of topicQuestions(topic)) {
      summary.questions += 1;
      if (pool !== "review" && pool !== "quiz") continue;
      for (const slot of question.manual ?? []) summary.confirmationSlots.push(`${question.id}/${slot}`);
    }
  }
  checkRules(loaded, report);
  await checkReferences(loaded, report, options.confirmations ?? "required");
  summary.python = usesPython(loaded.topics.map(({ topic }) => topic));
  // 不用 Python 的课不启动沙箱；用到 Python 却没写 runtime 的，规则检查已报 runtime_missing。
  const expected = loaded.course.runtime;
  if (options.run === false || !summary.python || !expected) return { diagnostics: report.diagnostics, summary };

  // 按顺序用第一处能用的 Python；课程清单与安装的版本不符是课程的问题，照常报告，不换下一处。
  const reasons: string[] = [];
  let running: CheckRun | undefined;
  for (const python of options.python ?? [sandboxPython]) {
    try {
      running = await python(expected, options);
      break;
    } catch (error) {
      if (error instanceof RuntimeProblem) {
        report.error(error.code, error.message, loaded.file, ["runtime"]);
        return { diagnostics: report.diagnostics, summary };
      }
      if (!(error instanceof PythonUnavailable)) throw error;
      reasons.push(error.message);
    }
  }
  if (!running) {
    report.error("python_unavailable", `${reasons.join("；")}。课里的 verify 核对程序和代码题没能运行，所以没有核对`, loaded.file, ["runtime"]);
    return { diagnostics: report.diagnostics, summary };
  }
  try {
    summary.where = running.where;
    summary.runtime = running.runtime;
    const mismatches = runtimeMismatches(expected, running.runtime);
    if (mismatches.length > 0) {
      report.error("runtime_mismatch", `实际加载的运行时与课程清单不一致：${mismatches.join("、")}`, loaded.file, ["runtime"]);
      return { diagnostics: report.diagnostics, summary };
    }
    summary.ran = true;
    for (const topic of loaded.topics) {
      if (options.topics && !options.topics.includes(topic.topic.id)) continue;
      await checkTopicCode(topic, running.run, report, code, expected.prelude ?? "");
    }
  } catch (error) {
    // 前端页面在核对中途断开、没有回应或失败：已经得到的结论照常报告，其余没有核对，整个检查不算通过。
    if (!(error instanceof PythonUnavailable)) throw error;
    summary.ran = false;
    report.error("python_unavailable", `${error.message}。课里的 verify 核对程序和代码题没有全部运行，所以没有核对完`, loaded.file, ["runtime"]);
  } finally {
    code.interpreterStarts = running.starts();
    await running.close();
  }
  return { diagnostics: report.diagnostics, summary };
}
