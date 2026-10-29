import path from "node:path";

import { fauxAssistantMessage, fauxProvider, getCurrentTools, type Tool } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

import { createAgentRuntimeForTest } from "../../packages/base/src/agent/runtime.js";
import { createPluginTestHost } from "../../packages/base/src/testing.js";
import notesPlugin from "../../packages/base/examples/notes-plugin.js";
import { createLearningPlugin } from "../../packages/learning/src/plugin.js";
import { cell, document, runGenerator } from "./generation.js";
import { schemaTable } from "./schema-table.js";

export async function generateTools() {
  const fixture = await createPluginTestHost({ plugins: [createLearningPlugin(), notesPlugin] });
  let runtime: Awaited<ReturnType<typeof createAgentRuntimeForTest>> | undefined;
  try {
    if (fixture.host.disabled().length || fixture.errors.length) throw new Error(`离线插件打开失败：${JSON.stringify(fixture.host.disabled())}`);
    const agentDir = path.join(fixture.directory, "agent");
    const faux = fauxProvider({ api: "docs-tools", provider: "docs-tools", models: [{ id: "offline", contextWindow: 32768, maxTokens: 64 }], tokensPerSecond: 0 });
    const models = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    models.registerNativeProvider(faux.provider);
    runtime = await createAgentRuntimeForTest({
      agentDir,
      modelRuntime: models,
      defaultModel: { provider: "docs-tools", id: "offline" },
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
    });
    const space = await runtime.openSpace({
      root: fixture.space.root,
      sessionsDir: path.join(fixture.directory, "sessions"),
      instructions: () => [],
      tools: () => [],
      views: async () => [],
      overrides: async () => ({ app: {}, space: {} }),
      commandPolicy: () => "ask",
      record: async (_runId, action) => action(),
      onEvent: () => {},
      confirm: async () => false,
    });
    let builtins: Tool[] = [];
    // 只在本地预设 provider 中读取 Pi 实际交给模型的声明，不执行工具，也不发网络请求。
    faux.setResponses([(context) => {
      builtins = getCurrentTools(context.messages);
      return fauxAssistantMessage("目录已读取");
    }]);
    await (await space.create()).send("读取工具声明");
    if (!builtins.length) throw new Error("没有读到底座工具声明");
    const entries = [
      ...builtins.map((tool) => ({ source: "底座内置", tool })),
      ...fixture.host.tools().map((tool) => ({ source: fixture.host.list().find((plugin) => plugin.tools.includes(tool.name))?.id ?? "插件", tool })),
    ].sort((a, b) => a.tool.name.localeCompare(b.tool.name, "en"));
    return document("tools", "docs/generated/tools.md", "模型看到的工具", entries.map(({ source, tool }) =>
      `## ${tool.name}\n\n来源：${source}。\n\n${cell(tool.description)}\n\n${schemaTable(tool.parameters)}`).join("\n\n"), entries.length);
  } finally {
    try {
      await runtime?.close();
    } finally {
      await fixture.close();
    }
  }
}
runGenerator(import.meta.url, generateTools);
