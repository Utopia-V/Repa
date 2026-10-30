import {
  describeRuntime, RuntimeProblem, SandboxRunner, SandboxUnavailable, verifyPackages, type RuntimeVersions,
} from "@repa/python-runner";
import type { RunTests } from "../code-tests.js";
import { Report, type Diagnostic } from "../format/diagnostics.js";
import { loadCourse } from "../format/load.js";
import { checkTopicCode, type CodeStats } from "./code.js";
import { checkReferences } from "./questions.js";
import { checkRules } from "./rules.js";
import { topicQuestions } from "./items.js";

/** checkCourse 的选项：是否运行代码核对、离线包位置、问题里路径的显示基准，以及只核对哪些 topic 的代码。 */
export interface CheckOptions {
  /** 是否在 Pyodide 里运行核对与测试，缺省为 true。 */
  run?: boolean;
  /** 离线 Pyodide 包所在目录，缺省见 @repa/python-runner 的 defaultPackagesDirectory。 */
  packagesDirectory?: string;
  /** 问题里文件路径的显示基准，缺省为当前目录。 */
  base?: string;
  timeoutMs?: number;
  /** 只对这些 topic 运行代码核对；结构和交叉规则仍检查整门课。缺省核对全部 topic。 */
  topics?: string[];
}

/** 一次课程检查的统计：topic 与题目数、要模型核对的作答位、代码核对是否运行，以及启动解释器等代价计数。 */
export interface CheckSummary {
  course?: { id: string; version: string };
  topics: { complete: number; outline: number };
  questions: number;
  /** 复习和测验题池里由模型核对的作答位，写成“题目 id/作答位 id”；缺少当前版本记录的另作为错误报告。 */
  confirmationSlots: string[];
  /** 代码核对是否真的运行了。 */
  ran: boolean;
  runtime?: RuntimeVersions;
  code: CodeStats;
}

/** 课程检查的结果：发现的全部问题和统计。 */
export interface CheckResult {
  diagnostics: Diagnostic[];
  summary: CheckSummary;
}

/** 检查一门课程：读取与 schema、交叉规则、标准答案自洽，最后在沙箱里运行核对与测试。 */
export async function checkCourse(root: string, options: CheckOptions = {}): Promise<CheckResult> {
  const report = new Report();
  const code: CodeStats = { verifyJobs: 0, verifiedSlots: 0, testRuns: 0, interpreterStarts: 0 };
  const summary: CheckSummary = { topics: { complete: 0, outline: 0 }, questions: 0, confirmationSlots: [], ran: false, code };
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
  await checkReferences(loaded, report);
  if (options.run === false) return { diagnostics: report.diagnostics, summary };

  let runner: SandboxRunner;
  try {
    const assets = await describeRuntime(loaded.course.runtime, options.packagesDirectory);
    await verifyPackages(assets);
    runner = new SandboxRunner({ assets });
    summary.runtime = await runner.start();
  } catch (error) {
    if (error instanceof RuntimeProblem) {
      report.error(error.code, error.message, loaded.file, ["runtime"]);
    } else if (error instanceof SandboxUnavailable) {
      report.error("sandbox_unavailable", `${error.message}。代码核对需要 Linux 的 Landlock（ABI 4 以上）与 libseccomp；只检查结构时加 --no-run`, loaded.file, ["runtime"]);
    } else {
      throw error;
    }
    return { diagnostics: report.diagnostics, summary };
  }
  try {
    const expected = loaded.course.runtime;
    const actual = summary.runtime;
    const mismatches = [
      actual.pyodide !== expected.pyodide ? `Pyodide ${actual.pyodide}` : "",
      actual.python !== expected.python ? `Python ${actual.python}` : "",
      ...Object.entries(expected.packages).map(([name, version]) => (actual.packages[name] !== version ? `${name} ${actual.packages[name] ?? "未加载"}` : "")),
    ].filter(Boolean);
    if (mismatches.length > 0) {
      report.error("runtime_mismatch", `实际加载的运行时与课程清单不一致：${mismatches.join("、")}`, loaded.file, ["runtime"]);
      return { diagnostics: report.diagnostics, summary };
    }
    summary.ran = true;
    // 整门课共用一个解释器；测试按判分的约定成批运行，任务之间由 runner.py 恢复状态，恢复失败或超时才换新的。
    const runtime = summary.runtime;
    const run: RunTests = async (tests) => ({ runtime, tests: await runner.runTests(tests, options.timeoutMs) });
    for (const topic of loaded.topics) {
      if (options.topics && !options.topics.includes(topic.topic.id)) continue;
      await checkTopicCode(topic, runner, run, report, code, loaded.course.runtime.prelude ?? "", options.timeoutMs);
    }
    code.interpreterStarts = runner.starts;
  } finally {
    await runner.close();
  }
  return { diagnostics: report.diagnostics, summary };
}
