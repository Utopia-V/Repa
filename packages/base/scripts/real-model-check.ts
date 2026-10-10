import { closeSync, openSync, writeSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { createAgentRuntime, startServer, type AgentRuntime, type RepaServer } from "@repa/base";
import { RepaClient } from "@repa/base/client";
import type { Plugin } from "@repa/base/plugin";
import type { Result } from "@repa/base/protocol";

import { notesPlugin } from "../examples/notes-plugin.js";
import { checkProbeReply } from "./real-model/answer.js";
import { leaseSettings } from "./real-model/settings.js";
import { guardProbeRuntime } from "./real-model/guard.js";
import { installDeepseekProbe } from "./real-model/deepseek.js";
import { installedPiVersion, probeAuth, selectProbeModel } from "./real-model/model.js";
import { assertModelBudget, summarizeUsage } from "./real-model/usage.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "agent-dir": { type: "string", default: path.join(os.homedir(), ".repa", "agent") },
    provider: { type: "string", default: "openai-codex" },
    model: { type: "string" },
    limit: { type: "string", default: "30" },
    "cost-limit": { type: "string", default: "0.5" },
    "request-limit": { type: "string", default: "50" },
    "skip-refresh": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help || !values.output) {
  console.log("用法：npm run real-model-check --workspace=@repa/base -- --output /绝对路径/新结果.jsonl [--provider openai-codex|deepseek] [--model 模型ID] [--limit 30] [--skip-refresh]");
  console.log("--limit 按 Pi 助手消息、压缩和保温操作计数，不是 HTTP 请求上限；一次压缩最多含两份摘要请求，OAuth 刷新另行执行一次。");
  console.log("DeepSeek 默认每次运行 --cost-limit 0.5 美元、--request-limit 50（含压缩子请求和失败），输出上限 2048 token；两次运行合计最多 1 美元、100 次请求。追加运行时须从总授权中扣除已用额度。API key 不执行 OAuth 刷新。");
  console.log("使用真实额度。先关闭使用同一 Repa agent 目录的进程；临时调整 settings.json，结束后恢复。凭据不复制，OAuth 刷新结果由 Pi 保存到原文件。");
  process.exit(values.help ? 0 : 1);
}

const limit = Number(values.limit);
if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit_must_be_1_to_100");
const costLimit = Number(values["cost-limit"]);
const requestLimit = Number(values["request-limit"]);
if (!Number.isFinite(costLimit) || costLimit <= 0 || costLimit > 1) throw new Error("cost_limit_must_be_positive_and_at_most_1");
if (!Number.isInteger(requestLimit) || requestLimit < 1 || requestLimit > 100) throw new Error("request_limit_must_be_1_to_100");
const model = selectProbeModel(values.provider, values.model);
const output = path.resolve(values.output);
await mkdir(path.dirname(output), { recursive: true });
const logFile = openSync(output, "wx", 0o600);
function log(value: Record<string, unknown>): void {
  writeSync(logFile, `${JSON.stringify(value)}\n`);
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

let phase = "setup";
const directory = await mkdtemp(path.join(os.tmpdir(), "repa-base-real-check-"));
let settings: Awaited<ReturnType<typeof leaseSettings>> | undefined;
let runtime: AgentRuntime | undefined;
let server: RepaServer | undefined;
let client: RepaClient | undefined;
let sessionId: string | undefined;
let interrupted = false;
let completed = false;
let settingsRestored = false;
let settingsAttempted = false;
let finalHistory: Result<"session.history"> = [];
let version = 0;
let suffix = "A";
let checksFailed = 0;
let probe: ReturnType<typeof installDeepseekProbe> | undefined;
const stopController = new AbortController();

const stop = () => {
  interrupted = true;
  stopController.abort();
  if (client && sessionId) client.call("session.abort", { sessionId }).catch(() => undefined);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  const authPath = path.join(values["agent-dir"], "auth.json");
  const initialCredential = readStoredCredential(model.provider, authPath);
  const auth = probeAuth(model.provider, initialCredential, values["skip-refresh"]);
  log({
    type: "environment", date: new Date().toISOString(), node: process.version,
    piVersion: installedPiVersion(), provider: model.provider, model: model.id, limit,
    sessionTransport: "sse", thinking: "off", viewBatchSize: 3,
    promptCache: model.promptCache ?? null,
    catalogCost: model.cost,
    budgetUnit: "pi-model-operation", usageSource: "pi-session-history",
    oauthPresent: initialCredential?.type === "oauth",
    oauthInitiallyExpired: initialCredential?.type === "oauth" ? initialCredential.expires <= Date.now() : null,
    auth: { credentialType: auth.credentialType, refreshStatus: auth.refreshStatus },
    supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
    deepseekBudget: model.provider === "deepseek" ? { costLimit, requestLimit, maxOutputTokens: 2048 } : null,
  });
  if (model.provider === "deepseek") {
    probe = installDeepseekProbe({ model, costLimit, requestLimit, phase: () => phase, log });
  }
  phase = "lease-settings";
  settingsAttempted = true;
  settings = await leaseSettings(values["agent-dir"], directory);
  phase = "runtime-open";
  runtime = guardProbeRuntime(await createAgentRuntime({ agentDir: values["agent-dir"] }));
  const probeNotes: Plugin = {
    ...notesPlugin,
    async open(host) {
      const instance = await notesPlugin.open(host);
      return {
        ...instance,
        // 示例原 view 是常量；只在核实夹具中叠加可控状态，不改变示例的工具和保存行为。
        async view() {
          return `${await instance.view?.() ?? ""}\n核实状态：当前版本 CHECK_${version}。同一来源的旧版本已经过时，只读取最新出现的一份。`;
        },
      };
    },
  };
  phase = "server-open";
  server = await startServer({ home: path.join(directory, "home"), runtime, plugins: [probeNotes] });
  phase = "client-connect";
  client = await RepaClient.connect(server.connection);
  client.on("confirm.request", ({ id }) => {
    client?.call("confirm.reply", { id, value: false }).catch(() => undefined);
  });
  phase = "space-create";
  await client.call("space.create", { root: path.join(directory, "space") });
  phase = "sample-note";
  await client.call("plugin.call", { pluginId: "notes", method: "save", input: { name: "probe", text: "缓存与上下文核实用的临时笔记。" } });
  phase = "prompt-setup";
  const preview = await client.call("prompt.preview", {});
  const notesInstructions = preview.sections.find(section => section.id === "plugin:notes")?.text;
  if (!notesInstructions) throw new Error("notes_instructions_missing");
  const setSuffix = () => client?.call("prompt.set", {
    scope: "space", id: "plugin:notes",
    override: { text: `${notesInstructions}\n核实回复后缀为 ${suffix}。核实时只回复当前 view 的版本码、竖线和此后缀，不调用工具。` },
  });
  await setSuffix();
  phase = "session-create";
  const session = await client.call("session.create", { model: { provider: model.provider, id: model.id } });
  sessionId = session.id;
  const activeClient = client;
  const history = () => activeClient.call("session.history", { sessionId: session.id });
  let previousHistory: Result<"session.history"> = [];

  async function runOperation(action: () => Promise<unknown>) {
    if (interrupted) throw new Error("interrupted");
    let timedOut = false;
    let cancellation: Promise<unknown> | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      cancellation = activeClient.call("session.abort", { sessionId: session.id }).catch(() => undefined);
    }, 90_000);
    try {
      await action();
      if (timedOut) throw new Error("model_operation_timeout");
    } finally {
      clearTimeout(timeout);
      await cancellation;
    }
  }

  async function capture(label: string, checkAnswer: boolean) {
    const entries = await history();
    const oldIds = new Set(previousHistory.map(entry => entry.id));
    const added = entries.filter(entry => !oldIds.has(entry.id));
    const answers = added.filter(entry => entry.type === "assistant");
    const usageSummary = summarizeUsage(added);
    const rawUsage = probe?.snapshot(label);
    const usageMatchesRaw = rawUsage ? rawUsage.requests > 0 && rawUsage.incompleteRequests === 0
      && rawUsage.fullInput === usageSummary.fullInput && rawUsage.output === usageSummary.output
      && rawUsage.cacheRead === usageSummary.cacheRead && rawUsage.input === usageSummary.input : null;
    if (usageMatchesRaw === false) checksFailed++;
    const replyCheck = checkAnswer ? checkProbeReply(answers.at(-1)?.text, version, suffix) : null;
    const replyMatches = replyCheck?.replyMatches ?? null;
    if (replyMatches === false) checksFailed++;
    const newPrompts = added.filter(entry => entry.type === "prompt").map(entry => {
      const sections = object(entry.data).sections;
      return Array.isArray(sections) ? sections.map((item: unknown) => object(item).id).filter(id => typeof id === "string") : [];
    });
    log({
      type: "step", phase: label, version, replyMatches, replyCheck,
      viewsAdded: added.filter(entry => entry.type === "view").length,
      editsAdded: added.filter(entry => entry.type === "contextEdit").length,
      promptSectionsAdded: newPrompts,
      compactionsAdded: added.filter(entry => entry.type === "compaction").length,
      toolResultsAdded: added.filter(entry => entry.type === "tool").length,
      usageSummary, rawUsage: rawUsage ?? null, usageMatchesRaw,
      usage: added.filter(entry => entry.usage).map(entry => ({
        kind: entry.type, ...entry.usage,
        modelMatchesRequested: entry.type === "assistant" ? object(entry.data).model === model.id : null,
      })),
    });
    if (added.some(entry => entry.type === "tool")) throw new Error("unexpected_tool_execution");
    previousHistory = entries;
    finalHistory = entries;
    console.log(`${label}: ${checkAnswer ? `reply=${replyMatches}` : "captured"}; modelOperations=${summarizeUsage(entries).modelOperations}`);
  }

  async function send(label: string) {
    if (interrupted) throw new Error("interrupted");
    phase = label;
    assertModelBudget(await history(), limit);
    await runOperation(() => activeClient.call("session.send", {
      sessionId: session.id,
      text: "读取最新 view 的核实版本，按当前插件说明仅回复版本码和后缀，用竖线连接。不要调用工具。",
    }));
    await capture(label, true);
    await sleep(1000, undefined, { signal: stopController.signal });
  }

  await send("initial");
  await send("stable");
  for (version = 1; version <= 6; version++) {
    await send(`view-${version}`);
    if (version <= 3 || version === 6) await send(`view-${version}-stable`);
    if (version === 2) {
      // 先取得已有缓存命中，再测覆盖是否保住前缀；至多补两次短探测，不无限等待服务命中。
      for (let attempt = 1; attempt <= 2 && !(finalHistory.findLast(entry => entry.type === "assistant")?.usage?.cacheRead); attempt++) {
        await send(`before-override-${attempt}`);
      }
      log({ type: "override-baseline", cached: finalHistory.findLast(entry => entry.type === "assistant")?.usage?.cacheRead ?? null });
      suffix = "B";
      await setSuffix();
      await send("override");
      await send("override-stable");
    }
  }
  // 让压缩后的正确答案只存在于新状态，不可能仅靠压缩前的对话复述。
  version = 7;
  phase = "compact";
  assertModelBudget(await history(), limit);
  await runOperation(() => activeClient.call("session.compact", { sessionId: session.id }));
  await capture(phase, false);
  await send("after-compact");
  await send("after-compact-stable");

  phase = "idle";
  const beforeIdle = summarizeUsage(await history()).modelOperations;
  await sleep(2000, undefined, { signal: stopController.signal });
  finalHistory = await history();
  log({
    type: "warming", waitMs: 2000, modelOperationsDuringIdle: summarizeUsage(finalHistory).modelOperations - beforeIdle,
    cacheWarmEntries: finalHistory.filter(entry => entry.type === "usage" && object(entry.data).kind === "cache_warm").length,
    catalogTtlAvailable: model.promptCache?.short !== undefined,
    applicability: model.promptCache?.short === undefined ? "not-applicable-catalog-ttl-unavailable" : "available",
    evidence: "catalog-and-source-plus-pi-history-observation",
  });

  if (auth.refresh) {
    if (interrupted) throw new Error("interrupted");
    phase = "oauth-refresh";
    const credential = readStoredCredential("openai-codex", authPath);
    if (credential?.type !== "oauth") throw new Error("codex_oauth_missing_before_refresh");
    const authRuntime = await ModelRuntime.create({ authPath, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    let minimumValiditySatisfied = false;
    try {
      // 用公开入口要求略长于现有寿命的凭据，让 Pi 在原存储锁内刷新；不改过期时间或令牌。
      await authRuntime.getAuth("openai-codex", {
        minOAuthValidityMs: Math.max(300_000, credential.expires - Date.now() + 1000),
        signal: AbortSignal.any([stopController.signal, AbortSignal.timeout(20_000)]),
      });
      minimumValiditySatisfied = true;
    } catch {
      // Pi 先保存刷新结果，再检查最短寿命；只记录结果布尔值，错误 cause 可能含凭据。
    }
    const refreshed = readStoredCredential("openai-codex", authPath);
    const refreshVerified = refreshed?.type === "oauth" && refreshed.expires > Date.now()
      && (refreshed.access !== credential.access || refreshed.refresh !== credential.refresh || refreshed.expires > credential.expires);
    log({
      type: "oauth", minimumValiditySatisfied, refreshVerified,
      accessChanged: refreshed?.type === "oauth" && refreshed.access !== credential.access,
      refreshChanged: refreshed?.type === "oauth" && refreshed.refresh !== credential.refresh,
      expiryAdvanced: refreshed?.type === "oauth" && refreshed.expires > credential.expires,
      validAfterRefresh: refreshed?.type === "oauth" && refreshed.expires > Date.now(),
    });
    if (!refreshVerified) throw new Error("oauth_refresh_unverified");
    await send("after-refresh");
  } else {
    log({ type: "oauth", status: auth.refreshStatus });
  }
  finalHistory = await history();
  completed = true;
} catch (error) {
  // 失败前的助手消息也计入预算；SDK 没有保存的压缩失败用量仍不可观测。
  if (client && sessionId) {
    try {
      finalHistory = await client.call("session.history", { sessionId });
    } catch {
      // 会话已不可用时，仍继续关闭宿主并恢复设置。
    }
  }
  // 上游 Error 与 RPC data 都可能包含敏感内容，不进入工件或终端。
  const safeReasons = ["model_operation_limit", "model_operation_timeout", "unexpected_tool_execution", "oauth_refresh_unverified", "probe_credential_required"];
  let reason = "operation_failed";
  if (interrupted) reason = "interrupted";
  else if (error instanceof Error && safeReasons.includes(error.message)) reason = error.message;
  log({ type: "failure", phase, interrupted, reason });
  console.error(`核实在 ${phase} 停止；查看脱敏记录中的阶段和 Pi usage。`);
  process.exitCode = 1;
} finally {
  for (const close of [() => client?.close(), () => server?.close(), () => runtime?.close()]) {
    try {
      await close();
    } catch {
      log({ type: "cleanup-failure", resource: "runtime" });
      process.exitCode = 1;
    }
  }
  try {
    if (settings) await settings.restore();
    else if (settingsAttempted) throw new Error("settings_setup_failed");
    settingsRestored = true;
  } catch {
    console.error(`设置有并发变化；保留恢复材料：${directory}`);
    process.exitCode = 1;
  }
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  log({
    type: "end", completed, checksFailed, settingsRestored,
    usageSummary: summarizeUsage(finalHistory),
    rawUsage: probe?.snapshot() ?? null,
  });
  probe?.close();
  closeSync(logFile);
  if (settingsRestored) await rm(directory, { recursive: true, force: true });
  if (checksFailed > 0) process.exitCode = 1;
}
