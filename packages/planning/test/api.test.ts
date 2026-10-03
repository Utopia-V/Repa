import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { RepaClient, startRepaServer, type SettingScope } from "repa";
import { PlanClockResultSchema, PlanResultSchema, type PlanInput } from "../dist/schema.js";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const skillFile = path.join(packageDirectory, "skills", "plan-learning", "SKILL.md");
const application = { kind: "application" as const };

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= deadline) assert.fail(`等待规划运行超时：${JSON.stringify(value)}`);
    await delay(10);
  }
}

async function set(client: RepaClient, scope: SettingScope, key: string, value: unknown) {
  const entry = (await client.call("settings.get", { scope, namespace: "plugins" })).entries.find(entry => entry.key === key);
  assert(entry);
  await client.call("settings.set", { scope, namespace: "plugins", key, value, base: entry.revision });
}

function toolText(context: TranscriptContext, name: string): string {
  const message = context.messages.findLast(message => message.role === "toolResult" && message.toolName === name);
  assert(message && message.role === "toolResult");
  assert.equal(message.isError, false, JSON.stringify(message));
  return message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
}

function checkedPlan(context: TranscriptContext) {
  const result: unknown = JSON.parse(toolText(context, "check_plan"));
  assert(Check(PlanResultSchema, result));
  return result;
}

test("真实Pi读取包内规划方法，按检查修正安排并保存文档，人工改动与重开后的时间减少进入接续", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-planning-api-"));
  const directory = path.join(root, "space");
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: [packageDirectory], extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"],
    retry: { enabled: false }, compaction: { enabled: false },
  }));
  const faux = fauxProvider({
    api: `planning-${randomUUID()}`, provider: `planning-${randomUUID()}`,
    models: [{ id: "test", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 2048 }], tokensPerSecond: 0,
  });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const options = { agentDir, appDirectory: path.join(root, "app"), modelOverride: { modelRuntime, model: faux.getModel() } };
  let server = await startRepaServer(options);
  let client = await RepaClient.connect(server.connection);
  t.after(async () => {
    await server.close("cancel");
    await client.close();
    await rm(root, { recursive: true, force: true });
  });
  const space = await client.call("space.open", { path: directory });
  const session = await client.call("session.create", { spaceId: space.id });
  const key = { spaceId: space.id, sessionId: session.sessionId };
  const scope = { kind: "space" as const, spaceId: space.id };
  await set(client, application, "disabled", ["repa-planning"]);
  await set(client, application, "backends", [{ id: "planning", package: { kind: "source", source: packageDirectory, scope: "user" } }]);
  await set(client, application, "trusted", [{ kind: "package", name: "@repa/planning" }]);
  const preview = await client.call("prompts.preview", key);
  assert.match(preview.prompt.system, /plan-learning/u);
  assert.equal(existsSync(path.join(directory, ".repa", "plugins", "planning")), false);
  const beforeClock = Date.now();
  const clock = await client.call("capability.invoke", {
    scope: application, requestId: randomUUID(), contract: { id: "repa.planning.clock", version: "1" }, input: { timeZone: "Asia/Taipei" },
  });
  assert(clock.kind === "inline" && Check(PlanClockResultSchema, clock.result));
  assert.equal(clock.result.timeZone, "Asia/Taipei");
  assert(Date.parse(clock.result.instant) >= beforeClock && Date.parse(clock.result.instant) <= Date.now());

  const windows = [5, 6, 7].map(day => ({ start: `2026-10-0${day}T18:00`, end: `2026-10-0${day}T19:00` }));
  const firstWindow = windows[0];
  assert(firstWindow);
  const input: PlanInput = {
    timeZone: "Asia/Taipei", availability: windows,
    goals: [{ id: "tides", minutes: 90, deadline: "2026-10-07T19:00" }, { id: "currents", minutes: 60, deadline: "2026-10-07T19:00" }],
    sessions: [
      { id: "tides-1", goalId: "tides", ...firstWindow },
      { id: "tides-2", goalId: "tides", start: "2026-10-06T18:00", end: "2026-10-06T18:30" },
      { id: "currents-1", goalId: "currents", start: "2026-10-05T18:00", end: "2026-10-05T19:00" },
    ],
  };
  // 两个目标竞争周一同一时段，修正候选将潮流阅读移到周三。
  const revised: PlanInput = { ...input, sessions: input.sessions.map(session => session.id === "currents-1"
    ? { ...session, start: "2026-10-07T18:00", end: "2026-10-07T19:00" } : session) };
  const original = "# 潮汐与潮流计划\n\n目标：潮汐 90 分钟，潮流 60 分钟。\n\n周一：潮汐 60 分钟。\n周二：潮汐 30 分钟。\n周三：潮流 60 分钟。\n\n调整理由：两个目标原来占用周一同一时段，潮流阅读移至周三。\n";
  faux.setResponses([
    context => {
      assert.match(getCurrentSystemPrompt(context.messages), /plan-learning/u);
      assert(getCurrentTools(context.messages).some(tool => tool.name === "check_plan"));
      return fauxAssistantMessage(fauxToolCall("read", { path: skillFile }), { stopReason: "toolUse" });
    },
    context => {
      assert.match(toolText(context, "read"), /# 学习规划/u);
      assert.match(toolText(context, "read"), /check_plan/u);
      return fauxAssistantMessage(fauxToolCall("check_plan", input), { stopReason: "toolUse" });
    },
    context => {
      assert(checkedPlan(context).issues.some(issue => issue.code === "session_overlap"));
      return fauxAssistantMessage(fauxToolCall("check_plan", revised), { stopReason: "toolUse" });
    },
    context => {
      const result = checkedPlan(context);
      assert.deepEqual(result.issues, []);
      assert.equal(result.availableMinutes, 180);
      assert.equal(result.scheduledMinutes, 150);
      return fauxAssistantMessage(fauxToolCall("write", { path: "plan.md", content: original }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage("已将冲突的潮流阅读移到周三，计划保存在 plan.md。"),
  ]);
  const send = async (text: string) => {
    const request = await client.call("session.submit", { target: key, requestId: randomUUID(), input: { parts: [{ kind: "text", text }] }, dispatch: { kind: "start" } });
    assert(request.runId);
    const runId = request.runId;
    const run = await until(() => client.call("run.get", { spaceId: space.id, runId }),
      run => ["completed", "failed", "cancelled", "interrupted"].includes(run.status));
    assert.equal(run.status, "completed", JSON.stringify(run));
  };
  await send("时区 Asia/Taipei，2026 年 10 月 5、6、7 日每天 18—19 点可用；潮汐需 90 分钟、潮流需 60 分钟，7 日 19 点前完成。请使用规划方法和检查工具形成可执行计划。");
  assert.equal(await readFile(path.join(directory, "plan.md"), "utf8"), original);

  const human = "\n人工补充：潮汐图必须保留符号 η；先读原始材料 🌊。\n";
  await writeFile(path.join(directory, "plan.md"), original + human);
  await server.close("cancel");
  await client.close();
  server = await startRepaServer(options);
  client = await RepaClient.connect(server.connection);
  assert.equal((await client.call("space.open", { path: directory })).id, space.id);
  const shortened = { ...revised, availability: windows.slice(0, 2) };
  const replacement = "周三：时间取消，潮流 60 分钟尚待重新安排。\n\n当前总工作量 150 分钟、可用时间 120 分钟，至少还缺 30 分钟；需缩小本次范围或增加时间后重新检查。";
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: "plan.md" }), { stopReason: "toolUse" }),
    context => {
      assert.match(toolText(context, "read"), /人工补充：潮汐图必须保留符号 η；先读原始材料 🌊。/u);
      return fauxAssistantMessage(fauxToolCall("check_plan", shortened), { stopReason: "toolUse" });
    },
    context => {
      const result = checkedPlan(context);
      assert(result.issues.some(issue => issue.code === "capacity_shortfall" && issue.shortfallMinutes === 30));
      return fauxAssistantMessage(fauxToolCall("edit", { path: "plan.md", edits: [{ oldText: "周三：潮流 60 分钟。", newText: replacement }] }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage("计划已标出时间缺口，人工补充保留；等待确定缩减范围或新增时间。"),
  ]);
  await send("周三的时间取消，请读取当前计划和我的补充，再核对安排；缺的时间先明确记下来，不擅自增加可用时间。");
  const saved = (original + human).replace("周三：潮流 60 分钟。", replacement);
  assert.equal(await readFile(path.join(directory, "plan.md"), "utf8"), saved);
  assert.equal(faux.state.callCount, 9);
  await set(client, scope, "disabled", ["repa-planning", "planning"]);
  const disabled = await client.call("prompts.preview", key);
  assert(!disabled.prompt.system.includes("plan-learning"));
  assert(!(await client.call("capability.describe", { scope })).capabilities.some(item => item.pluginId === "planning"));
  assert.equal(await readFile(path.join(directory, "plan.md"), "utf8"), saved);
});
