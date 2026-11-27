import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { brokenLinks, changeOf, ensureId, keptPaths, mocMembers, RepaFault, revert, saveCard, saveVersion, scanKb, setId } from "../src/kb.js";

async function kb(t: TestContext, files: Record<string, string>): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-kb-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  }
  return root;
}

test("资料文件夹、仓库和以点开头的文件夹里的 Markdown 不算卡片，也不成层；资料仍列在树里，根含 .git 照常扫描", async (t) => {
  const root = await kb(t, {
    ".git/HEAD": "ref",
    "AGENTS.md": "总要求",
    "CSAPP/虚拟内存.md": "正文",
    "CSAPP/讲义.pdf": "%PDF",
    "CSAPP/_资料/转写.md": "不是卡片",
    "CSAPP/lab/.git/HEAD": "ref",
    "CSAPP/lab/README.md": "不是卡片",
    "CSAPP/node_modules/x/README.md": "不是卡片",
    ".repa/modes/讨论学习.md": "不是卡片",
  });
  const scanned = await scanKb(root);
  assert.deepEqual(scanned.folders, ["", "CSAPP"]);
  assert.deepEqual(scanned.pages.map((page) => page.path), ["CSAPP/虚拟内存.md"]);
  assert.deepEqual(scanned.agentsFiles, ["AGENTS.md"]);
  assert.deepEqual([...scanned.materials].sort((a, b) => a.path.localeCompare(b.path)), [
    { path: "CSAPP/_资料", kind: "folder" },
    { path: "CSAPP/lab", kind: "repo" },
    { path: "CSAPP/讲义.pdf", kind: "file" },
  ]);
});

test("文件头各项都可以不写；summary 缺省取正文第一行，requires 里写成链接的也认，读不出的文件头标为出错", async (t) => {
  const root = await kb(t, {
    "a.md": "# 页表\n\n把虚拟页映射到物理页。\n",
    "b.md": "---\nid: k7f3qa9d\nsummary: 缓存页表项\nkeep: true\nrequires: [\"[[a]]\", c]\nreview: 2026-11-29\n---\n正文\n",
    "c.md": "---\nkeep: [\n---\n正文\n",
  });
  const [a, b, c] = (await scanKb(root)).pages;
  assert.equal(a?.summary, "页表");
  assert.equal(a?.keep, undefined);
  assert.deepEqual({ id: b?.id, summary: b?.summary, keep: b?.keep, requires: b?.requires, review: b?.review }, {
    id: "k7f3qa9d", summary: "缓存页表项", keep: true, requires: ["a", "c"], review: "2026-11-29",
  });
  assert.match(c?.error ?? "", /文件头读不出来/u);
});

test("链接按标题找卡片，重名时先取同一层的；改名后找不到的链接、先修和 MOC 列项都标出来", async (t) => {
  const root = await kb(t, {
    "A/页表.md": "A 层的页表",
    "B/页表.md": "B 层的页表",
    "B/TLB.md": "---\nrequires: [页表, 旧名字]\n---\n和 [[页表|PT]]、[[不存在]] 一起看。\n",
    "B/地图.md": "---\nmoc: true\n---\n- [[A/页表]]\n- [[没了]]\n",
  });
  const scanned = await scanKb(root);
  const tlb = scanned.byPath.get("B/TLB.md");
  const moc = scanned.byPath.get("B/地图.md");
  assert.ok(tlb && moc);
  assert.deepEqual(brokenLinks(scanned, tlb), ["不存在", "旧名字"]);
  const { members, broken } = mocMembers(scanned, moc);
  assert.deepEqual(members.map((page) => page.path), ["A/页表.md"]);
  assert.deepEqual(broken, ["没了"]);
});

test("写了 keep: true 的 MOC 列出的卡片都算保持，卡片自己写 keep: false 的退出；MOC 本身不算卡片", async (t) => {
  const root = await kb(t, {
    "地图.md": "---\nmoc: true\nkeep: true\n---\n[[甲]] [[乙]] [[丙]]\n",
    "甲.md": "甲",
    "乙.md": "---\nkeep: false\n---\n乙",
    "丙.md": "丙",
    "丁.md": "---\nkeep: true\n---\n丁",
  });
  assert.deepEqual([...keptPaths(await scanKb(root))].sort(), ["丁.md", "丙.md", "甲.md"]);
});

test("写入 id 时只动文件头的这一行，其余文字原样保留；没有文件头就加一个；id 首位是字母", async (t) => {
  const original = "---\nsummary: 概括\n# 注释\n---\n正文第一段\r\n\n第二段 [[链接]]\n";
  assert.equal(setId(original, "abc"), "---\nid: abc\nsummary: 概括\n# 注释\n---\n正文第一段\r\n\n第二段 [[链接]]\n");
  assert.equal(setId("---\nid: old\n---\n正文", "new"), "---\nid: new\n---\n正文");
  assert.equal(setId("没有文件头", "abc"), "---\nid: abc\n---\n没有文件头");
  const root = await kb(t, { "a.md": "正文\n" });
  const [page] = (await scanKb(root)).pages;
  assert.ok(page);
  const id = await ensureId(root, page);
  assert.match(id, /^[a-z][a-z0-9]{7}$/u);
  assert.equal(await readFile(path.join(root, "a.md"), "utf8"), `---\nid: ${id}\n---\n正文\n`);
  assert.equal((await scanKb(root)).pages[0]?.id, id);
});

test("在 Repa 里保存时，文件若在打开以后被别处改过就拒绝，并带回最新内容；新建已存在的卡片也拒绝", async (t) => {
  const root = await kb(t, { "a.md": "旧\n" });
  const opened = (await stat(path.join(root, "a.md"))).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(path.join(root, "a.md"), "编辑器里改过\n");
  const conflict = await saveCard(root, "a.md", "我的新写法\n", opened).catch((error: unknown) => error);
  assert.ok(conflict instanceof RepaFault);
  assert.equal(conflict.code, "conflict");
  assert.deepEqual((conflict.details as { text: string }).text, "编辑器里改过\n");
  assert.equal(await readFile(path.join(root, "a.md"), "utf8"), "编辑器里改过\n");
  const latest = (await stat(path.join(root, "a.md"))).mtimeMs;
  await saveCard(root, "a.md", "我的新写法\n", latest);
  assert.equal(await readFile(path.join(root, "a.md"), "utf8"), "我的新写法\n");
  await assert.rejects(saveCard(root, "a.md", "x", undefined), (error: unknown) => error instanceof RepaFault && error.code === "conflict");
  await assert.rejects(saveCard(root, "../外面.md", "x", undefined), (error: unknown) => error instanceof RepaFault && error.code === "bad_request");
});

test("撤回一次改动恢复整个文件，之后的改动一并退掉；撤回本身也能撤回；撤回新建就是删除；id 保持当前的", async (t) => {
  const root = await kb(t, { "a.md": "第一版\n" });
  const file = path.join(root, "a.md");
  const first = await saveVersion(root, "a.md", "call_1");
  await writeFile(file, "第二版\n");
  await saveVersion(root, "a.md", "call_2");
  await writeFile(file, "---\nid: k7f3qa9d\n---\n第三版\n");
  assert.deepEqual(await changeOf(root, "a.md", "call_1"), { version: first, before: "第一版\n", after: "第二版\n" });
  assert.equal((await changeOf(root, "a.md", "call_2")).after, "---\nid: k7f3qa9d\n---\n第三版\n");

  const saved = await revert(root, "a.md", first);
  assert.equal(await readFile(file, "utf8"), "---\nid: k7f3qa9d\n---\n第一版\n");
  await revert(root, "a.md", saved);
  assert.equal(await readFile(file, "utf8"), "---\nid: k7f3qa9d\n---\n第三版\n");

  const created = await saveVersion(root, "新.md", "call_3");
  await writeFile(path.join(root, "新.md"), "新建的\n");
  assert.equal((await changeOf(root, "新.md", "call_3")).before, undefined);
  const beforeDelete = await revert(root, "新.md", created);
  await assert.rejects(stat(path.join(root, "新.md")));
  await revert(root, "新.md", beforeDelete);
  assert.equal(await readFile(path.join(root, "新.md"), "utf8"), "新建的\n");
});
