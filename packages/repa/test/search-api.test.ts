import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { RepaClient, RpcError } from "../src/client.js";
import type { CapabilityScope, ContentTarget, Result } from "../src/protocol.js";
import { methods, SearchPageDataSchema, type SearchCursor } from "../src/protocol.js";
import { RepresentationSchema, type Input, type ProcessingResult } from "../src/requests/schema.js";
import { startRepaServer } from "../src/server.js";
import { remapInput } from "../src/requests/store.js";

const contract = (id: string) => ({ id, version: "1" });
const OwnersSchema = Type.Object({ owners: Type.Record(Type.String(), Type.Array(Type.String())) });
const fault = (code: string) => (error: unknown) => error instanceof RpcError &&
  error.data !== null && typeof error.data === "object" && "code" in error.data && error.data.code === code;

function representation(value: unknown): ProcessingResult {
  assert(Check(RepresentationSchema, value), "能力结果应保留真实 Representation");
  assert.deepEqual(value.format, { id: "repa.search-results", version: "1" });
  return value;
}
function nextCursor(value: ProcessingResult): SearchCursor | undefined {
  assert(value.value.kind === "inline" && Check(SearchPageDataSchema, value.value.data));
  const next = value.value.data.next;
  if (!next) return undefined;
  const snapshot = value.resources[next.snapshotIndex];
  assert(snapshot);
  return { snapshot: snapshot.id, offset: next.offset };
}
function contentPage(value: ProcessingResult) {
  assert(value.value.kind === "inline" && Check(SearchPageDataSchema, value.value.data));
  assert(value.value.data.kind === "content");
  const { matches, next: _next, ...data } = value.value.data;
  return { ...data, next: nextCursor(value), matches: matches.map(match => {
    const source = value.sources[match.sourceIndex];
    const resource = value.resources[match.resourceIndex];
    assert(source && resource);
    return { ...match, target: source.target, revision: source.revision, resource };
  }) };
}
function historyPage(value: ProcessingResult) {
  assert(value.value.kind === "inline" && Check(SearchPageDataSchema, value.value.data));
  assert(value.value.data.kind === "history");
  const { next: _next, ...data } = value.value.data;
  const snapshot = value.resources[0];
  assert(snapshot);
  return { ...data, spaceId: snapshot.spaceId, next: nextCursor(value) };
}
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: unknown) => part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "").join("\n");
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= deadline) assert.fail(`等待状态超时：${JSON.stringify(value)}`);
    await delay(10);
  }
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-search-api-"));
  const directory = path.join(root, "space");
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: [], extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"],
    retry: { enabled: false }, compaction: { enabled: false },
  }));
  const faux = fauxProvider({
    api: `repa-search-api-${randomUUID()}`, provider: `repa-search-provider-${randomUUID()}`,
    models: [{ id: "test", reasoning: false, input: ["text"], contextWindow: 16384, maxTokens: 512 }], tokensPerSecond: 0,
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
  const session = await client.call("session.create", { spaceId: space.id });
  const scope: CapabilityScope = { kind: "space", spaceId: space.id };
  const key = { spaceId: space.id, sessionId: session.sessionId };
  const target = (file: string): ContentTarget => ({ kind: "file", spaceId: space.id, location: { kind: "relative", path: file } });
  const invoke = (id: string, input: unknown) => client.call("capability.invoke", {
    scope, requestId: randomUUID(), contract: contract(id), input,
  });
  return {
    root, directory, space, key, faux, target, invoke,
    get client() { return client; },
    async search(id: string, input: unknown) {
      const accepted = await invoke(id, input);
      assert.equal(accepted.kind, "background");
      if (accepted.kind !== "background") assert.fail("搜索应通过真实后台请求受理");
      const finished = await until(() => client.call("request.get", { spaceId: space.id, requestId: accepted.request.requestId }),
        value => ["completed", "failed", "cancelled", "interrupted"].includes(value.status));
      assert.equal(finished.status, "completed", JSON.stringify(finished));
      assert("operation" in finished && finished.result?.value.kind === "inline");
      return { requestId: accepted.request.requestId, finished, result: representation(finished.result.value.data) };
    },
    async page(cursor: SearchCursor, limit = 1) {
      const result = await invoke("repa.search.page", { cursor, limit });
      assert.equal(result.kind, "inline");
      if (result.kind !== "inline") assert.fail("分页应等待同一快照读取完成");
      return representation(result.result);
    },
    async send(text: string) {
      const accepted = await client.call("session.submit", {
        target: key, requestId: randomUUID(), input: { parts: [{ kind: "text", text }] }, dispatch: { kind: "start" },
      });
      assert(accepted.runId);
      const runId = accepted.runId;
      const run: Result<"run.get"> = await until(() => client.call("run.get", { spaceId: space.id, runId }),
        value => ["completed", "failed", "cancelled", "interrupted"].includes(value.status));
      assert.equal(run.status, "completed", JSON.stringify(run));
      return accepted;
    },
    async reopen(openDirectory = directory) {
      await server.close("cancel");
      await client.close();
      server = await startRepaServer(options);
      client = await RepaClient.connect(server.connection);
      const opened = await client.call("space.open", { path: openDirectory });
      if (openDirectory === directory) assert.equal(opened.id, space.id);
      return opened;
    },
    async owners() {
      const state: unknown = JSON.parse(await readFile(path.join(directory, ".repa/content/resources.json"), "utf8"));
      assert(Check(OwnersSchema, state));
      return state.owners;
    },
  };
}

test("内容搜索分页沿用原文快照，修改和移除原件后仍可定位旧页与重开读取资源", async (t) => {
  const f = await fixture(t);
  const original = "依据一：😀alpha\r\n依据二：beta\n依据三：gamma\n";
  const target = f.target("evidence.md");
  await f.client.call("content.write", { target, base: { kind: "absent" }, operationId: randomUUID(), value: { kind: "text", text: original } });
  const searched = await f.search("repa.search.content", { pattern: "依据", path: "evidence.md", literal: true, limit: 1 });
  const first = contentPage(searched.result);
  assert.equal(first.total, 3);
  assert.equal(first.truncated, false);
  assert.equal(first.matches.length, 1);
  const match = first.matches[0];
  assert(match && first.next);
  assert.equal(match.line, 1);
  assert.deepEqual(searched.result.sources, [{ target: match.target, revision: match.revision }]);
  assert.equal(await (await f.client.resource(match.resource)).text(), original);
  const owners = await f.owners();
  assert(owners[`processing:${searched.requestId}`]?.includes(first.next.snapshot));
  assert(owners[`processing:${searched.requestId}`]?.includes(match.resource.id));

  const info = await f.client.call("content.get", { target });
  assert(info.bodyRevision);
  await f.client.call("content.write", { target, base: info.bodyRevision, operationId: randomUUID(), value: { kind: "text", text: "后来修改，无旧依据\n" } });
  await assert.rejects(f.client.call("content.read", { target: match.target, revision: match.revision }), fault("revision_conflict"));
  const second = contentPage(await f.page(first.next));
  assert.equal(second.total, 3);
  assert.equal(second.matches[0]?.line, 2);
  assert.equal(second.matches[0]?.revision, match.revision);
  assert.equal(second.matches[0]?.snippet.text, "依据二：beta");
  assert(second.next);
  const changed = await f.client.call("content.get", { target });
  assert(changed.bodyRevision);
  await f.client.call("content.remove", { target, base: changed.bodyRevision, operationId: randomUUID() });
  await f.reopen();
  const third = contentPage(await f.page(second.next));
  assert.equal(third.total, 3);
  assert.equal(third.matches[0]?.line, 3);
  assert.equal(third.matches[0]?.snippet.text, "依据三：gamma");
  assert.equal(third.matches[0]?.revision, match.revision);
  assert.equal(third.next, undefined);
  await f.client.call("resource.collect", { spaceId: f.space.id });
  assert.equal(await (await f.client.resource(match.resource)).text(), original);
  assert.deepEqual(await f.client.call("request.get", { spaceId: f.space.id, requestId: searched.requestId }), searched.finished);
  assert.equal(f.faux.state.callCount, 0);
});

test("卸载 Agent 时历史搜索不启动模型，追加后原结果页与 around 仍冻结且重开可读", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("第一答"), fauxAssistantMessage("第二答"), fauxAssistantMessage("第三答")]);
  await f.send("历史证据一");
  await f.send("历史证据二");
  await f.send("历史证据三");
  await f.client.call("session.close", f.key);
  const history = await f.client.call("session.history", f.key);
  const calls = f.faux.state.callCount;
  const searched = await f.search("repa.search.history", { sessionId: f.key.sessionId, pattern: "历史证据", literal: true, limit: 1 });
  const first = historyPage(searched.result);
  assert.equal(first.total, 3);
  assert.equal(first.revision, history.revision);
  assert.equal(first.query.sessionId, f.key.sessionId);
  assert.equal(first.spaceId, f.space.id);
  assert.equal((await f.client.call("session.get", f.key)).runtime, "unloaded");
  assert.equal(f.faux.state.callCount, calls);
  assert(first.next);
  f.faux.setResponses([fauxAssistantMessage("第四答")]);
  await f.send("历史证据四");
  const second = historyPage(await f.page(first.next));
  assert.equal(second.total, 3);
  assert.equal(second.matches[0]?.snippet.text, "历史证据二");
  assert.equal(second.revision, first.revision);
  const selected = second.matches[0];
  assert(selected && second.next);
  const located = await f.invoke("repa.history.read", { sessionId: f.key.sessionId, revision: second.revision, around: selected.messageId, limit: 1 });
  assert.equal(located.kind, "inline");
  if (located.kind !== "inline") assert.fail("历史读取应 inline 完成");
  assert(Check(methods["session.history"].result, located.result));
  assert.equal(located.result.revision, first.revision);
  assert.equal(located.result.messages[0]?.id, selected.messageId);
  assert.equal(textOf(located.result.messages[0]?.content), "历史证据二");
  await f.client.call("session.close", f.key);
  await f.reopen();
  const third = historyPage(await f.page(second.next));
  assert.equal(third.matches[0]?.snippet.text, "历史证据三");
  assert.equal(third.total, 3);
  assert.equal(third.revision, first.revision);
  assert.equal(third.next, undefined);
  assert.equal((await f.client.call("session.get", f.key)).runtime, "unloaded");
  assert.equal(f.faux.state.callCount, calls + 1);
});

test("真实 Pi 用 grep、search_page 和 read 消费同一来源与游标，结果转交会话且不另建后台记录", async (t) => {
  const f = await fixture(t);
  const original = "依据一：第一处\n依据二：第二处\n";
  await f.client.call("content.write", { target: f.target("tool.md"), base: { kind: "absent" }, operationId: randomUUID(), value: { kind: "text", text: original } });
  const before = await readdir(path.join(f.directory, ".repa/runtime/processing"));
  let firstResult: ProcessingResult | undefined;
  let pageResult: ProcessingResult | undefined;
  f.faux.setResponses([
    context => {
      const tools = getCurrentTools(context.messages);
      assert(tools.some(tool => tool.name === "grep"));
      assert(tools.some(tool => tool.name === "search_page"));
      const readHistory = tools.find(tool => tool.name === "read_history");
      assert(readHistory);
      assert("properties" in readHistory.parameters && readHistory.parameters.properties !== null && typeof readHistory.parameters.properties === "object");
      assert.deepEqual(Object.keys(readHistory.parameters.properties).sort(), ["around", "before", "limit", "revision", "sessionId"]);
      assert(Check(readHistory.parameters, { sessionId: f.key.sessionId, revision: "history-v1:example:empty", limit: 1 }));
      assert(!Check(readHistory.parameters, {}));
      assert(!Check(readHistory.parameters, { sessionId: f.key.sessionId, before: "one", around: "two" }));
      return fauxAssistantMessage(fauxToolCall("grep", { pattern: "依据", path: "tool.md", literal: true, limit: 1 }), { stopReason: "toolUse" });
    },
    context => {
      const tool = context.messages.find(message => message.role === "toolResult" && message.toolName === "grep");
      assert(tool);
      firstResult = representation(JSON.parse(textOf(tool.content)));
      const first = contentPage(firstResult);
      assert.equal(first.total, 2);
      assert(first.next && first.matches[0]);
      assert.deepEqual(firstResult.sources, [{ target: first.matches[0].target, revision: first.matches[0].revision }]);
      return fauxAssistantMessage(fauxToolCall("search_page", { cursor: first.next, limit: 1 }), { stopReason: "toolUse" });
    },
    context => {
      const tool = context.messages.find(message => message.role === "toolResult" && message.toolName === "search_page");
      assert(tool && firstResult);
      pageResult = representation(JSON.parse(textOf(tool.content)));
      const second = contentPage(pageResult);
      assert.equal(second.matches[0]?.snippet.text, "依据二：第二处");
      assert.equal(second.matches[0]?.revision, contentPage(firstResult).matches[0]?.revision);
      assert.equal(second.next, undefined);
      return fauxAssistantMessage(fauxToolCall("read", { path: "tool.md", offset: second.matches[0]?.line, limit: 1 }), { stopReason: "toolUse" });
    },
    context => {
      const tool = context.messages.find(message => message.role === "toolResult" && message.toolName === "read");
      assert(tool);
      assert.match(textOf(tool.content), /依据二：第二处/u);
      assert.doesNotMatch(textOf(tool.content), /依据一：第一处/u);
      return fauxAssistantMessage("根据第二处依据继续");
    },
  ]);
  const accepted = await f.send("寻找依据并读取第二处原文");
  assert(firstResult && pageResult);
  assert.equal(f.faux.state.callCount, 4);
  assert.deepEqual(await readdir(path.join(f.directory, ".repa/runtime/processing")), before);
  const owners = await f.owners();
  const owner = owners[`session:${f.key.sessionId}`];
  assert(owner);
  for (const resource of [...firstResult.resources, ...pageResult.resources]) {
    assert(owner.includes(resource.id));
    assert(!(owners[`request:${accepted.requestId}`] ?? []).includes(resource.id));
  }
  await f.client.call("resource.collect", { spaceId: f.space.id });
  const source = contentPage(firstResult).matches[0];
  assert(source);
  assert.equal(await (await f.client.resource(source.resource)).text(), original);
});


test("复制空间后的搜索页、重传与历史定位自足，源空间未打开也读取原快照", async (t) => {
  const f = await fixture(t);
  const original = "复制证据一\n复制证据二\n复制证据三\n";
  await f.client.call("content.write", { target: f.target("copy.md"), base: { kind: "absent" }, operationId: randomUUID(), value: { kind: "text", text: original } });
  const query = { pattern: "复制证据", path: "copy.md", literal: true, limit: 1 };
  const content = await f.search("repa.search.content", query);
  const first = contentPage(content.result);
  assert(first.next && first.matches[0]);
  const snapshotResource = content.result.resources[0];
  assert(snapshotResource);
  const snapshotBytes = await (await f.client.resource(snapshotResource)).text();
  const originalPage = await f.invoke("repa.search.page", { cursor: first.next, limit: 1 });
  assert(originalPage.kind === "inline");
  f.faux.setResponses([fauxAssistantMessage("复制历史答一"), fauxAssistantMessage("复制历史答二")]);
  await f.send("复制历史证据一");
  await f.send("复制历史证据二");
  await f.client.call("session.close", f.key);
  const history = await f.search("repa.search.history", { sessionId: f.key.sessionId, pattern: "复制历史证据", literal: true, limit: 1 });
  const oldHistory = historyPage(history.result);
  assert(oldHistory.next);
  const copied = await f.client.call("space.copy", { spaceId: f.space.id, destination: path.join(f.root, "copy"), operationId: randomUUID() });
  assert.equal(copied.status, "completed", copied.error?.message);
  const copy = await f.reopen(copied.destination);
  assert.notEqual(copy.id, f.space.id);
  assert.deepEqual((await f.client.call("space.list", {})).map(space => space.id), [copy.id]);
  await assert.rejects(f.client.resource(snapshotResource));
  const stored = await f.client.call("request.get", { spaceId: copy.id, requestId: content.requestId });
  assert("operation" in stored && stored.result?.value.kind === "inline");
  const firstRepresentation = representation(stored.result.value.data);
  const copiedFirst = contentPage(firstRepresentation);
  assert(copiedFirst.next && copiedFirst.matches[0]);
  assert(firstRepresentation.resources.every(resource => resource.spaceId === copy.id));
  assert(firstRepresentation.sources.every(source => source.target.kind === "content" ? source.target.ref.spaceId === copy.id : source.target.spaceId === copy.id));
  assert.deepEqual(stored.result.sources, firstRepresentation.sources, "嵌套标准表示与外层来源共同映射");
  assert.deepEqual(stored.result.resources, firstRepresentation.resources);
  const originalMatch = first.matches[0];
  const copiedMatch = copiedFirst.matches[0];
  assert.equal(copiedMatch.revision, originalMatch.revision);
  assert.equal(copiedMatch.resource.id, originalMatch.resource.id);
  assert.equal(await (await f.client.resource(copiedMatch.resource)).text(), original);
  const copiedSnapshotResource = firstRepresentation.resources[0];
  assert(copiedSnapshotResource);
  assert.equal(await (await f.client.resource(copiedSnapshotResource)).text(), snapshotBytes, "复制不重写结果blob hash或历史字节");
  assert.equal((await f.client.call("content.read", { target: copiedMatch.target, revision: copiedMatch.revision })).text, original);
  const scope: CapabilityScope = { kind: "space", spaceId: copy.id };
  const next = async (cursor: SearchCursor) => {
    const result = await f.client.call("capability.invoke", { scope, requestId: randomUUID(), contract: contract("repa.search.page"), input: { cursor, limit: 1 } });
    assert(result.kind === "inline");
    return { response: result, representation: representation(result.result) };
  };
  await rm(path.join(copy.path, "copy.md"));
  const replay = await f.client.call("capability.invoke", { scope, requestId: content.requestId, contract: contract("repa.search.content"), input: query });
  assert(replay.kind === "background");
  assert.deepEqual(replay.request, stored, "副本重传原搜索ID不重新搜索已经移走的文件");
  const storedPage = await f.client.call("request.get", { spaceId: copy.id, requestId: originalPage.requestId });
  assert("operation" in storedPage && storedPage.result?.value.kind === "inline");
  const copiedPageReplay = await f.client.call("capability.invoke", { scope, requestId: originalPage.requestId, contract: contract("repa.search.page"), input: { cursor: copiedFirst.next, limit: 1 } });
  assert(copiedPageReplay.kind === "inline");
  assert.deepEqual(copiedPageReplay.result, storedPage.result.value.data, "副本重传源空间已受理分页ID沿用同blobId与原scope映射");
  const second = await next(copiedFirst.next);
  const copiedSecond = contentPage(second.representation);
  assert.equal(copiedSecond.matches[0]?.snippet.text, "复制证据二");
  assert.equal(copiedSecond.matches[0]?.resource.spaceId, copy.id);
  assert.equal(await (await f.client.resource(copiedMatch.resource)).text(), original);
  // 已受理的分页输入只保存blobId；再次复制/重开也不遗留另一份cursor空间引用。
  assert(typeof copiedFirst.next.snapshot === "string");
  const replayPage = await f.client.call("capability.invoke", { scope, requestId: second.response.requestId, contract: contract("repa.search.page"), input: { cursor: copiedFirst.next, limit: 1 } });
  assert.deepEqual(replayPage, second.response);
  const storedHistory = await f.client.call("request.get", { spaceId: copy.id, requestId: history.requestId });
  assert("operation" in storedHistory && storedHistory.result?.value.kind === "inline");
  const copiedHistory = historyPage(representation(storedHistory.result.value.data));
  assert(copiedHistory.next);
  assert.equal(copiedHistory.spaceId, copy.id);
  assert.equal(copiedHistory.revision, oldHistory.revision);
  const nextHistory = historyPage((await next(copiedHistory.next)).representation);
  const selected = nextHistory.matches[0];
  assert(selected);
  assert.equal(selected.snippet.text, "复制历史证据二");
  const located = await f.client.call("session.history", { spaceId: copy.id, sessionId: f.key.sessionId, revision: nextHistory.revision, around: selected.messageId, limit: 1 });
  assert.equal(located.messages[0]?.id, selected.messageId);
  assert.equal(textOf(located.messages[0]?.content), "复制历史证据二");
  assert.equal(f.faux.state.callCount, 2);
  // 材料结果复用同一标准表示边界，不为其业务正文建立任意 JSON 引用扫描。
  const material: ProcessingResult = {
    format: { id: "repa.material-extraction", version: "1" },
    value: { kind: "inline", data: { text: original, business: { spaceId: f.space.id },
      arbitrary: { embedded: { resource: originalMatch.resource } } } },
    sources: structuredClone(content.result.sources), resources: [structuredClone(originalMatch.resource)],
  };
  const untouchedBusinessValue = structuredClone(material.value);
  const input: Input = { parts: [{ kind: "data", representation: {
    format: contract("repa.material.extract"), value: { kind: "inline", data: material }, sources: [], resources: [],
  } }] };
  remapInput(input, f.space.id, copy.id);
  const materialPart = input.parts[0];
  assert(materialPart?.kind === "data" && materialPart.representation.value.kind === "inline");
  assert(Check(RepresentationSchema, materialPart.representation.value.data));
  const mappedMaterial = materialPart.representation.value.data;
  assert.deepEqual(mappedMaterial.sources, firstRepresentation.sources);
  assert.equal(mappedMaterial.resources[0]?.spaceId, copy.id);
  assert.deepEqual(mappedMaterial.value, untouchedBusinessValue, "任意业务正文未被扫描或重写");
  const materialResource = mappedMaterial.resources[0];
  assert(materialResource);
  assert.equal(await (await f.client.resource(materialResource)).text(), original);
});
