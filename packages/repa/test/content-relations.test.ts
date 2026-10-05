import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { RepaClient } from "../src/client.js";
import { startRepaServer } from "../src/server.js";
import type { ContentInfo, ContentTarget } from "../src/content/schema.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-content-relations-"));
  const server = await startRepaServer({ appDirectory: path.join(root, "app") });
  const client = await RepaClient.connect(server.connection);
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  const space = await client.call("space.open", { path: path.join(root, "space") });
  const target = (file: string): ContentTarget => ({ kind: "file", spaceId: space.id, location: { kind: "relative", path: file } });
  const associate = async (file: string, role: "document" | "material" = "document") => {
    const result = await client.call("content.associate", {
      spaceId: space.id, operationId: randomUUID(), role, location: { kind: "relative", path: file },
    });
    const content = result.contents[0];
    assert(content?.ref);
    return content;
  };
  return { root, server, client, space, target, associate };
}

function revision(content: ContentInfo): string {
  assert(content.revision);
  return content.revision;
}

test("正文关系只提取实际使用的 Markdown 引用，保留修订、范围和当前目标", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.space.path, "notes"));
  await writeFile(path.join(f.space.path, "tides.md"), "# 潮汐观测\n");
  await writeFile(path.join(f.space.path, "notes", "figure.svg"), "<svg/>\n");
  const tides = await f.associate("tides.md");
  assert(tides.ref);
  const source = [
    "# 潮汐笔记 🌊", "[观测](../tides.md#晚潮)", "![示意](figure.svg)", "[教材][book]", "[简写][]", "[短名]",
    "<https://example.org/tides?q=1&season=summer>", "`[假引用](fake.md)`", "```md", "[代码](fake.md)", "```",
    "[book]: repa:document/" + tides.ref.id + "#潮位", "[简写]: ../tides.md?view=raw", "[短名]: ../tides.md",
    "[未用]: unused.md", "[diagram]: figure.svg", "[失效](missing.md)", "[转义](../tides\\.md)",
    "[实体](../tides&#46;md)", "![示意引用][diagram]", "",
  ].join("\n");
  await writeFile(path.join(f.space.path, "notes", "summary.md"), source);
  const result = await f.client.call("content.relations", { spaceId: f.space.id, path: "notes/summary.md" });
  assert.equal(result.truncated, false);
  assert.deepEqual(result.unavailable, []);
  assert.equal(result.relations.length, 10);
  const references = result.relations.filter(relation => relation.kind === "reference");
  assert.equal(references.length, 10);
  assert.equal(references.some(relation => relation.href === "unused.md" || relation.href === "fake.md"), false);
  const first = references[0];
  assert(first);
  assert.equal(source.slice(first.range.start, first.range.end), "[观测](../tides.md#晚潮)");
  assert.equal(first.line, 2);
  assert.equal(first.revision, (await f.client.call("content.get", { target: f.target("notes/summary.md") })).bodyRevision);
  assert.equal(first.source.ref, undefined);
  assert.equal(first.target.kind, "local");
  if (first.target.kind === "local") {
    assert.deepEqual(first.target.ref, tides.ref);
    assert.equal(first.target.status, "available");
    assert.deepEqual(first.target.location, { kind: "relative", path: "tides.md" });
  }
  const url = references.find(relation => relation.target.kind === "url");
  assert(url?.target.kind === "url");
  assert.equal(url.target.href, "https://example.org/tides?q=1&season=summer");
  assert.equal(url.target.status, "unverified");
  assert.equal(references.filter(relation => relation.syntax === "image").length, 2);
  const entity = references.find(relation => source.slice(relation.range.start, relation.range.end) === "[实体](../tides&#46;md)");
  assert(entity?.target.kind === "local");
  assert.equal(entity.href, "../tides.md");
  assert.deepEqual(entity.target.ref, tides.ref);
  const missing = references.find(relation => relation.href === "missing.md");
  assert(missing?.target.kind === "local");
  assert.equal(missing.target.status, "missing");
  assert.equal((await f.client.call("content.list", { spaceId: f.space.id, path: "notes" })).every(content => content.ref === undefined), true);
});

test("更新、移动与解除关联后重新解释当前位置，身份引用不串到同路径新对象", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.space.path, "notes"));
  await mkdir(path.join(f.space.path, "other"));
  await writeFile(path.join(f.space.path, "notes", "tides.md"), "原来的潮汐资料\n");
  await writeFile(path.join(f.space.path, "other", "tides.md"), "另一份潮汐资料\n");
  const tides = await f.associate("notes/tides.md", "material");
  assert(tides.ref);
  const body = `[身份](repa:material/${tides.ref.id}#晚潮)\n[路径](tides.md)\n`;
  await writeFile(path.join(f.space.path, "notes", "summary.md"), body);
  const summary = await f.associate("notes/summary.md");
  assert(summary.ref);
  const before = await f.client.call("content.relations", { spaceId: f.space.id, path: "notes" });
  const beforeReferences = before.relations.filter(relation => relation.kind === "reference");
  assert.equal(beforeReferences.length, 2);
  await f.client.call("content.move", {
    target: summary.target, operationId: randomUUID(), destination: { kind: "relative", path: "other/summary.md" }, base: revision(summary),
  });
  const moved = await f.client.call("content.relations", { spaceId: f.space.id, path: "other/summary.md" });
  assert.equal(moved.relations.find(relation => relation.kind === "reference")?.revision, beforeReferences[0]?.revision);
  const pathReference = moved.relations.find(relation => relation.kind === "reference" && relation.href === "tides.md");
  assert(pathReference?.target.kind === "local");
  assert.deepEqual(pathReference.target.location, { kind: "relative", path: "other/tides.md" });
  assert.equal(pathReference.target.ref, undefined);
  await f.client.call("content.move", {
    target: tides.target, operationId: randomUUID(), destination: { kind: "relative", path: "tides.md" }, base: revision(tides),
  });
  const targetMoved = await f.client.call("content.relations", { spaceId: f.space.id, path: "other/summary.md" });
  const movedIdentity = targetMoved.relations.find(relation => relation.kind === "reference" && relation.href.startsWith("repa:"));
  assert(movedIdentity?.target.kind === "local");
  assert.deepEqual(movedIdentity.target.location, { kind: "relative", path: "tides.md" });
  assert.deepEqual(movedIdentity.target.ref, tides.ref);
  const movedSummary = await f.client.call("content.get", { target: summary.target });
  await f.client.call("content.setComposition", {
    ref: summary.ref, operationId: randomUUID(), base: revision(movedSummary),
    members: [{ target: tides.target, name: "旧资料" }, { target: f.target("other/tides.md"), name: "观测表" }], resources: [],
  });
  const currentTides = await f.client.call("content.get", { target: tides.target });
  await f.client.call("content.remove", { target: tides.target, operationId: randomUUID(), base: revision(currentTides), detach: true });
  await writeFile(path.join(f.space.path, "tides.md"), "新对象\n");
  const replacement = await f.associate("tides.md");
  assert.notDeepEqual(replacement.ref, tides.ref);
  const detached = await f.client.call("content.relations", { spaceId: f.space.id, path: "other/summary.md" });
  const identity = detached.relations.find(relation => relation.kind === "reference" && relation.href.startsWith("repa:"));
  assert(identity?.target.kind === "local");
  assert.deepEqual(identity.target.ref, tides.ref);
  assert.equal(identity.target.status, "detached");
  await writeFile(path.join(f.space.path, "other", "summary.md"), "[新关系](../tides.md)\n");
  const updated = await f.client.call("content.relations", { spaceId: f.space.id, path: "other/summary.md" });
  const updatedReferences = updated.relations.filter(relation => relation.kind === "reference");
  assert.equal(updatedReferences.length, 1);
  const replacementReference = updatedReferences[0];
  assert(replacementReference?.target.kind === "local");
  assert.deepEqual(replacementReference.target.ref, replacement.ref);
  assert.equal(replacementReference.target.status, "available");
  assert.notEqual(updatedReferences[0]?.revision, identity.revision);
  const members = updated.relations.filter(relation => relation.kind === "composition");
  assert.deepEqual(members.map(member => member.name), ["旧资料", "观测表"]);
  assert.equal(members[0]?.target.kind === "local" && members[0].target.status, "detached");
  const currentSummary = await f.client.call("content.get", { target: summary.target });
  assert.equal(members[0]?.revision, currentSummary.revision);
  await f.client.call("content.setComposition", {
    ref: summary.ref, operationId: randomUUID(), base: revision(currentSummary), members: [], resources: [],
  });
  const removed = await f.client.call("content.relations", { spaceId: f.space.id, path: "other/summary.md" });
  assert.equal(removed.relations.length, 1);
  assert.equal(removed.relations[0]?.kind, "reference");
});

test("默认查询只发现 Markdown 和明确组成，不让普通资源耗尽来源配额或增加持有账本", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.space.path, "course"));
  await writeFile(path.join(f.space.path, "course", "tides.md"), "[观测](../data.txt)\n[未知身份](repa:material/unknown)\n");
  await writeFile(path.join(f.space.path, "data.txt"), "潮位观测\n");
  const course = await f.associate("course");
  assert(course.ref);
  await f.client.call("content.setComposition", {
    ref: course.ref, operationId: randomUUID(), base: revision(course), members: [{ target: f.target("course/tides.md") }], resources: [],
  });
  const external = path.join(f.root, "潮汐教材.md");
  await writeFile(external, "[外部来源](https://example.org/book)\n");
  await f.client.call("content.associate", {
    spaceId: f.space.id, operationId: randomUUID(), role: "material", location: { kind: "external", path: external },
  });
  await Promise.all(Array.from({ length: 501 }, (_, index) =>
    writeFile(path.join(f.space.path, `0000-resource-${index}.png`), "普通资源")));
  await writeFile(path.join(f.space.path, "index.json"), "{}\n");
  const index = await f.associate("index.json");
  assert(index.ref);
  await f.client.call("content.setComposition", {
    ref: index.ref, operationId: randomUUID(), base: revision(index),
    members: [{ target: f.target("data.txt"), name: "观测数据" }], resources: [],
  });
  await writeFile(path.join(f.space.path, "outline.md"), "[资料](course/tides.md)\n");
  const outline = await f.associate("outline.md");
  await f.client.call("content.move", {
    target: outline.target, operationId: randomUUID(), base: revision(outline),
    destination: { kind: "relative", path: "outline.notes" },
  });
  const ledger = path.join(f.space.path, ".repa", "content", "resources.json");
  const readLedger = async () => {
    try { return await readFile(ledger); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  };
  const before = await readLedger();
  const blobDirectory = path.join(f.space.path, ".repa", "content", "blobs");
  const beforeBlobs = await readdir(blobDirectory);
  const result = await f.client.call("content.relations", { spaceId: f.space.id });
  assert.equal(result.truncated, false);
  assert.equal(result.relations.filter(relation => relation.kind === "composition").length, 2);
  assert.equal(result.relations.filter(relation => relation.kind === "reference").length, 4);
  const movedMarkdown = result.relations.find(relation => relation.source.ref?.id === outline.ref?.id);
  assert.equal(movedMarkdown?.source.mediaType, "text/markdown");
  assert.deepEqual(movedMarkdown?.source.location, { kind: "relative", path: "outline.notes" });
  const unknown = result.relations.find(relation => relation.kind === "reference" && relation.href === "repa:material/unknown");
  assert(unknown?.target.kind === "local");
  assert.equal(unknown.target.status, "missing");
  assert.equal(unknown.target.location, undefined);
  assert.deepEqual(unknown.target.target, { kind: "content", ref: { spaceId: f.space.id, id: "unknown" } });
  assert.deepEqual(result.unavailable, []);
  assert.deepEqual(await readLedger(), before);
  assert.deepEqual(await readdir(blobDirectory), beforeBlobs);
  const plainFile = await f.client.call("content.relations", { spaceId: f.space.id, path: "data.txt" });
  assert.deepEqual(plainFile.relations, []);
  assert.equal(plainFile.unavailable[0]?.code, "unsupported_format");
  const limited = await f.client.call("content.relations", { spaceId: f.space.id, limit: 1 });
  assert.equal(limited.relations.length, 1);
  assert.equal(limited.truncated, true);
  await writeFile(external, "[更新来源](https://example.org/new-book)\n");
  const updated = await f.client.call("content.relations", { spaceId: f.space.id });
  assert(updated.relations.some(relation => relation.kind === "reference" && relation.href === "https://example.org/new-book"));
});


test("正文路径越出空间时保留未授权目标，格式错误的链接不阻断其他关系", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "原始观测.md"), "未关联的原始观测\n");
  await writeFile(path.join(f.space.path, "tides.md"), `[空间外](../原始观测.md)\n[错误引用](repa:unknown/abc)\n[错误路径](bad%ZZ.md)\n[NUL路径](bad%00.md)\n[过长身份](repa:document/${"a".repeat(129)})\n[观测](observations.md)\n`);
  await writeFile(path.join(f.space.path, "observations.md"), "观测笔记\n");
  const result = await f.client.call("content.relations", { spaceId: f.space.id, path: "tides.md" });
  assert.equal(result.truncated, false);
  assert.deepEqual(result.unavailable, []);
  assert.equal(result.relations.length, 6);
  const external = result.relations[0];
  assert(external?.target.kind === "local");
  assert.equal(external.target.status, "permission_required");
  assert.deepEqual(external.target.location, { kind: "external", path: path.join(f.root, "原始观测.md") });
  assert.equal(result.relations[1]?.target.kind, "unresolved");
  assert.equal(result.relations[2]?.target.kind, "unresolved");
  assert.equal(result.relations[3]?.target.kind, "unresolved");
  assert.equal(result.relations[4]?.target.kind, "unresolved");
  const available = result.relations[5];
  assert(available?.target.kind === "local");
  assert.equal(available.target.status, "available");
});


test("来源原件缺失后保留已确认的组成，正文缺口不抹掉清单中的关系", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.space.path, "course.md"), "# 潮汐课程\n");
  await writeFile(path.join(f.space.path, "observations.txt"), "潮位观测\n");
  const course = await f.associate("course.md");
  assert(course.ref);
  const composed = await f.client.call("content.setComposition", {
    ref: course.ref, operationId: randomUUID(), base: revision(course),
    members: [{ target: f.target("observations.txt"), name: "观测记录" }], resources: [],
  });
  const confirmed = composed.contents.find(content => content.ref?.id === course.ref?.id);
  assert(confirmed);
  await rm(path.join(f.space.path, "course.md"));
  for (const scope of [{ spaceId: f.space.id }, { spaceId: f.space.id, path: "course.md" }]) {
    const result = await f.client.call("content.relations", scope);
    assert.equal(result.truncated, false);
    assert.equal(result.relations.length, 1);
    const member = result.relations[0];
    assert(member?.kind === "composition");
    assert.equal(member.source.status, "missing");
    assert.equal(member.revision, confirmed.revision);
    assert.equal(member.target.status, "available");
    assert.deepEqual(member.target.location, { kind: "relative", path: "observations.txt" });
    assert.deepEqual(result.unavailable.map(item => item.code), ["missing"]);
  }
});
