import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { ContentPatchInput, ResourceRef } from "../src/content/schema.js";
import { ContentStore, type ContentPatchScope, type DerivedContentPatch } from "../src/content/store.js";
import { RepaFault } from "../src/errors.js";
import { digest } from "../src/storage/blobs.js";

const code = (expected: string) => (error: unknown) => error instanceof RepaFault && error.code === expected;
const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
const add = (file: string, text = "保存原文") => ({ patch: patch(`*** Add File: ${file}`, `+${text}`) });
function gate() {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function fixture(t: TestContext) {
  const work = await mkdtemp(path.join(os.tmpdir(), "repa-derived-patch-"));
  const root = path.join(work, "space");
  await mkdir(root);
  const spaceId = randomUUID();
  const stores: ContentStore[] = [];
  const open = async () => {
    const store = await ContentStore.open({ root, spaceId, assertOwned() {} });
    stores.push(store);
    return store;
  };
  const store = await open();
  t.after(async () => {
    await Promise.all(stores.map(item => item.settled()));
    await rm(work, { recursive: true, force: true });
  });
  return { root, spaceId, store, open };
}

async function absent(root: string, file: string) {
  await assert.rejects(readFile(path.join(root, file)), { code: "ENOENT" });
}

test("派生补丁按业务输入先去重，正文与本地时间改变和重开均不重复准备", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "current.txt"), "旧正文\n");
  const input = { operationId: randomUUID(), request: { intent: "保存判断", evidence: ["原始尝试"] } };
  let preparations = 0;
  let localTime = "第一次本地时间";
  const prepare = async (request: typeof input.request, scope: ContentPatchScope) => {
    preparations++;
    request.evidence.push("仅修改回调副本");
    const observed = await scope.read(f.store.target("current.txt"), 64);
    assert.equal(observed.bytes?.toString("utf8"), "旧正文\n");
    assert(observed.content.bodyRevision);
    return { patch: {
      patch: patch("*** Add File: judgment.txt", `+${localTime}`, "*** Update File: current.txt", "@@", "-旧正文", "+新正文"),
      bases: [{ target: observed.content.target, base: observed.content.bodyRevision }],
    } };
  };
  const result = await f.store.applyDerivedPatch(input, prepare);
  assert.deepEqual(input.request.evidence, ["原始尝试"]);
  await writeFile(path.join(f.root, "current.txt"), "后来外部正文\n");
  localTime = "第二次本地时间";
  assert.deepEqual(await f.store.applyDerivedPatch(input, prepare), result);
  const reopened = await f.open();
  assert.deepEqual(await reopened.applyDerivedPatch(input, prepare), result);
  assert.equal(preparations, 1);
  assert.equal(await readFile(path.join(f.root, "judgment.txt"), "utf8"), "第一次本地时间\n");
  assert.equal(await readFile(path.join(f.root, "current.txt"), "utf8"), "后来外部正文\n");
  await assert.rejects(reopened.applyDerivedPatch({ ...input, request: { ...input.request, intent: "不同判断" } }, prepare),
    code("operation_id_conflict"));
  assert.equal(preparations, 1);
});

test("同ID并发派生仅准备一次，历史清理保留墓碑而不重新计算", async t => {
  const f = await fixture(t);
  const entered = gate();
  const release = gate();
  const input = { operationId: randomUUID(), request: { intent: "一次派生" } };
  let preparations = 0;
  const prepare = async () => {
    preparations++;
    entered.release();
    await release.promise;
    return { patch: add("once.txt") };
  };
  const first = f.store.applyDerivedPatch(input, prepare);
  await entered.promise;
  const second = f.store.applyDerivedPatch(input, prepare);
  release.release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(preparations, 1);
  await f.store.pruneHistory([input.operationId]);
  const reopened = await f.open();
  await assert.rejects(reopened.applyDerivedPatch(input, prepare), code("history_pruned"));
  await assert.rejects(reopened.applyDerivedPatch({ ...input, request: { intent: "不同" } }, prepare), code("operation_id_conflict"));
  assert.equal(preparations, 1);
  assert.equal(await readFile(path.join(f.root, "once.txt"), "utf8"), "保存原文\n");
});

test("准备失败和返回的补丁失败均不留下文档身份，准备失败可按同原意重试", async t => {
  const f = await fixture(t);
  const input = { operationId: randomUUID(), request: { intent: "可重试准备" } };
  await assert.rejects(f.store.applyDerivedPatch(input, async () => { throw new RepaFault("invalid_input", "准备失败"); }), code("invalid_input"));
  assert.equal((await f.store.operation(input.operationId)).status, "unknown");
  await absent(f.root, "candidate.txt");
  const result = await f.store.applyDerivedPatch(input, async () => ({ patch: add("candidate.txt") }));
  assert.equal(result.operationId, input.operationId);
  const id = randomUUID();
  const resource: ResourceRef = { spaceId: f.spaceId, id: digest("未提交证据"), mediaType: "text/plain" };
  const failing = { operationId: randomUUID(), request: { intent: "无效登记" } };
  await assert.rejects(f.store.applyDerivedPatch(failing, async () => ({
    patch: { ...add("uncommitted.txt"), registrations: [{ path: "missing.txt", id, role: "document", resources: [resource] }] },
    resources: [Buffer.from("未提交证据")],
  })), code("not_found"));
  await absent(f.root, "uncommitted.txt");
  await assert.rejects(f.store.get({ kind: "content", ref: { spaceId: f.spaceId, id } }), code("not_found"));
  await f.store.collectResources();
  await assert.rejects(f.store.blobs.get(resource.id), code("revision_unavailable"));
});

test("派生资源与新文档登记共用提交队列，回收不能插入blob写入和owner登记之间", async t => {
  const f = await fixture(t);
  const bytes = Buffer.from("实际证据原文\n");
  const resource: ResourceRef = { spaceId: f.spaceId, id: digest(bytes), mediaType: "text/plain" };
  const id = randomUUID();
  const input = { operationId: randomUUID(), request: { intent: "保存证据" } };
  const stored = gate();
  const release = gate();
  const put = f.store.blobs.put.bind(f.store.blobs);
  t.mock.method(f.store.blobs, "put", async (value: Uint8Array | string) => {
    const hash = await put(value);
    if (hash === resource.id) {
      stored.release();
      await release.promise;
    }
    return hash;
  });
  const saving = f.store.applyDerivedPatch(input, async () => ({
    patch: { ...add("judgment.txt"), registrations: [{ path: "judgment.txt", id, role: "document", resources: [resource] }] },
    resources: [bytes],
  }));
  await stored.promise;
  const collecting = f.store.collectResources();
  release.release();
  await saving;
  await collecting;
  assert.deepEqual((await f.store.get({ kind: "content", ref: { spaceId: f.spaceId, id } })).resources, [resource]);
  assert.deepEqual(await f.store.blobs.get(resource.id), bytes);
  await f.store.pruneHistory([...f.store.journal.entries.keys()]);
  const reopened = await f.open();
  await reopened.collectResources();
  assert.deepEqual(await reopened.blobs.get(resource.id), bytes);
  assert.deepEqual((await reopened.get({ kind: "content", ref: { spaceId: f.spaceId, id } })).resources, [resource]);
});

test("派生scope读取受空间和字节上限约束，回调结束后读入口失效", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "source.txt"), "原始材料\n");
  const resource: ResourceRef = { spaceId: f.spaceId, id: await f.store.blobs.put("来源资源"), mediaType: "text/plain" };
  let captured: ContentPatchScope | undefined;
  await f.store.applyDerivedPatch({ operationId: randomUUID(), request: "读取材料" }, async (_request, scope) => {
    captured = scope;
    assert.deepEqual(Object.keys(scope).sort(), ["read", "readResource"]);
    const read = await scope.read(f.store.target("source.txt"), 64);
    assert.equal(read.bytes?.toString("utf8"), "原始材料\n");
    assert.equal(read.content.bodyRevision, digest("原始材料\n"));
    assert.equal((await scope.readResource(resource)).toString("utf8"), "来源资源");
    await assert.rejects(scope.read(f.store.target("source.txt"), 1), code("content_limit"));
    await assert.rejects(scope.read({ kind: "file", spaceId: randomUUID(), location: { kind: "relative", path: "source.txt" } }), code("invalid_input"));
    await assert.rejects(scope.readResource({ ...resource, spaceId: randomUUID() }), code("permission_required"));
    return { patch: add("read-result.txt") };
  });
  assert(captured);
  await assert.rejects(captured.read(f.store.target("source.txt")), code("closed"));
  await assert.rejects(captured.readResource(resource), code("closed"));
  const failed = { operationId: randomUUID(), request: "失败后也关闭" };
  await assert.rejects(f.store.applyDerivedPatch(failed, async (_request, scope) => {
    captured = scope;
    throw new RepaFault("invalid_input", "本地失败");
  }), code("invalid_input"));
  await assert.rejects(captured.readResource(resource), code("closed"));
});

test("回调退出前启动但未完成的scope资源读取不能在退出后返回数据", async t => {
  const f = await fixture(t);
  const resource: ResourceRef = { spaceId: f.spaceId, id: await f.store.blobs.put("延迟材料"), mediaType: "text/plain" };
  const release = gate();
  const get = f.store.blobs.get.bind(f.store.blobs);
  t.mock.method(f.store.blobs, "get", async (id: string) => {
    if (id === resource.id) await release.promise;
    return get(id);
  });
  let pending: Promise<Buffer> | undefined;
  await f.store.applyDerivedPatch({ operationId: randomUUID(), request: "不等待资源" }, async (_request, scope) => {
    pending = scope.readResource(resource);
    return { patch: add("local.txt") };
  });
  assert(pending);
  const rejected = assert.rejects(pending, code("closed"));
  release.release();
  await rejected;
});

test("回调不能覆盖operationId或返回非法资源，普通applyPatch仍使用独立原请求去重", async t => {
  const f = await fixture(t);
  const input = { operationId: randomUUID(), request: "业务原意" };
  const derived: DerivedContentPatch = { patch: add("invalid.txt") };
  Object.assign(derived.patch, { operationId: randomUUID() });
  await assert.rejects(f.store.applyDerivedPatch(input, async () => derived), code("invalid_input"));
  assert.equal((await f.store.operation(input.operationId)).status, "unknown");
  await absent(f.root, "invalid.txt");
  const malformed: DerivedContentPatch = { patch: add("invalid-resource.txt") };
  Object.assign(malformed, { resources: ["不是字节"] });
  await assert.rejects(f.store.applyDerivedPatch({ ...input, operationId: randomUUID() }, async () => malformed), code("invalid_input"));
  await absent(f.root, "invalid-resource.txt");
  const publicInput: ContentPatchInput = { operationId: input.operationId, ...add("public.txt") };
  const saved = await f.store.applyPatch(publicInput);
  assert.deepEqual(await f.store.applyPatch(publicInput), saved);
  let preparations = 0;
  await assert.rejects(f.store.applyDerivedPatch(input, async () => {
    preparations++;
    return { patch: add("never.txt") };
  }), code("operation_id_conflict"));
  assert.equal(preparations, 0);
  const derivedInput = { operationId: randomUUID(), request: "另一业务原意" };
  await f.store.applyDerivedPatch(derivedInput, async () => ({ patch: add("derived.txt") }));
  await assert.rejects(f.store.applyPatch({ operationId: derivedInput.operationId, ...add("derived.txt") }), code("operation_id_conflict"));
});

test("派生提交实际文件和清单写入失败时journal回滚，重开重传失败回执不重新准备", async t => {
  const f = await fixture(t);
  const input = { operationId: randomUUID(), request: "可恢复提交" };
  const id = randomUUID();
  const persist = f.store.journal.persist.bind(f.store.journal);
  let preparations = 0;
  let interrupted = false;
  t.mock.method(f.store.journal, "persist", async (entry: Parameters<typeof persist>[0]) => {
    if (entry.operationId === input.operationId && entry.status === "committed" && !interrupted) {
      interrupted = true;
      throw new Error("模拟最终提交确认落盘失败");
    }
    return persist(entry);
  });
  const prepare = async () => {
    preparations++;
    return { patch: { ...add("rollback.txt"), registrations: [{ path: "rollback.txt", id, role: "document" as const }] } };
  };
  await assert.rejects(f.store.applyDerivedPatch(input, prepare), code("storage"));
  assert(interrupted);
  await absent(f.root, "rollback.txt");
  await assert.rejects(f.store.get({ kind: "content", ref: { spaceId: f.spaceId, id } }), code("not_found"));
  assert.equal((await f.store.operation(input.operationId)).status, "rolled_back");
  const reopened = await f.open();
  await assert.rejects(reopened.applyDerivedPatch(input, prepare), code("storage"));
  assert.equal(preparations, 1);
  assert.equal((await reopened.operation(input.operationId)).status, "rolled_back");
});

test("派生原意必须是无损JSON，非法输入不进入prepare，合法嵌套空值保持区别", async t => {
  const f = await fixture(t);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const invalid: unknown[] = [new Date(0), new Map(), new Set(), NaN, Infinity, -Infinity, cycle, 1n,
    undefined, { value: undefined }, [undefined]];
  let preparations = 0;
  for (const request of invalid) {
    await assert.rejects(f.store.applyDerivedPatch({ operationId: randomUUID(), request }, async () => {
      preparations++;
      return { patch: add("invalid-json.txt") };
    }), code("invalid_input"));
  }
  assert.equal(preparations, 0);
  await absent(f.root, "invalid-json.txt");
  const input = { operationId: randomUUID(), request: { empty: "", absent: null, array: [], object: {},
    nested: [false, 0, { value: "原文" }] } };
  const saved = await f.store.applyDerivedPatch(input, async request => {
    preparations++;
    assert.deepEqual(request, input.request);
    return { patch: add("json.txt") };
  });
  assert.deepEqual(await f.store.applyDerivedPatch(input, async () => { assert.fail("重传不应重新准备"); }), saved);
  await assert.rejects(f.store.applyDerivedPatch({ ...input, request: { ...input.request, absent: "" } }, async () => {
    assert.fail("不同JSON原意不应进入准备");
  }), code("operation_id_conflict"));
  assert.equal(preparations, 1);
});
