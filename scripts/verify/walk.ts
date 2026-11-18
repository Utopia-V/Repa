/**
 * 端到端走查：启动真实的后端和 Web 界面，用无界面浏览器像学习者那样走一遍主要流程，每一步给出通过或不通过；
 * 不通过时给出截图路径、当时的页面文字和页面里的错误。不联网、不调用真实模型、不打开任何窗口。
 *
 * 用法见 .agents/skills/verify/SKILL.md：
 *   npm run verify                         走完全部步骤
 *   npm run verify -- --until lesson       走到这一步为止，之后应用保持运行，用 npm run verify:drive 接着操作
 *   npm run verify -- --keep               走完以后保持运行
 */
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";

import { App, REPO } from "./app.js";
import { STEPS, type Context } from "./steps.js";

/** 一项检查的结果。known：这项检查记录的是一个已知问题，不成立是预期的。 */
export interface CheckResult {
  name: string;
  status: "pass" | "fail" | "expected-fail" | "fixed";
  known?: string;
  detail?: string;
}

interface StepResult {
  id: string;
  title: string;
  status: "pass" | "fail" | "skipped";
  ms: number;
  checks: CheckResult[];
  error?: string;
  shot?: string;
  text?: string;
  pageErrors?: string[];
  model?: string[];
}

/** 一项必须成立的检查没有成立。 */
export class CheckFailed extends Error {}

/** 给步骤用的检查入口：必须成立的检查与已知问题。 */
export class Checks {
  readonly results: CheckResult[] = [];

  /** 必须成立；不成立时这一步不通过，后面的步骤不再运行（它们依赖这一步留下的状态）。 */
  expect(name: string, condition: boolean, detail?: string): void {
    this.results.push({ name, status: condition ? "pass" : "fail", ...(detail === undefined ? {} : { detail }) });
    if (!condition) throw new CheckFailed(`${name}${detail ? `：${detail}` : ""}`);
  }

  /**
   * 已知问题：condition 是修好以后应当成立的情形。现在不成立记为预期失败，不影响结果；
   * 成立了记为“已修好”，提醒把这项改成普通的 expect。
   */
  known(issue: string, name: string, condition: boolean, detail?: string): void {
    this.results.push({ name, status: condition ? "fixed" : "expected-fail", known: issue, ...(detail === undefined ? {} : { detail }) });
  }
}

const SYMBOL = { pass: "通过", fail: "不通过", skipped: "未运行" } as const;
const CHECK_SYMBOL = { pass: "  ✓", fail: "  ✗", "expected-fail": "  ○ 预期失败", fixed: "  ! 已修好" } as const;

function printStep(result: StepResult): void {
  process.stdout.write(`${SYMBOL[result.status]}  ${result.id}  ${result.title}（${(result.ms / 1000).toFixed(1)} 秒）\n`);
  for (const check of result.checks) {
    process.stdout.write(`${CHECK_SYMBOL[check.status]} ${check.name}${check.detail ? `：${check.detail}` : ""}\n`);
    if (check.known) process.stdout.write(`      已知问题：${check.known}${check.status === "fixed" ? "。这一项现在成立，修好了就把它改成 expect。" : ""}\n`);
  }
  if (result.status === "pass" && result.pageErrors?.length) process.stdout.write(`  页面报错 ${result.pageErrors.length} 条，见报告\n`);
  if (result.status === "fail") {
    process.stdout.write(`  错误：${result.error ?? ""}\n`);
    if (result.shot) process.stdout.write(`  截图：${result.shot}\n`);
    if (result.pageErrors?.length) process.stdout.write(`  页面错误：\n${result.pageErrors.map((line) => `    ${line}`).join("\n")}\n`);
    if (result.model?.length) process.stdout.write(`  假模型：\n${result.model.map((line) => `    ${line}`).join("\n")}\n`);
    if (result.text !== undefined) process.stdout.write(`  页面文字：\n${result.text.split("\n").filter((line) => line.trim() !== "").map((line) => `    | ${line}`).join("\n")}\n`);
  }
}

/** 走查目录：仓库的 .scratch/verify/ 下按时间命名；current.json 记着正在运行的那一次，verify:drive 读它。 */
function runDirectory(): string {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-").replace(/Z$/u, "");
  return path.join(REPO, ".scratch", "verify", stamp);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * 保持运行，接 verify:drive 发来的操作：读文字、截图、点、输入、关闭再打开、拨时钟、直接调用后端。
 * 每条操作的结果是一段文字。收到 quit 时关闭一切。
 */
async function serve(app: App): Promise<void> {
  const page = app.page;
  const commands: Record<string, (args: string[]) => Promise<string>> = {
    text: async () => page.text(),
    url: async () => page.url(),
    shot: async ([name]) => page.shot(name ?? `drive-${Date.now()}`),
    size: async ([width, height]) => { await page.resize(Number(width ?? 1120), Number(height ?? 760)); return "已改视口大小"; },
    click: async ([name, near]) => { await page.click(near === undefined ? name ?? "" : { name: name ?? "", near }); return "已点"; },
    fill: async ([name, text, near]) => { await page.fill(name ?? "", text ?? "", near === undefined ? {} : { near }); return "已输入"; },
    press: async ([key]) => { await page.press(key as "Enter"); return "已按"; },
    wait: async ([text, seconds]) => page.waitText(text ?? "", Number(seconds ?? 15) * 1000),
    goto: async ([target]) => { await page.goto(`${app.url}${target ?? "/"}`); return "已打开"; },
    eval: async ([expression]) => JSON.stringify(await page.evaluate(expression ?? "null"), null, 2),
    reopen: async ([days]) => { await app.reopen({ days: Number(days ?? 0) }); return `已关闭再打开，后端时钟偏移 ${app.clockOffsetMs} 毫秒`; },
    "stop-backend": async () => { await app.stopBackend(); return "后端已关闭"; },
    "start-backend": async () => { await app.startBackend(); return "后端已启动"; },
    rpc: async ([method, input]) => {
      const client = await app.rpc();
      return JSON.stringify(await client.call(method as never, JSON.parse(input ?? "{}") as never), null, 2);
    },
    plugin: async ([pluginId, method, input]) => {
      const client = await app.rpc();
      const opening = client.handshake.baseline.space?.opening;
      if (opening === undefined) throw new Error("后端现在没有打开的空间");
      return JSON.stringify(await client.call("plugin.call", { pluginId: pluginId ?? "", method: method ?? "", input: JSON.parse(input ?? "{}") as unknown, opening }), null, 2);
    },
    model: async () => [...app.model.log.map((entry) => `${entry.kind} ${entry.note}${entry.toolResult ? `\n    ${entry.toolResult.replaceAll("\n", "\n    ")}` : ""}`), ...app.model.unexpected.map((line) => `意外：${line}`)].join("\n"),
    errors: async () => page.takeErrors().join("\n"),
  };
  const server = createServer((request, response) => {
    void (async () => {
      let reply: string;
      let status = 200;
      try {
        const { command, args } = JSON.parse(await readBody(request)) as { command: string; args: string[] };
        if (command === "quit") {
          response.end("关闭中");
          server.close();
          await rm(path.join(REPO, ".scratch", "verify", "current.json"), { force: true });
          await app.close();
          process.exit(0);
        }
        const handler = commands[command];
        if (!handler) throw new Error(`没有这个操作：${command}。可用的有 ${[...Object.keys(commands), "quit"].join("、")}`);
        reply = await handler(args);
      } catch (error) {
        status = 500;
        reply = error instanceof Error ? error.message : String(error);
      }
      response.statusCode = status;
      response.end(reply);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await writeFile(path.join(REPO, ".scratch", "verify", "current.json"), JSON.stringify({ port, dir: app.dir, url: app.url }));
  process.stdout.write(`\n应用保持运行：${app.url}（后台进程 ${process.pid}）。用 npm run verify:drive -- <操作> 接着走，npm run verify:drive -- quit 结束。\n`);
}

/** 只留最近几次走查的目录：每次约 8 MB（空间与历史、配置、备份、导出、截图）；浏览器数据和构建出的界面在结束时删掉。 */
const KEEP_RUNS = 10;

async function pruneRuns(): Promise<void> {
  const root = path.join(REPO, ".scratch", "verify");
  const runs = (await readdir(root, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory() && /^\d{4}-/u.test(entry.name)).map((entry) => entry.name).sort();
  for (const name of runs.slice(0, Math.max(0, runs.length - KEEP_RUNS + 1))) await rm(path.join(root, name), { recursive: true, force: true });
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { until: { type: "string" }, keep: { type: "boolean" }, list: { type: "boolean" } } });
  if (values.list) {
    for (const step of STEPS) process.stdout.write(`${step.id}  ${step.title}\n`);
    return;
  }
  if (values.until !== undefined && !STEPS.some((step) => step.id === values.until)) {
    throw new Error(`没有这一步：${values.until}。步骤有 ${STEPS.map((step) => step.id).join("、")}`);
  }
  await pruneRuns();
  const dir = runDirectory();
  await mkdir(dir, { recursive: true });
  process.stdout.write(`走查目录：${dir}\n`);
  const started = Date.now();
  const app = await App.start({ dir });
  // 中途被打断时也关掉后端、浏览器和界面的服务，不留下进程。
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void app.close().finally(() => process.exit(130));
    });
  }
  process.stdout.write(`应用已起（${((Date.now() - started) / 1000).toFixed(1)} 秒）：${app.url}\n\n`);
  const results: StepResult[] = [];
  const context: Context = { app, page: app.page, model: app.model, notes: new Map() };
  let failed = false;
  try {
    for (const step of STEPS) {
      if (failed) {
        results.push({ id: step.id, title: step.title, status: "skipped", ms: 0, checks: [] });
        continue;
      }
      const checks = new Checks();
      const begin = Date.now();
      const result: StepResult = { id: step.id, title: step.title, status: "pass", ms: 0, checks: checks.results };
      try {
        await step.run(context, checks);
      } catch (error) {
        failed = true;
        result.status = "fail";
        result.error = error instanceof Error ? error.message : String(error);
        if (!(error instanceof CheckFailed) && error instanceof Error && error.stack) result.error = `${result.error}\n${error.stack.split("\n").slice(1, 4).join("\n")}`;
        result.shot = await app.page.shot(`${step.id}-失败`).catch(() => undefined);
        result.text = (await app.page.text().catch(() => "（读不到页面文字）")).slice(0, 3000);
        result.pageErrors = app.page.takeErrors().slice(-10);
        result.model = [...app.model.unexpected, ...app.model.log.slice(-8).map((entry) => `${entry.kind} ${entry.note}${entry.toolResult ? `：${entry.toolResult.slice(0, 300).replaceAll("\n", " ")}` : ""}`)];
      }
      result.ms = Date.now() - begin;
      // 通过的步骤里页面报过的错也记进报告：不算不通过（重连时的连接错误是预期的），但值得看一眼。
      if (result.status === "pass") {
        const errors = app.page.takeErrors();
        if (errors.length > 0) result.pageErrors = errors.slice(-10);
      }
      results.push(result);
      printStep(result);
      if (step.id === values.until) break;
    }
  } finally {
    const total = Date.now() - started;
    const counts = { pass: 0, fail: 0, "expected-fail": 0, fixed: 0 };
    for (const result of results) for (const check of result.checks) counts[check.status]++;
    const scope = values.until === undefined ? "" : `（走到 ${values.until} 为止）`;
    const summary = `\n${failed ? "走查没有通过" : "走查通过"}${scope}：${results.filter((result) => result.status === "pass").length}/${STEPS.length} 步通过，`
      + `检查 ${counts.pass} 项通过、${counts.fail} 项不通过、${counts["expected-fail"]} 项预期失败${counts.fixed ? `、${counts.fixed} 项已知问题已不再出现` : ""}；用时 ${(total / 1000).toFixed(1)} 秒。\n`;
    process.stdout.write(summary);
    if (app.model.unexpected.length > 0) process.stdout.write(`假模型收到的意外请求：\n${app.model.unexpected.map((line) => `  ${line}`).join("\n")}\n`);
    await writeFile(path.join(dir, "report.json"), JSON.stringify({ ok: !failed, ms: total, steps: results, unexpected: app.model.unexpected }, null, 2));
    process.stdout.write(`报告：${path.join(dir, "report.json")}\n`);
    if (values.until !== undefined || values.keep) {
      await serve(app);
    } else {
      await app.close();
      process.exitCode = failed ? 1 : 0;
    }
  }
}

try {
  await main();
} catch (error) {
  // 应用没能起来（缺离线包、找不到浏览器、构建失败）：说明原因，不打印整段调用栈。
  process.stderr.write(`走查没能开始：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
