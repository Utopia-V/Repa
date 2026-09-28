import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { startRepaServer, type ServerOptions } from "../src/server.js";
import { RepaClient, RpcError } from "../src/client.js";
import type { ContentTarget } from "../src/protocol.js";

const code = (expected: string) => (error: unknown) => error instanceof RpcError && (error.data as { code?: string })?.code === expected;
async function fixture(t: TestContext, options: ServerOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-space-snapshot-"));
  const server = await startRepaServer({ appDirectory: path.join(root, "app"), ...options });
  const client = await RepaClient.connect(server.connection);
  const space = await client.call("space.open", { path: path.join(root, "space") });
  t.after(async () => { await server.close(); await client.close(); await rm(root, { recursive: true, force: true }); });
  const target = (file: string): ContentTarget => ({ kind: "file", spaceId: space.id, location: { kind: "relative", path: file } });
  const create = async (file: string, text: string) => {
    await client.call("content.write", { target: target(file), base: { kind: "absent" }, operationId: randomUUID(), value: { kind: "text", text } });
    return (await client.call("content.associate", { spaceId: space.id, location: { kind: "relative", path: file }, role: "document", operationId: randomUUID() })).contents[0]!;
  };
  return { root, server, client, space, target, create };
}

test("空间独立复制保留本地身份，映射组成、语境和历史；副本撤回不改变原空间", async t => {
  const f = await fixture(t);
  const goal = await f.create("goal.md", "before");
  const operationId = randomUUID();
  await f.client.call("content.edit", { target: goal.target, operationId, edits: [{ oldText: "before", newText: "after" }] });
  let composition = await f.create("context.json", JSON.stringify({ items: [{ ref: goal.ref!, mode: "expand" }] }));
  const { resource } = await f.client.uploadResource(f.space.id, Buffer.from("attachment"), "text/plain");
  composition = (await f.client.call("content.setComposition", { ref: composition.ref!, base: composition.revision!, operationId: randomUUID(), members: [{ target: goal.target }], resources: [resource] })).contents[0]!;
  const context = await f.client.call("context.get", { spaceId: f.space.id });
  await f.client.call("context.set", { spaceId: f.space.id, base: context.revision, operationId: randomUUID(), binding: { kind: "composition", ref: composition.ref! } });
  const input = { spaceId: f.space.id, destination: path.join(f.root, "copy"), operationId: randomUUID() };
  const copied = await f.client.call("space.copy", input);
  assert.equal(copied.status, "completed", copied.error?.message);
  assert.notEqual(copied.spaceId, f.space.id);
  assert.deepEqual(await f.client.call("space.copy", input), copied);
  const space = await f.client.call("space.open", { path: copied.destination });
  assert.equal(space.id, copied.spaceId);
  assert.equal((await f.client.call("context.preview", { spaceId: space.id })).text, `## ${goal.ref!.id}\nafter`);
  const copiedComposition = await f.client.call("content.get", { target: { kind: "content", ref: { ...composition.ref!, spaceId: space.id } } });
  assert.equal(copiedComposition.resources[0]!.spaceId, space.id);
  assert.deepEqual(copiedComposition.members[0]!.target, { kind: "content", ref: { ...goal.ref!, spaceId: space.id } });
  await f.client.call("operation.undo", { spaceId: space.id, operationId, undoOperationId: randomUUID() });
  assert.equal((await f.client.call("context.preview", { spaceId: space.id })).text, `## ${goal.ref!.id}\nbefore`);
  assert.equal((await f.client.call("context.preview", { spaceId: f.space.id })).text, `## ${goal.ref!.id}\nafter`);
  assert.equal(await (await f.client.resource({ ...resource, spaceId: space.id })).text(), "attachment");
});

test("备份和恢复保存文件、历史、外部依赖与 SQLite owner 的一致快照", async t => {
  const f = await fixture(t, { snapshotParticipants: [{ id: "review", version: "1", directory: ".repa/plugins/review",
    async capture({ sourceDirectory, destinationDirectory, sourceSpaceId, targetSpaceId }) {
      const db = new DatabaseSync(path.join(sourceDirectory, "review.sqlite"));
      try { db.prepare("VACUUM INTO ?").run(path.join(destinationDirectory, "review.sqlite")); } finally { db.close(); }
      const copy = new DatabaseSync(path.join(destinationDirectory, "review.sqlite"));
      try { copy.prepare("UPDATE cards SET space = ? WHERE space = ?").run(targetSpaceId, sourceSpaceId); } finally { copy.close(); }
    } }] });
  const directory = path.join(f.space.path, ".repa/plugins/review"); await mkdir(directory, { recursive: true });
  const db = new DatabaseSync(path.join(directory, "review.sqlite"));
  t.after(() => db.close());
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE cards(space TEXT, due INTEGER)");
  db.prepare("INSERT INTO cards VALUES (?, ?)").run(f.space.id, 42);
  const doc = await f.create("notes/answer.md", "saved");
  const external = path.join(f.root, "outside.pdf"); await writeFile(external, "external");
  await f.client.call("content.associate", { spaceId: f.space.id, location: { kind: "external", path: external }, role: "material", operationId: randomUUID() });
  await symlink("notes/answer.md", path.join(f.space.path, "shortcut"));
  const backup = await f.client.call("space.backup", { spaceId: f.space.id, destination: path.join(f.root, "backup"), operationId: randomUUID() });
  assert.equal(backup.status, "completed", backup.error?.message);
  assert.deepEqual(backup.externalDependencies, [{ kind: "external", path: external }]);
  assert.equal(backup.participants[0]!.id, "review");
  await assert.rejects(f.client.call("space.open", { path: backup.destination }), code("snapshot_requires_restore"));
  await writeFile(path.join(f.space.path, "notes/answer.md"), "later");
  const restored = await f.client.call("space.restore", { source: backup.destination, destination: path.join(f.root, "restored"), operationId: randomUUID() });
  assert.equal(restored.status, "completed", restored.error?.message);
  assert.equal(restored.spaceId, f.space.id);
  await rm(backup.destination, { recursive: true });
  assert.deepEqual(await f.client.call("space.restore", { source: backup.destination, destination: restored.destination, operationId: restored.operationId }), restored);
  assert.equal(await readFile(path.join(restored.destination, "shortcut"), "utf8"), "saved");
  const savedDB = new DatabaseSync(path.join(restored.destination, ".repa/plugins/review/review.sqlite"));
  try { assert.deepEqual({ ...savedDB.prepare("SELECT * FROM cards").get() }, { space: f.space.id, due: 42 }); } finally { savedDB.close(); }
  const copied = await f.client.call("space.copy", { spaceId: f.space.id, destination: path.join(f.root, "independent"), operationId: randomUUID() });
  assert.equal(copied.status, "completed", copied.error?.message);
  const copiedDB = new DatabaseSync(path.join(copied.destination, ".repa/plugins/review/review.sqlite"));
  try { assert.equal(copiedDB.prepare("SELECT * FROM cards").get()!.space, copied.spaceId); } finally { copiedDB.close(); }
  await f.server.close();
  const reopened = await startRepaServer({ appDirectory: path.join(f.root, "app") });
  const client = await RepaClient.connect(reopened.connection);
  t.after(async () => { await reopened.close(); await client.close(); });
  await client.call("space.open", { path: restored.destination });
  assert.equal((await client.readText(doc.target)).text, "saved");
});

test("快照占用期间拒绝新写入，未知数据 owner 和外部并发变化留下明确失败结果", async t => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, { snapshotParticipants: [{ id: "gated", version: "1", directory: ".repa/gated", async capture() { entered(); await gate; } }] });
  await f.create("a.txt", "original"); await mkdir(path.join(f.space.path, ".repa/gated"));
  const input = { spaceId: f.space.id, destination: path.join(f.root, "copy"), operationId: randomUUID() };
  const pending = f.client.call("space.copy", input);
  await started;
  try {
    const observer = await startRepaServer({ appDirectory: path.join(f.root, "app") });
    const connection = await RepaClient.connect(observer.connection);
    try { assert.equal((await connection.call("space.operation.get", { operationId: input.operationId })).status, "prepared"); }
    finally { await observer.close(); await connection.close(); }
    await assert.rejects(f.client.call("content.edit", { target: f.target("a.txt"), operationId: randomUUID(), edits: [{ oldText: "original", newText: "blocked" }] }), code("space_busy"));
    await assert.rejects(f.client.call("session.create", { spaceId: f.space.id }), code("space_busy"));
    await writeFile(path.join(f.space.path, "a.txt"), "external change");
  } finally { release(); }
  const result = await pending;
  assert.equal(result.status, "failed"); assert.equal(result.error?.code, "revision_conflict");
  assert.deepEqual(await f.client.call("space.operation.get", { operationId: input.operationId }), result);
  assert.deepEqual(await f.client.call("space.copy", input), result);
  assert(! (await readdir(f.root)).some(name => name.startsWith(".repa-space-")));
  await mkdir(path.join(f.space.path, ".repa/unknown-db"));
  const unknown = await f.client.call("space.backup", { ...input, operationId: randomUUID() });
  assert.equal(unknown.error?.code, "snapshot_owner_unavailable");
});

test("发布后回执中断可恢复结果；恢复校验拒绝被修改的备份", async t => {
  const f = await fixture(t); await f.create("a.txt", "snapshot");
  const backup = await f.client.call("space.backup", { spaceId: f.space.id, destination: path.join(f.root, "backup"), operationId: randomUUID() });
  assert.equal(backup.status, "completed", backup.error?.message);
  const receiptPath = path.join(f.root, "app/space-operations", `${backup.operationId}.json`);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")); receipt.result.status = "prepared";
  await writeFile(receiptPath, JSON.stringify(receipt));
  assert.deepEqual(await f.client.call("space.operation.get", { operationId: backup.operationId }), backup);
  await writeFile(path.join(backup.destination, "data/a.txt"), "corrupt");
  const restored = await f.client.call("space.restore", { source: backup.destination, destination: path.join(f.root, "restored"), operationId: randomUUID() });
  assert.equal(restored.error?.code, "invalid_snapshot");
  assert.equal((await f.client.readText(f.target("a.txt"))).text, "snapshot");
  const manifestPath = path.join(backup.destination, ".repa-snapshot.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.entries.find((entry: { path: string }) => entry.path === "a.txt").path = "../outside.txt";
  await writeFile(manifestPath, JSON.stringify(manifest));
  const outside = path.join(f.root, "outside.txt"); await writeFile(outside, "untouched");
  await assert.rejects(f.client.call("space.restore", { source: backup.destination, destination: path.join(f.root, "escaped"), operationId: randomUUID() }), code("invalid_snapshot"));
  assert.equal(await readFile(outside, "utf8"), "untouched");
});
