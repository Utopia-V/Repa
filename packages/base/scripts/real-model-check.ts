import { closeSync, openSync, writeSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { createAgentRuntime, startServer, type AgentRuntime, type RepaServer } from "@repa/base";
import { RepaClient } from "@repa/base/client";
import type { Plugin } from "@repa/base/plugin";
import type { Result } from "@repa/base/protocol";

import { notesPlugin } from "../examples/notes-plugin.js";
import { leaseSettings } from "./real-model/settings.js";
import { installTransportRecorder } from "./real-model/transport.js";
import { usageMatches } from "./real-model/usage.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "agent-dir": { type: "string", default: path.join(os.homedir(), ".repa", "agent") },
    model: { type: "string", default: "gpt-6-luna" },
    limit: { type: "string", default: "30" },
    "skip-refresh": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help || !values.output) {
  console.log("用法：npm run real-model-check --workspace=@repa/base -- --output /绝对路径/新结果.jsonl [--limit 30] [--skip-refresh]");
  console.log("使用真实订阅额度。先关闭使用同一 Repa agent 目录的进程；临时调整 settings.json，结束后恢复。凭据不复制，刷新结果由 Pi 保存到原文件。");
  process.exit(values.help ? 0 : 1);
}

const limit = Number(values.limit);
if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit_must_be_1_to_100");
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
const recorder = installTransportRecorder({
  limit,
  phase: () => phase,
  viewMarker: "<repa-view source=",
  onRecord: record => log({ type: "request", ...record }),
});
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
let version = 0;
let suffix = "A";
let checksFailed = 0;

const stop = () => {
  interrupted = true;
  if (client && sessionId) client.call("session.abort", { sessionId }).catch(() => undefined);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  const authPath = path.join(values["agent-dir"], "auth.json");
  const initialCredential = readStoredCredential("openai-codex", authPath);
  if (initialCredential?.type !== "oauth") throw new Error("codex_oauth_required");
  const model = openaiCodexProvider().getModels().find(item => item.id === values.model);
  if (!model) throw new Error("model_not_in_locked_catalog");
  log({
    type: "environment", date: new Date().toISOString(), node: process.version,
    piVersion: "0.87.1", provider: "openai-codex", model: model.id, limit,
    transport: "sse", thinking: "off", viewBatchSize: 3,
    promptCache: model.promptCache ?? null,
    catalogCost: model.cost,
    oauthPresent: true, oauthInitiallyExpired: initialCredential.expires <= Date.now(),
  });
  phase = "lease-settings";
  settingsAttempted = true;
  settings = await leaseSettings(values["agent-dir"], directory);
  phase = "runtime-open";
  runtime = await createAgentRuntime({ agentDir: values["agent-dir"] });
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
  recorder.allowLocalWebSocket(server.connection.url);
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
  const session = await client.call("session.create", { model: { provider: "openai-codex", id: model.id } });
  sessionId = session.id;
  const activeClient = client;
  const history = () => activeClient.call("session.history", { sessionId: session.id });
  let previousHistory: Result<"session.history"> = [];
  let previousRequestCount = 0;

  async function capture(label: string, checkAnswer: boolean) {
    await recorder.waitForIdle();
    const entries = await history();
    const oldIds = new Set(previousHistory.map(entry => entry.id));
    const added = entries.filter(entry => !oldIds.has(entry.id));
    const answers = added.filter(entry => entry.type === "assistant");
    const replyMatches = checkAnswer ? answers.at(-1)?.text?.trim() === `CHECK_${version}|${suffix}` : null;
    if (replyMatches === false) checksFailed++;
    const newPrompts = added.filter(entry => entry.type === "prompt").map(entry => {
      const sections = object(entry.data).sections;
      return Array.isArray(sections) ? sections.map((item: unknown) => object(item).id).filter(id => typeof id === "string") : [];
    });
    const requests = recorder.records.slice(previousRequestCount).filter(record => record.kind === "model");
    const usages = added.flatMap(entry => entry.usage ? [entry.usage] : []);
    const usageMatchesRaw = usageMatches(requests.map(request => request.rawUsage), usages);
    if (!usageMatchesRaw) checksFailed++;
    log({
      type: "step", phase: label, version, replyMatches, usageMatchesRaw,
      viewsAdded: added.filter(entry => entry.type === "view").length,
      editsAdded: added.filter(entry => entry.type === "contextEdit").length,
      promptSectionsAdded: newPrompts,
      compactionsAdded: added.filter(entry => entry.type === "compaction").length,
      toolResultsAdded: added.filter(entry => entry.type === "tool").length,
      usage: added.filter(entry => entry.usage).map(entry => ({
        kind: entry.type, ...entry.usage,
        modelMatchesRequested: entry.type === "assistant" ? object(entry.data).model === values.model : null,
      })),
    });
    if (added.some(entry => entry.type === "tool")) throw new Error("unexpected_tool_execution");
    previousHistory = entries;
    previousRequestCount = recorder.records.length;
    console.log(`${label}: ${checkAnswer ? `reply=${replyMatches}` : "captured"}; requests=${recorder.records.length}`);
  }

  async function send(label: string) {
    if (interrupted) throw new Error("interrupted");
    phase = label;
    await activeClient.call("session.send", {
      sessionId: session.id,
      text: "读取最新 view 的核实版本，按当前插件说明仅回复版本码和后缀，用竖线连接。不要调用工具。",
    });
    await capture(label, true);
    await sleep(1000);
  }

  await send("initial");
  await send("stable");
  for (version = 1; version <= 6; version++) {
    await send(`view-${version}`);
    if (version <= 3 || version === 6) await send(`view-${version}-stable`);
    if (version === 2) {
      // 先取得已有缓存命中，再测覆盖是否保住前缀；至多补两次短探测，不无限等待服务命中。
      for (let attempt = 1; attempt <= 2 && !(recorder.records.at(-1)?.rawUsage.cached); attempt++) {
        await send(`before-override-${attempt}`);
      }
      log({ type: "override-baseline", cached: recorder.records.at(-1)?.rawUsage.cached ?? null });
      suffix = "B";
      await setSuffix();
      await send("override");
      await send("override-stable");
    }
  }
  // 让压缩后的正确答案只存在于新状态，不可能仅靠压缩前的对话复述。
  version = 7;
  phase = "compact";
  await activeClient.call("session.compact", { sessionId: session.id });
  await capture(phase, false);
  await send("after-compact");
  await send("after-compact-stable");

  phase = "idle";
  const beforeIdle = recorder.records.length;
  await sleep(2000);
  log({
    type: "warming", waitMs: 2000, requestsDuringIdle: recorder.records.length - beforeIdle,
    cacheWarmEntries: (await history()).filter(entry => entry.type === "usage" && object(entry.data).kind === "cache_warm").length,
    catalogTtlAvailable: model.promptCache?.short !== undefined,
    evidence: "catalog-and-source-plus-network-observation",
  });

  if (!values["skip-refresh"]) {
    phase = "oauth-refresh";
    const credential = readStoredCredential("openai-codex", authPath);
    if (credential?.type !== "oauth") throw new Error("codex_oauth_missing_before_refresh");
    const authRuntime = await ModelRuntime.create({ authPath, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    let minimumValiditySatisfied = false;
    try {
      // 用公开入口要求略长于现有寿命的凭据，让 Pi 在原存储锁内刷新；不改过期时间或令牌。
      await authRuntime.getAuth("openai-codex", {
        minOAuthValidityMs: Math.max(300_000, credential.expires - Date.now() + 1000),
        signal: AbortSignal.timeout(20_000),
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
  }
  completed = true;
} catch {
  // 上游 Error、RPC data 与请求体都可能包含敏感内容，不进入工件或终端。
  log({ type: "failure", phase, interrupted });
  console.error(`核实在 ${phase} 停止；查看脱敏记录中的 HTTP 状态和 usage。`);
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
  recorder.restore();
  await recorder.waitForIdle();
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  log({
    type: "end", completed, checksFailed, settingsRestored,
    totalRequests: recorder.records.length,
    blockedWebSocketAttempts: recorder.blockedWebSocketAttempts,
  });
  closeSync(logFile);
  if (settingsRestored) await rm(directory, { recursive: true, force: true });
  if (checksFailed > 0) process.exitCode = 1;
}
