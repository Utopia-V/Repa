import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Git } from "../src/git.js";
import { openHistory } from "../src/index.js";

test("独占打开清理残留的 Git 锁，保留正文、对象和引用", async (t) => {
  const space = await mkdtemp(join(tmpdir(), "repa-stale-locks-"));
  t.after(() => rm(space, { recursive: true, force: true }));
  const text = Buffer.from("正文原样保留\r\n\0");
  await writeFile(join(space, "正文.txt"), text);
  const history = await openHistory(space);
  const revisions = await history.list();
  const gitDir = join(space, ".repa", "history.git");
  const ref = await readFile(join(gitDir, "refs", "heads", "history"));
  const git = new Git(space, gitDir);
  const locks = ["index.lock", "HEAD.lock", "config.lock", "packed-refs.lock", "shallow.lock", "ORIG_HEAD.lock", "refs/heads/history.lock", "refs/tags/old.lock"];
  await mkdir(join(gitDir, "refs", "tags"), { recursive: true });
  await writeFile(join(gitDir, "objects", "keep.lock"), "不是 Git 锁");
  await writeFile(join(gitDir, "keep.lock"), "不是已知的 Git 锁");
  for (const file of locks) await writeFile(join(gitDir, file), "");
  // 不独占打开时不清理：没有改动要保存时只读历史，可以打开，但残留锁挡住之后写仓库的操作。
  const shared = await openHistory(space);
  await assert.rejects(shared.maintain({ force: true }));
  for (const file of locks) assert.equal((await readFile(join(gitDir, file))).length, 0);
  const reopened = await openHistory(space, { exclusive: true });
  assert.deepEqual(await reopened.list(), revisions);
  for (const file of locks) await assert.rejects(readFile(join(gitDir, file)), { code: "ENOENT" });
  assert.deepEqual(await readFile(join(space, "正文.txt")), text);
  assert.deepEqual(await readFile(join(gitDir, "refs", "heads", "history")), ref);
  assert.equal(await readFile(join(gitDir, "objects", "keep.lock"), "utf8"), "不是 Git 锁");
  assert.equal(await readFile(join(gitDir, "keep.lock"), "utf8"), "不是已知的 Git 锁");
  assert.equal((await git.run(["fsck", "--full"])).toString(), "");
});

test("独占清理不沿 refs 中的符号链接删除文件", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "repa-lock-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const space = join(root, "space");
  const outside = join(root, "outside");
  await mkdir(space);
  await mkdir(outside);
  await openHistory(space);
  await writeFile(join(outside, "keep.lock"), "保留");
  await symlink(outside, join(space, ".repa", "history.git", "refs", "linked"), process.platform === "win32" ? "junction" : "dir");
  await openHistory(space, { exclusive: true });
  assert.equal(await readFile(join(outside, "keep.lock"), "utf8"), "保留");
});
