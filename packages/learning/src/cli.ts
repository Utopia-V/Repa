#!/usr/bin/env node
import { open, readdir, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { openSpace, resolveAppHome } from "@repa/base";
import { describeRuntime, preparePackages } from "@repa/python-runner";

import { confirmCourse, type ConfirmOutcome } from "./check/confirm.js";
import { checkCourse, type CheckResult } from "./check/course.js";
import { parseModel, withModel } from "./check/model.js";
import { formatDiagnostic } from "./format/diagnostics.js";
import { COURSE_FILE } from "./format/load.js";
import { CONFIRMATION_SCOPES, type ConfirmationScope } from "./format/schema.js";

/** 本包的根目录，随包的课程在其下的 courses/。 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `用法：
  repa-course recover-log <已关闭的空间目录> <新日志文件>
      保留原日志，将验证过的完整前缀写入新的文件。
  repa-course check [课程目录…] [--no-run] [--topic id …] [--packages 目录] [--scope 范围] [--json]
      检查课程文件；缺省检查 courses/ 下全部课程。--no-run 只做结构检查，不运行代码；
      --topic 只对给出的 topic 运行代码核对（可以写多次），结构仍检查整门课。
      --scope 是要求哪种模型核对记录：question-runtime-v1（缺省，随包课程）或 question-lesson-v1（应用里自制的课）。
  repa-course runtime [--from 目录] [--packages 目录]
      准备 Repa 的 Python 环境带的离线 Pyodide 包，放进 @repa/python-runner 的缓存目录；--from 从已有目录复制，
      不给时从 jsDelivr 下载。都会按 lockfile 核对 SHA-256。
  repa-course confirm [课程目录…] [--topic id …] [--scope 范围] [--max-requests 50] [--concurrency 1]
                      [--model deepseek/deepseek-flash] [--agent-dir 应用配置目录/agent] [--force] [--dry-run] [--log 文件]
      用一次隔离的模型调用独立再解题目，与标准答案一致时写进 topic 的 verified 段。--scope question-runtime-v1（缺省）
      核对复习和测验题里的 manual 作答位，请求只有题面；question-lesson-v1 与应用里的 course_confirm 相同，
      核对四个题池里全部由程序判分的作答位，请求带上所属知识点的讲解。
      会产生真实的模型费用；--dry-run 只打印要发的请求，--log 把每道题的请求与结果逐行写成 JSON。
`;

function scopeOption(value: string | undefined): ConfirmationScope {
  const scope = value ?? "question-runtime-v1";
  if (!(CONFIRMATION_SCOPES as readonly string[]).includes(scope)) throw new Error(`--scope 要是 ${CONFIRMATION_SCOPES.join(" 或 ")}`);
  return scope as ConfirmationScope;
}

async function defaultCourses(): Promise<string[]> {
  const root = path.join(PACKAGE_ROOT, "courses");
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const courses: string[] = [];
  for (const entry of entries.sort()) {
    try {
      if ((await stat(path.join(root, entry, COURSE_FILE))).isFile()) courses.push(path.join(root, entry));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
    }
  }
  return courses;
}

function printResult(result: CheckResult): void {
  for (const diagnostic of result.diagnostics) process.stdout.write(`${formatDiagnostic(diagnostic)}\n`);
  // 应用里做课的 Agent 也读这条错误，那里没有命令行，所以只在这里提示。
  if (result.diagnostics.some((diagnostic) => diagnostic.code === "python_unavailable")) process.stdout.write("只检查结构时加 --no-run。\n");
  const { summary } = result;
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const course = summary.course ? `${summary.course.id} ${summary.course.version}` : "课程";
  process.stdout.write(`\n${course}：完整 topic ${summary.topics.complete} 个，骨架 ${summary.topics.outline} 个，题目 ${summary.questions} 道。\n`);
  if (summary.ran && summary.runtime) {
    const packages = summary.loaded.map((name) => `${name} ${summary.runtime?.packages[name] ?? ""}`).join("、") || "没有加载带的包";
    process.stdout.write(`代码核对：Pyodide ${summary.runtime.pyodide}（Python ${summary.runtime.python}，${packages}），`
      + `verify ${summary.code.verifyJobs} 道、核对作答位 ${summary.code.verifiedSlots} 个、测试运行 ${summary.code.testRuns} 次（含算期望值），启动解释器 ${summary.code.interpreterStarts} 次。\n`);
  } else if (summary.course && !summary.python) {
    process.stdout.write("代码核对：课里没有要运行 Python 的题。\n");
  } else {
    process.stdout.write("代码核对：没有运行。\n");
  }
  const { confirmations } = summary;
  if (confirmations.questions > 0) {
    const missing = confirmations.missing.map((entry) => entry.question);
    process.stdout.write(`要模型核对的题（${confirmations.scope}）${confirmations.questions} 道，缺当前记录 ${missing.length} 道${missing.length > 0 ? `：${missing.join("、")}` : ""}\n`);
  }
  process.stdout.write(errors === 0 ? "检查通过。\n" : `发现 ${errors} 个错误。\n`);
}

async function check(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: {
      "no-run": { type: "boolean" }, topic: { type: "string", multiple: true }, packages: { type: "string" }, scope: { type: "string" }, json: { type: "boolean" },
    },
  });
  const scope = scopeOption(values.scope);
  const courses = positionals.length > 0 ? positionals.map((item) => path.resolve(item)) : await defaultCourses();
  if (courses.length === 0) {
    process.stdout.write("没有找到课程：课程目录里要有 course.yaml。\n");
    return 1;
  }
  let failed = false;
  const results: CheckResult[] = [];
  for (const course of courses) {
    const result = await checkCourse(course, {
      run: !values["no-run"],
      scope,
      ...(values.topic ? { topics: values.topic } : {}),
      ...(values.packages ? { packagesDirectory: path.resolve(values.packages) } : {}),
    });
    results.push(result);
    if (result.diagnostics.some((diagnostic) => diagnostic.severity === "error")) failed = true;
    if (!values.json) printResult(result);
  }
  if (values.json) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  return failed ? 1 : 0;
}

async function runtime(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { from: { type: "string" }, packages: { type: "string" } } });
  const assets = await describeRuntime(values.packages ? path.resolve(values.packages) : undefined);
  process.stdout.write(`Pyodide ${assets.pyodideVersion}，包放在 ${assets.packagesDirectory}\n`);
  await preparePackages(assets, {
    ...(values.from ? { from: path.resolve(values.from) } : {}),
    log: (message) => process.stdout.write(`  ${message}\n`),
  });
  return 0;
}

function describeOutcome(outcome: ConfirmOutcome): string {
  const label = {
    confirmed: "一致，已记录", noted: "一致，但模型指出题目有问题，没有记录", disagreed: "不一致，交给人看", unusable: "输出不合格式，交给人看", failed: "请求失败",
    current: "已有当前核对范围的证明", skipped: "没有发请求",
  }[outcome.status];
  const lines = [`${outcome.question}（${outcome.slots.join("、")}）：${label}${outcome.detail ? `，${outcome.detail}` : ""}`];
  for (const difference of outcome.differences ?? []) {
    lines.push(`  ${difference.slot}：模型答 ${JSON.stringify(difference.model)}，标准答案 ${JSON.stringify(difference.key)}`);
  }
  if (outcome.note) lines.push(`  模型的说明：${outcome.note}`);
  return lines.join("\n");
}

/** 在发任何请求之前独占创建 --log 的文件；已经存在就报错，免得核对做完才发现日志写不进去。 */
async function openLog(file: string): Promise<FileHandle> {
  try {
    return await open(path.resolve(file), "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`--log 指定的文件已经存在：${path.resolve(file)}。换一个文件名，或先自己处理掉它`);
    throw error;
  }
}

async function confirm(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: {
      topic: { type: "string", multiple: true },
      scope: { type: "string" },
      "max-requests": { type: "string", default: "50" },
      concurrency: { type: "string", default: "1" },
      model: { type: "string", default: "deepseek/deepseek-flash" },
      "agent-dir": { type: "string", default: path.join(resolveAppHome(), "agent") },
      force: { type: "boolean" },
      "dry-run": { type: "boolean" },
      log: { type: "string" },
    },
  });
  const maxRequests = Number(values["max-requests"]);
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 200) throw new Error("--max-requests 要是 1 到 200 的整数");
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error("--concurrency 要是 1 到 16 的整数");
  const scope = scopeOption(values.scope);
  const model = parseModel(values.model);
  const courses = positionals.length > 0 ? positionals.map((item) => path.resolve(item)) : await defaultCourses();
  const log = values.log ? await openLog(values.log) : undefined;
  try {
    const requestsSent: { question: string; system: string; prompt: string }[] = [];
    // 并发核对时几道题可能同时有结果，日志一行一行依次写，不交错。
    let logging: Promise<void> = Promise.resolve();
    const run = async (complete: Parameters<typeof confirmCourse>[1]["complete"]) => {
      const results = [];
      let remaining = maxRequests;
      for (const course of courses) {
        const result = await confirmCourse(course, {
          complete, model: values.model, maxRequests: remaining, scope, concurrency,
          ...(values.topic ? { topics: values.topic } : {}), ...(values.force ? { force: true } : {}), ...(values["dry-run"] ? { dryRun: true } : {}),
          onRequest: (question, request) => requestsSent.push({ question, ...request }),
          // 每道题一有结果就写进日志，中途出错也不会丢掉已经花了钱的那些。
          onOutcome: (outcome, request) => {
            const line = `${JSON.stringify({ ...outcome, course, model: values.model, system: request?.system, request: request?.prompt })}\n`;
            logging = logging.then(() => log?.appendFile(line));
            return logging;
          },
        });
        remaining -= result.requests;
        results.push(result);
      }
      return results;
    };
    const dryRun = values["dry-run"] === true;
    const results = dryRun
      ? await run(async () => { throw new Error("--dry-run 不调用模型"); })
      : await withModel(path.resolve(values["agent-dir"]), model, run);
    let failed = false;
    for (const result of results) {
      for (const diagnostic of result.diagnostics) process.stdout.write(`${formatDiagnostic(diagnostic)}\n`);
      if (result.diagnostics.length > 0) failed = true;
      for (const item of result.outcomes) {
        process.stdout.write(`${describeOutcome(item)}\n`);
        if (item.status === "noted" || item.status === "disagreed" || item.status === "unusable" || item.status === "failed" || (item.status === "skipped" && !dryRun)) failed = true;
      }
    }
    if (dryRun) for (const request of requestsSent) process.stdout.write(`\n----- ${request.question}\n${request.system}\n\n${request.prompt}\n`);
    const total = results.reduce((sum, result) => sum + result.requests, 0);
    process.stdout.write(`\n共发请求 ${total} 次（上限 ${maxRequests}）。\n`);
    return failed ? 1 : 0;
  } finally {
    await log?.close();
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "recover-log") {
    if (args.length !== 2 || !args[0] || !args[1]) throw new Error("需要空间目录和新日志文件");
    const { recoverLearningLog } = await import("./records.js");
    const space = await openSpace(path.resolve(args[0]), { watch: false });
    try {
      await recoverLearningLog(path.join(space.dataDir, "plugins", "learning", "records.jsonl"), path.resolve(args[1]));
    } finally {
      await space.close();
    }
  } else if (command === "check") {
    process.exitCode = await check(args);
  } else if (command === "runtime") {
    process.exitCode = await runtime(args);
  } else if (command === "confirm") {
    process.exitCode = await confirm(args);
  } else {
    process.stdout.write(USAGE);
    process.exitCode = command === undefined || command === "--help" || command === "-h" ? 0 : 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
