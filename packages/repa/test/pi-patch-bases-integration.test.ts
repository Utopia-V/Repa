import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { Static } from "typebox";
import { Check } from "typebox/value";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { PromptSettings } from "../src/configuration/schema.js";
import { ContentOperationSchema, ContentTargetSchema } from "../src/content/schema.js";
import { ContentStore } from "../src/content/store.js";
import { Resources } from "../src/messages.js";
import { PiConversationHost } from "../src/pi-host.js";
import { IdSchema, object, RevisionSchema } from "../src/schema.js";
import { digest } from "../src/storage/blobs.js";

const settings: PromptSettings = {
  base: "", append: [], projectInstructions: false, skillCatalog: false,
  environment: false, learningContext: false, fileChanges: "on-demand",
};
const ReadSnapshotSchema = object({ target: ContentTargetSchema, bodyRevision: RevisionSchema });
type ReadSnapshot = Static<typeof ReadSnapshotSchema>;
const snapshotPrefix = "[Repa content snapshot: ";
const original = "{\n  \"current\": null,\n  \"untouched\": \"original\"\n}\n";

function lastTool(context: TranscriptContext, name: string) {
  const result = context.messages.findLast(message => message.role === "toolResult" && message.toolName === name);
  assert(result?.role === "toolResult", `模型输入缺少 ${name} 工具结果`);
  return result;
}

function texts(context: TranscriptContext, name: string) {
  return lastTool(context, name).content.flatMap(part => part.type === "text" ? [part.text] : []);
}

function snapshot(context: TranscriptContext): ReadSnapshot {
  const blocks = texts(context, "read").filter(text => text.startsWith(snapshotPrefix));
  assert.equal(blocks.length, 1, "模型必须从独立文本块取得读取快照，而不是工具details");
  const block = blocks[0];
  assert(block && block.endsWith("]"));
  const parsed: unknown = JSON.parse(block.slice(snapshotPrefix.length, -1));
  assert(Check(ReadSnapshotSchema, parsed));
  return parsed;
}

function operationId(context: TranscriptContext) {
  const match = /^operationId: (\S+)$/m.exec(texts(context, "apply_patch").join("\n"));
  const id = match?.[1];
  assert(Check(IdSchema, id), "模型可见的保存结果或错误应携带操作标识");
  return id;
}

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-pi-patch-bases-"));
  const directory = path.join(root, "space");
  const agentDir = path.join(root, "agent");
  await mkdir(directory);
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: [], extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"],
    retry: { enabled: false }, compaction: { enabled: false },
  }));
  const content = await ContentStore.open({ root: directory, spaceId: randomUUID(), assertOwned() {} });
  const manager = SessionManager.inMemory(directory);
  const provider = fauxProvider({ api: `pi-patch-bases-${randomUUID()}`, provider: `pi-patch-bases-${randomUUID()}`,
    models: [{ id: "local", reasoning: false, input: ["text", "image"], contextWindow: 16384, maxTokens: 512 }],
    tokensPerSecond: 0 });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(provider.provider);
  const host = await PiConversationHost.open({ learnerSpace: directory, agentDir, sessionManager: manager,
    content, resources: new Resources(content.retention, `session:${manager.getSessionId()}`), trustExtensions: false,
    modelOverride: { modelRuntime, model: provider.getModel() }, onEvent() {}, ask: async () => null });
  t.after(async () => {
    await host.close();
    await content.settled();
    await rm(root, { recursive: true, force: true });
  });
  const send = (tools: string[]) => host.send("读取实际内容快照，使用明确正文基准保存，并查询操作结果。", settings,
    { requestId: randomUUID(), images: [], options: { tools } });
  return { directory, content, provider, send };
}

test("真实Pi从分页read文本取得完整正文基准，旧基准拒绝整组修改，重读后保存并查询实际操作", async t => {
  const f = await fixture(t);
  const file = path.join(f.directory, "current.json");
  await writeFile(file, original);
  const associated = await f.content.associate({ location: { kind: "relative", path: "current.json" },
    role: "document", operationId: randomUUID() });
  const current = associated.contents[0]?.ref;
  assert(current);
  const judgmentId = randomUUID();
  const patch = ["*** Begin Patch", "*** Add File: judgment.json", "+{\"result\":\"candidate\"}",
    "*** Update File: current.json", "@@", '-  "current": null,', `+  "current": "${judgmentId}",`, "*** End Patch"].join("\n");
  const registrations = [{ path: "judgment.json", role: "document", id: judgmentId }];
  const external = original.replace('"original"', '"external"');
  let first: ReadSnapshot | undefined;
  let second: ReadSnapshot | undefined;
  let failed: string | undefined;
  let saved: string | undefined;
  f.provider.setResponses([
    context => {
      assert.deepEqual(getCurrentSystemMessage(context.messages)?.toolsAdded?.map(tool => tool.name).sort(),
        ["apply_patch", "content_operation", "read"]);
      return call("read", { path: "current.json", limit: 2 });
    },
    async context => {
      first = snapshot(context);
      assert.deepEqual(first.target, { kind: "content", ref: current });
      assert.equal(first.bodyRevision, digest(original), "分页返回整个正文版本，不是可见片段版本");
      const body = texts(context, "read").filter(text => !text.startsWith(snapshotPrefix)).join("\n");
      assert.match(body, /"current": null/u);
      assert.doesNotMatch(body, /"untouched"/u);
      await writeFile(file, external);
      return call("apply_patch", { patch, registrations, bases: [{ target: first.target, base: first.bodyRevision }] });
    },
    async context => {
      assert.equal(lastTool(context, "apply_patch").isError, true);
      failed = operationId(context);
      assert.equal(await readFile(file, "utf8"), external);
      await assert.rejects(readFile(path.join(f.directory, "judgment.json")), { code: "ENOENT" });
      assert.equal((await f.content.operation(failed)).status, "unknown");
      return call("content_operation", { action: "get", operationId: failed });
    },
    context => {
      assert(failed && first?.target.kind === "content");
      const value: unknown = JSON.parse(texts(context, "content_operation").join("\n"));
      assert.deepEqual(value, { operationId: failed, status: "unknown" });
      return call("read", { path: `repa:document/${first.target.ref.id}`, offset: 2, limit: 1 });
    },
    context => {
      assert(first);
      second = snapshot(context);
      assert.deepEqual(second.target, first.target);
      assert.equal(second.bodyRevision, digest(external));
      assert.notEqual(second.bodyRevision, first.bodyRevision);
      const body = texts(context, "read").filter(text => !text.startsWith(snapshotPrefix)).join("\n");
      assert.match(body, /"current": null/u);
      assert.doesNotMatch(body, /"external"/u);
      return call("apply_patch", { patch, registrations, bases: [{ target: second.target, base: second.bodyRevision }] });
    },
    context => {
      assert.equal(lastTool(context, "apply_patch").isError, false);
      saved = operationId(context);
      assert.notEqual(saved, failed);
      return call("content_operation", { action: "get", operationId: saved });
    },
    context => {
      const value: unknown = JSON.parse(texts(context, "content_operation").join("\n"));
      assert(Check(ContentOperationSchema, value));
      assert.equal(value.status, "committed");
      assert.equal(value.operationId, saved);
      assert.deepEqual(value.result?.changes.map(change => change.path).sort(), ["current.json", "judgment.json"]);
      return fauxAssistantMessage("已用重读取得的完整正文版本保存，并确认操作完成。");
    },
  ]);
  assert.deepEqual(await f.send(["read", "apply_patch", "content_operation"]), { status: "completed" });
  assert.equal(f.provider.state.callCount, 7);
  assert(first && second && saved && failed);
  assert.equal(await readFile(file, "utf8"), external.replace('"current": null', `"current": "${judgmentId}"`));
  assert.equal(await readFile(path.join(f.directory, "judgment.json"), "utf8"), "{\"result\":\"candidate\"}\n");
  assert.deepEqual((await f.content.get({ kind: "content", ref: { spaceId: current.spaceId, id: judgmentId } })).ref,
    { spaceId: current.spaceId, id: judgmentId });
  assert.equal((await f.content.operation(saved)).status, "committed");
});

test("真实Pi文件read保留图像块并另附快照文本，不可变resource读取不冒充文件正文基准", async t => {
  const f = await fixture(t);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await writeFile(path.join(f.directory, "pixel.png"), png);
  const resourceId = await f.content.blobs.put("不可变资源原文\n");
  f.provider.setResponses([
    call("read", { path: "pixel.png" }),
    context => {
      const result = lastTool(context, "read");
      const image = result.content.find(part => part.type === "image");
      assert(image?.type === "image");
      assert.equal(image.mimeType, "image/png");
      assert(image.data.length > 0);
      assert.equal(result.content.at(-1)?.type, "text");
      const metadata = snapshot(context);
      assert.deepEqual(metadata.target, f.content.target("pixel.png"));
      assert.equal(metadata.bodyRevision, digest(png));
      return call("read", { path: `repa:resource/${resourceId}` });
    },
    context => {
      const blocks = texts(context, "read");
      assert.equal(blocks.some(text => text.startsWith(snapshotPrefix)), false);
      assert(blocks.join("\n").includes("不可变资源原文"));
      return fauxAssistantMessage("图像内容与读取快照分别取得，资源读取保持原通道。");
    },
  ]);
  assert.deepEqual(await f.send(["read"]), { status: "completed" });
  assert.equal(f.provider.state.callCount, 3);
});
