import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { ContentPatchInput, ContentRef, ResourceRef } from "../src/content/schema.js";
import { ContentStore, canonicalJson } from "../src/content/store.js";
import { RepaFault } from "../src/errors.js";
import { digest } from "../src/storage/blobs.js";

const original = "{\n  \"current\": null,\n  \"note\": \"original\"\n}\n";
const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
const target = (ref: ContentRef) => ({ kind: "content" as const, ref });
const code = (expected: string) => (error: unknown) => error instanceof RepaFault && error.code === expected;

async function fixture(t: TestContext) {
  const work = await mkdtemp(path.join(os.tmpdir(), "repa-patch-bases-"));
  const root = path.join(work, "space");
  await mkdir(root);
  const spaceId = randomUUID();
  const stores: ContentStore[] = [];
  const open = async () => {
    const store = await ContentStore.open({ root, spaceId, assertOwned() {},
      canReadExternal: file => file.startsWith(`${work}${path.sep}`) });
    stores.push(store);
    return store;
  };
  const store = await open();
  t.after(async () => {
    await Promise.all(stores.map(item => item.settled()));
    await rm(work, { recursive: true, force: true });
  });
  await writeFile(path.join(root, "current.json"), original);
  const registered = await store.associate({ location: { kind: "relative", path: "current.json" },
    role: "document", operationId: randomUUID() });
  const current = registered.contents[0]?.ref;
  assert(current);
  return { work, root, spaceId, store, current, open };
}

async function change(store: ContentStore, current: ContentRef, file = "judgment.json", resources: ResourceRef[] = []) {
  const observed = await store.get(target(current));
  assert(observed.bodyRevision && observed.revision);
  const judgment = { spaceId: current.spaceId, id: randomUUID() };
  const input: ContentPatchInput = {
    operationId: randomUUID(),
    patch: patch("*** Add File: " + file, "+{\"result\":\"candidate\"}",
      "*** Update File: current.json", "@@", "-  \"current\": null,", `+  "current": "${judgment.id}",`),
    bases: [{ target: target(current), base: observed.bodyRevision }],
    registrations: [{ path: file, role: "document", id: judgment.id, resources }],
    compositions: [{ ref: current, base: observed.revision, members: [{ target: target(judgment) }], resources: [] }],
  };
  return { input, judgment, observed };
}

async function absent(root: string, file: string) {
  await assert.rejects(readFile(path.join(root, file)), { code: "ENOENT" });
}

async function unchanged(f: Awaited<ReturnType<typeof fixture>>, input: ContentPatchInput) {
  assert.equal(await readFile(path.join(f.root, "current.json"), "utf8"), original);
  await absent(f.root, "unexpected.json");
  assert.equal((await f.store.operation(input.operationId)).status, "unknown");
}

test("正文改变但结构修订不变时，旧正文基准拒绝整个补丁且不登记新文档资源", async t => {
  const f = await fixture(t);
  const resource = { spaceId: f.spaceId, id: await f.store.blobs.put("原始证据"), mediaType: "text/plain" };
  const { input, judgment, observed } = await change(f.store, f.current, "judgment.json", [resource]);
  const external = original.replace('"original"', '"external"');
  await writeFile(path.join(f.root, "current.json"), external);
  const changed = await f.store.get(target(f.current));
  assert.equal(changed.revision, observed.revision);
  assert.notEqual(changed.bodyRevision, observed.bodyRevision);
  await assert.rejects(f.store.applyPatch(input), code("revision_conflict"));
  assert.equal(await readFile(path.join(f.root, "current.json"), "utf8"), external);
  await absent(f.root, "judgment.json");
  await assert.rejects(f.store.get(target(judgment)), code("not_found"));
  assert.deepEqual((await f.store.get(target(f.current))).members, []);
  assert.equal((await f.store.operation(input.operationId)).status, "unknown");
});

test("正文基准与证据资源同次保存，重开重传返回旧回执，清理历史后文档仍持有证据", async t => {
  const f = await fixture(t);
  const resource = { spaceId: f.spaceId, id: await f.store.blobs.put("需要长期保留的证据"), mediaType: "text/plain" };
  const { input, judgment } = await change(f.store, f.current, "judgment.json", [resource]);
  const result = await f.store.applyPatch(input);
  assert.equal(result.changes.length, 2);
  assert.deepEqual((await f.store.get(target(judgment))).resources, [resource]);
  assert.deepEqual((await f.store.get(target(f.current))).members, [{ target: target(judgment) }]);
  assert.deepEqual(await f.store.applyPatch(input), result);
  const reopened = await f.open();
  assert.deepEqual(await reopened.applyPatch(input), result, "当前正文已变，旧提交应先去重而不是重新校验基准");
  const current = await reopened.get(target(f.current));
  assert(current.bodyRevision);
  const different = { ...input, bases: [{ target: target(f.current), base: current.bodyRevision }] };
  await assert.rejects(reopened.applyPatch(different), code("operation_id_conflict"));
  await reopened.pruneHistory([...reopened.journal.entries.keys()]);
  await assert.rejects(reopened.applyPatch(input), code("history_pruned"));
  await assert.rejects(reopened.applyPatch(different), code("operation_id_conflict"));
  await reopened.collectResources();
  assert.equal((await reopened.blobs.get(resource.id)).toString("utf8"), "需要长期保留的证据");
  assert.deepEqual((await reopened.get(target(judgment))).resources, [resource]);
});

test("两个共享旧正文基准的竞争补丁仅一个完成，失败者不留下新文档", async t => {
  const f = await fixture(t);
  const a = await change(f.store, f.current, "a.json");
  const b = await change(f.store, f.current, "b.json");
  // 未改动的锚点让第二项仍能准备文本，失败必须由旧正文基准判定，而非旧行匹配。
  for (const item of [a, b]) item.input.patch = patch(`*** Add File: ${item === a ? "a.json" : "b.json"}`,
    "+{\"result\":\"candidate\"}", "*** Update File: current.json", '@@   "note": "original"',
    `+  , "candidate": "${item.judgment.id}"`);
  const results = await Promise.allSettled([f.store.applyPatch(a.input), f.store.applyPatch(b.input)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  for (const [index, result] of results.entries()) {
    const candidate = index === 0 ? a : b;
    if (result.status === "fulfilled") {
      assert((await f.store.get(target(candidate.judgment))).ref);
      assert((await readFile(path.join(f.root, "current.json"), "utf8")).includes(candidate.judgment.id));
    } else {
      assert(code("revision_conflict")(result.reason));
      await absent(f.root, index === 0 ? "a.json" : "b.json");
      await assert.rejects(f.store.get(target(candidate.judgment)), code("not_found"));
    }
  }
});

test("移动按内容身份的原位置校验源正文，目的仍要求不存在，重传不重读已移动源", async t => {
  const f = await fixture(t);
  const observed = await f.store.get(target(f.current));
  assert(observed.bodyRevision);
  const input: ContentPatchInput = { operationId: randomUUID(),
    patch: patch("*** Update File: current.json", "*** Move to: moved.json"),
    bases: [{ target: target(f.current), base: observed.bodyRevision },
      { target: f.store.target("moved.json"), base: { kind: "absent" } }] };
  const external = original.replace('"original"', '"changed"');
  await writeFile(path.join(f.root, "current.json"), external);
  await assert.rejects(f.store.applyPatch(input), code("revision_conflict"));
  await absent(f.root, "moved.json");
  const latest = await f.store.get(target(f.current));
  assert(latest.bodyRevision);
  const correct = { ...input, operationId: randomUUID(), bases: [
    { target: target(f.current), base: latest.bodyRevision },
    { target: f.store.target("moved.json"), base: { kind: "absent" as const } },
  ] };
  await writeFile(path.join(f.root, "moved.json"), "被其他文件占用");
  await assert.rejects(f.store.applyPatch(correct), code("revision_conflict"));
  assert.equal(await readFile(path.join(f.root, "moved.json"), "utf8"), "被其他文件占用");
  await rm(path.join(f.root, "moved.json"));
  const result = await f.store.applyPatch(correct);
  await absent(f.root, "current.json");
  assert.equal(await readFile(path.join(f.root, "moved.json"), "utf8"), external);
  assert.equal((await f.store.get(target(f.current))).location.path, "moved.json");
  assert.deepEqual(await f.store.applyPatch(correct), result);
});

test("基准按规范文件去重，内容身份与路径别名不能给同一目标重复基准", async t => {
  const f = await fixture(t);
  const { input } = await change(f.store, f.current);
  const base = input.bases?.[0]?.base;
  assert(base);
  await assert.rejects(f.store.applyPatch({ ...input, bases: [
    { target: target(f.current), base }, { target: f.store.target("./part/../current.json"), base },
  ] }), code("invalid_input"));
  await absent(f.root, "judgment.json");
  const result = await f.store.applyPatch({ ...input, operationId: randomUUID(),
    bases: [{ target: f.store.target("./part/../current.json"), base }] });
  assert.equal(result.changes.length, 2);
});

test("符号链接路径和真实文件使用同一正文基准，不改写别名本身", async t => {
  if (process.platform === "win32") { t.skip("Windows 创建符号链接需要额外权限"); return; }
  const f = await fixture(t);
  await symlink("current.json", path.join(f.root, "alias.json"));
  const { input } = await change(f.store, f.current);
  input.patch = input.patch.replace("*** Update File: current.json", "*** Update File: alias.json");
  const result = await f.store.applyPatch(input);
  assert.equal(result.changes.find(item => item.before !== null)?.path, "current.json");
  assert.equal(await readlink(path.join(f.root, "alias.json")), "current.json");
  assert.equal(await readFile(path.join(f.root, "alias.json"), "utf8"), await readFile(path.join(f.root, "current.json"), "utf8"));
});

test("未修改、空补丁、仅登记组成及no-op不接受正文基准，目录与跨界目标也不能绕过", async t => {
  const f = await fixture(t);
  const info = await f.store.get(target(f.current));
  assert(info.bodyRevision && info.revision);
  await writeFile(path.join(f.root, "unregistered.json"), "已有文件");
  await mkdir(path.join(f.root, "folder"));
  const outside = path.join(f.work, "outside.json");
  await writeFile(outside, "可读的外部材料");
  const body = { target: target(f.current), base: info.bodyRevision };
  const adding = patch("*** Add File: unexpected.json", "+不能留下");
  const cases: Array<{ input: ContentPatchInput; error: string }> = [
    { input: { operationId: randomUUID(), patch: adding, bases: [body] }, error: "invalid_input" },
    { input: { operationId: randomUUID(), patch: patch(), bases: [body] }, error: "invalid_input" },
    { input: { operationId: randomUUID(), patch: patch(), bases: [body],
      registrations: [{ path: "unregistered.json", role: "document" }] }, error: "invalid_input" },
    { input: { operationId: randomUUID(), patch: patch(), bases: [body],
      compositions: [{ ref: f.current, base: info.revision, members: [], resources: [] }] }, error: "invalid_input" },
    { input: { operationId: randomUUID(), bases: [body],
      patch: patch("*** Update File: current.json", "@@", '-  "current": null,', '+  "current": null,') }, error: "invalid_input" },
    { input: { operationId: randomUUID(), patch: adding,
      bases: [{ target: f.store.target("folder"), base: { kind: "absent" } }] }, error: "invalid_input" },
    { input: { operationId: randomUUID(), patch: adding,
      bases: [{ target: target({ ...f.current, spaceId: randomUUID() }), base: info.bodyRevision }] }, error: "invalid_input" },
    { input: { operationId: randomUUID(), patch: adding,
      bases: [{ target: { kind: "file", spaceId: f.spaceId, location: { kind: "external", path: outside } }, base: digest("可读的外部材料") }] }, error: "permission_required" },
    { input: { operationId: randomUUID(), patch: adding,
      bases: [{ target: f.store.target("../outside.json"), base: digest("可读的外部材料") }] }, error: "permission_required" },
  ];
  for (const item of cases) {
    await assert.rejects(f.store.applyPatch(item.input), code(item.error));
    await unchanged(f, item.input);
  }
  assert.equal((await f.store.get(f.store.target("unregistered.json"))).ref, undefined);
  assert.deepEqual((await f.store.get(target(f.current))).members, []);
});

test("正文基准通过后到commit之间的外部修改仍拒绝，不把更新正文当成新before", async t => {
  const f = await fixture(t);
  const { input, judgment } = await change(f.store, f.current);
  const commit = f.store.journal.commit.bind(f.store.journal);
  const external = original.replace('"original"', '"during-prepare"');
  t.mock.method(f.store.journal, "commit", async (params: Parameters<typeof commit>[0]) => {
    await writeFile(path.join(f.root, "current.json"), external);
    return commit(params);
  });
  await assert.rejects(f.store.applyPatch(input), code("revision_conflict"));
  assert.equal(await readFile(path.join(f.root, "current.json"), "utf8"), external);
  await absent(f.root, "judgment.json");
  await assert.rejects(f.store.get(target(judgment)), code("not_found"));
  assert.equal((await f.store.operation(input.operationId)).status, "unknown");
});

test("准备读到旧字节后发生外部修改，不得再次观察并把新正文接纳为合法before", async t => {
  const f = await fixture(t);
  const { input, judgment } = await change(f.store, f.current);
  const snapshot = f.store.journal.snapshot.bind(f.store.journal);
  const external = original.replace('"original"', '"after-observation"');
  let changed = false;
  t.mock.method(f.store.journal, "snapshot", async (relative: string, retain = true) => {
    const observed = await snapshot(relative, retain);
    if (relative === "current.json" && !changed) {
      changed = true;
      await writeFile(path.join(f.root, "current.json"), external);
    }
    return observed;
  });
  await assert.rejects(f.store.applyPatch(input), code("revision_conflict"));
  assert(changed);
  assert.equal(await readFile(path.join(f.root, "current.json"), "utf8"), external);
  await absent(f.root, "judgment.json");
  await assert.rejects(f.store.get(target(judgment)), code("not_found"));
  assert.equal((await f.store.operation(input.operationId)).status, "unknown");
});

test("带正文基准的实际文件与清单写入失败由journal全部回滚，重开不重做失败操作", async t => {
  const f = await fixture(t);
  const { input, judgment } = await change(f.store, f.current);
  const persist = f.store.journal.persist.bind(f.store.journal);
  let interrupted = false;
  t.mock.method(f.store.journal, "persist", async (entry: Parameters<typeof persist>[0]) => {
    if (entry.operationId === input.operationId && entry.status === "committed" && !interrupted) {
      interrupted = true;
      throw new Error("模拟最终提交确认落盘失败");
    }
    return persist(entry);
  });
  await assert.rejects(f.store.applyPatch(input), code("storage"));
  assert(interrupted);
  assert.equal(await readFile(path.join(f.root, "current.json"), "utf8"), original);
  await absent(f.root, "judgment.json");
  await assert.rejects(f.store.get(target(judgment)), code("not_found"));
  assert.deepEqual((await f.store.get(target(f.current))).members, []);
  assert.equal((await f.store.operation(input.operationId)).status, "rolled_back");
  const reopened = await f.open();
  await assert.rejects(reopened.applyPatch(input), code("storage"));
  assert.equal((await reopened.operation(input.operationId)).status, "rolled_back");
});

test("带基准的成功操作可撤回，prepared重开回滚仍按实际前后图像而非重跑基准", async t => {
  const f = await fixture(t);
  const first = await change(f.store, f.current);
  await f.store.applyPatch(first.input);
  await f.store.undo({ operationId: first.input.operationId, undoOperationId: randomUUID() });
  assert.equal(await readFile(path.join(f.root, "current.json"), "utf8"), original);
  await absent(f.root, "judgment.json");
  assert.equal((await f.store.get(target(first.judgment))).status, "missing");
  const second = await change(f.store, f.current, "second.json");
  await f.store.applyPatch(second.input);
  const entry = f.store.journal.entries.get(second.input.operationId);
  assert(entry);
  await f.store.journal.persist({ ...entry, status: "prepared" });
  const reopened = await f.open();
  assert.equal((await reopened.operation(second.input.operationId)).status, "rolled_back");
  assert.equal(await readFile(path.join(f.root, "current.json"), "utf8"), original);
  await absent(f.root, "second.json");
  await assert.rejects(reopened.get(target(second.judgment)), code("not_found"));
  assert.deepEqual((await reopened.get(target(f.current))).members, []);
});

test("省略bases的历史请求hash和回执不变，后来补空bases也属于不同载荷", async t => {
  const f = await fixture(t);
  const input: ContentPatchInput = { operationId: randomUUID(), patch: patch("*** Add File: legacy.txt", "+旧形状") };
  const result = await f.store.applyPatch(input);
  assert.equal(f.store.journal.entries.get(input.operationId)?.requestHash, digest(canonicalJson({ method: "patch", ...input })));
  const reopened = await f.open();
  assert.deepEqual(await reopened.applyPatch(input), result);
  await assert.rejects(reopened.applyPatch({ ...input, bases: [] }), code("operation_id_conflict"));
});
