import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { ContentFormat } from "../src/content/formats.js";
import { mapReference } from "../src/content/references.js";
import { ContentRefSchema, type ContentRef } from "../src/content/schema.js";
import { canonicalJson, ContentStore } from "../src/content/store.js";
import { RepaFault } from "../src/errors.js";
import { digest } from "../src/storage/blobs.js";

const code = (expected: string) => (error: unknown) => error instanceof RepaFault && error.code === expected;
function gate() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>(ready => { resolve = ready; });
  return { promise, release() { assert(resolve); resolve(); } };
}
async function fixture(t: TestContext, installed = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-content-format-lifecycle-"));
  const directory = path.join(root, "space");
  await mkdir(directory);
  const spaceId = randomUUID();
  const callbacks = { references: 0, files: 0, metadata: 0, file: 0 };
  const format: ContentFormat = {
    id: "fixture-binding", field: "fixtureBinding", default: null,
    schema: Type.Union([Type.Null(), ContentRefSchema]),
    references(value) { callbacks.references++; return Check(ContentRefSchema, value) ? [value] : []; },
    files(value) { callbacks.files++; return Check(ContentRefSchema, value) ? [value] : []; },
    remapMetadata(value, mapping) { callbacks.metadata++; return Check(ContentRefSchema, value) ? mapReference(value, mapping) : value; },
    remapFile(bytes) { callbacks.file++; return bytes; },
  };
  const formats = installed ? [format] : [];
  const options = { root: directory, spaceId, formats, assertOwned() {} };
  const store = await ContentStore.open(options);
  const stores = [store];
  t.after(async () => { await Promise.all(stores.map(value => value.settled())); await rm(root, { recursive: true, force: true }); });
  async function create(name: string, text = "固定原文\r\n") {
    await store.write({ target: store.target(name), base: { kind: "absent" }, value: { kind: "text", text }, operationId: randomUUID() });
    const result = await store.associate({ location: { kind: "relative", path: name }, role: "document", operationId: randomUUID() });
    const ref = result.contents[0]?.ref;
    assert(ref);
    return ref;
  }
  function metadata(value: ContentRef | null, base: ContentRef | null = null) {
    const operationId = randomUUID();
    return { field: format.field, value, base: digest(canonicalJson(base)), operationId,
      request: { method: "fixture-binding", operationId, value, base } };
  }
  async function reopen() {
    const reopened = await ContentStore.open(options);
    stores.push(reopened);
    return reopened;
  }
  return { root, directory, spaceId, store, format, formats, callbacks, create, metadata, reopen };
}

test("失效barrier前排队的观察、关系保存和复制使用完整旧格式结束", async t => {
  const f = await fixture(t);
  const ref = await f.create("source.txt");
  const base = (await f.store.get({ kind: "content", ref })).revision;
  assert(base);
  const entered = gate(), release = gate();
  const observed = f.store.observe(async scope => {
    entered.release();
    await release.promise;
    return scope.metadata(f.format.field);
  });
  await entered.promise;
  const input = f.metadata(ref);
  const saved = f.store.setMetadata(input);
  const copied = f.store.transfer("copy", {
    target: { kind: "content", ref }, destination: { kind: "relative", path: "copy.txt" },
    base,
    operationId: randomUUID(),
  });
  const barrier = f.store.invalidateFormats();
  release.release();
  assert.equal(await observed, null);
  await saved;
  await copied;
  await barrier;
  assert.equal(await readFile(path.join(f.directory, "copy.txt"), "utf8"), "固定原文\r\n");
  assert(f.callbacks.references > 0);
  assert(f.callbacks.files > 0);
  assert(f.callbacks.file > 0);
  const before = { ...f.callbacks };
  await assert.rejects(f.store.observe(async scope => scope.metadata(f.format.field)), code("plugin_restart_required"));
  assert.deepEqual(f.callbacks, before);
});

test("失效后引用变更与内容复制明确拒绝，不调用旧解释器，普通正文读取继续", async t => {
  const f = await fixture(t);
  const ref = await f.create("source.txt");
  await f.store.setMetadata(f.metadata(ref));
  const read = await f.store.read({ target: { kind: "content", ref } });
  assert(read.content.revision);
  const bodyRevision = read.content.bodyRevision;
  assert(bodyRevision);
  await f.store.invalidateFormats();
  const before = { ...f.callbacks };
  await assert.rejects(f.store.setMetadata(f.metadata(null, ref)), code("plugin_restart_required"));
  await assert.rejects(f.store.write({ target: { kind: "content", ref }, base: bodyRevision,
    value: { kind: "text", text: "不应覆盖\n" }, operationId: randomUUID() }), code("plugin_restart_required"));
  await assert.rejects(f.store.transfer("copy", { target: { kind: "content", ref }, base: read.content.revision,
    destination: { kind: "relative", path: "rejected.txt" }, operationId: randomUUID() }), code("plugin_restart_required"));
  assert.deepEqual(f.callbacks, before);
  assert.equal((await f.store.read({ target: { kind: "content", ref } })).text, "固定原文\r\n");
  assert.equal((await f.store.get({ kind: "content", ref })).status, "available");
  assert.equal((await f.store.list()).length, 1);
  assert.equal((await f.store.observe(async scope => (await scope.read(ref)).bytes?.toString("utf8"))), "固定原文\r\n");
  await f.store.collectResources();
  assert.deepEqual(f.callbacks, before);
  await assert.rejects(readFile(path.join(f.directory, "rejected.txt")), { code: "ENOENT" });
});

test("旧metadata回执在失效后优先重传，冲突和墓碑也不重新解释，重开取得新格式", async t => {
  const f = await fixture(t);
  const ref = await f.create("source.txt");
  const input = f.metadata(ref);
  const result = await f.store.setMetadata(input);
  const catalog = await readFile(path.join(f.directory, ".repa/content/catalog.json"));
  await f.store.invalidateFormats();
  const before = { ...f.callbacks };
  assert.deepEqual(await f.store.setMetadata(input), result);
  await assert.rejects(f.store.setMetadata({ ...input, request: { ...input.request, value: null } }), code("operation_id_conflict"));
  await f.store.pruneHistory([input.operationId]);
  await assert.rejects(f.store.setMetadata(input), code("history_pruned"));
  assert.deepEqual(await readFile(path.join(f.directory, ".repa/content/catalog.json")), catalog);
  assert.deepEqual(f.callbacks, before);
  const reopened = await f.reopen();
  assert.deepEqual(await reopened.observe(async scope => scope.metadata(f.format.field)), ref);
  await reopened.setMetadata(f.metadata(null, ref));
  assert.equal(await reopened.observe(async scope => scope.metadata(f.format.field)), null);
  assert(f.callbacks.references > before.references);
});

test("先受理的capture完整映射当前和历史，barrier之后copy与backup不执行旧owner", async t => {
  const f = await fixture(t);
  const ref = await f.create("source.txt");
  await f.store.setMetadata(f.metadata(ref));
  const destination = path.join(f.root, "copy");
  await cp(f.directory, destination, { recursive: true });
  const entered = gate(), release = gate();
  const blocked = f.store.observe(async () => { entered.release(); await release.promise; });
  await entered.promise;
  const targetSpaceId = randomUUID();
  const capture = f.store.capture(destination, targetSpaceId);
  const barrier = f.store.invalidateFormats();
  release.release();
  await blocked;
  await capture;
  await barrier;
  const catalog = JSON.parse(await readFile(path.join(destination, ".repa/content/catalog.json"), "utf8"));
  assert.deepEqual(catalog.fixtureBinding, { ...ref, spaceId: targetSpaceId });
  assert(f.callbacks.metadata > 0);
  assert(f.callbacks.file > 0);
  const before = { ...f.callbacks };
  await assert.rejects(f.store.capture(path.join(f.root, "later-copy"), randomUUID()), code("plugin_restart_required"));
  await assert.rejects(f.store.capture(path.join(f.root, "later-backup"), f.spaceId), code("plugin_restart_required"));
  assert.deepEqual(f.callbacks, before);
});

test("格式快照不接受调用方更换数组或回调，失效也不修改持久schema数据", async t => {
  const f = await fixture(t);
  let replacedCalls = 0;
  f.format.references = () => { replacedCalls++; return []; };
  f.format.files = () => { replacedCalls++; return []; };
  f.formats.splice(0);
  const ref = await f.create("source.txt");
  await f.store.setMetadata(f.metadata(ref));
  assert.equal(replacedCalls, 0);
  assert(f.callbacks.references > 0);
  const catalog = await readFile(path.join(f.directory, ".repa/content/catalog.json"));
  await Promise.all([f.store.invalidateFormats(), f.store.invalidateFormats()]);
  assert.deepEqual(await readFile(path.join(f.directory, ".repa/content/catalog.json")), catalog);
  assert.equal((await f.store.read({ target: { kind: "content", ref } })).text, "固定原文\r\n");
});

test("没有领域格式的空间失效后普通保存与独立捕获继续工作", async t => {
  const f = await fixture(t, false);
  await f.store.invalidateFormats();
  const ref = await f.create("plain.txt", "plain\n");
  const read = await f.store.read({ target: { kind: "content", ref } });
  const bodyRevision = read.content.bodyRevision;
  assert(bodyRevision);
  await f.store.write({ target: { kind: "content", ref }, base: bodyRevision,
    value: { kind: "text", text: "updated\n" }, operationId: randomUUID() });
  await f.store.applyPatch({ operationId: randomUUID(), patch: "*** Begin Patch\n*** Add File: other.txt\n+other\n*** End Patch" });
  await f.store.capture(path.join(f.root, "plain-copy"), randomUUID());
  assert.equal((await f.store.read({ target: { kind: "content", ref } })).text, "updated\n");
});

test("固定快照保留class格式owner的原回调与私有实例状态", async t => {
  const f = await fixture(t, false);
  class ClassFormat implements ContentFormat {
    id = "class-owner";
    field = "classBinding";
    default = null;
    schema = Type.Null();
    #calls = 0;
    get calls() { return this.#calls; }
    references() { this.#calls++; return []; }
    files() { this.#calls++; return []; }
    remapMetadata(value: unknown) { this.#calls++; return value; }
    remapFile(bytes: Buffer) { this.#calls++; return bytes; }
  }
  const format = new ClassFormat();
  const directory = path.join(f.root, "class");
  await mkdir(directory);
  const store = await ContentStore.open({ root: directory, spaceId: randomUUID(), formats: [format], assertOwned() {} });
  t.after(() => store.settled());
  let replacedCalls = 0;
  format.references = () => { replacedCalls++; return []; };
  await store.write({ target: store.target("plain.txt"), base: { kind: "absent" },
    value: { kind: "text", text: "class正文\n" }, operationId: randomUUID() });
  assert.equal(replacedCalls, 0);
  assert(format.calls > 0);
  const before = format.calls;
  await store.invalidateFormats();
  await assert.rejects(store.observe(async scope => scope.metadata(format.field)), code("plugin_restart_required"));
  assert.equal(format.calls, before);
});
