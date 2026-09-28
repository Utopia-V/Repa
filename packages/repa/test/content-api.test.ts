import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { RepaClient, RpcError } from "../src/client.js";
import { startRepaServer } from "../src/server.js";
import type { ContentTarget, Change } from "../src/protocol.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-content-api-"));
  const server = await startRepaServer({ appDirectory: path.join(root, "app") });
  const client = await RepaClient.connect(server.connection);
  const servers = [server], clients = [client];
  const space = await client.call("space.open", { path: path.join(root, "space") });
  t.after(async () => {
    for (const entry of servers) await entry.close();
    for (const entry of clients) await entry.close();
    await rm(root, { recursive: true, force: true });
  });
  const target = (file: string): ContentTarget => ({ kind: "file", spaceId: space.id, location: { kind: "relative", path: file } });
  return { root, server, client, space, target, track: (value: typeof server, connection?: RepaClient) => {
    servers.push(value); if (connection) clients.push(connection);
  } };
}
const code = (expected: string) => (error: unknown) => error instanceof RpcError && (error.data as { code?: string })?.code === expected;

test("两个客户端通过同一内容入口保存、撤回、查询并得到完整操作批次", async (t) => {
  const f = await fixture(t);
  const other = await RepaClient.connect(f.server.connection);
  t.after(() => other.close());
  const changes: Change[] = [];
  await other.watch({ spaceId: f.space.id }, (_snapshot, delivery) => {
    if (delivery.type === "changes") changes.push(...delivery.changes);
  });
  const operationId = randomUUID();
  const input = { spaceId: f.space.id, operationId,
    patch: "*** Begin Patch\n*** Add File: lessons/a.md\n+第一课\n*** Add File: lessons/code.py\n+print(1)\n*** End Patch" };
  const created = await f.client.call("content.applyPatch", input);
  assert.equal(created.changes.length, 2);
  assert.deepEqual(await other.call("content.applyPatch", input), created);
  assert.equal((await other.call("operation.get", { spaceId: f.space.id, operationId })).status, "committed");
  await assert.rejects(other.call("content.applyPatch", { ...input, patch: input.patch.replace("第一课", "第二课") }), code("operation_id_conflict"));
  const read = await f.client.readText(f.target("lessons/a.md"));
  assert.equal(read.text, "第一课\n");
  const competing = await Promise.allSettled(["甲", "乙"].map((text) => other.call("content.write", {
    target: read.content.target, base: read.content.bodyRevision!, operationId: randomUUID(), value: { kind: "text", text },
  })));
  assert.equal(competing.filter((result) => result.status === "fulfilled").length, 1);
  const conflict = competing.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert(code("revision_conflict")(conflict.reason));
  assert((conflict.reason as RpcError).data && "details" in ((conflict.reason as RpcError).data as object));
  const batches = changes.filter((entry) => entry.type === "content" && entry.result?.operationId === operationId);
  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.type === "content" && batches[0].result?.changes.length, 2);
  assert.equal((await other.call("content.list", { spaceId: f.space.id, path: "lessons" })).length, 2);
  assert.equal((await other.call("operation.get", { spaceId: f.space.id, operationId: "unknown" })).status, "unknown");
});

test("截断预览与完整编辑正文共享不可变版本，二进制资源按空间读取并跨重开保留", async (t) => {
  const f = await fixture(t);
  const text = "甲".repeat(60000) + "\r\n尾部\r\n";
  const saved = await f.client.call("content.write", { target: f.target("large.md"), operationId: randomUUID(), base: { kind: "absent" }, value: { kind: "text", text } });
  const read = await f.client.call("content.read", { target: f.target("large.md") });
  assert.equal(read.truncated, true);
  assert.equal(read.text, undefined);
  assert.deepEqual(await f.client.readText(f.target("large.md")), { content: read.content, text });
  assert.equal(read.content.bodyRevision, saved.changes[0]?.after);
  const { resource } = await f.client.uploadResource(f.space.id, new Uint8Array([0, 255, 1, 2, 3]), "application/octet-stream");
  await f.client.call("content.write", { target: f.target("data.bin"), operationId: randomUUID(), base: { kind: "absent" }, value: { kind: "resource", resource } });
  assert.deepEqual([...await readFile(path.join(f.space.path, "data.bin"))], [0, 255, 1, 2, 3]);
  const range = await f.client.resource(resource, "bytes=1-2");
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), "bytes 1-2/5");
  assert.deepEqual([...new Uint8Array(await range.arrayBuffer())], [255, 1]);
  await assert.rejects(f.client.resource({ ...resource, spaceId: "other-space" }));
  await f.server.close();
  const reopened = await startRepaServer({ appDirectory: path.join(f.root, "app") });
  const client = await RepaClient.connect(reopened.connection);
  f.track(reopened, client);
  await client.call("space.open", { path: f.space.path });
  assert.deepEqual([...new Uint8Array(await (await client.resource(resource)).arrayBuffer())], [0, 255, 1, 2, 3]);
});

test("外部材料明确关联后可读取，默认引用原件，移除关联保留原件", async (t) => {
  const f = await fixture(t);
  const original = path.join(f.root, "book.txt");
  await writeFile(original, "教材原文");
  const target: ContentTarget = { kind: "file", spaceId: f.space.id, location: { kind: "external", path: original } };
  await assert.rejects(f.client.call("content.read", { target }), code("permission_required"));
  const associated = await f.client.call("content.associate", { spaceId: f.space.id, location: target.location, role: "material", operationId: randomUUID() });
  const content = associated.contents[0]!;
  assert.equal(content.location.kind, "external");
  const opened = await f.client.readText(content.target);
  assert.equal(opened.text, "教材原文");
  await assert.rejects(f.client.call("content.write", { target: content.target, base: opened.content.bodyRevision!, operationId: randomUUID(), value: { kind: "text", text: "改写" } }), code("permission_required"));
  await f.client.call("content.remove", { target: content.target, base: content.revision!, detach: true, operationId: randomUUID() });
  assert.equal(await readFile(original, "utf8"), "教材原文");
  await assert.rejects(f.client.call("content.read", { target: content.target }), code("not_found"));
});

test("提示覆盖和语境绑定通过公开协议独立保存，关闭自动注入仍可预览", async (t) => {
  const f = await fixture(t);
  await f.client.call("content.write", { target: f.target("context.md"), base: { kind: "absent" }, operationId: randomUUID(), value: { kind: "text", text: "正在学习体系结构" } });
  const associated = await f.client.call("content.associate", { spaceId: f.space.id, location: { kind: "relative", path: "context.md" }, role: "document", operationId: randomUUID() });
  const binding = await f.client.call("context.get", { spaceId: f.space.id });
  await f.client.call("context.set", { spaceId: f.space.id, base: binding.revision, operationId: randomUUID(), binding: { kind: "document", ref: associated.contents[0]!.ref! } });
  const scope = { kind: "space" as const, spaceId: f.space.id };
  let settings = await f.client.call("settings.get", { scope, namespace: "prompts" });
  const base = settings.entries.find((entry) => entry.key === "base")!;
  settings = await f.client.call("settings.set", { scope, namespace: "prompts", key: "base", base: base.revision, value: "" });
  assert.equal(settings.entries.find((entry) => entry.key === "base")?.effective, "");
  const context = settings.entries.find((entry) => entry.key === "learningContext")!;
  await f.client.call("settings.set", { scope, namespace: "prompts", key: "learningContext", base: context.revision, value: false });
  assert.equal((await f.client.call("context.preview", { spaceId: f.space.id })).text, "正在学习体系结构");
  assert.equal((await f.client.call("context.get", { spaceId: f.space.id })).binding?.kind, "document");
});

test("退出等待已进入应用的保存，释放空间锁后可重新确认实际结果", async (t) => {
  const f = await fixture(t);
  const operationId = randomUUID();
  const save = f.server.application.contentCall("content.write", { target: f.target("pending.md"), operationId, base: { kind: "absent" }, value: { kind: "text", text: "完整保存" } });
  const closed = f.server.close("drain");
  await save;
  await closed;
  const reopened = await startRepaServer({ appDirectory: path.join(f.root, "app") });
  f.track(reopened);
  const space = await reopened.application.openSpace(f.space.path);
  const result = await reopened.application.contentCall("operation.get", { spaceId: space.id, operationId }) as { status: string };
  assert.equal(result.status, "committed");
  assert.equal(await readFile(path.join(space.path, "pending.md"), "utf8"), "完整保存");
});

test("冲突的外部关联不提前授予另一文件权限", async (t) => {
  const f = await fixture(t);
  const first = path.join(f.root, "first.txt"), second = path.join(f.root, "second.txt");
  await writeFile(first, "first"); await writeFile(second, "second");
  const operationId = randomUUID();
  const results = await Promise.allSettled([first, second].map((file) => f.client.call("content.associate", {
    spaceId: f.space.id, operationId, role: "material", location: { kind: "external", path: file },
  })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const failed = results.findIndex((result) => result.status === "rejected");
  assert(code("operation_id_conflict")((results[failed] as PromiseRejectedResult).reason));
  await assert.rejects(f.client.call("content.read", { target: { kind: "file", spaceId: f.space.id,
    location: { kind: "external", path: [first, second][failed]! },
  } }), code("permission_required"));
});

test("资源受理复制输入字节，调用方后续修改不破坏不可变资源", async (t) => {
  const f = await fixture(t);
  const input = new Uint8Array([1, 2, 3]);
  const pending = f.server.application.uploadResource(f.space.id, input, "application/octet-stream");
  input[0] = 99;
  const { resource } = await pending;
  assert.deepEqual([...await f.server.application.contentResource(resource.spaceId, resource.id)], [1, 2, 3]);
});

test("空间内外部编辑触发查询失效，文件保存不启动 Agent", async (t) => {
  const f = await fixture(t);
  let resolve!: () => void, reject!: (error: Error) => void;
  const changed = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  await f.client.watch({ spaceId: f.space.id }, (_snapshot, delivery) => {
    if (delivery.type === "changes" && delivery.changes.some((entry) => entry.type === "content" && entry.paths.includes("external-edit.md"))) resolve();
  });
  const timeout = setTimeout(() => reject(new Error("没有收到实际文件变更通知")), 3000);
  try {
    await writeFile(path.join(f.space.path, "external-edit.md"), "外部编辑器保存");
    await changed;
  } finally { clearTimeout(timeout); }
  assert.equal((await f.client.readText(f.target("external-edit.md"))).text, "外部编辑器保存");
  assert.equal((await f.client.call("session.list", { spaceId: f.space.id })).length, 0);
});
