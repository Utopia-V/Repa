import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ContentStore } from "../src/content/store.js";
import { RepaFault } from "../src/errors.js";
import type { ContentRef } from "../src/content/schema.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-content-"));
  const spaceId = randomUUID();
  const open = () => ContentStore.open({ root, spaceId, assertOwned() {} });
  const store = await open();
  t.after(async () => { await store.settled(); await rm(root, { recursive: true, force: true }); });
  const create = (name: string, text: string) => store.write({ target: store.target(name), value: { kind: "text", text }, base: { kind: "absent" }, operationId: randomUUID() });
  const register = async (name: string): Promise<ContentRef> => {
    const result = await store.associate({ location: { kind: "relative", path: name }, role: "document", operationId: randomUUID() });
    return result.contents[0]!.ref!;
  };
  return { root, spaceId, store, open, create, register };
}
const code = (expected: string) => (error: unknown): boolean => error instanceof RepaFault && error.code === expected;

test("实际保存、版本保护、重复请求与重开共用内容操作", async (t) => {
  const f = await fixture(t);
  await f.create("notes/intro.md", "初始内容\r\n");
  const target = f.store.target("notes/intro.md");
  const first = await f.store.read({ target });
  assert.equal(first.text, "初始内容\r\n");
  const operationId = randomUUID();
  const input = { target, value: { kind: "text" as const, text: "已保存\r\n" }, base: first.content.bodyRevision!, operationId };
  const saved = await f.store.write(input);
  assert.equal(await readFile(path.join(f.root, "notes/intro.md"), "utf8"), "已保存\r\n");
  assert.deepEqual(await f.store.write(input), saved);
  await assert.rejects(f.store.write({ ...input, value: { kind: "text", text: "另一个输入" } }), code("operation_id_conflict"));
  await assert.rejects(f.store.write({ ...input, operationId: randomUUID(), value: { kind: "text", text: "旧草稿" } }), code("revision_conflict"));
  const reopened = await f.open();
  assert.deepEqual(await reopened.write(input), saved);
  assert.equal((await reopened.read({ target })).text, "已保存\r\n");
});

test("两个入口保存同一基准只允许一个成功，独立位置仍可继续", async (t) => {
  const f = await fixture(t);
  await f.create("shared.txt", "base");
  const target = f.store.target("shared.txt");
  const base = (await f.store.read({ target })).content.bodyRevision!;
  const results = await Promise.allSettled(["first", "second"].map((text) => f.store.write({ target, base, value: { kind: "text", text }, operationId: randomUUID() })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.ok(code("revision_conflict")(failed.reason));
  await f.create("other.txt", "independent");
  assert.equal((await f.store.read({ target: f.store.target("other.txt") })).text, "independent");
});

test("文件补丁、身份移动与删除后同路径重建保留各自身份", async (t) => {
  const f = await fixture(t);
  await f.create("old.md", "标题\r\n公式 x²；值 old\n结尾\r\n");
  const ref = await f.register("old.md");
  await f.store.applyPatch({ operationId: randomUUID(), patch: "*** Begin Patch\n*** Update File: old.md\n*** Move to: moved.md\n@@\n 标题\n-公式 x²；值 old\n+公式 x²；值 new\n 结尾\n*** End Patch" });
  assert.equal((await f.store.read({ target: { kind: "content", ref } })).text, "标题\r\n公式 x²；值 new\n结尾\r\n");
  assert.equal((await f.store.get({ kind: "content", ref })).location.path, "moved.md");
  await f.store.applyPatch({ operationId: randomUUID(), patch: "*** Begin Patch\n*** Delete File: moved.md\n*** End Patch" });
  await f.create("moved.md", "另一份内容");
  assert.equal((await f.store.get({ kind: "content", ref })).status, "missing");
  const next = await f.register("moved.md");
  assert.notEqual(next.id, ref.id);
  assert.equal((await f.store.read({ target: { kind: "content", ref: next } })).text, "另一份内容");
});

test("一次多文件补丁先全部验证，实际写入失败会恢复已经写入的文件", async (t) => {
  const f = await fixture(t);
  await f.create("a.txt", "old-a\n");
  await f.create("blocked/b.txt", "old-b\n");
  await assert.rejects(f.store.applyPatch({ operationId: randomUUID(), patch: "*** Begin Patch\n*** Update File: a.txt\n@@\n-old-a\n+new-a\n*** Update File: missing.txt\n@@\n-no\n+yes\n*** End Patch" }), code("not_found"));
  assert.equal(await readFile(path.join(f.root, "a.txt"), "utf8"), "old-a\n");
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  const blocked = path.join(f.root, "blocked");
  const operationId = randomUUID();
  await chmod(blocked, 0o500);
  try {
    await assert.rejects(f.store.applyPatch({ operationId, patch: "*** Begin Patch\n*** Update File: a.txt\n@@\n-old-a\n+new-a\n*** Update File: blocked/b.txt\n@@\n-old-b\n+new-b\n*** End Patch" }));
    assert.equal(await readFile(path.join(f.root, "a.txt"), "utf8"), "old-a\n");
    assert.equal(await readFile(path.join(f.root, "blocked/b.txt"), "utf8"), "old-b\n");
    assert.equal((await f.store.operation(operationId)).status, "rolled_back");
  } finally { await chmod(blocked, 0o700); }
});

test("中断恢复按实际文件核对，后续修改保留且无关内容可继续使用", async (t) => {
  const f = await fixture(t);
  await f.create("a.txt", "before-a");
  await f.create("b.txt", "before-b");
  const beforeA = await f.store.journal.image("a.txt");
  const beforeB = await f.store.journal.image("b.txt");
  assert.equal(beforeA.kind, "file"); assert.equal(beforeB.kind, "file");
  const afterA = { kind: "file" as const, hash: await f.store.blobs.put("after-a"), mode: 0o644 };
  const afterB = { kind: "file" as const, hash: await f.store.blobs.put("after-b"), mode: 0o644 };
  const interrupted = randomUUID();
  await f.store.journal.persist({ version: 1, operationId: interrupted, requestHash: "fixture", status: "prepared", createdAt: Date.now(), affectedIds: [], conflicts: [], result: { operationId: interrupted, changes: [], contents: [] }, files: [
    { path: "a.txt", before: beforeA, after: afterA }, { path: "b.txt", before: beforeB, after: afterB },
  ] });
  await writeFile(path.join(f.root, "a.txt"), "after-a");
  await writeFile(path.join(f.root, "b.txt"), "later-external");
  const reopened = await f.open();
  assert.equal((await reopened.operation(interrupted)).status, "needs_recovery");
  assert.equal((await reopened.read({ target: reopened.target("a.txt") })).text, "after-a");
  assert.equal((await reopened.read({ target: reopened.target("b.txt") })).text, "later-external");
  await reopened.write({ target: reopened.target("unrelated.md"), value: { kind: "text", text: "normal" }, base: { kind: "absent" }, operationId: randomUUID() });
  const failedPersist = t.mock.method(reopened.journal, "persist", async () => { throw new Error("模拟恢复确认落盘失败"); });
  await assert.rejects(reopened.reconcile(interrupted), /恢复确认落盘失败/);
  assert.equal((await reopened.operation(interrupted)).status, "needs_recovery");
  failedPersist.mock.restore();
  const repaired = await reopened.reconcile(interrupted);
  assert.equal(repaired.status, "reconciled");
  assert.ok(repaired.error);
  assert.equal((await reopened.get(reopened.target("a.txt"))).status, "available");
});

test("撤回保留可分离的后续文字与其他内容关系，重叠修改返回冲突", async (t) => {
  const f = await fixture(t);
  await f.create("a.md", "alpha = old\nbeta = old\n");
  const ref = await f.register("a.md");
  const operationId = randomUUID();
  await f.store.edit({ target: { kind: "content", ref }, edits: [{ oldText: "alpha = old", newText: "alpha = NEW" }], operationId });
  await writeFile(path.join(f.root, "a.md"), "alpha = NEW\nbeta = LATER\n");
  await f.create("b.md", "other");
  const other = await f.register("b.md");
  await f.store.undo({ operationId, undoOperationId: randomUUID() });
  assert.equal(await readFile(path.join(f.root, "a.md"), "utf8"), "alpha = old\nbeta = LATER\n");
  assert.equal((await f.store.get({ kind: "content", ref: other })).status, "available");
  const overlapping = randomUUID();
  await f.store.edit({ target: { kind: "content", ref }, edits: [{ oldText: "alpha = old", newText: "alpha = NEXT" }], operationId: overlapping });
  await writeFile(path.join(f.root, "a.md"), "alpha = USER\nbeta = LATER\n");
  await assert.rejects(f.store.undo({ operationId: overlapping, undoOperationId: randomUUID() }), code("revision_conflict"));
  assert.equal(await readFile(path.join(f.root, "a.md"), "utf8"), "alpha = USER\nbeta = LATER\n");
});

test("语境使用当前正文、有序组成和引用，清空与读取失败区分", async (t) => {
  const f = await fixture(t);
  await f.create("goals.md", "目标 A");
  const goal = await f.register("goals.md");
  let state = await f.store.context();
  await f.store.setContext({ binding: { kind: "document", ref: goal }, base: state.revision, operationId: randomUUID() });
  assert.equal((await f.store.contextView()).text, "目标 A");
  await writeFile(path.join(f.root, "goals.md"), "目标 B");
  assert.equal((await f.store.contextView()).text, "目标 B");
  await f.create("context.json", JSON.stringify({ items: [ { title: "计划", items: [{ ref: goal, mode: "expand", title: "目标" }] }, { ref: goal, mode: "reference", title: "来源" } ] }));
  const composition = await f.register("context.json");
  state = await f.store.context();
  await f.store.setContext({ binding: { kind: "composition", ref: composition }, base: state.revision, operationId: randomUUID() });
  const view = await f.store.contextView();
  assert.match(view.text, /# 计划\n\n## 目标\n目标 B/);
  assert.match(view.text, new RegExp(`repa:document/${goal.id}`));
  await rm(path.join(f.root, "goals.md"));
  await assert.rejects(f.store.contextView(), code("context_unavailable"));
  state = await f.store.context();
  await f.store.setContext({ binding: null, base: state.revision, operationId: randomUUID() });
  assert.equal((await f.store.contextView()).text, "");
});

test("普通文件访问不会授予空间外权限，管理目录不能经符号链接逃逸", async (t) => {
  const f = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "repa-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "private.txt"), "outside");
  await assert.rejects(f.store.read({ target: f.store.target(path.join(outside, "private.txt")) }), code("permission_required"));
  await assert.rejects(f.store.write({ target: f.store.target(".repa/runtime/secret"), value: { kind: "text", text: "x" }, base: { kind: "absent" }, operationId: randomUUID() }), code("permission_required"));
  if (process.platform !== "win32") {
    await symlink(outside, path.join(f.root, "escape"), "dir");
    await assert.rejects(f.store.read({ target: f.store.target("escape/private.txt") }), code("permission_required"));
    const other = path.join(f.root, "other-space");
    await mkdir(other);
    await symlink(outside, path.join(other, ".repa"), "dir");
    await assert.rejects(ContentStore.open({ root: other, spaceId: randomUUID(), assertOwned() {} }), code("invalid_storage"));
  }
});

test("重复文本的撤回不猜测原插入位置，保留后续修改", async (t) => {
  const f = await fixture(t);
  await f.create("repeat.txt", "alpha\n");
  const operationId = randomUUID();
  await f.store.edit({ target: f.store.target("repeat.txt"), edits: [{ oldText: "alpha\n", newText: "alpha\nalpha\n" }], operationId });
  await writeFile(path.join(f.root, "repeat.txt"), "LATER\nalpha\n");
  await assert.rejects(f.store.undo({ operationId, undoOperationId: randomUUID() }), code("revision_conflict"));
  assert.equal(await readFile(path.join(f.root, "repeat.txt"), "utf8"), "LATER\nalpha\n");
});

test("恢复旧身份前检查位置的新归属，即使该位置没有物理文件", async (t) => {
  const f = await fixture(t);
  await f.create("doc.md", "original");
  const a = await f.register("doc.md");
  const deletion = randomUUID();
  await f.store.applyPatch({ operationId: deletion, patch: "*** Begin Patch\n*** Delete File: doc.md\n*** End Patch" });
  const b = await f.register("doc.md");
  await assert.rejects(f.store.undo({ operationId: deletion, undoOperationId: randomUUID() }), code("revision_conflict"));
  assert.equal((await f.store.get({ kind: "content", ref: a })).status, "missing");
  assert.equal((await f.store.get({ kind: "content", ref: b })).status, "missing");
  await assert.rejects(readFile(path.join(f.root, "doc.md")), { code: "ENOENT" });
});

test("分页按实际返回字节推进，过长单行明确提供完整资源", async (t) => {
  const f = await fixture(t);
  const full = Array.from({ length: 1000 }, (_, i) => `${String(i).padStart(4, "0")}${"中".repeat(90)}\r\n`).join("");
  await f.create("large.txt", full);
  let offset: number | undefined = 1;
  let restored = "";
  let revision: string | undefined;
  let pages = 0;
  do {
    const result = await f.store.read({ target: f.store.target("large.txt"), offset, revision });
    assert.equal(typeof result.text, "string");
    revision ??= result.content.bodyRevision!;
    restored += result.text;
    offset = result.nextOffset;
    pages++;
  } while (offset);
  assert.ok(pages > 1);
  assert.equal(restored, full);
  await f.create("single-line.txt", "x".repeat(60 * 1024));
  const result = await f.store.read({ target: f.store.target("single-line.txt") });
  assert.equal(result.text, undefined);
  assert.equal(result.truncated, true);
  assert.equal((await f.store.blobs.get(result.resource!.id)).toString(), "x".repeat(60 * 1024));
});

test("字节版本与关系版本分别检查，保存正文不会覆盖组成关系", async (t) => {
  const f = await fixture(t);
  await f.create("root.md", "root");
  await f.create("member.md", "member");
  const ref = await f.register("root.md");
  const child = await f.register("member.md");
  const target = { kind: "content" as const, ref };
  const before = await f.store.read({ target });
  await f.store.setComposition({ ref, base: before.content.revision!, members: [{ target: { kind: "content", ref: child } }], resources: [], operationId: randomUUID() });
  await f.store.write({ target, base: before.content.bodyRevision!, value: { kind: "text", text: "updated" }, operationId: randomUUID() });
  const current = await f.store.read({ target });
  assert.equal(current.text, "updated");
  assert.deepEqual(current.content.members, [{ target: { kind: "content", ref: child } }]);
  await assert.rejects(f.store.setComposition({ ref, base: before.content.revision!, members: [], resources: [], operationId: randomUUID() }), code("revision_conflict"));
});

test("中断移动必须修复身份位置或明确删除后，才可以解除恢复状态", async (t) => {
  const f = await fixture(t);
  await f.create("src.md", "original");
  const ref = await f.register("src.md");
  const source = await f.store.journal.image("src.md");
  assert.equal(source.kind, "file");
  const catalogPath = ".repa/content/catalog.json";
  const originalCatalog = await f.store.journal.image(catalogPath);
  assert.equal(originalCatalog.kind, "file");
  const nextCatalog = JSON.parse(await readFile(path.join(f.root, catalogPath), "utf8"));
  nextCatalog.items[ref.id].location.path = "dest.md";
  const changedCatalog = { kind: "file" as const, hash: await f.store.blobs.put(JSON.stringify(nextCatalog)), mode: 0o600 };
  const operationId = randomUUID();
  await f.store.journal.persist({ version: 1, operationId, requestHash: "interrupted-move", status: "prepared", createdAt: Date.now(), affectedIds: [ref.id], conflicts: [], result: { operationId, changes: [], contents: [] }, files: [
    { path: "src.md", before: source, after: { kind: "absent" } },
    { path: "dest.md", before: { kind: "absent" }, after: source },
    { path: catalogPath, before: originalCatalog, after: changedCatalog },
  ] });
  await rm(path.join(f.root, "src.md"));
  await writeFile(path.join(f.root, "dest.md"), "later content");
  const reopened = await f.open();
  await assert.rejects(reopened.reconcile(operationId), code("recovery_required"));
  const info = await reopened.get({ kind: "content", ref });
  await reopened.relink({ ref, base: info.revision!, location: { kind: "relative", path: "dest.md" }, operationId: randomUUID() });
  assert.equal((await reopened.reconcile(operationId)).status, "reconciled");
  assert.equal((await reopened.read({ target: { kind: "content", ref } })).text, "later content");
});

test("完整临时文件在回滚父目录前清理，可恢复的中断自动收尾", async (t) => {
  const f = await fixture(t);
  const operationId = randomUUID();
  const after = { kind: "file" as const, hash: await f.store.blobs.put("staged"), mode: 0o644 };
  await f.store.journal.persist({ version: 1, operationId, requestHash: "interrupted-stage", status: "prepared", createdAt: Date.now(), affectedIds: [], conflicts: [], result: { operationId, changes: [], contents: [] }, files: [
    { path: "new", before: { kind: "absent" }, after: { kind: "directory", mode: 0o755 } },
    { path: "new/doc.md", before: { kind: "absent" }, after },
  ] });
  await mkdir(path.join(f.root, "new"), { mode: 0o755 });
  await writeFile(path.join(f.root, "new", `.repa-${operationId}-1.tmp`), "staged");
  const reopened = await f.open();
  assert.equal((await reopened.operation(operationId)).status, "rolled_back");
  await assert.rejects(readFile(path.join(f.root, "new/doc.md")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(f.root, "new", `.repa-${operationId}-1.tmp`)), { code: "ENOENT" });
});

test("删除正文检查字节基准，保留外部编辑产生的新版本", async (t) => {
  const f = await fixture(t);
  await f.create("remove.md", "旧正文");
  const ref = await f.register("remove.md");
  const target = { kind: "content" as const, ref };
  const old = await f.store.get(target);
  await writeFile(path.join(f.root, "remove.md"), "更新正文");
  assert.equal((await f.store.get(target)).revision, old.revision);
  await assert.rejects(f.store.remove({ target, base: old.bodyRevision!, operationId: randomUUID() }), code("revision_conflict"));
  assert.equal(await readFile(path.join(f.root, "remove.md"), "utf8"), "更新正文");
  const latest = await f.store.get(target);
  await f.store.remove({ target, base: latest.bodyRevision!, operationId: randomUUID() });
  assert.equal((await f.store.get(target)).status, "missing");
});

test("已完成操作的历史路径改变不会阻止重新打开无关内容", async (t) => {
  const f = await fixture(t);
  await f.create("old/file.md", "历史版本");
  await f.create("current/file.md", "当前版本");
  await rm(path.join(f.root, "old"), { recursive: true });
  await symlink(path.join(f.root, "current"), path.join(f.root, "old"));
  const reopened = await f.open();
  assert.equal((await reopened.read({ target: reopened.target("current/file.md") })).text, "当前版本");
});
