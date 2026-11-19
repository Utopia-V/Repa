import assert from "node:assert/strict";
import fs from "node:fs";
import { chmod, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { deflateSync, inflateSync } from "node:zlib";

import { isContentAddressed } from "@repa/space-history";

import { copyStats } from "../src/backup/copy.js";
import { restoreInPlace, restoreToNew } from "../src/backup/restore.js";
import { checkBackup, deleteBackup, groupDirectory, listBackups } from "../src/backup/store.js";
import type { BackupManifest } from "../src/schema.js";
import { createSpace, openSpace } from "../src/space.js";
import { writeJson } from "../src/storage.js";

// 定期备份之间共用历史库中按内容命名的文件（硬链接）。这些测试都在真实文件系统上进行，各平台的 CI 都跑。

const HISTORY = "history.git/";
const named = (relative: string) => relative.startsWith(HISTORY) && isContentAddressed(relative.slice(HISTORY.length));

// 空间里先放 120 个文件：打开空间时的初次快照超过 fast-import 的解包阈值，留下一个 pack；之后的单个修改留下松散对象。
async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-backup-links-")));
  const home = path.join(directory, "home");
  const root = path.join(directory, "space");
  await mkdir(path.join(root, "materials"), { recursive: true });
  for (let index = 0; index < 120; index++) await writeFile(path.join(root, "materials", `${index}.md`), `第 ${index} 份资料\n`);
  let space = await createSpace(root, { watch: false });
  t.after(async () => {
    await space.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  let now = Date.UTC(2026, 10, 19, 8, 0, 0);
  const clock = () => (now += 1000);
  const records = path.join(await space.pluginDataDir("learning"), "records.jsonl");
  const session = path.join(space.sessionsDir, "2026-11-19T08-00-00-000Z_s1.jsonl");
  await writeFile(session, `${JSON.stringify({ type: "session", id: "s1" })}\n`);
  await space.filesFor({ kind: "plugin", pluginId: "notes" }).write("notes/a.md", "第一版\n");
  return {
    directory, home, records, session, clock,
    get space() { return space; },
    async reopen() {
      await space.close();
      space = await openSpace(root, { watch: false });
    },
    async close() {
      await space.close();
    },
  };
}

async function append(file: string, text: string): Promise<void> {
  const handle = await open(file, "a", 0o600);
  try {
    await handle.writeFile(text);
  } finally {
    await handle.close();
  }
}

const fact = (seq: number) => `${JSON.stringify({ seq, text: `第 ${seq} 题` })}\n`;

async function manifestOf(home: string, root: string, id: string): Promise<BackupManifest> {
  return JSON.parse(await readFile(path.join(groupDirectory(home, root), id, "manifest.json"), "utf8")) as BackupManifest;
}

function backupFile(home: string, root: string, id: string, relative: string): string {
  return path.join(groupDirectory(home, root), id, "data", ...relative.split("/"));
}

// 文件的身份：同一个文件的各个硬链接相同。ino 取 bigint，Windows 上的文件编号超出 Number 的精度。
async function identity(file: string): Promise<string> {
  const info = await stat(file, { bigint: true });
  return `${info.dev}:${info.ino}`;
}

// 一组里每份备份的全部内容（含清单），按备份 id 与相对路径。
async function groupContents(home: string, root: string): Promise<Map<string, Buffer>> {
  const group = groupDirectory(home, root);
  const result = new Map<string, Buffer>();
  for (const entry of await readdir(group, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    result.set(path.relative(group, full).split(path.sep).join("/"), await readFile(full));
  }
  return result;
}

const byPath = ([a]: [string, Buffer], [b]: [string, Buffer]) => (a < b ? -1 : a > b ? 1 : 0);

// 两次统计之间各来源被复制、被链接的次数。
function delta(before: ReturnType<typeof copyStats>, after: ReturnType<typeof copyStats>) {
  const diff = (a: Map<string, number>, b: Map<string, number>) => new Map([...b].map(([file, count]) => [file, count - (a.get(file) ?? 0)] as const).filter(([, count]) => count > 0));
  return { copied: diff(before.files, after.files), linked: diff(before.linked, after.linked), bytes: after.bytes - before.bytes };
}

test("代价关卡：历史库没变时，按内容命名的文件一个也不复制，都链接上一份里的同一文件；其余文件即使没变也复制；新提交只复制新对象；同名而大小不同的对象复制", async (t) => {
  const f = await fixture(t);
  const root = f.space.root;
  const dataDir = f.space.dataDir;
  const first = await checkBackup(f.home, f.space, 5, f.clock());
  const firstFiles = (await manifestOf(f.home, root, first.backup.id)).files;
  // 第一份没有来源，全部复制。
  assert.ok(firstFiles.some((file) => named(file.path) && file.path.endsWith(".pack")), "有 pack");
  assert.ok(firstFiles.some((file) => named(file.path) && !file.path.endsWith(".pack")), "有松散对象");

  // 只追加学习记录。
  await append(f.records, fact(1));
  const before = copyStats();
  const second = await checkBackup(f.home, f.space, 5, f.clock());
  const counted = delta(before, copyStats());
  const secondFiles = (await manifestOf(f.home, root, second.backup.id)).files;
  const source = (relative: string) => path.join(dataDir, ...relative.split("/"));
  const shared = secondFiles.filter((file) => named(file.path));
  const others = secondFiles.filter((file) => !named(file.path));
  assert.deepEqual(shared.map((file) => file.path).sort(), firstFiles.filter((file) => named(file.path)).map((file) => file.path).sort());
  for (const file of shared) {
    assert.equal(counted.copied.get(source(file.path)), undefined, `${file.path} 不应复制`);
    assert.equal(counted.linked.get(source(file.path)), 1, `${file.path} 应链接`);
    assert.equal(await identity(backupFile(f.home, root, second.backup.id, file.path)), await identity(backupFile(f.home, root, first.backup.id, file.path)));
  }
  for (const file of others) assert.equal(counted.copied.get(source(file.path)), 1, `${file.path} 应复制`);
  assert.equal(counted.copied.size, others.length);
  assert.equal(counted.bytes, others.reduce((sum, file) => sum + file.size, 0));
  // 没动过的会话与 HEAD 不属于那两类，照样复制。
  assert.ok(counted.copied.has(f.session));
  assert.ok(counted.copied.has(source("history.git/HEAD")));

  // 新提交一个文件：只复制新出现的对象。
  await f.space.filesFor({ kind: "plugin", pluginId: "notes" }).write("notes/b.md", "新笔记\n");
  const beforeCommit = copyStats();
  const third = await checkBackup(f.home, f.space, 5, f.clock());
  const afterCommit = delta(beforeCommit, copyStats());
  const thirdNamed = (await manifestOf(f.home, root, third.backup.id)).files.filter((file) => named(file.path)).map((file) => file.path);
  const fresh = thirdNamed.filter((file) => !shared.some((old) => old.path === file));
  assert.ok(fresh.length > 0);
  assert.deepEqual(thirdNamed.filter((file) => afterCommit.copied.has(source(file))).sort(), fresh.sort());
  assert.deepEqual(thirdNamed.filter((file) => afterCommit.linked.has(source(file))).sort(), thirdNamed.filter((file) => !fresh.includes(file)).sort());

  // 同一个松散对象换一种压缩级别重写：名字不变、大小变了，复制而不链接。
  const loose = thirdNamed.find((file) => !file.endsWith(".pack"));
  assert.ok(loose);
  const object = source(loose);
  const original = await readFile(object);
  const recompressed = deflateSync(inflateSync(original), { level: 0 });
  assert.notEqual(recompressed.length, original.length);
  await chmod(object, 0o644);
  await writeFile(object, recompressed);
  await append(f.records, fact(2));
  const beforeRewrite = copyStats();
  const fourth = await checkBackup(f.home, f.space, 5, f.clock());
  const afterRewrite = delta(beforeRewrite, copyStats());
  assert.equal(afterRewrite.copied.get(object), 1);
  assert.equal(afterRewrite.linked.get(object), undefined);
  assert.deepEqual(await readFile(backupFile(f.home, root, fourth.backup.id, loose)), recompressed);
});

test("删掉较旧或较新的一份，共用文件的其余备份仍完整，可以恢复", async (t) => {
  const f = await fixture(t);
  const root = f.space.root;
  const ids: string[] = [];
  ids.push((await checkBackup(f.home, f.space, 5, f.clock())).backup.id);
  await append(f.records, fact(1));
  ids.push((await checkBackup(f.home, f.space, 5, f.clock())).backup.id);
  await f.space.filesFor({ kind: "plugin", pluginId: "notes" }).write("notes/a.md", "第二版\n");
  ids.push((await checkBackup(f.home, f.space, 5, f.clock())).backup.id);
  await f.close();
  const [oldest, middle, newest] = ids as [string, string, string];
  const contents = await groupContents(f.home, root);
  const of = (...kept: string[]) => [...contents].filter(([file]) => kept.some((id) => file.startsWith(`${id}/`))).sort(byPath);

  await deleteBackup(f.home, root, oldest);
  const afterOldest = await groupContents(f.home, root);
  assert.deepEqual([...afterOldest].sort(byPath), of(middle, newest));
  const restoredNewest = await restoreToNew({ home: f.home, root, id: newest, target: path.join(f.directory, "从最新恢复") });
  const opened = await openSpace(restoredNewest, { watch: false });
  try {
    assert.equal(await opened.files.read("notes/a.md"), "第二版\n");
    assert.equal(await readFile(path.join(opened.dataDir, "plugins", "learning", "records.jsonl"), "utf8"), fact(1));
  } finally {
    await opened.close();
  }

  await deleteBackup(f.home, root, newest);
  assert.deepEqual([...await groupContents(f.home, root)].sort(byPath), of(middle));
  const restoredMiddle = await restoreToNew({ home: f.home, root, id: middle, target: path.join(f.directory, "从中间恢复") });
  const reopened = await openSpace(restoredMiddle, { watch: false });
  try {
    assert.equal(await reopened.files.read("notes/a.md"), "第一版\n");
  } finally {
    await reopened.close();
  }
});

test("从带链接的备份恢复以后再写空间，任何一份备份都不变；“恢复前”的备份不与别的备份共用文件，之后的定期备份从它之前的定期备份链接", async (t) => {
  const f = await fixture(t);
  const root = f.space.root;
  const first = await checkBackup(f.home, f.space, 5, f.clock());
  await append(f.records, fact(1));
  const second = await checkBackup(f.home, f.space, 5, f.clock());
  await append(f.records, fact(2));
  await f.close();
  const kept = await groupContents(f.home, root);

  const before = await restoreInPlace({ home: f.home, root, id: second.backup.id, now: f.clock() });
  // 恢复出的 .repa/ 是复制来的，不与任何备份共用。
  for (const entry of await readdir(path.join(root, ".repa"), { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) assert.equal((await stat(path.join(entry.parentPath, entry.name))).nlink, 1, entry.name);
  }

  await f.reopen();
  await append(f.records, fact(3));
  await writeJson(path.join(f.space.dataDir, "prompts.json"), { base: { text: "恢复以后写的说明" } });
  await f.space.filesFor({ kind: "plugin", pluginId: "notes" }).write("notes/a.md", "恢复以后的笔记\n");
  // 恢复前的备份是最新的一份；新的定期备份不从它链接。
  const third = await checkBackup(f.home, f.space, 5, f.clock());
  await f.close();

  const after = await groupContents(f.home, root);
  for (const [file, bytes] of kept) assert.deepEqual(after.get(file), bytes, `${file} 变了`);
  const beforeFiles = (await manifestOf(f.home, root, before.id)).files;
  for (const file of beforeFiles) assert.equal((await stat(backupFile(f.home, root, before.id, file.path))).nlink, 1, `恢复前的 ${file.path} 与别的备份共用`);
  const thirdNamed = (await manifestOf(f.home, root, third.backup.id)).files.filter((file) => named(file.path));
  const secondNamed = new Set((await manifestOf(f.home, root, second.backup.id)).files.filter((file) => named(file.path)).map((file) => file.path));
  let linked = 0;
  for (const file of thirdNamed) {
    if (!secondNamed.has(file.path)) continue;
    assert.equal(await identity(backupFile(f.home, root, third.backup.id, file.path)), await identity(backupFile(f.home, root, second.backup.id, file.path)));
    linked++;
  }
  assert.ok(linked > 0);
  assert.equal((await listBackups(f.home))[0]?.backups.some((backup) => backup.id === first.backup.id), true);
});

test("链接失败时照旧复制，备份完整", async (t) => {
  const f = await fixture(t);
  const root = f.space.root;
  await checkBackup(f.home, f.space, 5, f.clock());
  const original = fs.promises.link;
  let attempts = 0;
  Object.assign(fs.promises, {
    link: () => {
      attempts++;
      return Promise.reject(Object.assign(new Error("EXDEV: cross-device link not permitted, link"), { code: "EXDEV" }));
    },
  });
  syncBuiltinESMExports();
  t.after(() => {
    Object.assign(fs.promises, { link: original });
    syncBuiltinESMExports();
  });
  await append(f.records, fact(1));
  const before = copyStats();
  const second = await checkBackup(f.home, f.space, 5, f.clock());
  const counted = delta(before, copyStats());
  const files = (await manifestOf(f.home, root, second.backup.id)).files;
  assert.equal(attempts, files.filter((file) => named(file.path)).length);
  assert.equal(counted.linked.size, 0);
  assert.equal(counted.copied.size, files.length);
  assert.equal(counted.bytes, files.reduce((sum, file) => sum + file.size, 0));
  for (const file of files) {
    const copied = backupFile(f.home, root, second.backup.id, file.path);
    assert.equal((await stat(copied)).nlink, 1);
    assert.deepEqual(await readFile(copied), await readFile(path.join(f.space.dataDir, ...file.path.split("/"))));
  }
});

test("删掉一组的最后一份时，空的组目录一并去掉", async (t) => {
  const f = await fixture(t);
  const root = f.space.root;
  const only = await checkBackup(f.home, f.space, 5, f.clock());
  await f.close();
  await deleteBackup(f.home, root, only.backup.id);
  await assert.rejects(stat(groupDirectory(f.home, root)), { code: "ENOENT" });
  assert.deepEqual(await listBackups(f.home), []);
});
