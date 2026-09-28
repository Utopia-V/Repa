import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DEFAULT_MAX_BYTES, generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { FileChanges } from "../src/agent/file-changes.js";
import { ContentStore } from "../src/content/store.js";

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "repa-file-changes-"));
  const root = path.join(temporary, "space");
  await mkdir(root);
  const content = await ContentStore.open({ root, spaceId: randomUUID(), assertOwned() {} });
  const tracker = new FileChanges(content);
  const file = (name: string) => path.join(root, name);
  const observe = async (name: string, complete = true, using = tracker) => {
    const snapshot = await content.readForTool(name);
    using.recordRead(snapshot.content, snapshot.bytes, complete);
    return snapshot;
  };
  t.after(async () => { await content.settled(); await rm(temporary, { recursive: true, force: true }); });
  return { temporary, content, tracker, file, observe };
}

function changes(message: { details: unknown } | undefined) {
  assert(message);
  return (message.details as { changes: { path: string; kind: string; reason?: string; before: string | null; after: string | null }[] }).changes;
}

test("on-demand 不读取或消耗变化，notice 只报告当前 Host 观察过的路径并逐次更新基准", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file("known.md"), "old private body\n");
  await writeFile(f.file("unseen.md"), "unseen old\n");
  await f.observe("known.md");
  await writeFile(f.file("known.md"), "new private body\n");
  await writeFile(f.file("unseen.md"), "unseen new\n");
  const otherHost = new FileChanges(f.content);
  await f.observe("known.md", true, otherHost);
  const get = f.content.get.bind(f.content);
  const reads: string[] = [];
  f.content.get = async (target) => {
    reads.push(target.kind === "file" ? target.location.path : target.ref.id);
    return get(target);
  };
  assert.equal(await f.tracker.prepare("on-demand"), undefined);
  assert.deepEqual(reads, []);
  const notice = await f.tracker.prepare("notice");
  assert.deepEqual(changes(notice).map((change) => [change.path, change.kind]), [["known.md", "notice"]]);
  assert(!notice!.text.includes("private body"));
  assert(!notice!.text.includes("unseen.md"));
  assert.deepEqual(reads, ["known.md"]);
  assert.equal(await f.tracker.prepare("notice"), undefined);
  assert.equal(await otherHost.prepare("diff"), undefined);
  await writeFile(f.file("known.md"), "third private body\n");
  const next = await f.tracker.prepare("diff");
  assert.equal(changes(next)[0]!.kind, "notice");
  assert.equal(changes(next)[0]!.reason, "partial");
});

test("完整已知文本复用 Pi 的 unified patch，已提供差异成为下一次差异的基准", async (t) => {
  const f = await fixture(t);
  const first = "标题\r\n值 = one\r\n结束\r\n";
  const second = "标题\r\n值 = two\r\n结束\r\n";
  const third = "标题\r\n值 = two\r\n新增 = three\r\n结束\r\n";
  await writeFile(f.file("notes.md"), first);
  await f.observe("notes.md");
  // 同一版本的片段读取不会撤销模型已经知道的完整正文。
  await f.observe("notes.md", false);
  await writeFile(f.file("notes.md"), second);
  const change = await f.tracker.prepare("diff");
  assert.equal(changes(change)[0]!.kind, "diff");
  assert(change!.text.includes(generateUnifiedPatch("notes.md", first, second)));
  assert.equal(await f.tracker.prepare("diff"), undefined);
  await writeFile(f.file("notes.md"), third);
  const following = await f.tracker.prepare("diff");
  assert(following!.text.includes(generateUnifiedPatch("notes.md", second, third)));
  assert.equal(await f.tracker.prepare("diff"), undefined);
});

test("片段读取和仅内部取得的新全文不产生完整知识，全写已知内容可显式建立新基准", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file("partial.md"), "first\nsecond\nthird\n");
  await f.observe("partial.md", false);
  const edited = await f.content.edit({
    target: f.content.target("partial.md"), edits: [{ oldText: "first", newText: "own" }], operationId: randomUUID(),
  });
  await f.tracker.recordSaved(edited);
  assert.equal(await f.tracker.prepare("diff"), undefined);
  await writeFile(f.file("partial.md"), "own\nexternal\nthird\n");
  const notice = await f.tracker.prepare("diff");
  assert.equal(changes(notice)[0]!.kind, "notice");
  assert(!notice!.text.includes("external"));
  await writeFile(f.file("partial.md"), "own\nexternal again\nthird\n");
  assert.equal(changes(await f.tracker.prepare("diff"))[0]!.kind, "notice");

  const current = await f.content.get(f.content.target("partial.md"));
  const known = "整篇新文\n";
  const saved = await f.content.write({
    target: current.target, value: { kind: "text", text: known }, base: current.bodyRevision!, operationId: randomUUID(),
  });
  await f.tracker.recordSaved(saved);
  f.tracker.recordRead(saved.contents[0]!, Buffer.from(known), true);
  await writeFile(f.file("partial.md"), "整篇新文\n后续外部修改\n");
  const diff = await f.tracker.prepare("diff");
  assert.equal(changes(diff)[0]!.kind, "diff");
  assert(diff!.text.includes(generateUnifiedPatch("partial.md", known, "整篇新文\n后续外部修改\n")));
});

test("保存回调只排除工具实际报告的版本，不吞掉回调前后的外部变化", async (t) => {
  const f = await fixture(t);
  const original = "agent = old\nexternal = old\n";
  const own = "agent = own\nexternal = old\n";
  const later = "agent = own\nexternal = later\n";
  await writeFile(f.file("notes.md"), original);
  await f.observe("notes.md");
  const saved = await f.content.edit({
    target: f.content.target("notes.md"), edits: [{ oldText: "agent = old", newText: "agent = own" }], operationId: randomUUID(),
  });
  await writeFile(f.file("notes.md"), later);
  const get = f.content.get.bind(f.content), blob = f.content.blobs.get.bind(f.content.blobs);
  f.content.get = async () => { throw new Error("recordSaved 不应额外读取当前文件"); };
  f.content.blobs.get = async () => { throw new Error("recordSaved 不应额外读取版本"); };
  await f.tracker.recordSaved(saved);
  assert.equal(await f.tracker.prepare("on-demand"), undefined);
  f.content.get = get;
  f.content.blobs.get = blob;
  const message = await f.tracker.prepare("diff");
  assert.equal(changes(message)[0]!.kind, "diff");
  assert(message!.text.includes(generateUnifiedPatch("notes.md", own, later)));
  assert(!message!.text.includes("+agent = own"));

  // 外部先改了未告知的部分，再发生自身局部编辑时，也不能静默认作已知全文。
  await writeFile(f.file("notes.md"), "agent = own\nexternal = unseen\n");
  const afterUnseen = await f.content.edit({
    target: f.content.target("notes.md"), edits: [{ oldText: "agent = own", newText: "agent = next" }], operationId: randomUUID(),
  });
  await f.tracker.recordSaved(afterUnseen);
  const notice = await f.tracker.prepare("diff");
  assert.equal(changes(notice)[0]!.kind, "notice");
  assert.match(notice!.text, /工具保存前已有其他变化/);
  assert.equal(await f.tracker.prepare("diff"), undefined);
});

test("二进制、过大正文或差异及缺失文件都退回路径提示，恢复后仍按实际观察报告", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file("binary.bin"), Buffer.from([0xff, 0x00, 1]));
  await writeFile(f.file("large.md"), "a".repeat(DEFAULT_MAX_BYTES + 1));
  await writeFile(f.file("large-diff.md"), "a".repeat(30_000) + "\n");
  await writeFile(f.file("gone.md"), "known\n");
  for (const name of ["binary.bin", "large.md", "large-diff.md", "gone.md"]) await f.observe(name);
  await writeFile(f.file("binary.bin"), Buffer.from([0xff, 0x00, 2]));
  await writeFile(f.file("large.md"), "b".repeat(DEFAULT_MAX_BYTES + 1));
  await writeFile(f.file("large-diff.md"), "b".repeat(30_000) + "\n");
  await rm(f.file("gone.md"));
  const message = await f.tracker.prepare("diff");
  assert.equal(changes(message).length, 4);
  assert(changes(message).every((change) => change.kind === "notice"));
  assert.match(message!.text, /文件已不存在/);
  assert(Buffer.byteLength(message!.text) <= DEFAULT_MAX_BYTES);
  assert.equal(await f.tracker.prepare("diff"), undefined);
  await writeFile(f.file("gone.md"), "restored\n");
  const restored = await f.tracker.prepare("diff");
  assert.deepEqual(changes(restored).map((change) => [change.path, change.kind]), [["gone.md", "notice"]]);
});

test("空间外 Skill 资源不进入自动跟踪，不借用一次工具读取的临时权限", async (t) => {
  const f = await fixture(t);
  const skill = path.join(f.temporary, "skill");
  await mkdir(skill);
  const file = path.join(skill, "SKILL.md");
  await writeFile(file, "skill one\n");
  const snapshot = await f.content.readForTool(file, [skill]);
  assert.equal(snapshot.content.location.kind, "external");
  f.tracker.recordRead(snapshot.content, snapshot.bytes, true);
  await writeFile(file, "skill two\n");
  f.content.get = async () => { throw new Error("不应再次读取空间外 Skill"); };
  assert.equal(await f.tracker.prepare("diff"), undefined);
});
