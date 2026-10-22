import { randomUUID } from "node:crypto";
import { writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { expectedBinding, runnerVersion, type Expected } from "../python-execution.js";
import { Report, type Diagnostic } from "../format/diagnostics.js";
import { loadCourse } from "../format/load.js";
import { describeRuntime, RuntimeProblem, verifyPackages } from "../sandbox/runtime.js";
import { SandboxRunner, SandboxUnavailable, type RuntimeVersions } from "../sandbox/session.js";
import { checkTopicCode, type CodeStats } from "./code.js";
import { checkReferences } from "./questions.js";
import { checkRules } from "./rules.js";
import { topicQuestions } from "./items.js";

export interface CheckOptions {
  /** 是否在 Pyodide 里运行核对与测试，缺省为 true。 */
  run?: boolean;
  /** 离线 Pyodide 包所在目录，缺省见 defaultPackagesDirectory。 */
  packagesDirectory?: string;
  /** 问题里文件路径的显示基准，缺省为当前目录。 */
  base?: string;
  timeoutMs?: number;
  /** 只对这些 topic 运行代码核对；结构和交叉规则仍检查整门课。缺省核对全部 topic。 */
  topics?: string[];
}

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

export interface CheckResult {
  diagnostics: Diagnostic[];
  summary: CheckSummary;
}

/** 检查一门课程：读取与 schema、交叉规则、标准答案自洽，最后在沙箱里运行核对与测试。 */
export async function checkCourse(root: string, options: CheckOptions = {}): Promise<CheckResult> {
  const report = new Report();
  const code: CodeStats = { verifyJobs: 0, verifiedSlots: 0, testRuns: 0 };
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
    const published: Record<string, Expected> = {};
    const runnerHash = await runnerVersion();
    for (const { topic } of loaded.topics) {
      for (const { question } of topicQuestions(topic)) {
        published[question.id] = {
          binding: await expectedBinding(question, topic, loaded.course.runtime, runnerHash),
          values: {},
        };
      }
    }
    // 核对器在每份候选程序前关闭旧解释器，随后按正式测试顺序逐项执行。
    for (const topic of loaded.topics) {
      if (options.topics && !options.topics.includes(topic.topic.id)) continue;
      await checkTopicCode(topic, runner, report, code, options.timeoutMs, published);
      await runner.close();
    }
    if (!options.topics && report.errorCount === 0) {
      const target = path.join(root, "expected.json");
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(published)}\n`);
      await rename(temporary, target);
    }
  } finally {
    await runner.close();
  }
  return { diagnostics: report.diagnostics, summary };
}
