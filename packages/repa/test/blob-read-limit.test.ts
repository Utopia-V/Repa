import assert from "node:assert/strict";
import { appendFile, mkdtemp, open, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { RepaFault } from "../src/errors.js";
import { BlobStore, digest } from "../src/storage/blobs.js";

const code = (expected: string) => (error: unknown) => error instanceof RepaFault && error.code === expected;

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-blob-limit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new BlobStore(path.join(root, "blobs"));
  await store.open();
  const bytes = Buffer.from("原件\r\n");
  const id = await store.put(bytes);
  const file = path.join(store.directory, id);
  const probe = await open(file, "r");
  const prototype: FileHandle = Object.getPrototypeOf(probe);
  await probe.close();
  return { store, bytes, id, file, prototype };
}

test("资源可按小于或等于限额读取，无限额调用保留完整原件与摘要校验", async t => {
  const f = await fixture(t);
  const stat = t.mock.method(f.prototype, "stat");
  assert.deepEqual(await f.store.get(f.id), f.bytes);
  assert.equal(stat.mock.callCount(), 0, "无限额调用不增加显式stat检查");
  assert.deepEqual(await f.store.get(f.id, f.bytes.length + 1), f.bytes);
  assert.deepEqual(await f.store.get(f.id, f.bytes.length), f.bytes);
  assert.equal(stat.mock.callCount(), 2);
  await writeFile(f.file, Buffer.alloc(f.bytes.length));
  await assert.rejects(f.store.get(f.id, f.bytes.length), code("invalid_storage"));
  await assert.rejects(f.store.get(f.id), code("invalid_storage"));
});

test("已知超限先于正文读取和摘要校验，缺失与非法限额保持明确错误", async t => {
  const f = await fixture(t);
  await writeFile(f.file, "已损坏且超限的原件");
  const read = t.mock.method(f.prototype, "readFile");
  await assert.rejects(f.store.get(f.id, 1), code("content_limit"));
  assert.equal(read.mock.callCount(), 0, "超限不需要读正文或判断损坏摘要");
  for (const limit of [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, null, false, "1"]) {
    await assert.rejects(Reflect.apply(f.store.get, f.store, [f.id, limit]), code("invalid_input"));
  }
  assert.equal(read.mock.callCount(), 0);
  await assert.rejects(f.store.get(digest("不存在的原件"), 1), code("revision_unavailable"));
  await assert.rejects(f.store.get("非法标识", 1), code("invalid_input"));
  await assert.rejects(f.store.get(f.id), code("invalid_storage"));
  assert.equal(read.mock.callCount(), 1);
});

test("同一打开句柄完成stat和读取，路径替换不将另一文件当作已检查原件", async t => {
  const f = await fixture(t);
  const originalStat = f.prototype.stat;
  t.mock.method(f.prototype, "stat", async function (this: FileHandle) {
    const stat = await originalStat.call(this);
    await rename(f.file, `${f.file}.previous`);
    await writeFile(f.file, "另一份不同的路径字节");
    return stat;
  });
  assert.deepEqual(await f.store.get(f.id, f.bytes.length), f.bytes);
});

test("stat之后原文件增长仍在读取后按实际字节拒绝，不先返回摘要损坏", async t => {
  const f = await fixture(t);
  const originalRead = f.prototype.readFile;
  t.mock.method(f.prototype, "readFile", async function (this: FileHandle) {
    await appendFile(f.file, "追加字节");
    return originalRead.call(this);
  });
  await assert.rejects(f.store.get(f.id, f.bytes.length), code("content_limit"));
});
