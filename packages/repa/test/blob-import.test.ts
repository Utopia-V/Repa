import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { ResourceRetention } from "../src/content/resources.js";
import { RepaFault } from "../src/errors.js";
import { BlobStore, digest } from "../src/storage/blobs.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-blob-import-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const store = new BlobStore(path.join(root, "blobs"));
  await store.open();
  return { root, store };
}

const code = (expected: string) => (error: unknown): boolean => error instanceof RepaFault && error.code === expected;

test("超过 SDK 截断阈值的完整日志按内容标识入库，保留源文件并可重复导入", async (t) => {
  const { root, store } = await fixture(t);
  const bytes = Buffer.from("完整输出\r\n".repeat(DEFAULT_MAX_BYTES));
  assert(bytes.length > DEFAULT_MAX_BYTES);
  const source = path.join(root, "output.log");
  await writeFile(source, bytes);

  const id = await store.importFile(source);
  assert.equal(id, digest(bytes));
  assert.deepEqual(await store.get(id), bytes);
  assert.deepEqual(await readFile(source), bytes);
  assert.equal(await store.importFile(source), id);
  assert.deepEqual(await readdir(store.directory), [id]);
});

test("源日志不存在时保留读取错误且清理导入临时文件", async (t) => {
  const { root, store } = await fixture(t);
  await assert.rejects(store.importFile(path.join(root, "missing.log")), {
    code: "ENOENT",
  });
  assert.deepEqual(await readdir(store.directory), []);
});

test("目标路径阻止发布时清理已写入的临时文件并保留源日志", async (t) => {
  const { root, store } = await fixture(t);
  const bytes = Buffer.from("完整日志\r\n");
  const source = path.join(root, "output.log");
  await writeFile(source, bytes);
  const id = digest(bytes);
  await mkdir(path.join(store.directory, id));

  await assert.rejects(store.importFile(source));
  assert.deepEqual(await readdir(store.directory), [id]);
  assert.deepEqual(await readFile(source), bytes);
});

test("保留资源只确认普通文件存在，完整读取仍校验字节摘要", async (t) => {
  const { root, store } = await fixture(t);
  const spaceId = randomUUID();
  const retention = new ResourceRetention(spaceId, store, path.join(root, "resources.json"));
  const id = await store.put("完整日志");
  await writeFile(path.join(store.directory, id), "已损坏的字节");
  const resource = { spaceId, id, mediaType: "text/plain" };

  retention.retainAdditional("request:output", [resource]);
  assert(retention.snapshot().roots.has(id));
  assert.throws(() => store.getSync(id), code("invalid_storage"));
  await assert.rejects(store.get(id), code("invalid_storage"));
  assert.throws(() => store.assertAvailableSync("invalid-id"), code("invalid_input"));
  assert.throws(() => store.assertAvailableSync(digest("missing")), code("revision_unavailable"));
  const directoryId = digest("directory");
  await mkdir(path.join(store.directory, directoryId));
  assert.throws(() => store.assertAvailableSync(directoryId), code("invalid_storage"));
});
