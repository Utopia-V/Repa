import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Check } from "typebox/value";
import type { RepaCapabilityServices } from "../src/capabilities/services.js";
import type { ContentTarget } from "../src/content/schema.js";
import { ContentStore } from "../src/content/store.js";
import { RepaFault } from "../src/errors.js";
import { ContentSearchResultSchema } from "../src/search/content-schema.js";
import { searchContent } from "../src/search/content.js";

const fault = (code: string) => (error: unknown) => error instanceof RepaFault && error.code === code;
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-content-search-"));
  const stores: ContentStore[] = [];
  t.after(async () => { await Promise.all(stores.map(store => store.settled())); await rm(root, { recursive: true, force: true }); });
  const open = async (name: string) => {
    const directory = path.join(root, name);
    await mkdir(directory);
    const allowed = new Set<string>();
    const content = await ContentStore.open({ root: directory, spaceId: randomUUID(), canReadExternal: file => allowed.has(file), assertOwned() {} });
    stores.push(content);
    const owner = `processing:${randomUUID()}`;
    const snapshots: ContentTarget[] = [];
    const resources: NonNullable<RepaCapabilityServices["resources"]> = {
      snapshot: params => { snapshots.push(params.target); return content.readSnapshot(params, owner); },
      retain: refs => content.retention.retainAdditional(owner, refs),
      create: async (bytes, mediaType) => ({ spaceId: content.options.spaceId, id: await content.blobs.put(bytes), mediaType }),
      read: ref => content.blobs.get(ref.id),
    };
    return { directory, content, resources, snapshots, owner, allowed };
  };
  return { root, open };
}

test("rg只发现空间命中文件，实际快照提供Unicode定位与限长片段，旧来源不会拼接新正文", async (t) => {
  const f = await fixture(t);
  const first = await f.open("one");
  const second = await f.open("two");
  const text = `起始🙂\r\n${"甲".repeat(600)}目标🙂${"乙".repeat(600)}\r\n`;
  await writeFile(path.join(first.directory, "hit.md"), text);
  await writeFile(path.join(first.directory, "unmatched.md"), "不匹配的独立正文");
  await writeFile(path.join(first.directory, ".repa", "private.md"), "目标🙂管理数据不能搜索");
  await writeFile(path.join(second.directory, "another.md"), "目标🙂另一个空间");
  const before = await readdir(first.content.blobs.directory);
  const result = await searchContent(first.content, first.resources, { pattern: "目标🙂", literal: true, glob: "*.md" });
  assert(Check(ContentSearchResultSchema, result));
  assert.equal(result.matches.length, 1);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.unavailable, []);
  assert.equal(first.snapshots.length, 1, "未命中目录文件不建立字节快照");
  assert.equal((await readdir(first.content.blobs.directory)).length - before.length, 1);
  const match = result.matches[0];
  assert(match);
  assert.equal(match.line, 2);
  assert.deepEqual(match.range, { start: text.indexOf("目标🙂"), end: text.indexOf("目标🙂") + 4 });
  assert.equal(match.byteRange.end - match.byteRange.start, 10);
  assert.equal(match.snippet.text.length, 500);
  assert.equal(match.snippet.truncated, true);
  assert.equal(text.slice(match.snippet.range.start, match.snippet.range.end), match.snippet.text);
  assert.deepEqual(result.resources, [match.resource]);
  const unchanged = await first.content.read({ target: match.target, revision: match.revision, offset: match.line });
  assert.equal(unchanged.content.bodyRevision, match.revision);
  assert.match(unchanged.text ?? "", /目标🙂/);
  await writeFile(path.join(first.directory, "hit.md"), "人工编辑后的新正文");
  await assert.rejects(first.content.read({ target: match.target, revision: match.revision, offset: match.line }), fault("revision_conflict"));
  const reopened = await ContentStore.open({ root: first.directory, spaceId: first.content.options.spaceId, assertOwned() {} });
  await reopened.collectResources();
  assert.equal((await reopened.blobs.get(match.resource.id)).toString(), text);
  const other = await searchContent(second.content, second.resources, { pattern: "目标🙂", literal: true });
  assert.equal(other.matches.length, 1);
  assert(other.matches.every(item => item.resource.spaceId === second.content.options.spaceId));
});

test("根搜索补入精确关联外部材料而不扫邻居，原件移走有状态且候选变更以后读取的新字节为准", async (t) => {
  const f = await fixture(t);
  const s = await f.open("space");
  const original = path.join(f.root, "external.txt");
  const neighbor = path.join(f.root, "neighbor.txt");
  await writeFile(original, "外部 NEEDLE 正文");
  await writeFile(neighbor, "NEEDLE 未授权邻居");
  s.allowed.add(original);
  const associated = await s.content.associate({ location: { kind: "external", path: original }, role: "material", operationId: randomUUID() });
  const ref = associated.contents[0]?.ref;
  assert(ref);
  const found = await searchContent(s.content, s.resources, { pattern: "needle", literal: true, ignoreCase: true, glob: "*.md" });
  assert.equal(found.matches.length, 1, "glob只过滤空间内目录候选，不改写精确外部材料集合");
  assert.deepEqual(found.matches[0]?.target, { kind: "content", ref });
  await assert.rejects(searchContent(s.content, s.resources, { pattern: "NEEDLE", path: neighbor }), fault("permission_required"));
  s.allowed.delete(original);
  const blocked = await searchContent(s.content, s.resources, { pattern: "NEEDLE", literal: true });
  assert.equal(blocked.unavailable[0]?.code, "permission_required");
  s.allowed.add(original);
  await rm(original);
  const absent = await searchContent(s.content, s.resources, { pattern: "NEEDLE", literal: true });
  assert.equal(absent.matches.length, 0);
  assert.deepEqual(absent.unavailable.map(item => ({ target: item.target, code: item.code })), [{ target: { kind: "content", ref }, code: "not_found" }]);
  await writeFile(path.join(s.directory, "changing.md"), "旧候选 needle");
  const changing = {
    ...s.resources,
    snapshot: async (params: Parameters<typeof s.resources.snapshot>[0]) => {
      if (params.target.kind === "file" && params.target.location.path.endsWith("changing.md"))
        await writeFile(path.join(s.directory, "changing.md"), "新🙂字节 needle");
      return s.resources.snapshot(params);
    },
  };
  const updated = await searchContent(s.content, changing, { pattern: "needle", literal: true });
  const match = updated.matches[0];
  assert(match);
  assert.match(match.snippet.text, /^新🙂字节/);
  assert.equal((await s.content.read({ target: match.target, revision: match.revision })).content.bodyRevision, match.revision);
  const noLonger = { ...s.resources, snapshot: async (params: Parameters<typeof s.resources.snapshot>[0]) => {
    await writeFile(path.join(s.directory, "changing.md"), "已经不命中");
    return s.resources.snapshot(params);
  } };
  assert.deepEqual((await searchContent(s.content, noLonger, { pattern: "needle", literal: true, path: "changing.md" })).resources, []);
});

test("内容查询按总字节预算和结果数结束，超限候选不读取且取消不继续建快照", async (t) => {
  const f = await fixture(t);
  const s = await f.open("space");
  const text = `needle ${" ".repeat(7 * 1024 * 1024)}`;
  for (let index = 0; index < 5; index++) await writeFile(path.join(s.directory, `${index}.txt`), text);
  await writeFile(path.join(s.directory, "large.txt"), `needle ${" ".repeat(9 * 1024 * 1024)}`);
  const result = await searchContent(s.content, s.resources, { pattern: "needle", literal: true });
  assert.equal(result.matches.length, 4);
  assert.equal(result.truncated, true);
  assert.equal(s.snapshots.length, 4);
  assert.deepEqual(result.unavailable.map(item => item.code), ["query_byte_limit", "file_byte_limit"]);
  const limited = await searchContent(s.content, s.resources, { pattern: "needle", literal: true }, { limit: 1 });
  assert.equal(limited.matches.length, 1);
  assert.equal(limited.truncated, true);
  const count = s.snapshots.length;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(searchContent(s.content, s.resources, { pattern: "needle" }, { signal: controller.signal }), fault("cancelled"));
  assert.equal(s.snapshots.length, count);
});

test("显式超限文件先读取授权元信息，不为拒绝查询保存完整正文", async (t) => {
  const f = await fixture(t);
  const s = await f.open("space");
  const text = `needle ${" ".repeat(9 * 1024 * 1024)}`;
  await writeFile(path.join(s.directory, "large.txt"), text);
  const target = s.content.target("large.txt");
  const before = await readdir(s.content.blobs.directory);
  const info = await s.content.inspect(target);
  assert.equal(info.status, "available");
  assert.equal(info.size, Buffer.byteLength(text));
  assert.equal(info.bodyRevision, undefined);
  const result = await searchContent(s.content, s.resources, { pattern: "needle", literal: true, path: "large.txt" });
  assert.deepEqual(result.matches, []);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.unavailable.map(item => item.code), ["file_byte_limit"]);
  assert.equal(s.snapshots.length, 0);
  assert.deepEqual(await readdir(s.content.blobs.directory), before);
  await assert.rejects(s.resources.snapshot({ target, maxBytes: 8 * 1024 * 1024 }), fault("content_limit"));
  assert.deepEqual(await readdir(s.content.blobs.directory), before);
  assert.equal(s.content.retention.snapshot().state.owners[s.owner], undefined);
  const outside = path.join(f.root, "private.txt");
  await writeFile(outside, "未授权的外部元信息");
  await assert.rejects(s.content.inspect(s.content.target(outside)), fault("permission_required"));
});
