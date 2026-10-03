import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { RepaClient, RpcError } from "../src/client.js";
import { ContentStore } from "../src/content/store.js";
import { ResourceRetention } from "../src/content/resources.js";
import { RepaFault } from "../src/errors.js";
import { PiSessionStore } from "../src/pi-sessions.js";
import type { Message, ResourceRef, Result, SessionKey } from "../src/protocol.js";
import { startRepaServer } from "../src/server.js";

const fault = (code: string) => (error: unknown) => error instanceof RpcError &&
  error.data !== null && typeof error.data === "object" && "code" in error.data && error.data.code === code;
const textOf = (message: Message) => message.content.map(block => "text" in block ? block.text : "").join("\n");

async function fixture(t: TestContext, seed: (manager: SessionManager) => void) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-session-history-"));
  const directory = path.join(root, "space"), agentDir = path.join(root, "agent");
  const sessionDirectory = path.join(directory, ".repa", "sessions");
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: [], extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"],
    retry: { enabled: false }, compaction: { enabled: false },
  }));
  const manager = SessionManager.create(directory, sessionDirectory);
  seed(manager);
  const file = manager.getSessionFile();
  assert(file);
  // 空会话与尚无 assistant 的样本沿用 Repa 的身份落盘形状，条目由真实 SDK 生成。
  await writeFile(file, [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const faux = fauxProvider({
    api: `repa-history-api-${randomUUID()}`, provider: `repa-history-provider-${randomUUID()}`,
    models: [{ id: "test", reasoning: false, input: ["text", "image"], contextWindow: 16384, maxTokens: 512 }],
    tokensPerSecond: 0,
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const options = { appDirectory: path.join(root, "app"), agentDir, modelOverride: { modelRuntime, model: faux.getModel() } };
  let server = await startRepaServer(options);
  let client = await RepaClient.connect(server.connection);
  t.after(async () => {
    await server.close("cancel");
    await client.close();
    await rm(root, { recursive: true, force: true });
  });
  const space = await client.call("space.open", { path: directory });
  const key: SessionKey = { spaceId: space.id, sessionId: manager.getSessionId() };
  const send = async (target: SessionKey, text: string, resource?: ResourceRef) => {
    faux.setResponses([fauxAssistantMessage("追加后的回复")]);
    const request = await client.call("session.submit", {
      target, requestId: randomUUID(), input: { parts: [
        { kind: "text", text }, ...(resource ? [{ kind: "resource" as const, resource }] : []),
      ] }, dispatch: { kind: "start" },
    });
    assert(request.runId);
    const deadline = Date.now() + 10000;
    for (;;) {
      const run: Result<"run.get"> = await client.call("run.get", { spaceId: target.spaceId, runId: request.runId });
      if (run.status === "completed") return;
      assert(!["failed", "cancelled", "interrupted"].includes(run.status), JSON.stringify(run));
      if (Date.now() >= deadline) assert.fail(`等待运行完成超时：${JSON.stringify(run)}`);
      await delay(10);
    }
  };
  return {
    root, file, manager, key, faux, send,
    get client() { return client; }, get application() { return server.application; },
    async reopen() {
      await server.close("cancel");
      await client.close();
      server = await startRepaServer(options);
      client = await RepaClient.connect(server.connection);
      assert.equal((await client.call("space.open", { path: directory })).id, key.spaceId);
    },
  };
}

test("历史修订冻结原分支，深处定位包含原消息且追加与重开不移动旧分页", async (t) => {
  const ids: string[] = [];
  const f = await fixture(t, manager => {
    for (let index = 0; index < 60; index++) {
      ids.push(manager.appendMessage({ role: "user", content: `第 ${index + 1} 轮问题😀`, timestamp: index * 2 }));
      ids.push(manager.appendMessage(fauxAssistantMessage(`第 ${index + 1} 轮回复`, { timestamp: index * 2 + 1 })));
    }
  });
  const bytes = await readFile(f.file);
  const latest = await f.client.call("session.history", { ...f.key, limit: 4 });
  assert(latest.before);
  assert.equal(latest.messages[0]?.id, ids.at(-4));
  const previous = await f.client.call("session.history", { ...f.key, revision: latest.revision, before: latest.before, limit: 4 });
  assert.deepEqual(previous.messages.map(message => message.id), ids.slice(-8, -4));
  const deep = await f.client.call("session.history", { ...f.key, revision: latest.revision, around: ids[2]!, limit: 3 });
  assert.deepEqual(deep.messages.map(message => message.id), ids.slice(1, 4));
  assert.equal(textOf(deep.messages[1]!), "第 2 轮问题😀");
  assert.equal(deep.revision, latest.revision);
  assert.deepEqual(f.application.history({ ...f.key, revision: latest.revision, around: ids[2]!, limit: 3 }), deep);
  assert.equal((await f.client.call("session.get", f.key)).runtime, "unloaded");
  assert.equal(f.faux.state.callCount, 0);
  assert.deepEqual(await readFile(f.file), bytes);
  await f.send(f.key, "新追加的问题");
  const advanced = await f.client.call("session.history", { ...f.key, limit: 200 });
  assert.notEqual(advanced.revision, latest.revision);
  assert.deepEqual(advanced.messages.slice(0, ids.length).map(message => message.id), ids);
  assert.deepEqual(await f.client.call("session.history", { ...f.key, revision: latest.revision, limit: 4 }), latest);
  await f.client.call("session.close", f.key);
  await f.reopen();
  assert.equal((await f.client.call("session.get", f.key)).runtime, "unloaded");
  assert.deepEqual(await f.client.call("session.history", { ...f.key, revision: latest.revision, limit: 4 }), latest);
  assert.deepEqual(await f.client.call("session.history", { ...f.key, revision: latest.revision, around: ids[2]!, limit: 3 }), deep);
  assert.equal(f.faux.state.callCount, 1);
});

test("原交流历史保留压缩前正文和上下文编辑前内容，读取不改 SDK 文件或分支", async (t) => {
  let original = "", recent = "", custom = "", summary = "";
  const f = await fixture(t, manager => {
    original = manager.appendMessage({ role: "user", content: "原始问题\n保留😀正文", timestamp: 1 });
    manager.appendMessage(fauxAssistantMessage("压缩前回复", { timestamp: 2 }));
    custom = manager.appendCustomMessageEntry("fixture.background", "原背景正文", true);
    recent = manager.appendMessage({ role: "user", content: "保留段问题", timestamp: 3 });
    manager.appendMessage(fauxAssistantMessage("保留段回复", { timestamp: 4 }));
    summary = manager.appendCompaction("真实 SDK 压缩条目的摘要", recent, 100);
    manager.appendContextEdit(original, null);
    manager.appendContextEdit(recent, { content: "只替换模型工作视图" });
  });
  const bytes = await readFile(f.file);
  const leaf = f.manager.getLeafId();
  const history = await f.client.call("session.history", f.key);
  assert.equal(textOf(history.messages.find(message => message.id === original)!), "原始问题\n保留😀正文");
  assert.equal(textOf(history.messages.find(message => message.id === recent)!), "保留段问题");
  assert.equal(textOf(history.messages.find(message => message.id === custom)!), "原背景正文");
  assert.equal(textOf(history.messages.find(message => message.id === summary)!), "真实 SDK 压缩条目的摘要");
  assert.equal(history.messages.length, 6);
  const modelText = JSON.stringify(f.manager.buildSessionContext().messages);
  assert(!modelText.includes("原始问题"));
  assert(modelText.includes("只替换模型工作视图"));
  const located = await f.client.call("session.history", { ...f.key, revision: history.revision, around: original, limit: 1 });
  assert.equal(located.messages[0]?.id, original);
  assert.equal((await f.client.call("session.get", f.key)).runtime, "unloaded");
  assert.equal(f.faux.state.callCount, 0);
  assert.equal(f.manager.getLeafId(), leaf);
  assert.deepEqual(await readFile(f.file), bytes);
});

test("空历史有冻结修订，消息和修订不能跨会话或未打开空间使用", async (t) => {
  let messageId = "";
  const f = await fixture(t, manager => {
    messageId = manager.appendMessage({ role: "user", content: "原会话的问题", timestamp: 1 });
    manager.appendMessage(fauxAssistantMessage("原会话回复", { timestamp: 2 }));
  });
  const original = await f.client.call("session.history", f.key);
  const other = await f.client.call("session.create", { spaceId: f.key.spaceId });
  const otherKey = { spaceId: f.key.spaceId, sessionId: other.sessionId };
  const empty = await f.client.call("session.history", otherKey);
  assert.equal(typeof empty.revision, "string");
  assert.deepEqual(empty.messages, []);
  await f.send(otherKey, "空历史之后的输入");
  assert.deepEqual(await f.client.call("session.history", { ...otherKey, revision: empty.revision }), empty);
  await assert.rejects(f.client.call("session.history", { ...otherKey, revision: original.revision }), fault("revision_unavailable"));
  await assert.rejects(f.client.call("session.history", { ...otherKey, around: messageId }), fault("invalid_cursor"));
  await assert.rejects(f.client.call("session.history", { ...f.key, revision: `${original.revision}-missing` }), fault("revision_unavailable"));
  const unrelated = await f.client.call("space.open", { path: path.join(f.root, "unrelated-space") });
  await f.client.call("session.create", { spaceId: unrelated.id });
  await assert.rejects(f.client.call("session.history", { ...f.key, spaceId: unrelated.id }), fault("not_found"));
  await assert.rejects(f.client.call("session.history", { ...f.key, spaceId: randomUUID() }), fault("not_found"));
  await assert.rejects(f.client.call("session.history", { ...f.key, sessionId: randomUUID() }), fault("not_found"));
  await assert.rejects(f.client.call("session.history", { ...f.key, before: messageId, around: messageId }),
    (error: unknown) => error instanceof RpcError && error.code === -32602);
  assert.throws(() => f.application.history({ ...f.key, before: messageId, around: messageId }),
    (error: unknown) => error instanceof RepaFault && error.code === "invalid_input");
  await f.reopen();
  assert.deepEqual(await f.client.call("session.history", { ...otherKey, revision: empty.revision }), empty);
});

test("含图历史重复读取和搜索不重新保存旧图，新增图片与独立分支仍建立各自资源持有", async (t) => {
  const pinned: { owner: string; resource: ResourceRef }[] = [];
  const pinBytes = ResourceRetention.prototype.pinBytes;
  t.mock.method(ResourceRetention.prototype, "pinBytes", function (this: ResourceRetention,
    ...args: Parameters<ResourceRetention["pinBytes"]>) {
    const resource = pinBytes.apply(this, args);
    pinned.push({ owner: args[0], resource });
    return resource;
  });
  const original = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const f = await fixture(t, manager => {
    manager.appendMessage({ role: "user", content: [
      { type: "text", text: "历史图片的文字证据" },
      { type: "image", mimeType: "image/png", data: original.toString("base64") },
    ], timestamp: 1 });
    manager.appendMessage(fauxAssistantMessage("已保存图片", { timestamp: 2 }));
    manager.appendThinkingLevelChange("off");
  });
  const owner = `session:${f.key.sessionId}`;
  const first = await f.client.call("session.history", f.key);
  const image = first.messages[0]?.content.find(block => block.type === "resource");
  assert(image?.type === "resource");
  assert.equal(pinned.filter(item => item.owner === owner).length, 1);
  for (let index = 0; index < 3; index++) {
    assert.deepEqual(await f.client.call("session.history", { ...f.key, revision: first.revision }), first);
    await f.client.call("session.history", { ...f.key, around: first.messages[0]!.id, limit: 1 });
  }
  const accepted = await f.client.call("capability.invoke", {
    scope: { kind: "space", spaceId: f.key.spaceId }, requestId: randomUUID(),
    contract: { id: "repa.search.history", version: "1" },
    input: { sessionId: f.key.sessionId, pattern: "文字证据", literal: true },
  });
  assert.equal(accepted.kind, "background");
  if (accepted.kind !== "background") assert.fail("历史搜索应通过后台请求受理");
  const deadline = Date.now() + 10000;
  for (;;) {
    const request: Result<"request.get"> = await f.client.call("request.get", { spaceId: f.key.spaceId, requestId: accepted.request.requestId });
    if (["completed", "failed", "cancelled", "interrupted"].includes(request.status)) {
      assert.equal(request.status, "completed", JSON.stringify(request));
      break;
    }
    if (Date.now() >= deadline) assert.fail(`等待搜索完成超时：${JSON.stringify(request)}`);
    await delay(10);
  }
  assert.equal(pinned.filter(item => item.owner === owner).length, 1);
  assert.equal(f.faux.state.callCount, 0);

  const nextImage = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==", "base64");
  const uploaded = await f.client.uploadResource(f.key.spaceId, nextImage, "image/png");
  await f.send(f.key, "新图片继续交流", uploaded.resource);
  const advanced = await f.client.call("session.history", f.key);
  assert(advanced.messages.some(message => message.content.some(block => block.type === "resource" && block.resource.id === uploaded.resource.id)));
  assert(pinned.some(item => item.owner === owner && item.resource.id === uploaded.resource.id));
  assert.equal(pinned.filter(item => item.owner === owner && item.resource.id === image.resource.id).length, 1);
  const afterAppend = pinned.length;
  assert.deepEqual(await f.client.call("session.history", f.key), advanced);
  assert.deepEqual(await f.client.call("session.history", { ...f.key, revision: first.revision }), first);
  assert.equal(pinned.length, afterAppend);

  const branch = await f.client.call("session.branch", { ...f.key, messageId: first.messages.at(-1)!.id });
  assert.equal(pinned.filter(item => item.owner === `session:${branch.sessionId}` && item.resource.id === image.resource.id).length, 1);
  await f.client.call("session.remove", f.key);
  await f.client.call("resource.collect", { spaceId: f.key.spaceId });
  assert.deepEqual(Buffer.from(await (await f.client.resource(image.resource)).arrayBuffer()), original);
  await f.client.call("session.remove", { spaceId: f.key.spaceId, sessionId: branch.sessionId });
  await f.client.call("resource.collect", { spaceId: f.key.spaceId });
  await assert.rejects(f.client.resource(image.resource));
});

test("会话内复用的不可变条目投影不泄露给可修改的历史快照", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-session-projection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionDirectory = path.join(root, ".repa", "sessions");
  await mkdir(sessionDirectory, { recursive: true });
  const manager = SessionManager.create(root, sessionDirectory);
  manager.appendMessage({ role: "user", content: "不可变的原文", timestamp: 1 });
  manager.appendMessage(fauxAssistantMessage("保存的回复", { timestamp: 2 }));
  const content = await ContentStore.open({ root, spaceId: randomUUID(), assertOwned() {} });
  const sessions = new PiSessionStore(root, content.retention);
  const [stored] = await sessions.list();
  assert(stored);
  const expected = stored.snapshot();
  const exposed = stored.snapshot();
  const block = exposed.messages[0]?.content[0];
  assert(block?.type === "text");
  block.text = "调用方的可变状态";
  exposed.messages.splice(1);
  assert.deepEqual(stored.snapshot(), expected);
  assert.equal(textOf(stored.snapshot().messages[0]!), "不可变的原文");
});
