import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ReviewHistoryResultSchema, ReviewItemSchema, ReviewMutationResultSchema, type ReviewItem } from "@repa/review/protocol";
import { Check } from "typebox/value";
import { RepaClient } from "../src/client.js";
import { ContentInfoSchema, type ContentRef } from "../src/content/schema.js";
import { ContextStateSchema } from "../src/learning/schema.js";
import { DEFAULT_LEARNING_PROMPT } from "../src/learning/default-prompt.js";
import { startRepaServer } from "../src/server.js";
import type { CapabilityScope, SettingScope } from "../src/protocol.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-learning-composition-"));
  const agentDir = path.join(root, "agent");
  const directory = path.join(root, "space");
  await mkdir(agentDir);
  await mkdir(directory);
  await mkdir(path.join(directory, ".git"));
  const piSettings = JSON.stringify({
    extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"],
    retry: { enabled: false }, compaction: { enabled: false },
  });
  await writeFile(path.join(agentDir, "settings.json"), piSettings);
  let cleanup = async () => {};
  t.after(async () => { await cleanup(); await rm(root, { recursive: true, force: true }); });
  return { root, directory, agentDir, piSettings, appDirectory: path.join(root, "app"),
    onClose(value: () => Promise<void>) { cleanup = value; } };
}

async function disable(client: RepaClient, scope: SettingScope, value: string[]) {
  await configure(client, scope, "disabled", value);
}

async function configure(client: RepaClient, scope: SettingScope, key: string, value: unknown) {
  const current = (await client.call("settings.get", { scope, namespace: "plugins" })).entries.find(entry => entry.key === key);
  assert(current);
  await client.call("settings.set", { scope, namespace: "plugins", key, value, base: current.revision });
}

async function invoke(client: RepaClient, scope: CapabilityScope, id: string, input: unknown) {
  const value = await client.call("capability.invoke", { scope, contract: { id, version: "1" }, requestId: randomUUID(), input });
  assert.equal(value.kind, "inline");
  if (value.kind !== "inline") assert.fail("预期即时能力");
  return value.result;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: unknown) => part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "").join("\n");
}

function toolText(context: TranscriptContext, name: string): string {
  const message = context.messages.findLast(message => message.role === "toolResult" && message.toolName === name);
  assert(message && message.role === "toolResult");
  assert.equal(message.isError, false, textOf(message.content));
  return textOf(message.content);
}

const useTool = (name: string, input: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, input), { stopReason: "toolUse" });

test("干净配置无需模型或手工安装即可使用默认本地能力，发现不创建复习数据库或改写 Pi 设置", async (t) => {
  const f = await fixture(t);
  const server = await startRepaServer(f);
  const client = await RepaClient.connect(server.connection);
  f.onClose(async () => { await server.close("cancel"); await client.close(); });
  const space = await client.call("space.open", { path: f.directory });
  const scope = { kind: "space" as const, spaceId: space.id };
  assert.deepEqual(await client.call("connection.list", {}), []);
  const packages = await client.call("package.list", { scope });
  assert.deepEqual(packages.map(item => item.name).sort(), ["@repa/learning", "@repa/materials", "@repa/organization", "@repa/planning", "@repa/review"]);
  assert(packages.every(item => item.scope === "bundled" && item.registrationId && item.status === "ready"));
  const described = await client.call("capability.describe", { scope });
  assert.deepEqual(described.issues, []);
  for (const id of ["repa.context.get", "repa.material.extract", "repa.planning.check", "repa.review.create"])
    assert(described.capabilities.some(item => item.contract.id === id), id);
  const database = path.join(f.directory, ".repa/plugins/repa-review/reviews.sqlite");
  assert.equal(existsSync(database), false);
  const checked = await invoke(client, scope, "repa.planning.check", {
    timeZone: "Asia/Taipei", availability: [{ start: "2026-10-03T09:00", end: "2026-10-03T10:00" }],
    goals: [{ id: "入门", minutes: 30 }], sessions: [{ id: "尝试", goalId: "入门", start: "2026-10-03T09:00", end: "2026-10-03T09:30" }],
  });
  assert(checked && typeof checked === "object" && "issues" in checked);
  assert.deepEqual(checked.issues, []);
  assert.equal(existsSync(database), false);
  const created = await invoke(client, scope, "repa.review.create", { operationId: randomUUID(), prompt: "什么是潮流？" });
  assert(Check(ReviewMutationResultSchema, created));
  assert.equal(existsSync(database), true);
  assert.equal(await readFile(path.join(f.agentDir, "settings.json"), "utf8"), f.piSettings);
  assert.equal(existsSync(path.join(f.directory, ".pi/settings.json")), false);
  assert.equal(existsSync(path.join(f.appDirectory, "settings.json")), false);
});

test("同名替换包必须选择明确来源，预览与运行共同排除含糊或已关闭的入口", async (t) => {
  const f = await fixture(t);
  const replacement = path.join(f.root, "replacement");
  const marker = path.join(f.root, "factory-imported");
  await mkdir(replacement);
  await writeFile(path.join(replacement, "package.json"), JSON.stringify({ name: "@repa/planning", type: "module",
    repa: { manifestVersion: 1, backend: { entry: "./index.js", api: "^1.0.0" } } }));
  await writeFile(path.join(replacement, "index.js"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "loaded");\nexport default function () { return { capabilities: [] }; }\n`);
  await writeFile(path.join(f.agentDir, "settings.json"), JSON.stringify({ ...JSON.parse(f.piSettings), packages: [replacement] }));
  const server = await startRepaServer(f);
  const client = await RepaClient.connect(server.connection);
  f.onClose(async () => { await server.close("cancel"); await client.close(); });
  const space = await client.call("space.open", { path: f.directory });
  const scope = { kind: "space" as const, spaceId: space.id };
  const session = await client.call("session.create", { spaceId: space.id });
  const key = { spaceId: space.id, sessionId: session.sessionId };
  const source = { kind: "source", source: replacement, scope: "user" };
  await configure(client, { kind: "application" }, "trusted", [source]);
  await configure(client, scope, "backends", [{ id: "replacement", package: { kind: "package", name: "@repa/planning" } }]);
  const ambiguous = await client.call("prompts.preview", key);
  assert(!ambiguous.prompt.sources.some(item => item.id === "capabilityPlugin:replacement"));
  assert.equal(existsSync(marker), false);
  assert((await client.call("capability.describe", { scope })).issues.some(issue => issue.pluginId === "replacement"));
  assert.equal(existsSync(marker), false);
  await disable(client, scope, ["repa-planning"]);
  await configure(client, scope, "backends", [{ id: "replacement", package: source }]);
  assert((await client.call("prompts.preview", key)).prompt.sources.some(item => item.id === "capabilityPlugin:replacement"));
  assert.equal(existsSync(marker), false, "明确选择后的预览仍不执行工厂");
  assert.deepEqual((await client.call("capability.describe", { scope })).issues, []);
  assert.equal(existsSync(marker), true);
  const bundled = (await client.call("package.list", { scope })).find(item => item.registrationId === "repa-planning");
  assert(bundled);
  await configure(client, scope, "backends", [{ id: "replacement", package: { kind: "source", source: bundled.source, scope: "bundled" } }]);
  assert(!(await client.call("prompts.preview", key)).prompt.sources.some(item => item.id === "capabilityPlugin:replacement"));
  assert((await client.call("capability.describe", { scope })).issues.some(issue => issue.pluginId === "replacement"));
});

test("官方组合沿真实工具保留实际作答，关闭后复制再启用仍接续学习语境与复习记录", async (t) => {
  const f = await fixture(t);
  const faux = fauxProvider({ api: `composition-${randomUUID()}`, provider: `composition-${randomUUID()}`,
    models: [{ id: "test", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 2048 }], tokensPerSecond: 0 });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(f.agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const options = { ...f, modelOverride: { modelRuntime, model: faux.getModel() } };
  let server = await startRepaServer(options);
  let client = await RepaClient.connect(server.connection);
  f.onClose(async () => { await server.close("cancel"); await client.close(); });
  const space = await client.call("space.open", { path: f.directory });
  const scope = { kind: "space" as const, spaceId: space.id };
  const session = await client.call("session.create", { spaceId: space.id });
  const key = { spaceId: space.id, sessionId: session.sessionId };
  const target = { kind: "file" as const, spaceId: space.id, location: { kind: "relative" as const, path: "material.md" } };
  await client.call("content.write", { target, operationId: randomUUID(), base: { kind: "absent" }, value: { kind: "text", text: "潮汐是海面周期性的升降，潮流是伴随潮汐的海水运动。\n" } });
  await client.call("content.associate", { spaceId: space.id, location: target.location, role: "material", operationId: randomUUID() });
  const send = async (text: string) => {
    const accepted = await client.call("session.submit", { target: key, requestId: randomUUID(), input: { parts: [{ kind: "text", text }] }, dispatch: { kind: "start" } });
    assert(accepted.runId);
    const deadline = Date.now() + 15000;
    for (;;) {
      const run = await client.call("run.get", { spaceId: space.id, runId: accepted.runId });
      if (["completed", "failed", "cancelled", "interrupted"].includes(run.status)) {
        assert.equal(run.status, "completed", JSON.stringify(run));
        return;
      }
      assert(Date.now() < deadline, JSON.stringify(run));
      await delay(10);
    }
  };
  const preview = await client.call("prompts.preview", key);
  assert(preview.prompt.system.includes(DEFAULT_LEARNING_PROMPT));
  for (const name of ["learn-with-feedback", "plan-learning", "organize-learning"]) assert(preview.prompt.system.includes(name));
  for (const id of ["repa-materials", "repa-planning", "repa-review"])
    assert(preview.prompt.sources.some(source => source.id === `capabilityPlugin:${id}` && source.dynamic));
  let noteRef: ContentRef | undefined;
  let review: ReviewItem | undefined;
  faux.setResponses([
    context => {
      const system = getCurrentSystemPrompt(context.messages);
      assert(system.includes(DEFAULT_LEARNING_PROMPT));
      for (const name of ["read_material", "check_plan", "review_create", "set_learning_context"])
        assert(getCurrentTools(context.messages).some(tool => tool.name === name));
      const location = /<name>learn-with-feedback<\/name>\s*<description>[\s\S]*?<\/description>\s*<location>([^<]+)<\/location>/u.exec(system)?.[1];
      assert(location, "方法路径由真实 Pi catalog 提供");
      return useTool("read", { path: location });
    },
    context => { assert.match(toolText(context, "read"), /实际作答/u); return useTool("content_info", { path: "material.md" }); },
    context => {
      const material: unknown = JSON.parse(toolText(context, "content_info"));
      assert(Check(ContentInfoSchema, material));
      return useTool("read_material", { target: material.target });
    },
    context => {
      assert.match(toolText(context, "read_material"), /伴随潮汐的海水运动/u);
      return useTool("apply_patch", {
        patch: "*** Begin Patch\n*** Add File: learning.md\n+# 学习进展\n+目标：区分潮汐与潮流。\n+材料：material.md。\n+已提供解释，等待学习者尝试；下一步用自己的话区分两者。\n*** End Patch",
        registrations: [{ path: "learning.md", role: "document" }],
      });
    },
    context => { toolText(context, "apply_patch"); return useTool("content_info", { path: "learning.md" }); },
    context => {
      const info: unknown = JSON.parse(toolText(context, "content_info"));
      assert(Check(ContentInfoSchema, info) && info.ref);
      noteRef = info.ref;
      return useTool("get_learning_context", {});
    },
    context => {
      const state: unknown = JSON.parse(toolText(context, "get_learning_context"));
      assert(Check(ContextStateSchema, state) && noteRef);
      return useTool("set_learning_context", { base: state.revision, binding: { kind: "document", contentId: noteRef.id } });
    },
    context => {
      toolText(context, "set_learning_context");
      assert(noteRef);
      return useTool("review_create", { prompt: "潮汐和潮流有什么区别？", answer: "水位升降与水的运动。", sources: [{ contentId: noteRef.id }] });
    },
    context => {
      const result: unknown = JSON.parse(toolText(context, "review_create"));
      assert(Check(ReviewMutationResultSchema, result));
      review = result.item;
      assert.equal(result.event, undefined);
      return fauxAssistantMessage("潮汐描述水位变化，潮流描述水的运动。请用自己的话区分两者。");
    },
  ]);
  await send("从 material.md 帮我区分潮汐与潮流，记录目标并留一道复习题。");
  assert(review && noteRef);
  const historyBefore = await invoke(client, scope, "repa.review.history", { itemId: review.id });
  assert(Check(ReviewHistoryResultSchema, historyBefore));
  assert.deepEqual(historyBefore.events, []);
  const response = "潮汐说的是水位上下变化，潮流说的是水在流动；我刚才需要提示才想起后者。";
  faux.setResponses([
    context => {
      assert(context.messages.some(message => message.role === "user" && textOf(message.content).includes(response)));
      assert(review);
      return useTool("review_get", { itemId: review.id });
    },
    context => {
      const current: unknown = JSON.parse(toolText(context, "review_get"));
      assert(Check(ReviewItemSchema, current));
      return useTool("review_feedback", { itemId: current.id, base: current.revision, rating: 2, response });
    },
    context => {
      const result: unknown = JSON.parse(toolText(context, "review_feedback"));
      assert(Check(ReviewMutationResultSchema, result));
      assert.equal(result.event?.kind, "feedback");
      return useTool("edit", { path: "learning.md", edits: [{ oldText: "已提供解释，等待学习者尝试；下一步用自己的话区分两者。", newText: `实际作答：${response}\n判断：提示后可以区分。下一步：换一个情境独立解释。` }] });
    },
    context => { toolText(context, "edit"); return fauxAssistantMessage("区分准确。下次换一个情境独立解释，再看是否还需要提示。"); },
  ]);
  await send(response);
  const expected = await readFile(path.join(f.directory, "learning.md"), "utf8");
  const history = await invoke(client, scope, "repa.review.history", { itemId: review.id });
  assert(Check(ReviewHistoryResultSchema, history));
  assert.equal(history.events.length, 1);
  assert.equal(history.events[0]?.recordedBy.kind, "agent");

  await disable(client, scope, ["repa-learning"]);
  const off = await client.call("prompts.preview", key);
  assert.equal(off.prompt.system.includes(DEFAULT_LEARNING_PROMPT), false);
  for (const name of ["learn-with-feedback", "plan-learning", "organize-learning"]) assert.equal(off.prompt.system.includes(name), false);
  const capabilities = await client.call("capability.describe", { scope });
  assert(capabilities.capabilities.some(item => item.pluginId === "repa-search"));
  assert(capabilities.capabilities.every(item => !["repa-learning", "repa-materials", "repa-planning", "repa-review"].includes(item.pluginId)));
  const destination = path.join(f.root, "copy");
  const copied = await client.call("space.copy", { operationId: randomUUID(), spaceId: space.id, destination });
  assert.equal(copied.status, "completed");
  assert(copied.participants.some(owner => owner.id === "repa-review"));
  assert.equal(await readFile(path.join(destination, "learning.md"), "utf8"), expected);
  await server.close("cancel");
  await client.close();
  server = await startRepaServer(options);
  client = await RepaClient.connect(server.connection);
  const copy = await client.call("space.open", { path: destination });
  const copyScope = { kind: "space" as const, spaceId: copy.id };
  await disable(client, copyScope, ["repa-teaching"]);
  assert.deepEqual(await invoke(client, copyScope, "repa.review.history", { itemId: review.id }), history);
  const binding = await client.call("context.get", { spaceId: copy.id });
  assert.deepEqual(binding.binding, { kind: "document", ref: { spaceId: copy.id, id: noteRef.id } });
  const next = await client.call("session.create", { spaceId: copy.id });
  const nextPreview = await client.call("prompts.preview", { spaceId: copy.id, sessionId: next.sessionId });
  assert.equal(nextPreview.prompt.system.includes("learn-with-feedback"), false);
  assert(nextPreview.prompt.system.includes("plan-learning"));
  assert(nextPreview.prompt.sources.some(source => source.id === "learningContext" && source.content?.includes(response)));
  assert.equal(await readFile(path.join(f.agentDir, "settings.json"), "utf8"), f.piSettings);
});
