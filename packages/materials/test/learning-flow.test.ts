import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { JSDOM } from "jsdom";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { RepaClient, startRepaServer, type ContentTarget, type Input, type SettingScope } from "repa";
import { RepresentationSchema, SearchPageDataSchema, type ProcessingResult } from "repa/protocol";
import { EXTRACT_CONTRACT, ExtractDataSchema, type ExtractInput } from "../dist/index.js";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const fixtureDirectory = new URL("fixtures/learning-flow/", import.meta.url);
const application = { kind: "application" as const };
const question = "潮汐和海流有什么区别？请根据两份 NOAA 材料找出依据，局部核对并保存带出处的学习笔记。";
const sourceUrls = {
  tides: "https://oceanservice.noaa.gov/facts/tides.html",
  currents: "https://oceanservice.noaa.gov/facts/tidescurrents.html",
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: unknown) => part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "").join("\n");
}
function toolText(context: TranscriptContext, name: string): string {
  const message = context.messages.findLast(message => message.role === "toolResult" && message.toolName === name);
  assert(message, `Pi 应实际收到 ${name} 的结果`);
  assert(message.role === "toolResult" && !message.isError, textOf(message.content));
  return textOf(message.content);
}
function representation(value: unknown): ProcessingResult {
  assert(Check(RepresentationSchema, value));
  return value;
}
function extraction(value: ProcessingResult) {
  assert(value.value.kind === "inline" && Check(ExtractDataSchema, value.value.data));
  assert.equal(value.value.data.status, "ready");
  return value.value.data;
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= deadline) assert.fail(`连续使用状态超时：${JSON.stringify(value)}`);
    await delay(10);
  }
}
async function set(client: RepaClient, scope: SettingScope, namespace: string, key: string, value: unknown) {
  const entry = (await client.call("settings.get", { scope, namespace })).entries.find(entry => entry.key === key);
  assert(entry);
  await client.call("settings.set", { scope, namespace, key, value, base: entry.revision });
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-materials-learning-flow-"));
  const directory = path.join(root, "space");
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: [packageDirectory], extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"],
    retry: { enabled: false }, compaction: { enabled: false },
  }));
  const faux = fauxProvider({
    api: `repa-materials-flow-api-${randomUUID()}`, provider: `repa-materials-flow-provider-${randomUUID()}`,
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
  const scope = { kind: "space" as const, spaceId: space.id };
  await set(client, application, "plugins", "disabled", ["repa-materials"]);
  await set(client, application, "plugins", "backends", [{ id: "materials", package: { kind: "source", source: packageDirectory, scope: "user" } }]);
  await set(client, application, "plugins", "trusted", [{ kind: "package", name: "@repa/materials" }]);
  const session = await client.call("session.create", { spaceId: space.id });
  const key = { spaceId: space.id, sessionId: session.sessionId };
  const target = (file: string): ContentTarget => ({ kind: "file", spaceId: space.id, location: { kind: "relative", path: file } });
  return {
    root, space, scope, key, faux, target,
    get client() { return client; },
    async put(file: string, bytes: Uint8Array) {
      const uploaded = await client.uploadResource(space.id, bytes, "application/octet-stream");
      await client.call("content.write", { target: target(file), operationId: randomUUID(), base: { kind: "absent" }, value: { kind: "resource", resource: uploaded.resource } });
      const associated = await client.call("content.associate", { spaceId: space.id, location: { kind: "relative", path: file }, role: "material", operationId: randomUUID() });
      const ref = associated.contents[0]?.ref;
      assert(ref);
      return { kind: "content" as const, ref };
    },
    async extract(input: ExtractInput) {
      const accepted = await client.call("capability.invoke", { scope, requestId: randomUUID(), contract: EXTRACT_CONTRACT, input });
      assert(accepted.kind === "background");
      const stored = await until(() => client.call("request.get", { spaceId: space.id, requestId: accepted.request.requestId }),
        value => ["completed", "failed", "cancelled", "interrupted"].includes(value.status));
      assert.equal(stored.status, "completed", JSON.stringify(stored));
      assert("operation" in stored && stored.result?.value.kind === "inline");
      const result = representation(stored.result.value.data);
      extraction(result);
      return { stored, result };
    },
    async send(parts: Input["parts"]) {
      const accepted = await client.call("session.submit", { target: key, requestId: randomUUID(), input: { parts }, dispatch: { kind: "start" } });
      assert(accepted.runId);
      const runId = accepted.runId;
      const run = await until(() => client.call("run.get", { spaceId: space.id, runId }),
        value => ["completed", "failed", "cancelled", "interrupted"].includes(value.status));
      assert.equal(run.status, "completed", JSON.stringify(run));
      return accepted;
    },
    async reopen() {
      await server.close("cancel");
      await client.close();
      server = await startRepaServer(options);
      client = await RepaClient.connect(server.connection);
      assert.equal((await client.call("space.open", { path: directory })).id, space.id);
    },
  };
}

test("NOAA原始材料连续关联、检索与Pi工具成稿，人工校订重提取后保留且重启继续查来源", async (t) => {
  const metadata: unknown = JSON.parse(await readFile(new URL("sources.json", fixtureDirectory), "utf8"));
  const MetadataSchema = Type.Object({ files: Type.Array(Type.Object({ file: Type.String(), sha256: Type.String(), url: Type.String() })) });
  assert(Check(MetadataSchema, metadata));
  for (const source of metadata.files) {
    const bytes = await readFile(new URL(source.file, fixtureDirectory));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), source.sha256);
  }
  const f = await fixture(t);
  const htmlBytes = await readFile(new URL("noaa-tides.html", fixtureDirectory));
  const textBytes = await readFile(new URL("noaa-tidescurrents.txt", fixtureDirectory));
  const paragraphs = textBytes.toString("utf8").split("\n");
  assert.equal(paragraphs.length, 5);
  const originalDocument = new JSDOM(await readFile(new URL("noaa-tidescurrents.html", fixtureDirectory), "utf8"));
  try {
    const originalParagraphs = [...originalDocument.window.document.querySelectorAll("p")]
      .map(paragraph => paragraph.textContent.replace(/\s+/gu, " ").trim())
      .filter(paragraph => ["Tides are driven", "When used", "A second", "A third"].some(prefix => paragraph.startsWith(prefix)));
    assert.deepEqual(originalParagraphs, paragraphs.slice(0, 4), "文本夹具来自保留的 NOAA 原始 HTML，而非测试自行编造");
  } finally {
    originalDocument.window.close();
  }
  const html = await f.put("noaa-tides.html", htmlBytes);
  const text = await f.put("noaa-tidescurrents.txt", textBytes);
  const htmlVersion = (await f.client.call("content.get", { target: html })).bodyRevision;
  const textVersion = (await f.client.call("content.get", { target: text })).bodyRevision;
  assert(htmlVersion && textVersion);
  const article = await f.extract({ target: html, expectedBodyRevision: htmlVersion });
  const excerpt = await f.extract({ target: text, expectedBodyRevision: textVersion, range: { kind: "lines", start: 1, end: 2 } });
  assert.equal(extraction(article.result).reader.name, "readability");
  assert.match(extraction(article.result).segments.map(segment => segment.text).join("\n"), /tidal range/u);
  assert.deepEqual(excerpt.result.sources.map(source => source.locator?.value), [{ line: 1 }, { line: 2 }]);
  assert.equal(extraction(excerpt.result).segments.map(segment => segment.text).join(""), `${paragraphs[0]}\n${paragraphs[1]}\n`);
  assert(article.result.sources.every(source => source.revision === htmlVersion));
  assert(excerpt.result.sources.every(source => source.revision === textVersion));
  assert.equal(f.faux.state.callCount, 0, "实际材料提取不调用模型");

  let evidence: ProcessingResult | undefined;
  let notes = "";
  f.faux.setResponses([
    context => {
      const tools = getCurrentTools(context.messages).map(tool => tool.name);
      for (const name of ["grep", "read_material", "read", "write", "search_history"]) assert(tools.includes(name));
      const user = context.messages.findLast(message => message.role === "user");
      assert(user);
      assert.match(textOf(user.content), /潮汐和海流有什么区别/u);
      assert.match(textOf(user.content), /tidal range/u, "已提取的标准表示进入真实 Pi 请求");
      assert(textOf(user.content).includes(sourceUrls.tides));
      assert(textOf(user.content).includes(sourceUrls.currents));
      return fauxAssistantMessage(fauxToolCall("grep", { pattern: "tidal currents", path: "noaa-tidescurrents.txt", literal: true }), { stopReason: "toolUse" });
    },
    context => {
      evidence = representation(JSON.parse(toolText(context, "grep")));
      assert(evidence.value.kind === "inline" && Check(SearchPageDataSchema, evidence.value.data));
      assert(evidence.value.data.kind === "content");
      assert.equal(evidence.value.data.matches.length, 1);
      const match = evidence.value.data.matches[0];
      assert(match);
      assert.equal(match.line, 2);
      assert.equal(evidence.sources[match.sourceIndex]?.revision, textVersion);
      assert.deepEqual(evidence.sources[match.sourceIndex]?.target, text);
      return fauxAssistantMessage(fauxToolCall("read", { path: `repa:material/${text.ref.id}`, offset: match.line, limit: 1 }), { stopReason: "toolUse" });
    },
    context => {
      assert.match(toolText(context, "read"), /These are called "tidal currents\."/u);
      assert.doesNotMatch(toolText(context, "read"), /thermohaline circulation/u);
      return fauxAssistantMessage(fauxToolCall("read_material", { target: html, expectedBodyRevision: htmlVersion }), { stopReason: "toolUse" });
    },
    context => {
      const material = representation(JSON.parse(toolText(context, "read_material")));
      assert.equal(extraction(material).kind, "html");
      const segmentIndex = extraction(material).segments.findIndex(segment => segment.text.includes("tidal range"));
      assert(segmentIndex >= 0);
      const source = material.sources[segmentIndex];
      assert(source && source.revision === htmlVersion && source.locator);
      // 预设输出只驱动真实工具链，不用于判断模型解释或教学质量。
      notes = `# 潮汐与海流学习笔记\n\n潮汐描述海面周期性的升降；海流描述水的流动，成因包括潮汐、风以及温盐环流。\n\n## 来源\n- NOAA, What are tides?: ${sourceUrls.tides}\n  本地原件 repa:material/${html.ref.id}，正文版本 ${htmlVersion}，定位 ${JSON.stringify(source.locator)}。\n- NOAA, What's the difference between a tide and a current?: ${sourceUrls.currents}\n  本地原文摘录 repa:material/${text.ref.id}，正文版本 ${textVersion}，第 2 行。\n\n来源为 NOAA 公共领域文章；本文是学习笔记，不是 NOAA 官方产品。\n`;
      return fauxAssistantMessage(fauxToolCall("write", { path: "tides-notes.md", content: notes }), { stopReason: "toolUse" });
    },
    context => {
      assert.match(toolText(context, "write"), /已向 tides-notes\.md 保存/u);
      return fauxAssistantMessage("已保存带原始来源、正文版本和局部定位的笔记。");
    },
  ]);
  await f.send([
    { kind: "text", text: question },
    { kind: "text", text: `材料出处：noaa-tides.html 完整保存自 ${sourceUrls.tides}；noaa-tidescurrents.txt 是 ${sourceUrls.currents} 正文四段原文摘录。作者 NOAA，公共领域文章；摘录仅解码字符实体、折叠空白，没有改写。` },
    { kind: "data", representation: article.result },
    { kind: "data", representation: excerpt.result },
  ]);
  assert.equal(f.faux.state.callCount, 5);
  assert(evidence);
  const saved = await f.client.readText(f.target("tides-notes.md"));
  assert.equal(saved.text, notes);
  assert(saved.content.bodyRevision);
  const associated = await f.client.call("content.associate", { spaceId: f.space.id, location: { kind: "relative", path: "tides-notes.md" }, role: "document", operationId: randomUUID() });
  const documentRef = associated.contents[0]?.ref;
  assert(documentRef);
  const document = { kind: "content" as const, ref: documentRef };
  const correction = "\n## 人工补充\n温盐环流不是潮流；下次继续对照 NOAA 的第三段。😀\n";
  await f.client.call("content.write", { target: document, operationId: randomUUID(), base: saved.content.bodyRevision, value: { kind: "text", text: notes + correction } });
  const edited = await f.client.readText(document);
  assert(edited.content.bodyRevision);
  assert.notEqual(edited.content.bodyRevision, saved.content.bodyRevision);
  await f.extract({ target: html });
  await f.extract({ target: text });
  assert.equal((await f.client.readText(document)).text, notes + correction);
  assert.equal((await f.client.readText(text)).text, textBytes.toString("utf8"));
  const htmlResource = article.result.resources[0];
  const textResource = excerpt.result.resources[0];
  assert(htmlResource && textResource);
  assert.deepEqual(Buffer.from(await (await f.client.resource(htmlResource)).arrayBuffer()), htmlBytes);
  assert.equal(await (await f.client.resource(textResource)).text(), textBytes.toString("utf8"));

  await f.reopen();
  const describe = await f.client.call("capability.describe", { scope: f.scope });
  assert(describe.packages.some(item => item.name === "@repa/materials" && item.backend?.status === "ready"));
  assert.deepEqual(await f.client.call("request.get", { spaceId: f.space.id, requestId: article.stored.requestId }), article.stored);
  assert.equal((await f.client.readText(document)).text, notes + correction);
  let historyRevision = "";
  f.faux.setResponses([
    context => {
      assert.match(context.messages.map(message => textOf(message.content)).join("\n"), /温盐环流不是潮流/u);
      return fauxAssistantMessage(fauxToolCall("search_history", { sessionId: f.key.sessionId, pattern: question, literal: true }), { stopReason: "toolUse" });
    },
    context => {
      const result = representation(JSON.parse(toolText(context, "search_history")));
      assert(result.value.kind === "inline" && Check(SearchPageDataSchema, result.value.data));
      assert(result.value.data.kind === "history");
      const match = result.value.data.matches[0];
      assert(match);
      assert.match(match.snippet.text, /潮汐和海流有什么区别/u);
      historyRevision = result.value.data.revision;
      return fauxAssistantMessage(fauxToolCall("read_history", { sessionId: f.key.sessionId, revision: historyRevision, around: match.messageId, limit: 1 }), { stopReason: "toolUse" });
    },
    context => {
      assert.match(toolText(context, "read_history"), /潮汐和海流有什么区别/u);
      return fauxAssistantMessage(fauxToolCall("read", { path: `repa:document/${documentRef.id}` }), { stopReason: "toolUse" });
    },
    context => {
      assert.match(toolText(context, "read"), /温盐环流不是潮流/u);
      assert(toolText(context, "read").includes(sourceUrls.currents));
      return fauxAssistantMessage(fauxToolCall("read_material", { target: text, expectedBodyRevision: textVersion, range: { kind: "lines", start: 4, end: 4 } }), { stopReason: "toolUse" });
    },
    context => {
      const result = representation(JSON.parse(toolText(context, "read_material")));
      assert.equal(extraction(result).segments[0]?.text, `${paragraphs[3]}\n`);
      assert.deepEqual(result.sources[0], { target: text, revision: textVersion, locator: extraction(result).segments[0]?.locator });
      assert.deepEqual(result.sources[0]?.locator?.value, { line: 4 });
      return fauxAssistantMessage("已从人工校订继续，并重新读取同一来源的温盐环流原文。");
    },
  ]);
  await f.send([{ kind: "text", text: "继续上次笔记。人工补充说温盐环流不是潮流，请找回当时的问题、读校订稿，再核对原文第四行。" }]);
  assert.equal(f.faux.state.callCount, 10);
  assert(historyRevision);
  assert.equal((await f.client.readText(document)).text, notes + correction);
  await f.client.call("resource.collect", { spaceId: f.space.id });
  assert.equal(await (await f.client.resource(textResource)).text(), textBytes.toString("utf8"));
  assert.deepEqual(await readFile(path.join(f.root, "space", "noaa-tides.html")), htmlBytes);
});
