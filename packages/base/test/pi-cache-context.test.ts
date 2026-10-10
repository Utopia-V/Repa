import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  getCurrentSystemPrompt,
  getCurrentTools,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type SessionMessage = AgentSession["messages"][number];

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-pi-cache-context-"));
  const agentDir = path.join(root, "agent");
  let session: AgentSession | undefined;
  t.after(async () => {
    if (session) {
      await session.abort();
      session.dispose();
    }
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(agentDir, { recursive: true });
  const faux = fauxProvider({
    api: `repa-cache-api-${randomUUID()}`,
    provider: `repa-cache-provider-${randomUUID()}`,
    models: [
      { id: "first", contextWindow: 16384, maxTokens: 512 },
      { id: "second", contextWindow: 16384, maxTokens: 512 },
    ],
    tokensPerSecond: 0,
  });
  const model = faux.getModel();
  // 长于本测试执行时间，状态读取只检查真实 SDK 闭包，不等待保温请求。
  model.promptCache = { short: 300 };
  model.cost = { input: 100000, output: 1, cacheRead: 1, cacheWrite: 100000 };
  const models = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  models.registerNativeProvider(faux.provider);
  const settings = SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: false },
    cacheWarming: "idle",
  });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "缓存回归测试",
    extensionFactories: [pi => {
      pi.on("before_agent_start", event => {
        event.systemPromptOptions.sections.plugin = "稳定的插件说明";
      });
    }],
  });
  await loader.reload();
  const result = await createAgentSession({
    cwd: root,
    agentDir,
    modelRuntime: models,
    model,
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(root),
    resourceLoader: loader,
    tools: ["test_state"],
    customTools: [{
      name: "test_state",
      label: "测试状态",
      description: "读取测试状态",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "状态" }], details: {} }),
    }],
  });
  session = result.session;
  await session.sendCustomMessage({
    customType: "test:note",
    content: "已有工作记录",
    display: false,
    details: { version: 1 },
  });
  await session.sendCustomMessage({
    customType: "repa-view",
    content: "<repa-view source=\"plugin:test\">状态版本 1</repa-view>",
    display: false,
    details: { id: "plugin:test", version: 1 },
  });
  let capture: TranscriptContext | undefined;
  faux.setResponses([context => {
    capture = structuredClone(context);
    return fauxAssistantMessage("完成");
  }]);
  await session.prompt("继续工作");
  assert(capture);
  assert.match(getCurrentSystemPrompt(capture.messages), /稳定的插件说明/u);
  assert.deepEqual(getCurrentTools(capture.messages).map(tool => tool.name), ["test_state"]);
  assert.match(JSON.stringify(capture.messages), /已有工作记录/u);
  assert.match(JSON.stringify(capture.messages), /状态版本 1/u);
  assert.equal(faux.state.callCount, 1);
  assert.equal(session.cacheWarmingStatus?.state, "scheduled", JSON.stringify(session.cacheWarmingStatus));
  return { session, faux, model };
}

function rebuildMessages(messages: SessionMessage[]): SessionMessage[] {
  // 即使测试在同一毫秒完成，每条消息也一定具有不同的顶层 timestamp。
  return structuredClone(messages).map(message => ({ ...message, timestamp: message.timestamp + 60000 }));
}

test("真实 SDK 请求后重建相同内容并改变 timestamp，缓存仍可保温", async t => {
  const f = await fixture(t);
  const original = f.session.messages;
  const rebuilt = rebuildMessages(original);
  assert.equal(rebuilt.length, original.length);
  for (const [index, message] of rebuilt.entries()) {
    assert.notEqual(message, original[index]);
    assert.notEqual(message.timestamp, original[index]?.timestamp);
  }
  // Pi 1.1.0 的公开 state.messages 赋值入口会复制消息数组，沿用 SDK 的上下文刷新路径。
  f.session.agent.state.messages = rebuilt;
  assert.equal(f.session.cacheWarmingStatus?.state, "scheduled", JSON.stringify(f.session.cacheWarmingStatus));
  assert.equal(f.faux.state.callCount, 1);
});

const mutations: Array<{
  name: string;
  change: (messages: SessionMessage[]) => SessionMessage[];
}> = [
  {
    name: "custom 内容改变",
    change: messages => messages.map(message => message.role === "custom" && message.customType === "test:note"
      ? { ...message, content: "改变的工作记录" }
      : message),
  },
  {
    name: "custom details 改变",
    change: messages => messages.map(message => message.role === "custom" && message.customType === "test:note"
      ? { ...message, details: { version: 2 } }
      : message),
  },
  {
    name: "view 内容改变",
    change: messages => messages.map(message => message.role === "custom" && message.customType === "repa-view"
      ? { ...message, content: "<repa-view source=\"plugin:test\">状态版本 2</repa-view>" }
      : message),
  },
  {
    name: "view details 改变",
    change: messages => messages.map(message => message.role === "custom" && message.customType === "repa-view"
      ? { ...message, details: { id: "plugin:test", version: 2 } }
      : message),
  },
  {
    name: "view 删除",
    change: messages => messages.filter(message => message.role !== "custom" || message.customType !== "repa-view"),
  },
  {
    name: "view 替换为另一来源",
    change: messages => messages.map(message => message.role === "custom" && message.customType === "repa-view"
      ? { ...message, content: "<repa-view source=\"plugin:other\">另一状态</repa-view>", details: { id: "plugin:other", version: 1 } }
      : message),
  },
  {
    name: "命名 system 段改变",
    change: messages => messages.map(message => message.role === "system" && message.sections?.plugin !== undefined
      ? { ...message, sections: { ...message.sections, plugin: "改变的插件说明" } }
      : message),
  },
  {
    name: "工具声明改变",
    change: messages => messages.map(message => message.role === "system" && message.toolsAdded !== undefined
      ? { ...message, toolsAdded: message.toolsAdded.map(tool => tool.name === "test_state" ? { ...tool, description: "改变的工具说明" } : tool) }
      : message),
  },
];

for (const mutation of mutations) {
  test(`真实 SDK 请求后，${mutation.name}使缓存失效，恢复原内容后重新有效`, async t => {
    const f = await fixture(t);
    const rebuilt = rebuildMessages(f.session.messages);
    const changed = mutation.change(structuredClone(rebuilt));
    assert.notDeepEqual(changed, rebuilt);
    f.session.agent.state.messages = changed;
    assert.equal(f.session.cacheWarmingStatus?.state, "inactive", JSON.stringify(f.session.cacheWarmingStatus));
    f.session.agent.state.messages = rebuilt;
    assert.equal(f.session.cacheWarmingStatus?.state, "scheduled", JSON.stringify(f.session.cacheWarmingStatus));
    assert.equal(f.faux.state.callCount, 1);
  });
}

test("真实 SDK 请求后选择不同模型使缓存失效，恢复原模型后重新有效", async t => {
  const f = await fixture(t);
  const second = f.faux.getModel("second");
  assert(second);
  f.session.agent.state.messages = rebuildMessages(f.session.messages);
  await f.session.setModel(second);
  assert.equal(f.session.cacheWarmingStatus?.state, "inactive", JSON.stringify(f.session.cacheWarmingStatus));
  await f.session.setModel(f.model);
  assert.equal(f.session.cacheWarmingStatus?.state, "scheduled", JSON.stringify(f.session.cacheWarmingStatus));
  assert.equal(f.faux.state.callCount, 1);
});
