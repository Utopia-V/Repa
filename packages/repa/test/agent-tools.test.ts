import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionContext, ResourceLoader, Skill } from "@earendil-works/pi-coding-agent";
import { createContentTools } from "../src/agent/tools.js";
import { ContentStore } from "../src/content/store.js";
import { RepaFault } from "../src/errors.js";
import { digest } from "../src/storage/blobs.js";

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "repa-agent-tools-"));
  const root = path.join(temporary, "space");
  const skill = path.join(temporary, "skill");
  await mkdir(root);
  await mkdir(skill);
  let roots = [skill];
  const loader = {
    getSkills: () => ({
      skills: roots.map((baseDir): Skill => ({
        name: path.basename(baseDir), description: "测试资源", baseDir,
        filePath: path.join(baseDir, "SKILL.md"), disableModelInvocation: false,
        sourceInfo: {} as Skill["sourceInfo"],
      })),
      diagnostics: [],
    }),
  } as unknown as ResourceLoader;
  const store = await ContentStore.open({ root, spaceId: randomUUID(), assertOwned() {} });
  const tools = await createContentTools(root, store, loader);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const ctx = { model: undefined } as ExtensionContext;
  const call = (name: string, parameters: unknown, signal?: AbortSignal) =>
    byName.get(name)!.execute("model-call", parameters, signal, undefined, ctx);
  t.after(async () => { await store.settled(); await rm(temporary, { recursive: true, force: true }); });
  return {
    temporary, root, skill, store, tools, loader, call,
    enable: (value: string[]) => { roots = value; },
    file: (name: string) => path.join(root, name),
  };
}

const code = (expected: string) => (error: unknown) => error instanceof RepaFault && error.code === expected;
const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");

test("Pi 分页读取提供正文修订，部分观察足够保护覆盖与连续自行保存", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file("notes.md"), "first\nsecond\nthird");
  await assert.rejects(f.call("write", { path: "notes.md", content: "blind" }), code("read_required"));
  const read = await f.call("read", { path: "notes.md", limit: 1 });
  assert.match(textOf(read), /^first\n\n\[2 more lines in file\. Use offset=2 to continue\.\]$/);
  assert.equal(read.details.bodyRevision, digest("first\nsecond\nthird"));
  const first = await f.call("write", { path: "notes.md", content: "保存一次\r\n" });
  const second = await f.call("write", { path: "notes.md", content: "保存两次\r\n" });
  assert.equal(await readFile(f.file("notes.md"), "utf8"), "保存两次\r\n");
  assert.equal(first.details.bodyRevision, digest("保存一次\r\n"));
  assert.equal(second.details.bodyRevision, digest("保存两次\r\n"));
  assert.notEqual(first.details.operationId, second.details.operationId);
  assert.equal((await f.store.operation(second.details.operationId)).status, "committed");
  const created = await f.call("write", { path: "new/note.md", content: "new" });
  assert.equal(await readFile(f.file("new/note.md"), "utf8"), "new");
  assert.equal(created.details.bodyRevision, digest("new"));
  const unchanged = await f.call("write", { path: "new/note.md", content: "new" });
  assert.equal(unchanged.details.bodyRevision, digest("new"));
  const other = await createContentTools(f.root, f.store, f.loader);
  await assert.rejects(other.find((tool) => tool.name === "write")!.execute(
    "another-session", { path: "notes.md", content: "unobserved" }, undefined, undefined, {} as ExtensionContext,
  ), code("read_required"));
});

test("read 的格式化使用同一份快照，外部写入不会被更新后的保存基准掩盖", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file("notes.md"), "observed\nsecond");
  const read = f.store.readForTool.bind(f.store);
  let reads = 0;
  f.store.readForTool = async (...args) => {
    reads++;
    const snapshot = await read(...args);
    await writeFile(f.file("notes.md"), "external\nsecond");
    return snapshot;
  };
  const result = await f.call("read", { path: "notes.md", limit: 1 });
  assert.equal(reads, 1);
  assert.match(textOf(result), /^observed\n/);
  assert.equal(result.details.bodyRevision, digest("observed\nsecond"));
  await assert.rejects(f.call("write", { path: "notes.md", content: "overwrite" }), code("revision_conflict"));
  assert.equal(await readFile(f.file("notes.md"), "utf8"), "external\nsecond");
});

test("edit 不要求全文读取，精确片段保存真实差异并保留其他字符与换行", async (t) => {
  const f = await fixture(t);
  const before = "①Ａ — “保留”\r\nvalue = old\nlast";
  const after = "①Ａ — “保留”\r\nvalue = new\nlast";
  await writeFile(f.file("notes.md"), before);
  const result = await f.call("edit", { path: "notes.md", edits: [{ oldText: "value = old", newText: "value = new" }] });
  assert.equal(await readFile(f.file("notes.md"), "utf8"), after);
  assert.equal(result.details.bodyRevision, digest(after));
  assert.match(result.details.patch, /-value = old\n\+value = new/);
  assert.match(result.details.diff, /value = new/);
  await f.call("write", { path: "notes.md", content: "rewrite after own edit" });
  await writeFile(f.file("ambiguous.md"), "same\nsame");
  await assert.rejects(f.call("edit", { path: "ambiguous.md", edits: [{ oldText: "same", newText: "new" }] }), code("ambiguous_match"));
  assert.equal(await readFile(f.file("ambiguous.md"), "utf8"), "same\nsame");
  await writeFile(f.file("unchanged.md"), "same");
  const unchanged = await f.call("edit", { path: "unchanged.md", edits: [{ oldText: "same", newText: "same" }] });
  assert.equal(unchanged.details.bodyRevision, digest("same"));
  await f.call("write", { path: "unchanged.md", content: "observed through edit" });
});

test("内容引用保持原样解析，路径与身份共用观察，补丁移动后仍可连续保存", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file("old.md"), "registered\nbody");
  await f.call("read", { path: "old.md", limit: 1 });
  const association = await f.store.associate({ location: { kind: "relative", path: "old.md" }, role: "document", operationId: randomUUID() });
  const ref = association.contents[0]!.ref!;
  const uri = `repa:document/${ref.id}`;
  await f.call("write", { path: uri, content: "reference write\nbody" });
  const read = await f.call("read", { path: uri, limit: 1 });
  assert.match(textOf(read), /^reference write/);
  assert.equal(read.details.path, uri);
  assert.equal(read.details.content.ref.id, ref.id);
  const patched = await f.call("apply_patch", { patch: "*** Begin Patch\n*** Update File: old.md\n*** Move to: moved.md\n@@\n-reference write\n+patched\n body\n*** Add File: added.md\n+added\n*** End Patch" });
  assert.equal((await f.store.operation(patched.details.operationId)).status, "committed");
  assert.equal(patched.details.bodyRevisions["moved.md"], digest("patched\nbody"));
  await f.call("write", { path: uri, content: "after move" });
  assert.equal(await readFile(f.file("moved.md"), "utf8"), "after move");
  await assert.rejects(readFile(f.file("old.md")), { code: "ENOENT" });
  await f.call("write", { path: "added.md", content: "own patch addition" });
  assert.equal(await readFile(f.file("added.md"), "utf8"), "own patch addition");
  await f.call("apply_patch", { patch: "*** Begin Patch\n*** Delete File: moved.md\n*** End Patch" });
  const replacement = await f.call("write", { path: "moved.md", content: "new object" });
  assert.equal(replacement.details.bodyRevision, digest("new object"));
  await f.call("write", { path: "moved.md", content: "second save of new object" });
  assert.equal(await readFile(f.file("moved.md"), "utf8"), "second save of new object");
  const unchanged = await f.call("write", { path: "moved.md", content: "second save of new object" });
  assert.equal(unchanged.details.bodyRevision, digest("second save of new object"));
  assert.equal((await f.store.get({ kind: "content", ref })).status, "missing");
});

test("只启用四个内容工具，skill 外部授权只用于读取且随启用状态变化", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.tools.map((tool) => tool.name), ["read", "edit", "write", "apply_patch"]);
  await writeFile(path.join(f.skill, "SKILL.md"), "enabled skill");
  const outside = path.join(f.temporary, "private.txt");
  await writeFile(outside, "outside");
  assert.equal(textOf(await f.call("read", { path: path.join(f.skill, "SKILL.md") })), "enabled skill");
  await assert.rejects(f.call("read", { path: outside }), code("permission_required"));
  await assert.rejects(f.call("write", { path: path.join(f.skill, "SKILL.md"), content: "changed" }), code("permission_required"));
  await assert.rejects(f.call("edit", { path: outside, edits: [{ oldText: "outside", newText: "changed" }] }), code("permission_required"));
  await assert.rejects(f.call("read", { path: ".repa/content/catalog.json" }), code("permission_required"));
  if (process.platform !== "win32") {
    await symlink(outside, path.join(f.skill, "escape.txt"));
    await assert.rejects(f.call("read", { path: path.join(f.skill, "escape.txt") }), code("permission_required"));
  }
  f.enable([]);
  await assert.rejects(f.call("read", { path: path.join(f.skill, "SKILL.md") }), code("permission_required"));
  assert.equal(await readFile(path.join(f.skill, "SKILL.md"), "utf8"), "enabled skill");
});

test("复用 Pi 字节截断与图像附件，过长单行不推荐未启用的 shell", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file("large.txt"), ("x".repeat(100) + "\n").repeat(1000));
  const large = await f.call("read", { path: "large.txt" });
  assert.equal(large.details.truncation.truncatedBy, "bytes");
  assert.match(textOf(large), /Use offset=507 to continue/);
  await writeFile(f.file("line.txt"), "x".repeat(60 * 1024));
  const line = await f.call("read", { path: "line.txt" });
  assert.equal(line.details.truncation.firstLineExceedsLimit, true);
  assert.doesNotMatch(textOf(line), /bash|sed/);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await writeFile(f.file("pixel.png"), png);
  const image = await f.call("read", { path: "pixel.png" });
  assert(image.content.some((part: { type: string; mimeType?: string }) => part.type === "image" && part.mimeType === "image/png"));
  assert.equal(image.details.bodyRevision, digest(png));
});

test("已取消调用不读取或保存，准备期间取消也不提交覆盖", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file("notes.md"), "original");
  const cancelled = new AbortController();
  cancelled.abort();
  for (const [name, params] of [
    ["read", { path: "notes.md" }],
    ["write", { path: "new.md", content: "new" }],
    ["edit", { path: "notes.md", edits: [{ oldText: "original", newText: "changed" }] }],
    ["apply_patch", { patch: "*** Begin Patch\n*** Delete File: notes.md\n*** End Patch" }],
  ] as const) await assert.rejects(f.call(name, params, cancelled.signal), code("cancelled"));
  assert.equal(f.store.journal.entries.size, 0);
  await f.call("read", { path: "notes.md" });
  const controller = new AbortController();
  const get = f.store.get.bind(f.store);
  f.store.get = async (...args) => { const result = await get(...args); controller.abort(); return result; };
  await assert.rejects(f.call("write", { path: "notes.md", content: "changed" }, controller.signal), code("cancelled"));
  assert.equal(await readFile(f.file("notes.md"), "utf8"), "original");
  assert.equal(f.store.journal.entries.size, 0);
});

test("保存完成后到达的取消保留成功结果与下一次保存基准", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const write = f.store.write.bind(f.store);
  f.store.write = async (...args) => { const result = await write(...args); controller.abort(); return result; };
  const saved = await f.call("write", { path: "notes.md", content: "saved" }, controller.signal);
  assert.equal(controller.signal.aborted, true);
  assert.equal(saved.details.bodyRevision, digest("saved"));
  assert.equal((await f.store.operation(saved.details.operationId)).status, "committed");
  await f.call("write", { path: "notes.md", content: "saved again" });
  assert.equal(await readFile(f.file("notes.md"), "utf8"), "saved again");
});

test("差异预览失败不把已经提交的编辑改报为保存失败", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file("notes.md"), "old");
  const edit = f.store.edit.bind(f.store);
  const getBlob = f.store.blobs.get.bind(f.store.blobs);
  f.store.edit = async (...args) => {
    const result = await edit(...args);
    f.store.blobs.get = async () => { throw new Error("preview unavailable"); };
    return result;
  };
  const saved = await f.call("edit", { path: "notes.md", edits: [{ oldText: "old", newText: "new" }] });
  f.store.blobs.get = getBlob;
  assert.equal(saved.details.diffError, "preview unavailable");
  assert.equal(saved.details.bodyRevision, digest("new"));
  assert.equal((await f.store.operation(saved.details.operationId)).status, "committed");
  assert.equal(await readFile(f.file("notes.md"), "utf8"), "new");
});
