import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { detectCommandTool, type CommandTool } from "../src/agent/command-tool.js";
import { createAgentRuntimeForTest } from "../src/agent/runtime.js";
import type { AgentSession, AgentSpaceOptions } from "../src/agent.js";
import type { AgentDefinition } from "../src/plugin.js";
import type { Confirmation } from "../src/schema.js";

const shell: AgentDefinition = { id: "shell", description: "用命令行整理文件", instructions: () => "你用命令行整理文件。", tools: ["bash", "read"] };

async function fixture(t: TestContext, commandTool: CommandTool, options: { policy?: "ask" | "fullAccess"; confirm?: boolean } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-command-tool-")));
  const agentDir = path.join(root, "app", "agent");
  await mkdir(agentDir, { recursive: true });
  const faux = fauxProvider({ api: `command-api-${randomUUID()}`, provider: `command-provider-${randomUUID()}`, models: [{ id: "test", contextWindow: 16384, maxTokens: 512 }], tokensPerSecond: 0 });
  const models = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  models.registerNativeProvider(faux.provider);
  const runtime = await createAgentRuntimeForTest({
    dateView: false,
    agentDir,
    modelRuntime: models,
    defaultModel: { provider: faux.getModel().provider, id: "test" },
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
    commandTool,
  });
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  const confirmations: Confirmation[] = [];
  const recorded: string[] = [];
  const space = await runtime.openSpace({
    root,
    sessionsDir: path.join(root, ".repa", "sessions"),
    instructions: () => [],
    tools: () => [],
    views: async () => [],
    agents: () => [shell],
    overrides: async () => ({ app: {}, space: {} }),
    commandPolicy: () => options.policy ?? "ask",
    record: async (runId, action) => {
      recorded.push(runId);
      return action();
    },
    onEvent: () => undefined,
    confirm: async request => {
      confirmations.push(request);
      return options.confirm ?? false;
    },
  } satisfies AgentSpaceOptions);
  const captures: TranscriptContext[] = [];
  // 第一次回复调用给定的工具，第二次结束运行；记下第一次请求，看声明了哪些工具。
  const respond = (tool: string, command: string) => {
    faux.setResponses([
      context => {
        captures.push(structuredClone(context));
        return fauxAssistantMessage(fauxToolCall(tool, { command }));
      },
      fauxAssistantMessage("完成"),
    ]);
  };
  return { space, captures, confirmations, recorded, respond };
}

function toolResults(session: AgentSession) {
  return session.history().filter(entry => entry.type === "tool").map(entry => {
    const data = entry.data !== null && typeof entry.data === "object" ? entry.data : {};
    return { tool: "tool" in data ? data.tool : undefined, isError: "isError" in data ? data.isError : undefined, text: entry.text ?? "" };
  });
}

test("Windows 上找到 Git Bash 时用 bash，找不到或只找到 WSL 的启动器时用 powershell；其他系统总是 bash", () => {
  const found = (shell: string) => () => shell;
  const missing = () => {
    throw new Error("No bash shell found");
  };
  assert.equal(detectCommandTool("linux", undefined, missing), "bash");
  assert.equal(detectCommandTool("darwin", undefined, missing), "bash");
  assert.equal(detectCommandTool("win32", undefined, found("C:\\Program Files\\Git\\bin\\bash.exe")), "bash");
  assert.equal(detectCommandTool("win32", undefined, found("C:\\msys64\\usr\\bin\\bash.exe")), "bash");
  assert.equal(detectCommandTool("win32", undefined, missing), "powershell");
  assert.equal(detectCommandTool("win32", undefined, found("C:\\Windows\\System32\\bash.exe")), "powershell");
  assert.equal(detectCommandTool("win32", undefined, found("c:/windows/sysnative/bash.exe")), "powershell");
  // Pi 设置里的 shellPath 交给查找函数，与 bash 工具执行时用的是同一个。
  const seen: (string | undefined)[] = [];
  detectCommandTool("win32", "D:\\cygwin\\bin\\bash.exe", path => {
    seen.push(path);
    return path ?? "";
  });
  assert.deepEqual(seen, ["D:\\cygwin\\bin\\bash.exe"]);
});

test("机器上运行命令用 powershell 时，通用 Agent 的工具和工具段里是 powershell，没有 bash", async t => {
  const f = await fixture(t, "powershell");
  const session = await f.space.create();
  f.respond("powershell", "Write-Output 你好");
  await session.send("运行命令");
  const context = f.captures[0];
  assert(context);
  const tools = getCurrentTools(context.messages).map(tool => tool.name);
  assert(tools.includes("powershell"));
  assert(!tools.includes("bash"));
  assert.match(getCurrentSystemPrompt(context.messages) ?? "", /不用 powershell；powershell 只用于运行程序/u);
});

test("powershell 命令在询问模式下先询问，看起来只读也问，拒绝后不执行；运行算不透明写入者", async t => {
  const f = await fixture(t, "powershell", { confirm: false });
  const session = await f.space.create();
  f.respond("powershell", "ls");
  await session.send("运行命令");
  assert.deepEqual(f.confirmations.map(item => [item.kind, item.message]), [["command", "ls"]]);
  assert.deepEqual(toolResults(session), [{ tool: "powershell", isError: true, text: "用户拒绝执行命令" }]);
  assert.equal(f.recorded.length, 1);
});

test("完全访问时 powershell 命令不询问", async t => {
  const f = await fixture(t, "powershell", { policy: "fullAccess" });
  const session = await f.space.create();
  f.respond("powershell", "Write-Output 你好");
  await session.send("运行命令");
  assert.equal(f.confirmations.length, 0);
  assert.equal(toolResults(session)[0]?.tool, "powershell");
});

test("插件 Agent 声明了 bash，在运行命令用 powershell 的机器上拿到 powershell", async t => {
  const f = await fixture(t, "powershell");
  const session = await f.space.create({ agent: "shell" });
  f.respond("powershell", "Write-Output 你好");
  await session.send("整理文件");
  const context = f.captures[0];
  assert(context);
  assert.deepEqual(getCurrentTools(context.messages).map(tool => tool.name).sort(), ["powershell", "read"]);
  assert.deepEqual(f.confirmations.map(item => item.kind), ["command"]);
});

test("机器上运行命令用 bash 时，工具与确认照旧，只读的 bash 命令不问", async t => {
  const f = await fixture(t, "bash");
  const session = await f.space.create();
  f.respond("bash", "ls");
  await session.send("运行命令");
  const context = f.captures[0];
  assert(context);
  const tools = getCurrentTools(context.messages).map(tool => tool.name);
  assert(tools.includes("bash"));
  assert(!tools.includes("powershell"));
  assert.match(getCurrentSystemPrompt(context.messages) ?? "", /不用 bash；bash 只用于运行程序/u);
  assert.equal(f.confirmations.length, 0);
  assert.equal(f.recorded.length, 1);
});

test("Windows 上 powershell 工具执行命令，中文输出按 UTF-8 读回", { skip: process.platform === "win32" ? false : "PowerShell 只在 Windows 上有" }, async t => {
  const f = await fixture(t, "powershell", { policy: "fullAccess" });
  const session = await f.space.create();
  f.respond("powershell", "Write-Output '中文输出'");
  await session.send("运行命令");
  const [result] = toolResults(session);
  assert.equal(result?.isError, false);
  assert.match(result?.text ?? "", /中文输出/u);
});
