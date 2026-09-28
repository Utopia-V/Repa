import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { getCurrentSystemPrompt, fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext as Context } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { CONTEXT_MESSAGE_TYPE, contextSnapshot, type WorkingMessage } from "../src/agent/context.js";
import type { PromptSettings } from "../src/configuration/schema.js";
import { ContentStore } from "../src/content/store.js";
import { historyView, Resources } from "../src/messages.js";
import { PiConversationHost } from "../src/pi-host.js";

const emptySettings: PromptSettings = {
  base: "", append: [], projectInstructions: false, skillCatalog: false,
  environment: false, learningContext: false, fileChanges: "on-demand",
};
const learningSettings: PromptSettings = { ...emptySettings, base: "RUN_BASE", learningContext: true };

async function send(host: PiConversationHost, text: string, settings: PromptSettings): Promise<void> {
  assert.deepEqual(await host.send(text, settings), { status: "completed" });
}

function textOf(message: { content: unknown }): string {
  return typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map((part) => typeof part.text === "string" ? part.text : "").join("\n")
      : "";
}
function conversation(context: Context) {
  return context.messages.filter((message) => message.role !== "system");
}
function contextTexts(context: Context): string[] {
  return context.messages.map(textOf).filter((text) => text.includes("<repa_learning_context>"));
}

async function fixture(t: TestContext, options: { trusted?: boolean; background?: string; localSummary?: boolean; legacy?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-pi-context-"));
  const directory = path.join(root, "space");
  const agentDir = path.join(root, "agent");
  const capture = path.join(root, "contexts.jsonl");
  const extensionPath = path.join(root, "probe-extension.mjs");
  const skillDirectory = path.join(agentDir, "skills", "fixture-skill");
  await mkdir(directory, { recursive: true });
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(path.join(skillDirectory, "SKILL.md"), "---\nname: fixture-skill\ndescription: A skill loaded for prompt integration.\n---\nSKILL_BODY\n");
  await writeFile(path.join(directory, "AGENTS.md"), "PROJECT_SOURCE");
  await writeFile(path.join(directory, "SYSTEM.md"), "HIDDEN_SYSTEM_SOURCE");
  await writeFile(path.join(directory, "APPEND_SYSTEM.md"), "HIDDEN_APPEND_SOURCE");
  await writeFile(extensionPath, `
import { appendFileSync } from "node:fs";
export default function (pi) {
  pi.on("before_agent_start", () => ({ systemPrompt: "EXTENSION_SYSTEM_OVERRIDE" }));
  pi.on("context", (event) => {
    appendFileSync(${JSON.stringify(capture)}, JSON.stringify(event.messages) + "\\n");
  });
  pi.registerTool({
    name: "probe", label: "Probe", description: "Return a local probe result.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: "text", text: "PROBE_DONE" }] }),
  });
  pi.on("session_before_compact", (event) => {
    if (${options.localSummary === false}) return;
    return {
      compaction: {
        summary: "LOCAL_COMPACTION_SUMMARY",
        firstKeptEntryId: event.branchEntries.findLast((entry) => entry.type === "message" && entry.message.role === "user").id,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  });
  pi.registerCommand("compact-fixture", {
    description: "Compact through the real SDK using a local summary.",
    handler: async (_args, ctx) => new Promise((resolve, reject) => {
      ctx.compact({ onComplete: resolve, onError: reject });
    }),
  });
  pi.registerCommand("direct-fixture", {
    description: "Start a turn from an extension command.",
    handler: async () => {
      pi.sendMessage({ customType: "probe.direct", content: "DIRECT_REQUEST", display: true }, { triggerTurn: true });
    },
  });
}
`);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    extensions: [extensionPath],
    skills: [skillDirectory],
    prompts: ["!**/*"], themes: ["!**/*"],
    retry: { enabled: false },
    compaction: { enabled: false, reserveTokens: 400, keepRecentTokens: 32 },
  }));
  const content = await ContentStore.open({ spaceId: "space", root: directory, assertOwned() {} });
  const backgroundPath = path.join(directory, "background.md");
  if (options.background !== undefined) {
    await writeFile(backgroundPath, options.background);
    const associated = await content.associate({
      location: { kind: "relative", path: "background.md" }, role: "document", operationId: randomUUID(),
    });
    const ref = associated.contents.find((item) => item.ref)?.ref;
    assert(ref);
    await content.setContext({
      binding: { kind: "document", ref }, base: (await content.context()).revision, operationId: randomUUID(),
    });
  }
  const legacyFile = path.join(root, "legacy.jsonl");
  if (options.legacy) await copyFile(new URL("fixtures/pi-session-0.84.3.jsonl", import.meta.url), legacyFile);
  const manager = options.legacy
    ? SessionManager.open(legacyFile, root, directory)
    : SessionManager.inMemory(directory);
  const faux = fauxProvider({
    api: `repa-pi-context-api-${randomUUID()}`,
    provider: `repa-pi-context-provider-${randomUUID()}`,
    models: [{ id: "test", reasoning: false, input: ["text"], contextWindow: 16384, maxTokens: 512 }],
    tokensPerSecond: 0,
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"), modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const hosts: PiConversationHost[] = [];
  const openHost = async () => {
    const host = await PiConversationHost.open({
      learnerSpace: directory, agentDir, sessionManager: manager,
      content, resources: new Resources(content.retention, `session:${manager.getSessionId()}`), trustExtensions: options.trusted ?? true,
      modelOverride: { modelRuntime, model: faux.getModel() },
      onEvent() {}, ask: async () => null,
    });
    hosts.push(host);
    return host;
  };
  t.after(async () => {
    for (const host of hosts) await host.close();
    await content.queue.run(async () => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const snapshots = () => manager.getBranch().flatMap((entry) =>
    entry.type === "custom_message" && entry.customType === CONTEXT_MESSAGE_TYPE ? [entry] : []);
  const captured = async (): Promise<WorkingMessage[][]> => (await readFile(capture, "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  return { directory, backgroundPath, content, manager, faux, openHost, snapshots, captured };
}

test("实际 Pi 调用接受空系统提示，可信扩展与工具后续轮不能恢复默认来源", async (t) => {
  const f = await fixture(t);
  const host = await f.openHost();
  f.faux.setResponses([
    (context) => {
      assert.equal(getCurrentSystemPrompt(context.messages), "");
      assert.deepEqual(contextTexts(context), []);
      return fauxAssistantMessage(fauxToolCall("probe", {}));
    },
    (context) => {
      assert.equal(getCurrentSystemPrompt(context.messages), "");
      assert.match(textOf(context.messages.at(-1)!), /PROBE_DONE/u);
      return fauxAssistantMessage("完成");
    },
    (context) => {
      assert.equal(getCurrentSystemPrompt(context.messages), "");
      assert.match(textOf(context.messages.at(-1)!), /DIRECT_REQUEST/u);
      return fauxAssistantMessage("扩展命令完成");
    },
  ]);
  await send(host, "普通请求", emptySettings);
  await send(host, "/direct-fixture", emptySettings);
  assert.equal(f.faux.state.callCount, 3);
  assert.equal(f.snapshots().length, 0);
});

test("每次 send 固定提示与入口背景，内部工具轮沿用该视图，后续 send 读取变化并判重", async (t) => {
  const f = await fixture(t, { background: "入口背景一" });
  const host = await f.openHost();
  const settings: PromptSettings = {
    ...learningSettings, append: ["追加一", "追加二"],
    projectInstructions: true, skillCatalog: true, environment: true,
  };
  let firstPrompt = "";
  f.faux.setResponses([
    async (context) => {
      firstPrompt = getCurrentSystemPrompt(context.messages)!;
      assert.match(firstPrompt, /RUN_BASE\n\n追加一\n\n追加二/u);
      assert.match(firstPrompt, /PROJECT_SOURCE/u);
      assert.match(firstPrompt, /fixture-skill/u);
      assert.match(firstPrompt, /Current working directory:/u);
      assert.doesNotMatch(firstPrompt, /EXTENSION_SYSTEM_OVERRIDE|HIDDEN_.*SOURCE/u);
      assert.equal(conversation(context)[0]?.role, "user");
      assert.match(textOf(conversation(context)[0]!), /入口背景一/u);
      assert.equal(textOf(conversation(context)[1]!), "开始学习");
      settings.base = "NEXT_RUN_BASE";
      settings.append.push("下一次追加");
      await writeFile(f.backgroundPath, "入口背景二");
      return fauxAssistantMessage(fauxToolCall("probe", {}));
    },
    (context) => {
      assert.equal(getCurrentSystemPrompt(context.messages), firstPrompt);
      assert.equal(contextTexts(context).length, 1);
      assert.match(contextTexts(context)[0]!, /入口背景一/u);
      assert.doesNotMatch(contextTexts(context)[0]!, /入口背景二/u);
      return fauxAssistantMessage("第一轮结束");
    },
    (context) => {
      assert.match(getCurrentSystemPrompt(context.messages)!, /^NEXT_RUN_BASE/u);
      assert.match(getCurrentSystemPrompt(context.messages)!, /下一次追加/u);
      assert.equal(contextTexts(context).length, 2);
      assert.match(contextTexts(context).at(-1)!, /入口背景二/u);
      return fauxAssistantMessage("第二轮结束");
    },
    (context) => {
      assert.equal(contextTexts(context).length, 2);
      return fauxAssistantMessage("第三轮结束");
    },
  ]);
  await send(host, "开始学习", settings);
  assert.equal(f.snapshots().length, 1);
  await send(host, "继续学习", settings);
  assert.equal(f.snapshots().length, 2);
  await send(host, "同一背景继续", settings);
  assert.equal(f.snapshots().length, 2);
  assert.equal(f.faux.state.callCount, 4);
});

test("关闭学习语境移除实际输入来源，历史与工具结果保留，重新启用和清空取得当前视图", async (t) => {
  const f = await fixture(t, { background: "持久背景" });
  const host = await f.openHost();
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("probe", {})),
    fauxAssistantMessage("已有回答"),
    (context) => {
      assert.deepEqual(contextTexts(context), []);
      assert(context.messages.some((message) => message.role === "toolResult" && textOf(message) === "PROBE_DONE"));
      assert(context.messages.some((message) => message.role === "assistant" && textOf(message) === "已有回答"));
      return fauxAssistantMessage("关闭来源后的回答");
    },
    (context) => {
      assert.equal(contextTexts(context).length, 1);
      assert.match(contextTexts(context)[0]!, /持久背景/u);
      return fauxAssistantMessage("重新启用后的回答");
    },
    (context) => {
      assert.equal(contextTexts(context).length, 2);
      assert.doesNotMatch(contextTexts(context).at(-1)!, /持久背景/u);
      return fauxAssistantMessage("空背景回答");
    },
  ]);
  await send(host, "先学习", learningSettings);
  await send(host, "关闭背景", { ...learningSettings, learningContext: false });
  assert.equal(f.snapshots().length, 1);
  await send(host, "重新启用", learningSettings);
  assert.equal(f.snapshots().length, 1);
  await f.content.setContext({ binding: null, base: (await f.content.context()).revision, operationId: randomUUID() });
  await send(host, "清空后继续", learningSettings);
  assert.equal(f.snapshots().length, 2);
  assert.equal((f.snapshots().at(-1)?.details as { text: string }).text, "");
});

test("真实 SDK 压缩后回填摘要后的完整语境，恢复 Host 与后续请求不重复记录", async (t) => {
  const f = await fixture(t, { background: "压缩后仍需保留的背景".repeat(40) });
  let host = await f.openHost();
  f.faux.setResponses([
    fauxAssistantMessage("早期回答".repeat(100)),
    fauxAssistantMessage("保留的回答"),
    (context) => {
      assert.match(textOf(conversation(context)[0]!), /LOCAL_COMPACTION_SUMMARY/u);
      assert.match(textOf(conversation(context)[1]!), /压缩后仍需保留的背景/u);
      assert.equal(textOf(conversation(context)[2]!), "保留的请求");
      assert.equal(contextTexts(context).length, 1);
      return fauxAssistantMessage("压缩后继续完成");
    },
    (context) => {
      assert.match(textOf(conversation(context)[1]!), /压缩后仍需保留的背景/u);
      assert.equal(contextTexts(context).length, 1);
      return fauxAssistantMessage("恢复后完成");
    },
  ]);
  await send(host, "早期请求", learningSettings);
  await send(host, "保留的请求", learningSettings);
  await send(host, "/compact-fixture", learningSettings);
  assert.equal(f.manager.getBranch().filter((entry) => entry.type === "compaction").length, 1);
  assert.equal(f.manager.buildSessionContext().messages.filter((message) => contextSnapshot(message)).length, 0);
  await send(host, "压缩后请求", learningSettings);
  assert.equal(f.snapshots().length, 1);
  const beforeFinalHook = (await f.captured()).at(-1)!;
  assert.equal(beforeFinalHook[0]?.role, "compactionSummary");
  assert.match(contextSnapshot(beforeFinalHook[1]!)!.text, /压缩后仍需保留的背景/u);
  await host.close();
  host = await f.openHost();
  await send(host, "恢复后请求", learningSettings);
  assert.equal(f.snapshots().length, 1);
  assert.equal(f.faux.state.callCount, 4);
});

test("未受信任空间不加载项目来源；语境读取失败在进入 Pi 历史前传播且可重试", async (t) => {
  const f = await fixture(t, { trusted: false, background: "可恢复背景" });
  const host = await f.openHost();
  const settings = { ...learningSettings, projectInstructions: true, skillCatalog: true };
  f.faux.setResponses([
    (context) => {
      assert.equal(getCurrentSystemPrompt(context.messages), "RUN_BASE");
      assert.match(contextTexts(context)[0]!, /可恢复背景/u);
      return fauxAssistantMessage("正常回答");
    },
    fauxAssistantMessage("修复后回答"),
  ]);
  await send(host, "正常请求", settings);
  const history = structuredClone(f.manager.getEntries());
  await rm(f.backgroundPath);
  await assert.rejects(host.send("准备失败的请求", settings));
  assert.deepEqual(f.manager.getEntries(), history);
  assert.equal(f.faux.state.callCount, 1);
  await writeFile(f.backgroundPath, "可恢复背景");
  await send(host, "修复后请求", settings);
  assert.equal(f.faux.state.callCount, 2);
  assert.equal(f.snapshots().length, 1);
});

test("关闭学习语境后，Pi 默认摘要模型也不再接收可识别的自动快照", async (t) => {
  const f = await fixture(t, { background: "关闭后不应再次注入的背景", localSummary: false });
  const host = await f.openHost();
  f.faux.setResponses([
    fauxAssistantMessage("历史回答".repeat(80)),
    fauxAssistantMessage("保留回答"),
    (context) => {
      const summaryInput = context.messages.map(textOf).join("\n");
      assert.match(summaryInput, /<conversation>/u);
      assert.match(summaryInput, /历史回答/u);
      assert.doesNotMatch(summaryInput, /repa_learning_context|关闭后不应再次注入的背景/u);
      return fauxAssistantMessage("默认摘要完成");
    },
    (context) => {
      assert.match(textOf(conversation(context)[0]!), /默认摘要完成/u);
      assert.deepEqual(contextTexts(context), []);
      return fauxAssistantMessage("关闭后继续完成");
    },
  ]);
  await send(host, "早期请求", learningSettings);
  await send(host, "保留请求".repeat(60), learningSettings);
  const off = { ...learningSettings, learningContext: false };
  await send(host, "/compact-fixture", off);
  await send(host, "摘要后继续", off);
  assert.equal(f.snapshots().length, 1);
  assert.equal(f.faux.state.callCount, 4);
});

test("真实工具读取后的文件差异只在下一次模型调用提供，关闭来源保留历史", async (t) => {
  const f = await fixture(t, { trusted: false });
  const host = await f.openHost();
  const file = path.join(f.directory, "notes.txt");
  await writeFile(file, "first\nsecond\n");
  const settings = { ...emptySettings, fileChanges: "diff" as const };
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: "notes.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("已读"),
  ]);
  await send(host, "读笔记", settings);
  await writeFile(file, "first\nchanged\n");
  assert.equal(f.faux.state.callCount, 2);
  f.faux.setResponses([
    (context) => {
      const notices = context.messages.map(textOf).filter((text) => text.includes("已观察文件有变化"));
      assert.equal(notices.length, 1, JSON.stringify(context.messages));
      assert.match(notices[0]!, /-second/);
      assert.match(notices[0]!, /\+changed/);
      return fauxAssistantMessage(fauxToolCall("read", { path: "notes.txt", limit: 1 }), { stopReason: "toolUse" });
    },
    (context) => {
      assert.equal(context.messages.map(textOf).filter((text) => text.includes("已观察文件有变化")).length, 1);
      return fauxAssistantMessage("已同步");
    },
  ]);
  await send(host, "继续", settings);
  f.faux.setResponses([(context) => {
    assert(!context.messages.map(textOf).some((text) => text.includes("已观察文件有变化")));
    return fauxAssistantMessage("按需读取");
  }]);
  await send(host, "关闭变化提示", emptySettings);
  assert.equal(f.manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "repa.file-changes").length, 1);
});

test("0.84.3 会话在新 SDK 中接续，保留旧历史、压缩边界与背景来源", async (t) => {
  const f = await fixture(t, { legacy: true, background: "新的空间背景" });
  const oldEntries = structuredClone(f.manager.getEntries());
  const original = await readFile(f.manager.getSessionFile()!, "utf8");
  const host = await f.openHost();
  f.faux.setResponses([(context) => {
    assert.match(textOf(conversation(context)[0]!), /旧版会话摘要/u);
    assert.match(contextTexts(context)[0]!, /旧版完整背景/u);
    assert.match(contextTexts(context).at(-1)!, /新的空间背景/u);
    assert.equal(textOf(context.messages.at(-1)!), "新版接续");
    return fauxAssistantMessage("新版回答");
  }]);
  await send(host, "新版接续", learningSettings);
  const systemIds = new Set(f.manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "system").map((entry) => entry.id));
  assert(systemIds.size > 0);
  const visible = historyView(f.manager.getEntries(), new Resources(f.content.retention, "migration-test"));
  assert(visible.every((message) => !systemIds.has(message.id)));
  assert.deepEqual(f.manager.getEntries().slice(0, oldEntries.length), oldEntries);
  assert((await readFile(f.manager.getSessionFile()!, "utf8")).startsWith(original));
  await host.close();
  const reopened = SessionManager.open(f.manager.getSessionFile()!, undefined, f.directory);
  assert.deepEqual(reopened.getEntries(), f.manager.getEntries());
});
