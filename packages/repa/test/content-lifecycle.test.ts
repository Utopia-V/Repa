import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ContentStore } from "../src/content/store.js";
import { RepaFault } from "../src/errors.js";

const code = (value: string) => (error: unknown) => error instanceof RepaFault && error.code === value;
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-lifecycle-"));
  let now = 100;
  const options = { root, spaceId: randomUUID(), assertOwned() {}, canReadExternal: () => true,
    now: () => now, holdTtlMs: 100, preparationTtlMs: 10 };
  const store = await ContentStore.open(options);
  t.after(async () => { await store.settled(); await rm(root, { recursive: true, force: true }); });
  const create = async (file: string, text = file) => {
    await store.write({ target: store.target(file), value: { kind: "text", text }, base: { kind: "absent" }, operationId: randomUUID() });
    return (await store.associate({ location: { kind: "relative", path: file }, role: "document", operationId: randomUUID() })).contents[0]!;
  };
  return { root, store, create, options, tick: (ms: number) => { now += ms; } };
}

test("复制分布式循环组成：新身份、内部链接和目录布局一起变化，代码字面量保留", async t => {
  const { store, root, create } = await fixture(t);
  let a = await create("notes/a.md"), b = await create("code/b.md");
  const original = `中文😀 [跳转](repa:document/${b.ref!.id}#x)\r\n\`[代码](repa:document/${b.ref!.id})\`\r\n`;
  await writeFile(path.join(root, "notes/a.md"), original);
  a = (await store.setComposition({ ref: a.ref!, base: a.revision!, members: [{ target: b.target }], resources: [], operationId: randomUUID() })).contents[0]!;
  b = (await store.setComposition({ ref: b.ref!, base: b.revision!, members: [{ target: a.target }], resources: [], operationId: randomUUID() })).contents[0]!;
  const input = { target: a.target, base: a.revision!, destination: { kind: "relative" as const, path: "copy" }, container: true, operationId: randomUUID() };
  const result = await store.transfer("copy", input);
  assert.deepEqual(await store.transfer("copy", input), result);
  const copiedA = result.contents.find(c => c.location.path === "copy/notes/a.md")!;
  const copiedB = result.contents.find(c => c.location.path === "copy/code/b.md")!;
  assert.notEqual(copiedA.ref!.id, a.ref!.id);
  assert.deepEqual(copiedA.members[0]!.target, copiedB.target);
  assert.deepEqual(copiedB.members[0]!.target, copiedA.target);
  assert.equal(await readFile(path.join(root, "copy/notes/a.md"), "utf8"), original.replace(`/${b.ref!.id}#x`, `/${copiedB.ref!.id}#x`));
  assert.equal(await readFile(path.join(root, "notes/a.md"), "utf8"), original);
  await assert.rejects(store.transfer("copy", { ...input, operationId: randomUUID() }), code("revision_conflict"));
});

test("移动目录后撤回恢复身份和层级，同时保留目标目录后来加入的文件", async t => {
  const { store, root, create } = await fixture(t);
  const a = await create("old/nested/a.txt");
  const source = await store.associate({ location: { kind: "relative", path: "old" }, role: "document", operationId: randomUUID() });
  const operationId = randomUUID();
  await store.transfer("move", { target: source.contents[0]!.target, base: source.contents[0]!.revision!, destination: { kind: "relative", path: "new/deep" }, operationId });
  assert.equal((await store.get(a.target)).location.path, "new/deep/nested/a.txt");
  await writeFile(path.join(root, "new/deep/later.txt"), "独立的后续文件");
  await store.undo({ operationId, undoOperationId: randomUUID() });
  assert.equal((await store.get(a.target)).location.path, "old/nested/a.txt");
  assert.equal(await readFile(path.join(root, "old/nested/a.txt"), "utf8"), "old/nested/a.txt");
  assert.equal(await readFile(path.join(root, "new/deep/later.txt"), "utf8"), "独立的后续文件");
  assert.deepEqual(await readdir(path.join(root, "new/deep")), ["later.txt"]);
});

test("外部材料关联不读取正文，显式收集保留身份、来源和原件", async t => {
  const { store, root } = await fixture(t);
  const external = await mkdtemp(path.join(os.tmpdir(), "repa-material-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  const file = path.join(external, "book.txt");
  await writeFile(file, "source bytes");
  const material = (await store.associate({ location: { kind: "external", path: file }, role: "material", operationId: randomUUID() })).contents[0]!;
  const blobs = await readdir(store.blobs.directory);
  assert.equal(await Promise.all(blobs.map(async id => (await store.blobs.get(id)).toString())).then(values => values.includes("source bytes")), false);
  const collected = (await store.transfer("collect", { target: material.target, base: material.revision!, destination: { kind: "relative", path: "materials/book.txt" }, operationId: randomUUID() })).contents[0]!;
  assert.deepEqual(collected.ref, material.ref);
  assert.deepEqual(collected.origin, { kind: "external", path: file });
  assert.equal(await readFile(file, "utf8"), "source bytes");
  assert.equal(await readFile(path.join(root, "materials/book.txt"), "utf8"), "source bytes");
});

test("同时打开的版本各自保留，重复持有不重绑最新内容；过期与其他 owner 分别回收", async t => {
  const f = await fixture(t), { store } = f;
  const a = await f.create("a.md", "old");
  const input = { id: randomUUID(), targets: [a.target] };
  const first = await store.hold(input, "host");
  await writeFile(path.join(f.root, "a.md"), "new");
  const second = await store.hold({ ...input, id: randomUUID() }, "host");
  assert.notEqual(first.resources[0]!.id, second.resources[0]!.id);
  assert.equal((await store.hold(input, "host")).resources[0]!.id, first.resources[0]!.id);
  await assert.rejects(store.hold(input, "intruder"), code("permission_required"));
  await store.pruneHistory([...store.journal.entries.keys()]);
  store.retention.retain("session:s", first.resources);
  store.retention.release("host", first.id);
  await store.collectResources();
  assert.equal((await store.blobs.get(first.resources[0]!.id)).toString(), "old");
  store.retention.releaseOwner("session:s");
  await store.collectResources();
  await assert.rejects(store.blobs.get(first.resources[0]!.id), code("revision_unavailable"));
  assert.equal((await store.blobs.get(second.resources[0]!.id)).toString(), "new");
  store.retention.setHostActive("host", true);
  f.tick(200); await store.collectResources();
  assert.equal((await store.blobs.get(second.resources[0]!.id)).toString(), "new");
  store.retention.checkpoint();
  const reopened = await ContentStore.open(f.options);
  assert.equal(reopened.retention.get("host", second.id).resources[0]!.id, second.resources[0]!.id);
  f.tick(200); await reopened.collectResources();
  await assert.rejects(reopened.hold({ id: second.id, targets: [a.target] }, "host"), code("lease_expired"));
  const prep = await reopened.upload(Buffer.from("unused upload"), "text/plain", "host");
  f.tick(11); await reopened.collectResources();
  await assert.rejects(reopened.blobs.get(prep.resource.id), code("revision_unavailable"));
});

test("清理历史保留操作回执，重开后也不会重放原提交", async t => {
  const f = await fixture(t);
  const file = await f.create("a.md", "before");
  const input = { target: file.target, operationId: randomUUID(), edits: [{ oldText: "before", newText: "after" }] };
  await f.store.edit(input);
  await f.store.undo({ operationId: input.operationId, undoOperationId: randomUUID() });
  await f.store.pruneHistory([...f.store.journal.entries.keys()]);
  const reopened = await ContentStore.open(f.options);
  assert.deepEqual(await reopened.operation(input.operationId), { operationId: input.operationId, status: "pruned" });
  await assert.rejects(reopened.edit(input), code("history_pruned"));
  assert.equal((await reopened.read({ target: file.target })).text, "before");
});

test("准备期间关闭并重建宿主，旧异步操作不复活持有，也不释放新实例", async t => {
  const f = await fixture(t), { store } = f;
  const document = await f.create("a.md", "bytes");
  const read = await store.read({ target: document.target });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const put = store.blobs.put.bind(store.blobs);
  t.mock.method(store.blobs, "put", async (bytes: Uint8Array | string) => { entered(); await gate; return put(bytes); });
  store.retention.setHostActive("host", true);
  const pending = store.hold({ id: randomUUID(), targets: [document.target] }, "host");
  const rejected = assert.rejects(pending, code("closed"));
  await started;
  store.retention.releaseHost("host");
  store.retention.setHostActive("host", true);
  const next = store.retention.hold("host", randomUUID(), "new instance", [], [read.resource!]);
  release(); await rejected;
  assert.deepEqual(store.retention.get("host", next.id), next);
});
