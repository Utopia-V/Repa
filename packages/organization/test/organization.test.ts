import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import {
  ContentChangeResultSchema, ContentInfoSchema, ContentOperationSchema, ContextStateSchema, ContextViewSchema,
  RepaClient, startRepaServer, type ContentInfo, type ContentTarget, type SettingScope,
} from "repa";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const skillFile = path.join(packageDirectory, "skills", "organize-learning", "SKILL.md");
const sourceDirectory = new URL("../../materials/test/fixtures/learning-flow/", import.meta.url);
const sourceUrl = "https://oceanservice.noaa.gov/facts/tidescurrents.html";
const application = { kind: "application" as const };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: unknown) => part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "").join("\n");
}

function toolText(context: TranscriptContext, name: string, failed = false): string {
  const message = context.messages.findLast(message => message.role === "toolResult" && message.toolName === name);
  assert(message && message.role === "toolResult", `Pi 应收到 ${name} 的实际结果`);
  assert.equal(message.isError, failed, textOf(message.content));
  return textOf(message.content);
}

function contentInfo(context: TranscriptContext): ContentInfo {
  const value: unknown = JSON.parse(toolText(context, "content_info"));
  assert(Check(ContentInfoSchema, value));
  assert(value.ref && value.revision);
  return value;
}

function operationId(context: TranscriptContext, tool: string, failed = false): string {
  const match = /\noperationId: ([a-zA-Z0-9_-]+)/u.exec(toolText(context, tool, failed));
  assert(match?.[1], `${tool} 的模型可见结果应包含操作标识`);
  return match[1];
}

function latestBackground(context: TranscriptContext): string {
  const matches = context.messages.flatMap(message => [...textOf(message.content).matchAll(/<repa_learning_context>[\s\S]*?<\/repa_learning_context>/gu)]);
  const latest = matches.at(-1);
  assert(latest, "新运行应实际收到完整学习语境背景");
  return latest[0];
}

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= deadline) assert.fail(`等待内容整理运行超时：${JSON.stringify(value)}`);
    await delay(10);
  }
}

async function set(client: RepaClient, scope: SettingScope, key: string, value: unknown) {
  const entry = (await client.call("settings.get", { scope, namespace: "plugins" })).entries.find(entry => entry.key === key);
  assert(entry);
  await client.call("settings.set", { scope, namespace: "plugins", key, value, base: entry.revision });
}

const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");

test("真实Pi读取整理方法与不同组织的笔记，一次保存拆分和引用，人工编辑重开后接续并切换新运行语境", async (t) => {
  const metadata: unknown = JSON.parse(await readFile(new URL("sources.json", sourceDirectory), "utf8"));
  const MetadataSchema = Type.Object({ files: Type.Array(Type.Object({ file: Type.String(), sha256: Type.String(), url: Type.String() })) });
  assert(Check(MetadataSchema, metadata));
  const sourceMetadata = metadata.files.find(file => file.file === "noaa-tidescurrents.txt");
  assert(sourceMetadata);
  assert.equal(sourceMetadata.url, sourceUrl);
  const sourceBytes = await readFile(new URL(sourceMetadata.file, sourceDirectory));
  assert.equal(createHash("sha256").update(sourceBytes).digest("hex"), sourceMetadata.sha256);

  const root = await mkdtemp(path.join(os.tmpdir(), "repa-organization-"));
  const directory = path.join(root, "space");
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: [packageDirectory], extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"],
    retry: { enabled: false }, compaction: { enabled: false },
  }));
  const faux = fauxProvider({
    api: `organization-${randomUUID()}`, provider: `organization-${randomUUID()}`,
    models: [{ id: "test", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 2048 }], tokensPerSecond: 0,
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  });
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
  await set(client, application, "disabled", ["repa-organization"]);
  await set(client, application, "trusted", [{ kind: "package", name: "@repa/organization" }]);
  const session = await client.call("session.create", { spaceId: space.id });
  const key = { spaceId: space.id, sessionId: session.sessionId };
  const target = (file: string): ContentTarget => ({ kind: "file", spaceId: space.id, location: { kind: "relative", path: file } });
  const create = async (file: string, text: string, role: "document" | "material" = "document") => {
    await client.call("content.write", { target: target(file), operationId: randomUUID(), base: { kind: "absent" }, value: { kind: "text", text } });
    const associated = await client.call("content.associate", { spaceId: space.id, location: { kind: "relative", path: file }, role, operationId: randomUUID() });
    const ref = associated.contents[0]?.ref;
    assert(ref);
    return ref;
  };
  const sourceRef = await create("noaa-tidescurrents.txt", sourceBytes.toString("utf8"), "material");
  const attribution = `出处：NOAA，${sourceUrl}；本地原文 repa:material/${sourceRef.id}。公共领域文章；学习笔记不代表 NOAA 背书。`;
  const tideLine = "潮汐：月球与太阳的引力驱动水位长期升降。";
  const currentLine = "潮流：潮汐升降造成的水运动；风和温盐环流也能形成海流。";
  const originalNotes = `# 潮汐与海流\n\n${tideLine}\n\n## 潮流\n${currentLine}\n\n${attribution}\n\n待解决：区别水位升降与水的流动。\n`;
  const notesRef = await create("notes.md", originalNotes);
  const alternate = `# 按阅读过程记录\n\n先核对 NOAA 第 1 段的水位升降，再看第 2 段的 tidal currents，风和温盐环流分别在第 3、4 段。\n\n${attribution}\n\n读者自己的目录保留，不按新笔记目录整体重排。\n`;
  await create("reading-log.md", alternate);
  const oldLinks = `[潮汐主体](repa:document/${notesRef.id})\n[潮流解释](repa:document/${notesRef.id})\n`;
  await create("index.md", oldLinks);
  const beforeItems = JSON.stringify({ items: [{ ref: notesRef, mode: "expand" }, { ref: sourceRef, mode: "reference", note: "需要时核对 NOAA 原文" }] });
  const contextRef = await create("context.json", `${beforeItems}\n`);
  const binding = await client.call("context.get", { spaceId: space.id });
  await client.call("context.set", { spaceId: space.id, operationId: randomUUID(), base: binding.revision, binding: { kind: "composition", ref: contextRef } });
  const originalBinding = await client.call("context.get", { spaceId: space.id });
  assert.equal(existsSync(path.join(directory, ".repa", "plugins", "organization")), false, "纯 Skill 包不创建虚构后台数据");

  const send = async (text: string) => {
    const accepted = await client.call("session.submit", { target: key, requestId: randomUUID(), input: { parts: [{ kind: "text", text }] }, dispatch: { kind: "start" } });
    assert(accepted.runId);
    const runId = accepted.runId;
    const run = await until(() => client.call("run.get", { spaceId: space.id, runId }),
      value => ["completed", "failed", "cancelled", "interrupted"].includes(value.status));
    assert.equal(run.status, "completed", JSON.stringify({ runId, status: run.status, error: "error" in run ? run.error : undefined }));
  };
  let observedNotes: ContentInfo | undefined;
  let observedContext: ContentInfo | undefined;
  let splitRef: ContentInfo["ref"];
  let savedOperation = "";
  let afterItems = "";
  const retainedNotes = originalNotes.replace(`## 潮流\n${currentLine}\n\n`, "");
  const splitNotes = `# 潮流解释\n\n${currentLine}\n\n${attribution}\n`;
  faux.setResponses([
    context => {
      assert.match(getCurrentSystemPrompt(context.messages), /organize-learning/u);
      const tools = getCurrentTools(context.messages);
      for (const name of ["read", "edit", "apply_patch", "content_info", "content_operation", "get_learning_context", "set_learning_context"]) {
        assert(tools.some(tool => tool.name === name), `${name} 应进入真实 provider 请求`);
      }
      const setTool = tools.find(tool => tool.name === "set_learning_context");
      const patchTool = tools.find(tool => tool.name === "apply_patch");
      assert(setTool && patchTool);
      assert(Check(setTool.parameters, { base: "observed-revision", binding: { kind: "document", contentId: "a" } }));
      assert(!Check(setTool.parameters, { base: "observed-revision", binding: { kind: "document", contentId: "a" }, spaceId: space.id, operationId: "invented" }));
      assert("additionalProperties" in patchTool.parameters);
      assert.equal(patchTool.parameters.additionalProperties, false);
      assert(!JSON.stringify(patchTool.parameters).includes('"operationId"'), "程序生成的 operationId 不进入模型参数声明");
      assert.match(latestBackground(context), /待解决：区别水位升降与水的流动/u);
      return fauxAssistantMessage(fauxToolCall("read", { path: skillFile }), { stopReason: "toolUse" });
    },
    context => {
      assert.match(toolText(context, "read"), /# 整理长期内容/u);
      assert.match(toolText(context, "read"), /items.*JSON.*正文/u);
      return fauxAssistantMessage(fauxToolCall("read", { path: "notes.md" }), { stopReason: "toolUse" });
    },
    context => {
      assert.equal(toolText(context, "read"), originalNotes);
      return fauxAssistantMessage(fauxToolCall("read", { path: `repa:material/${sourceRef.id}` }), { stopReason: "toolUse" });
    },
    context => {
      assert.equal(toolText(context, "read"), sourceBytes.toString("utf8"));
      return fauxAssistantMessage(fauxToolCall("read", { path: "reading-log.md" }), { stopReason: "toolUse" });
    },
    context => {
      assert.equal(toolText(context, "read"), alternate);
      return fauxAssistantMessage(fauxToolCall("read", { path: "index.md" }), { stopReason: "toolUse" });
    },
    context => {
      assert.equal(toolText(context, "read"), oldLinks);
      return fauxAssistantMessage(fauxToolCall("read", { path: "context.json" }), { stopReason: "toolUse" });
    },
    context => {
      assert.equal(toolText(context, "read"), `${beforeItems}\n`);
      return fauxAssistantMessage(fauxToolCall("content_info", { path: "notes.md" }), { stopReason: "toolUse" });
    },
    context => {
      observedNotes = contentInfo(context);
      assert.deepEqual(observedNotes.ref, notesRef);
      assert.deepEqual(observedNotes.members, []);
      return fauxAssistantMessage(fauxToolCall("content_info", { path: "context.json" }), { stopReason: "toolUse" });
    },
    context => {
      observedContext = contentInfo(context);
      assert.deepEqual(observedContext.ref, contextRef);
      assert.deepEqual(observedContext.members, [], "学习语境 items 不冒充通用 ContentInfo.members");
      return fauxAssistantMessage(fauxToolCall("get_learning_context", {}), { stopReason: "toolUse" });
    },
    context => {
      const current: unknown = JSON.parse(toolText(context, "get_learning_context"));
      assert(Check(ContextStateSchema, current));
      assert.deepEqual(current.binding, { kind: "composition", ref: observedContext?.ref });
      assert(observedNotes?.ref && observedNotes.revision);
      splitRef = { spaceId: observedNotes.ref.spaceId, id: "currents-notes" };
      afterItems = JSON.stringify({ items: [{ ref: observedNotes.ref, mode: "expand" }, { ref: splitRef, mode: "reference", title: "潮流解释" }, { ref: sourceRef, mode: "reference", note: "需要时核对 NOAA 原文" }] });
      // faux 只驱动已确定的整理操作，不能证明模型形成了正确的组织判断。
      return fauxAssistantMessage(fauxToolCall("apply_patch", {
        patch: patch(
          "*** Update File: notes.md", "@@", ` ${tideLine}`, " ", "-## 潮流", `-${currentLine}`, "-", ` ${attribution}`,
          "*** Add File: currents.md", ...splitNotes.trimEnd().split("\n").map(line => `+${line}`),
          "*** Update File: index.md", "@@", ` [潮汐主体](repa:document/${observedNotes.ref.id})`, `-[潮流解释](repa:document/${observedNotes.ref.id})`, `+[潮流解释](repa:document/${splitRef.id})`,
          "*** Update File: context.json", "@@", `-${beforeItems}`, `+${afterItems}`,
        ),
        registrations: [{ path: "currents.md", role: "document", id: splitRef.id }],
        compositions: [{ ref: observedNotes.ref, base: observedNotes.revision, members: [{ target: { kind: "content", ref: splitRef }, name: "潮流解释" }], resources: [] }],
      }), { stopReason: "toolUse" });
    },
    context => {
      savedOperation = operationId(context, "apply_patch");
      return fauxAssistantMessage(fauxToolCall("content_operation", { action: "get", operationId: savedOperation }), { stopReason: "toolUse" });
    },
    context => {
      const operation: unknown = JSON.parse(toolText(context, "content_operation"));
      assert(Check(ContentOperationSchema, operation));
      assert.equal(operation.operationId, savedOperation);
      assert.equal(operation.status, "committed");
      assert(operation.result);
      assert.deepEqual(operation.result.changes.map(change => change.path).sort(), ["context.json", "currents.md", "index.md", "notes.md"]);
      assert.deepEqual(operation.result.contents.find(info => info.location.path === "currents.md")?.ref, splitRef);
      assert.deepEqual(operation.result.contents.find(info => info.location.path === "notes.md")?.members, [{ target: { kind: "content", ref: splitRef }, name: "潮流解释" }]);
      return fauxAssistantMessage("已保存拆分、明确引用及原语境清单；按阅读过程组织的笔记没有改动。");
    },
  ]);
  await send("请用整理方法核对 NOAA 来源和现有两种笔记，将 notes.md 的潮流解释拆出，保留潮汐主体身份。index.md 的潮流解释链接确认指向拆出内容，主体链接保持；原语境清单补上新文档引用，不换语境根，也不要重排 reading-log.md。");
  assert(splitRef && savedOperation);
  assert.equal(await readFile(path.join(directory, "notes.md"), "utf8"), retainedNotes);
  assert.equal(await readFile(path.join(directory, "currents.md"), "utf8"), splitNotes);
  assert.equal(await readFile(path.join(directory, "context.json"), "utf8"), `${afterItems}\n`);
  assert.equal(await readFile(path.join(directory, "index.md"), "utf8"), oldLinks.replace(`[潮流解释](repa:document/${notesRef.id})`, `[潮流解释](repa:document/${splitRef.id})`));
  assert.equal(await readFile(path.join(directory, "reading-log.md"), "utf8"), alternate);
  assert.deepEqual(await client.call("context.get", { spaceId: space.id }), originalBinding);

  const finalSplitRef = splitRef;
  const human = "\r\n## 人工校订\r\n保留符号 η、组合字符 e\u0301 与 🌊。\r\n\r\n下次先解释潮流，不再从水位升降开始。\r\n";
  await writeFile(path.join(directory, "currents.md"), splitNotes + human);
  await server.close("cancel");
  await client.close();
  server = await startRepaServer(options);
  client = await RepaClient.connect(server.connection);
  assert.equal((await client.call("space.open", { path: directory })).id, space.id);
  const added = `${currentLine}\n\n补充定位：NOAA 第 2 段解释 tidal currents；第 4 段解释温盐环流。`;
  let observedSplit: ContentInfo | undefined;
  let editOperation = "";
  let setOperation = "";
  faux.setResponses([
    context => {
      assert.match(latestBackground(context), /待解决：区别水位升降与水的流动/u);
      assert.doesNotMatch(latestBackground(context), /人工校订/u, "新文档只是 reference 成员，普通 members 也不隐式展开");
      return fauxAssistantMessage(fauxToolCall("read", { path: `repa:document/${finalSplitRef.id}` }), { stopReason: "toolUse" });
    },
    context => {
      // Pi 的读取展示可能规范化行尾，逐字保留由实际落盘断言验证。
      assert.match(toolText(context, "read"), /保留符号 η、组合字符 é 与 🌊。/u);
      return fauxAssistantMessage(fauxToolCall("read", { path: `repa:material/${sourceRef.id}`, offset: 2, limit: 3 }), { stopReason: "toolUse" });
    },
    context => {
      assert.match(toolText(context, "read"), /tidal currents/u);
      assert.match(toolText(context, "read"), /thermohaline circulation/u);
      return fauxAssistantMessage(fauxToolCall("edit", { path: `repa:document/${finalSplitRef.id}`, edits: [{ oldText: currentLine, newText: added }] }), { stopReason: "toolUse" });
    },
    context => {
      editOperation = operationId(context, "edit");
      return fauxAssistantMessage(fauxToolCall("content_info", { path: "currents.md" }), { stopReason: "toolUse" });
    },
    context => {
      observedSplit = contentInfo(context);
      assert.deepEqual(observedSplit.ref, finalSplitRef);
      return fauxAssistantMessage(fauxToolCall("get_learning_context", {}), { stopReason: "toolUse" });
    },
    context => {
      const current: unknown = JSON.parse(toolText(context, "get_learning_context"));
      assert(Check(ContextStateSchema, current));
      assert.equal(current.binding?.kind, "composition");
      assert(observedSplit?.ref);
      return fauxAssistantMessage(fauxToolCall("set_learning_context", { base: current.revision, binding: { kind: "document", contentId: observedSplit.ref.id } }), { stopReason: "toolUse" });
    },
    context => {
      const result: unknown = JSON.parse(toolText(context, "set_learning_context"));
      assert(Check(ContentChangeResultSchema, result));
      setOperation = result.operationId;
      return fauxAssistantMessage(fauxToolCall("learning_context", {}), { stopReason: "toolUse" });
    },
    context => {
      const view: unknown = JSON.parse(toolText(context, "learning_context"));
      assert(Check(ContextViewSchema, view));
      assert.match(view.text, /人工校订/u);
      assert.match(view.text, /补充定位/u);
      assert(view.sources.some(source => source.ref.id === finalSplitRef.id));
      return fauxAssistantMessage("补充了来源定位，保留人工校订，并按请求把潮流解释设为当前语境根。");
    },
  ]);
  await send("继续拆出的潮流解释，读取我在外部编辑器新增的校订，核对 NOAA 原文，只补来源段落定位；将当前学习语境明确改为这个潮流文档。");
  const finalNotes = (splitNotes + human).replace(currentLine, added);
  assert.equal(await readFile(path.join(directory, "currents.md"), "utf8"), finalNotes);
  assert.deepEqual((await client.call("content.get", { target: target("notes.md") })).ref, notesRef);
  assert.deepEqual((await client.call("content.get", { target: target("currents.md") })).ref, finalSplitRef);
  assert.deepEqual((await client.call("context.get", { spaceId: space.id })).binding, { kind: "document", ref: finalSplitRef });
  assert(editOperation && setOperation);
  assert.equal((await client.call("operation.get", { spaceId: space.id, operationId: savedOperation })).status, "committed");
  assert.equal((await client.call("operation.get", { spaceId: space.id, operationId: editOperation })).status, "committed");
  assert.equal((await client.call("operation.get", { spaceId: space.id, operationId: setOperation })).status, "committed");

  let newBackgroundObserved = false;
  faux.setResponses([
    context => {
      const background = latestBackground(context);
      assert.match(background, /# 潮流解释/u);
      assert.match(background, /人工校订/u);
      assert.match(background, /补充定位/u);
      assert.match(background, /下次先解释潮流/u);
      assert.doesNotMatch(background, /待解决：区别水位升降与水的流动/u);
      assert(background.includes(finalSplitRef.id));
      newBackgroundObserved = true;
      return fauxAssistantMessage("这次从当前潮流文档及人工校订接续。");
    },
  ]);
  await send("接着当前语境继续，先承接我保留的校订。");
  assert(newBackgroundObserved);
  assert.equal(faux.state.callCount, 21, "调用数仅验证本地 SDK 接入，不评价模型整理能力");
  assert.equal(await readFile(path.join(directory, "currents.md"), "utf8"), finalNotes);
  assert.equal(await readFile(path.join(directory, "reading-log.md"), "utf8"), alternate);
  assert.deepEqual(await readFile(path.join(directory, "noaa-tidescurrents.txt")), sourceBytes);
});

test("真实Pi改变语境根保存失败，从错误正文取得操作标识并查询实际回退状态", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("需要真实 POSIX 非 root 文件权限");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-organization-failure-"));
  const directory = path.join(root, "space");
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: [packageDirectory], extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"],
    retry: { enabled: false }, compaction: { enabled: false },
  }));
  const faux = fauxProvider({
    api: `organization-failure-${randomUUID()}`, provider: `organization-failure-${randomUUID()}`,
    models: [{ id: "test", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 2048 }], tokensPerSecond: 0,
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const server = await startRepaServer({ agentDir, appDirectory: path.join(root, "app"), modelOverride: { modelRuntime, model: faux.getModel() } });
  const client = await RepaClient.connect(server.connection);
  const blocked = path.join(directory, ".repa", "content");
  let permissionsChanged = false;
  let originalPermissions = 0o700;
  t.after(async () => {
    if (permissionsChanged) await chmod(blocked, originalPermissions);
    await server.close("cancel");
    await client.close();
    await rm(root, { recursive: true, force: true });
  });
  const space = await client.call("space.open", { path: directory });
  await set(client, application, "disabled", ["repa-organization"]);
  await set(client, application, "trusted", [{ kind: "package", name: "@repa/organization" }]);
  const session = await client.call("session.create", { spaceId: space.id });
  const key = { spaceId: space.id, sessionId: session.sessionId };
  const target: ContentTarget = { kind: "file", spaceId: space.id, location: { kind: "relative", path: "next.md" } };
  await client.call("content.write", { target, operationId: randomUUID(), base: { kind: "absent" }, value: { kind: "text", text: "# 用户选择的新语境\n" } });
  await client.call("content.associate", { spaceId: space.id, location: { kind: "relative", path: "next.md" }, role: "document", operationId: randomUUID() });
  const before = await client.call("context.get", { spaceId: space.id });
  let observed: ContentInfo | undefined;
  let failedOperation = "";
  let rollbackObserved = false;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("content_info", { path: "next.md" }), { stopReason: "toolUse" }),
    context => {
      observed = contentInfo(context);
      return fauxAssistantMessage(fauxToolCall("get_learning_context", {}), { stopReason: "toolUse" });
    },
    context => {
      const current: unknown = JSON.parse(toolText(context, "get_learning_context"));
      assert(Check(ContextStateSchema, current));
      assert(observed?.ref);
      return fauxAssistantMessage(fauxToolCall("set_learning_context", { base: current.revision, binding: { kind: "document", contentId: observed.ref.id } }), { stopReason: "toolUse" });
    },
    context => {
      failedOperation = operationId(context, "set_learning_context", true);
      return fauxAssistantMessage(fauxToolCall("content_operation", { action: "get", operationId: failedOperation }), { stopReason: "toolUse" });
    },
    context => {
      const operation: unknown = JSON.parse(toolText(context, "content_operation"));
      assert(Check(ContentOperationSchema, operation));
      assert.equal(operation.operationId, failedOperation);
      assert.equal(operation.status, "rolled_back");
      rollbackObserved = true;
      return fauxAssistantMessage("语境选择未保存，实际操作已回退；保持原绑定，先处理保存权限。");
    },
  ]);
  // 父目录不能替换 catalog，已存在的 journal/blob 子目录仍可写，覆盖真实保存与回退链。
  originalPermissions = (await stat(blocked)).mode & 0o777;
  await chmod(blocked, 0o500);
  permissionsChanged = true;
  try {
    const accepted = await client.call("session.submit", { target: key, requestId: randomUUID(), input: { parts: [{ kind: "text", text: "请将 next.md 设为当前学习语境；若保存失败先核对实际结果，不重复操作。" }] }, dispatch: { kind: "start" } });
    assert(accepted.runId);
    const runId = accepted.runId;
    const run = await until(() => client.call("run.get", { spaceId: space.id, runId }), value => ["completed", "failed", "cancelled", "interrupted"].includes(value.status));
    assert.equal(run.status, "completed", JSON.stringify({ runId, status: run.status, error: "error" in run ? run.error : undefined }));
  } finally {
    await chmod(blocked, originalPermissions);
    permissionsChanged = false;
  }
  assert(rollbackObserved && failedOperation);
  assert.deepEqual(await client.call("context.get", { spaceId: space.id }), before);
  assert.equal((await client.call("operation.get", { spaceId: space.id, operationId: failedOperation })).status, "rolled_back");
  assert.equal(await readFile(path.join(directory, "next.md"), "utf8"), "# 用户选择的新语境\n");
  assert.equal(faux.state.callCount, 5);
});
