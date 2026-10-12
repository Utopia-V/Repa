// 子进程入口，供 agent-files.test.ts 使用：父进程让 PATH 只指向空目录、设 PI_OFFLINE，并把 Pi 的工具目录换成空目录，
// 这里让插件 Agent 调一次 find，把工具结果打印到 stdout。插件 Agent 的 find 若仍要 fd，就只能得到错误。
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAgentRuntimeForTest } from "../../src/agent/runtime.js";

const root = process.argv[2];
if (root === undefined) throw new Error("缺少空间路径");
const agentDir = path.join(root, ".repa", "test-agent");
await mkdir(agentDir, { recursive: true });
const faux = fauxProvider({ api: `find-api-${randomUUID()}`, provider: `find-provider-${randomUUID()}`, models: [{ id: "test", contextWindow: 16384, maxTokens: 512 }], tokensPerSecond: 0 });
const models = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
models.registerNativeProvider(faux.provider);
const runtime = await createAgentRuntimeForTest({
  agentDir,
  modelRuntime: models,
  defaultModel: { provider: faux.getModel().provider, id: "test" },
  settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
});
try {
  const space = await runtime.openSpace({
    root,
    sessionsDir: path.join(root, ".repa", "sessions"),
    instructions: () => [],
    tools: () => [],
    views: async () => [],
    agents: () => [{ id: "finder", instructions: () => "你查找课程文件。", tools: ["find"] }],
    overrides: async () => ({ app: {}, space: {} }),
    commandPolicy: () => "ask",
    record: async (_id, action) => action(),
    onEvent: () => undefined,
    confirm: async () => false,
  });
  const session = await space.create({ agent: "finder" });
  faux.setResponses([fauxAssistantMessage(fauxToolCall("find", { pattern: "*.md" })), fauxAssistantMessage("已查找")]);
  await session.send("查找课程文件");
  const result = session.history().find(entry => entry.type === "tool");
  const data = result?.data !== null && typeof result?.data === "object" ? result.data : {};
  process.stdout.write(JSON.stringify({ text: result?.text, isError: "isError" in data ? data.isError : undefined }));
} finally {
  await runtime.close();
}
