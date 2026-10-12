#!/usr/bin/env node
import { readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { confirmCourse, type ConfirmOutcome } from "./check/confirm.js";
import { checkCourse, type CheckResult } from "./check/course.js";
import { parseModel, withModel } from "./check/model.js";
import { formatDiagnostic, Report } from "./format/diagnostics.js";
import { COURSE_FILE, loadCourse } from "./format/load.js";
import { describeRuntime, PACKAGE_ROOT, preparePackages } from "./sandbox/runtime.js";

const USAGE = `用法：
  repa-course check [课程目录…] [--no-run] [--topic id …] [--packages 目录] [--json]
      检查课程文件；缺省检查 courses/ 下全部课程。--no-run 只做结构检查，不运行代码；
      --topic 只对给出的 topic 运行代码核对（可以写多次），结构仍检查整门课。
  repa-course runtime [课程目录…] [--from 目录] [--packages 目录]
      准备离线 Pyodide 包；--from 从已有目录复制，不给时从 jsDelivr 下载。都会按 lockfile 核对 SHA-256。
  repa-course confirm [课程目录…] [--topic id …] [--max-requests 50] [--model deepseek/deepseek-flash]
                      [--agent-dir ~/.repa/agent] [--force] [--dry-run] [--log 文件]
      复习和测验题里的 manual 作答位，用一次隔离的模型调用独立再解，与标准答案一致时写进 topic 的 verified 段。
      会产生真实的模型费用；--dry-run 只打印要发的请求。
`;

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
  const { summary } = result;
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const course = summary.course ? `${summary.course.id} ${summary.course.version}` : "课程";
  process.stdout.write(`\n${course}：完整 topic ${summary.topics.complete} 个，骨架 ${summary.topics.outline} 个，题目 ${summary.questions} 道。\n`);
  if (summary.ran && summary.runtime) {
    const packages = Object.entries(summary.runtime.packages).map(([name, version]) => `${name} ${version}`).join("、");
    process.stdout.write(`代码核对：Pyodide ${summary.runtime.pyodide}（Python ${summary.runtime.python}、${packages}），`
      + `verify ${summary.code.verifyJobs} 道、核对作答位 ${summary.code.verifiedSlots} 个、测试运行 ${summary.code.testRuns} 次。\n`);
  } else {
    process.stdout.write("代码核对：没有运行。\n");
  }
  if (summary.confirmationSlots.length > 0) {
    process.stdout.write(`复习和测验题池里由模型核对的作答位 ${summary.confirmationSlots.length} 个：${summary.confirmationSlots.join("、")}\n`);
  }
  process.stdout.write(errors === 0 ? "检查通过。\n" : `发现 ${errors} 个错误。\n`);
}

async function check(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: { "no-run": { type: "boolean" }, topic: { type: "string", multiple: true }, packages: { type: "string" }, json: { type: "boolean" } },
  });
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
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: { from: { type: "string" }, packages: { type: "string" } },
  });
  const courses = positionals.length > 0 ? positionals.map((item) => path.resolve(item)) : await defaultCourses();
  for (const course of courses) {
    const report = new Report();
    const loaded = await loadCourse(course, report);
    if (!loaded) {
      for (const diagnostic of report.diagnostics) process.stdout.write(`${formatDiagnostic(diagnostic)}\n`);
      return 1;
    }
    const assets = await describeRuntime(loaded.course.runtime, values.packages ? path.resolve(values.packages) : undefined);
    process.stdout.write(`${loaded.course.id}：Pyodide ${assets.pyodideVersion}，包放在 ${assets.packagesDirectory}\n`);
    await preparePackages(assets, {
      ...(values.from ? { from: path.resolve(values.from) } : {}),
      log: (message) => process.stdout.write(`  ${message}\n`),
    });
  }
  return 0;
}

function describeOutcome(outcome: ConfirmOutcome): string {
  const label = { confirmed: "一致，已记录", disagreed: "不一致，交给人看", unusable: "输出不合格式，交给人看", skipped: "没有发请求" }[outcome.status];
  const lines = [`${outcome.question}（${outcome.slots.join("、")}）：${label}${outcome.detail ? `，${outcome.detail}` : ""}`];
  for (const difference of outcome.differences ?? []) {
    lines.push(`  ${difference.slot}：模型答 ${JSON.stringify(difference.model)}，标准答案 ${JSON.stringify(difference.key)}`);
  }
  return lines.join("\n");
}

async function confirm(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: {
      topic: { type: "string", multiple: true },
      "max-requests": { type: "string", default: "50" },
      model: { type: "string", default: "deepseek/deepseek-flash" },
      "agent-dir": { type: "string", default: path.join(os.homedir(), ".repa", "agent") },
      force: { type: "boolean" },
      "dry-run": { type: "boolean" },
      log: { type: "string" },
    },
  });
  const maxRequests = Number(values["max-requests"]);
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 200) throw new Error("--max-requests 要是 1 到 200 的整数");
  const model = parseModel(values.model);
  const courses = positionals.length > 0 ? positionals.map((item) => path.resolve(item)) : await defaultCourses();
  const requestsSent: { question: string; system: string; prompt: string }[] = [];
  const run = async (complete: Parameters<typeof confirmCourse>[1]["complete"]) => {
    const results = [];
    let remaining = maxRequests;
    for (const course of courses) {
      const result = await confirmCourse(course, {
        complete, model: values.model, maxRequests: remaining,
        ...(values.topic ? { topics: values.topic } : {}), ...(values.force ? { force: true } : {}), ...(values["dry-run"] ? { dryRun: true } : {}),
        onRequest: (question, request) => requestsSent.push({ question, ...request }),
      });
      remaining -= result.requests;
      results.push(result);
    }
    return results;
  };
  const dryRun = values["dry-run"] === true;
  const outcome = dryRun
    ? { value: await run(async () => { throw new Error("--dry-run 不调用模型"); }) }
    : await withModel(path.resolve(values["agent-dir"]), model, run);
  let failed = false;
  for (const result of outcome.value) {
    for (const diagnostic of result.diagnostics) process.stdout.write(`${formatDiagnostic(diagnostic)}\n`);
    if (result.diagnostics.length > 0) failed = true;
    for (const item of result.outcomes) {
      process.stdout.write(`${describeOutcome(item)}\n`);
      if (item.status === "disagreed" || item.status === "unusable" || (item.status === "skipped" && !dryRun && item.detail !== "已有当前版本的核对记录")) failed = true;
    }
  }
  if (dryRun) for (const request of requestsSent) process.stdout.write(`\n----- ${request.question}\n${request.system}\n\n${request.prompt}\n`);
  const total = outcome.value.reduce((sum, result) => sum + result.requests, 0);
  process.stdout.write(`\n共发请求 ${total} 次（上限 ${maxRequests}）。\n`);
  if (outcome.warning) process.stdout.write(`${outcome.warning}\n`);
  if (values.log) {
    const lines = outcome.value.flatMap((result) => result.outcomes).map((item) => JSON.stringify({
      ...item, model: values.model, request: requestsSent.find((request) => request.question === item.question)?.prompt,
    }));
    await writeFile(path.resolve(values.log), `${lines.join("\n")}\n`, { flag: "wx" });
  }
  return failed ? 1 : 0;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "check") {
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
