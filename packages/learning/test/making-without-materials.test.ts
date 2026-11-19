/**
 * 没有课件也能做课：经真实的协议后端、通用 Agent、学习插件与课件插件，模型是离线的 faux，按脚本调用工具；
 * DeepSeek 的搜索与读网页换成注入的请求函数，不访问网络。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { startServer } from "@repa/base";
import { RepaClient } from "@repa/base/client";
import { INTERACTION_CAPABILITIES, parse } from "@repa/base/protocol";
import materialsPlugin from "../../materials/dist/plugin.js";
import { createAgentRuntimeForTest } from "../../base/dist/agent/runtime.js";
import { connectLearning } from "../src/flow.js";
import { createLearningPlugin } from "../src/plugin.js";
import { learningMethods, type LearningInput, type LearningMethod, type LearningResult } from "../src/protocol.js";

const PAGE = "https://example.edu/linear-algebra/notes/";

function lastToolResult(context: TranscriptContext): string {
  const message = context.messages.findLast((entry) => entry.role === "toolResult");
  assert.ok(message?.role === "toolResult");
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

const write = (file: string, content: string) => fauxToolCall("write", { path: file, content });

const manifest = [
  "id: linear-algebra",
  "version: 1.0.0",
  "title: 线性代数",
  "language: zh-CN",
  "license: NOASSERTION",
  "sources:",
  `  notes: { title: 线性代数讲义, url: "${PAGE}", version: 访问于 2026-11-15, license: NOASSERTION, permits: [reference] }`,
  "topics: [la01, la02]",
  "",
].join("\n");

function outline(id: string, title: string, prerequisites: string[], where: string): string {
  return [
    `id: ${id}`,
    `title: ${title}`,
    "status: outline",
    "minutes: 15",
    `summary: ${title}的范围。`,
    `prerequisites: [${prerequisites.join(", ")}]`,
    `sources: [{ source: notes, where: ${where}, use: reference }]`,
    "kps:",
    `  - { id: ${id}.k1, title: ${title}一 }`,
    `  - { id: ${id}.k2, title: ${title}二 }`,
    "",
  ].join("\n");
}

/** 空间里没有课件；接上了 DeepSeek 的密钥，搜索与读网页由 web 回答。 */
async function fixture(t: TestContext, web: (url: string, body: unknown) => unknown) {
  const saved = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-making-web-")));
  const root = path.join(directory, "space");
  const agentDir = path.join(directory, "home", "agent");
  await mkdir(root, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, "auth.json"), JSON.stringify({ deepseek: { type: "api_key", key: "sk-fixture" } }));
  const faux = fauxProvider({ api: `making-web-${randomUUID()}`, provider: `making-web-${randomUUID()}`, models: [{ id: "test", contextWindow: 65536, maxTokens: 512 }], tokensPerSecond: 0 });
  const models = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  models.registerNativeProvider(faux.provider);
  const runtime = await createAgentRuntimeForTest({
    agentDir, modelRuntime: models, defaultModel: { provider: faux.getModel().provider, id: "test" }, now: () => 1_792_454_400_000,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
    async webRequest(url, init) {
      return new Response(JSON.stringify(web(url, JSON.parse(String(init.body)))), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const learning = createLearningPlugin({ connect: (opened) => connectLearning(opened) });
  const server = await startServer({ home: path.join(directory, "home"), runtime, plugins: [learning, materialsPlugin] });
  const client = await RepaClient.connect(server.connection, { capabilities: { interaction: { supports: [...INTERACTION_CAPABILITIES] } } });
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
    if (saved !== undefined) process.env.DEEPSEEK_API_KEY = saved;
  });
  const { opening } = await client.call("space.open", { root });
  async function call<M extends LearningMethod>(method: M, input: LearningInput<M>): Promise<LearningResult<M>> {
    return parse(learningMethods[method].result, await client.call("plugin.call", { pluginId: "learning", method, input, opening })) as LearningResult<M>;
  }
  return { faux, client, call };
}

test("没有课件也能做课：起点开始，Agent 先问清需求，学习者作答，搜索、读网页以后出轮廓，学习页上有了整门课", async (t) => {
  const requests: { url: string; body: unknown }[] = [];
  const f = await fixture(t, (url, body) => {
    requests.push({ url, body });
    if (url.endsWith("/search")) {
      return { results: [{ rerank_score: 2, title: "线性代数讲义", url: PAGE, snippet: "", summary: "大学线性代数讲义：向量、矩阵与线性方程组。", content: "", site_name: null, site_icon: null, date: null, authority: 3 }] };
    }
    return { title: "线性代数讲义", content: "# 线性代数\n\n## 第一节 向量\n\n## 第二节 矩阵乘法\n" };
  });

  // 学习页的起点：没有课件，写了想学什么。前端建好通用会话以后取第一条消息发出去。
  const session = await f.client.call("session.create", {});
  const { text } = await f.call("building.begin", { sessionId: session.id, materials: false, request: "线性代数" });

  const seen: { first?: string; tools?: string[]; answered?: string; searched?: string; read?: string; checked?: string; used?: string } = {};
  f.faux.appendResponses([
    (context) => {
      // 用户消息之后还有日期视图，取学习者的那一条。
      seen.first = context.messages.flatMap((entry) => (entry.role === "user" ? [typeof entry.content === "string" ? entry.content : entry.content.map((part) => (part.type === "text" ? part.text : "")).join("")] : [])).find((text) => text.includes("没有课件")) ?? "";
      seen.tools = getCurrentTools(context.messages).map((tool) => tool.name);
      return fauxAssistantMessage([fauxToolCall("ask_user", { questions: [
        { id: "goal", question: "学线性代数是为了什么？", options: [{ label: "考试" }, { label: "项目" }, { label: "兴趣" }] },
        { id: "start", question: "现在会到哪一步？有指定的资料吗？", input: "text" },
      ] })]);
    },
    (context) => {
      seen.answered = lastToolResult(context);
      return fauxAssistantMessage([fauxToolCall("web_search", { query: "线性代数 讲义", count: 5 })]);
    },
    (context) => {
      seen.searched = lastToolResult(context);
      return fauxAssistantMessage([fauxToolCall("web_fetch", { url: PAGE })]);
    },
    (context) => {
      seen.read = lastToolResult(context);
      return fauxAssistantMessage([
        write("courses/space/course/course.yaml", manifest),
        write("courses/space/course/topics/la01.yaml", outline("la01", "向量", [], "第一节 向量")),
        write("courses/space/course/topics/la02.yaml", outline("la02", "矩阵乘法", ["la01"], "第二节 矩阵乘法")),
      ]);
    },
    fauxAssistantMessage([fauxToolCall("course_check", {})]),
    (context) => {
      seen.checked = lastToolResult(context);
      return fauxAssistantMessage([fauxToolCall("course_use", {})]);
    },
    (context) => {
      seen.used = lastToolResult(context);
      return fauxAssistantMessage("轮廓有两部分：向量、矩阵乘法。");
    },
  ]);
  const asked = new Promise<{ id: string; item: { id: string; version: string } }>((resolve) => {
    const off = f.client.on("ask.request", (request) => { off(); resolve(request); });
  });
  const running = f.client.call("session.send", { sessionId: session.id, text });
  const request = await asked;
  await f.client.call("ask.reply", {
    id: request.id, action: "submit",
    response: { item: { id: request.item.id, version: request.item.version }, answers: { goal: { type: "choice", selected: ["o1"] }, start: { type: "text", text: "学过高中数学，没有指定资料" } } },
  });
  await running;

  assert.match(seen.first ?? "", /没有课件/u);
  assert.ok(seen.tools?.includes("web_search") && seen.tools.includes("web_fetch") && seen.tools.includes("ask_user"));
  assert.match(seen.answered ?? "", /考试/u);
  assert.match(seen.answered ?? "", /学过高中数学/u);
  assert.match(seen.searched ?? "", /\[1\] 线性代数讲义\n地址：https:\/\/example\.edu/u);
  assert.match(seen.read ?? "", /## 第一节 向量/u);
  assert.deepEqual(requests.map((item) => item.url), ["https://api.deepseek.com/v1/tools/search", "https://api.deepseek.com/v1/tools/fetch"]);
  assert.match(seen.checked ?? "", /通过检查/u);
  assert.match(seen.used ?? "", /^已换用/u);
  const building = await f.call("building.get", {});
  assert.equal(building.course?.id, "linear-algebra");
  assert.deepEqual(building.parts.map((part) => [part.topicId, part.status]), [["la01", "outline"], ["la02", "outline"]]);
  assert.equal(building.sessionId, session.id);
  // 学习页给学习者看的出处是网页地址。
  assert.deepEqual(building.parts[0]?.sources, [{ title: "线性代数讲义", url: PAGE, where: "第一节 向量" }]);
});
