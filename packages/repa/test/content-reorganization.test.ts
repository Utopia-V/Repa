import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { learningContentFormat, LearningContext } from "@repa/learning";
import { catalogPath } from "../src/content/catalog.js";
import type { ContentPatchInput, ContentRef } from "../src/content/schema.js";
import { ContentStore, canonicalJson } from "../src/content/store.js";
import { RepaFault } from "../src/errors.js";
import { digest } from "../src/storage/blobs.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-reorganization-"));
  const spaceId = randomUUID();
  const events: string[] = [];
  const open = () => ContentStore.open({ root, spaceId, assertOwned() {}, formats: [learningContentFormat],
    onChange(result) { events.push(result.operationId); } });
  const store = await open();
  t.after(async () => {
    await store.settled();
    await rm(root, { recursive: true, force: true });
  });
  const create = async (name: string, text: string): Promise<ContentRef> => {
    await store.write({ target: store.target(name), value: { kind: "text", text },
      base: { kind: "absent" }, operationId: randomUUID() });
    const result = await store.associate({ location: { kind: "relative", path: name },
      role: "document", operationId: randomUUID() });
    return result.contents[0]!.ref!;
  };
  return { root, spaceId, store, events, open, create };
}
const code = (expected: string) => (error: unknown): boolean => error instanceof RepaFault && error.code === expected;
const target = (ref: ContentRef) => ({ kind: "content" as const, ref });
const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");

async function splitFixture(t: TestContext) {
  const f = await fixture(t);
  const original = await f.create("main.md", "保留正文\r\n拆出正文\r\n分隔正文\r\n人工正文\r\n");
  const split = { spaceId: f.spaceId, id: randomUUID() };
  const input: ContentPatchInput = {
    operationId: randomUUID(),
    patch: patch("*** Update File: main.md", "@@", " 保留正文", "-拆出正文", " 分隔正文", " 人工正文",
      "*** Add File: split.md", "+拆出正文"),
    registrations: [{ path: "split.md", role: "document", id: split.id }],
    compositions: [{ ref: original, base: (await f.store.get(target(original))).revision!,
      members: [{ target: target(split), name: "拆出内容" }], resources: [] }],
  };
  return { ...f, original, split, input };
}

test("拆分一次保存保留主体身份，登记新组成并修改明确引用及已绑定语境清单，重传不重复", async (t) => {
  const f = await splitFixture(t);
  const linked = await f.create("links.md", `[拆出内容](repa:document/${f.original.id})\n`);
  const beforeItems = JSON.stringify({ items: [{ ref: f.original, mode: "expand" }] });
  const context = await f.create("context.json", `${beforeItems}\n`);
  const learning = new LearningContext(f.store);
  const state = await learning.get();
  const binding = { kind: "composition" as const, ref: context };
  await learning.set({ binding, base: state.revision, operationId: randomUUID() });
  const appendix = { spaceId: f.spaceId, id: randomUUID() };
  const afterItems = JSON.stringify({ items: [{ ref: f.original, mode: "expand" }, { ref: f.split, mode: "expand" }] });
  const resource = { spaceId: f.spaceId, id: await f.store.blobs.put("必要资源"), mediaType: "text/plain" };
  const input: ContentPatchInput = { ...f.input,
    patch: f.input.patch.replace("*** End Patch", patch("*** Add File: parts/appendix.md", "+补充正文",
      "*** Update File: links.md", "@@", `-[拆出内容](repa:document/${f.original.id})`, `+[拆出内容](repa:document/${f.split.id})`,
      "*** Update File: context.json", "@@", `-${beforeItems}`, `+${afterItems}`).replace("*** Begin Patch\n", "")),
    registrations: [
      { path: "split.md", role: "document", id: f.split.id, members: [{ target: target(appendix) }], resources: [resource] },
      { path: "parts/appendix.md", role: "document", id: appendix.id },
      { path: "parts", role: "document" },
    ],
  };
  const result = await f.store.applyPatch(input);
  assert.equal(f.events.filter(id => id === input.operationId).length, 1);
  assert.equal((await f.store.read({ target: target(f.original) })).text, "保留正文\r\n分隔正文\r\n人工正文\r\n");
  assert.equal((await f.store.read({ target: target(f.split) })).text, "拆出正文\n");
  assert.deepEqual((await f.store.get(target(f.original))).members, input.compositions![0]!.members);
  assert.deepEqual((await f.store.get(target(f.split))).resources, [resource]);
  assert.deepEqual((await f.store.get(target(f.split))).members, [{ target: target(appendix) }]);
  assert.equal(result.contents.find(info => info.location.path === "parts")?.fileType, "directory");
  assert.ok(result.contents.find(info => info.location.path === "parts")?.ref);
  assert.equal((await f.store.read({ target: target(linked) })).text, `[拆出内容](repa:document/${f.split.id})\n`);
  assert.equal((await f.store.read({ target: target(context) })).text, `${afterItems}\n`);
  assert.match((await learning.preview()).text, /拆出正文/);
  assert.deepEqual((await learning.get()).binding, binding);
  const entry = f.store.journal.entries.get(input.operationId)!;
  assert.equal(entry.status, "committed");
  assert.ok(entry.files.some(file => file.path === catalogPath));
  assert.deepEqual(await f.store.applyPatch(input), result);
  const reopened = await f.open();
  assert.deepEqual(await reopened.applyPatch(input), result);
  assert.equal(f.events.filter(id => id === input.operationId).length, 1);
  await reopened.undo({ operationId: input.operationId, undoOperationId: randomUUID() });
  assert.equal((await reopened.read({ target: target(linked) })).text, `[拆出内容](repa:document/${f.original.id})\n`);
  assert.equal((await reopened.read({ target: target(context) })).text, `${beforeItems}\n`);
  assert.deepEqual((await reopened.get(target(f.original))).members, []);
  assert.equal((await reopened.get(target(f.split))).status, "missing");
  assert.equal((await reopened.get(target(appendix))).status, "missing");
  await assert.rejects(readFile(path.join(f.root, "parts/appendix.md")), { code: "ENOENT" });
});

test("结构基准过期拒绝整个补丁，自身移动不造成基准冲突，同补丁删除不能更新组成", async (t) => {
  const f = await splitFixture(t);
  const ref = f.original;
  await f.store.setComposition({ ref, base: f.input.compositions![0]!.base,
    members: [{ target: f.store.target("main.md") }], resources: [], operationId: randomUUID() });
  await assert.rejects(f.store.applyPatch(f.input), code("revision_conflict"));
  assert.equal(await readFile(path.join(f.root, "main.md"), "utf8"), "保留正文\r\n拆出正文\r\n分隔正文\r\n人工正文\r\n");
  await assert.rejects(readFile(path.join(f.root, "split.md")), { code: "ENOENT" });
  await assert.rejects(f.store.get(target(f.split)), code("not_found"));
  assert.equal((await f.store.operation(f.input.operationId)).status, "unknown");
  await f.store.applyPatch({ operationId: randomUUID(), patch: patch("*** Update File: main.md", "*** Move to: moved.md"),
    compositions: [{ ref, base: (await f.store.get(target(ref))).revision!, members: [], resources: [] }] });
  assert.equal((await f.store.get(target(ref))).location.path, "moved.md");
  assert.deepEqual((await f.store.get(target(ref))).members, []);
  await assert.rejects(f.store.applyPatch({ operationId: randomUUID(), patch: patch("*** Delete File: moved.md"),
    compositions: [{ ref, base: (await f.store.get(target(ref))).revision!, members: [], resources: [] }] }), code("not_found"));
  assert.equal((await f.store.get(target(ref))).status, "available");
});

test("登记可关联已有文件并生成身份，缺失位置与跨空间资源不保存", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "existing.md"), "现有文字");
  const result = await f.store.applyPatch({ operationId: randomUUID(), patch: patch(),
    registrations: [{ path: "existing.md", role: "document" }] });
  assert.equal((await f.store.read({ target: target(result.contents[0]!.ref!) })).text, "现有文字");
  await assert.rejects(f.store.applyPatch({ operationId: randomUUID(), patch: patch("*** Add File: failed.md", "+不应保存"),
    registrations: [{ path: "missing.md", role: "document" }] }), code("not_found"));
  await assert.rejects(f.store.applyPatch({ operationId: randomUUID(), patch: patch("*** Add File: failed.md", "+不应保存"),
    registrations: [{ path: "failed.md", role: "document", resources: [{ spaceId: randomUUID(), id: randomUUID(), mediaType: "text/plain" }] }] }), code("invalid_input"));
  await assert.rejects(readFile(path.join(f.root, "failed.md")), { code: "ENOENT" });
});

test("组合撤回同时还原身份与组成，保留主体可分离的后续人工文字", async (t) => {
  const f = await splitFixture(t);
  await f.store.applyPatch(f.input);
  await writeFile(path.join(f.root, "main.md"), "保留正文\r\n分隔正文\r\n人工后续改文\r\n");
  const other = await f.create("other.md", "另一文档");
  await f.store.undo({ operationId: f.input.operationId, undoOperationId: randomUUID() });
  assert.equal(await readFile(path.join(f.root, "main.md"), "utf8"), "保留正文\r\n拆出正文\r\n分隔正文\r\n人工后续改文\r\n");
  assert.deepEqual((await f.store.get(target(f.original))).members, []);
  assert.equal((await f.store.get(target(f.split))).status, "missing");
  assert.equal((await f.store.read({ target: target(other) })).text, "另一文档");
});

test("组合的真实 journal 恢复同时回退部分落盘的正文和清单", async (t) => {
  const f = await splitFixture(t);
  await f.store.applyPatch(f.input);
  const entry = f.store.journal.entries.get(f.input.operationId)!;
  await f.store.journal.persist({ ...entry, status: "prepared" });
  await writeFile(path.join(f.root, "main.md"), "保留正文\r\n拆出正文\r\n分隔正文\r\n人工正文\r\n");
  const reopened = await f.open();
  assert.equal((await reopened.operation(f.input.operationId)).status, "rolled_back");
  assert.equal((await reopened.read({ target: target(f.original) })).text, "保留正文\r\n拆出正文\r\n分隔正文\r\n人工正文\r\n");
  assert.deepEqual((await reopened.get(target(f.original))).members, []);
  await assert.rejects(reopened.get(target(f.split)), code("not_found"));
  await assert.rejects(readFile(path.join(f.root, "split.md")), { code: "ENOENT" });
});

test("组合实际保存失败恢复已写正文、新文件与身份清单", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  const f = await splitFixture(t);
  await f.create("blocked/last.md", "末项\n");
  const blocked = path.join(f.root, "blocked");
  await chmod(blocked, 0o500);
  try {
    const input = { ...f.input, patch: f.input.patch.replace("*** End Patch", "*** Update File: blocked/last.md\n@@\n-末项\n+改末项\n*** End Patch") };
    await assert.rejects(f.store.applyPatch(input));
    assert.equal(await readFile(path.join(f.root, "main.md"), "utf8"), "保留正文\r\n拆出正文\r\n分隔正文\r\n人工正文\r\n");
    assert.deepEqual((await f.store.get(target(f.original))).members, []);
    await assert.rejects(f.store.get(target(f.split)), code("not_found"));
    await assert.rejects(readFile(path.join(f.root, "split.md")), { code: "ENOENT" });
    assert.equal((await f.store.operation(f.input.operationId)).status, "rolled_back");
  } finally {
    await chmod(blocked, 0o700);
  }
});

test("普通补丁保持原请求 hash，不为可选协调字段补默认数组", async (t) => {
  const f = await fixture(t);
  const input = { operationId: randomUUID(), patch: patch("*** Add File: main.md", "+正文") };
  const result = await f.store.applyPatch(input);
  assert.equal(f.store.journal.entries.get(input.operationId)!.requestHash, digest(canonicalJson({ method: "patch", ...input })));
  assert.deepEqual(await f.store.applyPatch(input), result);
  const rpcInput = { spaceId: f.spaceId, operationId: randomUUID(), patch: patch("*** Add File: rpc.md", "+正文") };
  const rpcResult = await f.store.applyPatch(rpcInput);
  assert.equal(f.store.journal.entries.get(rpcInput.operationId)!.requestHash, digest(canonicalJson({ method: "patch", ...rpcInput })));
  assert.deepEqual(await f.store.applyPatch(rpcInput), rpcResult);
});
