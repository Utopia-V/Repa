import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { openHistory } from "../src/index.js";

const execute = promisify(execFile);
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

async function git(cwd: string, ...args: string[]) {
  return execute("git", args, { cwd, env: gitEnv });
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-space-history-"));
  const space = path.join(root, "space");
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(space);
  const file = (relative: string) => path.join(space, relative);
  const write = async (relative: string, value: string | Uint8Array) => {
    await mkdir(path.dirname(file(relative)), { recursive: true });
    await writeFile(file(relative), value);
  };
  return { root, space, file, write };
}

async function treeBytes(directory: string): Promise<Record<string, Buffer>> {
  const result: Record<string, Buffer> = {};
  const visit = async (relative: string) => {
    const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
    for (const entry of entries) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        await visit(name);
      } else if (entry.isFile()) {
        result[name] = await readFile(path.join(directory, name));
      }
    }
  };
  await visit("");
  return result;
}

async function firstRevision(history: Awaited<ReturnType<typeof openHistory>>) {
  const revision = (await history.list())[0];
  assert.ok(revision);
  return revision;
}

test("空目录启动建立基线，重开和无变化外部快照复用同一版本", async (t) => {
  const f = await fixture(t);
  const history = await openHistory(f.space);
  const baseline = await firstRevision(history);
  assert.equal(baseline.parent, null);
  assert.deepEqual(baseline.source, { kind: "external" });
  assert.equal(new Date(baseline.timestamp).toISOString(), baseline.timestamp);
  assert.deepEqual(await history.snapshot(), {
    revision: baseline.id,
    committed: false,
    skipped: [],
  });
  const reopened = await openHistory(f.space);
  assert.equal((await firstRevision(reopened)).id, baseline.id);
  assert.equal((await reopened.list()).length, 1);
  assert.deepEqual(await reopened.changesSince(null), {
    revision: baseline.id,
    revisions: [{ ...baseline, changes: [] }],
  });
});

test("普通目录的已有内容进入基线，进程外增删由快照纳入历史", async (t) => {
  const f = await fixture(t);
  await f.write("old.txt", "启动时内容\n");
  const history = await openHistory(f.space);
  const baseline = await firstRevision(history);
  await execute("sh", ["-c", 'printf "shell 写入\\n" > "shell.txt"; rm "old.txt"'], { cwd: f.space });
  const snapshot = await history.snapshot();
  assert.equal(snapshot.committed, true);
  assert.notEqual(snapshot.revision, baseline.id);
  const caughtUp = await history.changesSince(baseline.id);
  assert.equal(caughtUp.revision, snapshot.revision);
  assert.equal(caughtUp.revisions.length, 1);
  assert.deepEqual(caughtUp.revisions[0]?.source, { kind: "external" });
  assert.deepEqual(caughtUp.revisions[0]?.changes, [
    { kind: "deleted", path: "old.txt" },
    { kind: "added", path: "shell.txt" },
  ]);
});

test("用户仓库的 Git 元数据、索引和暂存内容在快照及撤销后逐字节保留", async (t) => {
  const f = await fixture(t);
  await git(f.space, "init", "--initial-branch=main");
  await git(f.space, "config", "core.autocrlf", "false");
  await f.write("tracked.txt", "原始提交\n");
  await git(f.space, "add", "tracked.txt");
  await git(f.space, "-c", "user.name=History Test", "-c", "user.email=history@example.invalid", "commit", "-m", "fixture");
  await f.write("tracked.txt", "暂存版本\n");
  await git(f.space, "add", "tracked.txt");
  await f.write("tracked.txt", "工作树版本\n");
  await f.write("staged.txt", "只存在暂存区的新文件\n");
  await git(f.space, "add", "staged.txt");
  const originalGit = await treeBytes(f.file(".git"));
  const stagedBefore = await git(f.space, "show", ":tracked.txt");
  const history = await openHistory(f.space);
  const result = await history.record({ kind: "agent", runId: "git-user-space" }, async () => {
    await f.write("tracked.txt", "Agent 修改\n");
    return "完成";
  });
  assert.equal(result.value, "完成");
  await history.undo(result.snapshot.revision);
  assert.equal(await readFile(f.file("tracked.txt"), "utf8"), "工作树版本\n");
  assert.deepEqual(await treeBytes(f.file(".git")), originalGit);
  assert.equal((await git(f.space, "show", ":tracked.txt")).stdout, stagedBefore.stdout);
  assert.equal((await git(f.space, "show", ":staged.txt")).stdout, "只存在暂存区的新文件\n");
});

test("嵌套独立仓库与任意 Git 元数据目录不进入空间历史", async (t) => {
  const f = await fixture(t);
  await f.write("visible.txt", "空间内容\n");
  await mkdir(f.file("nested/repository"), { recursive: true });
  await git(f.file("nested/repository"), "init", "--initial-branch=main");
  await f.write("nested/repository/private.txt", "嵌套仓库\n");
  await f.write("other/.git/config", "任意元数据\n");
  const history = await openHistory(f.space);
  const initial = await history.changesSince(null);
  const initialPaths = initial.revisions.flatMap((revision) => revision.changes.map((change) => change.path));
  assert.deepEqual(initialPaths, ["visible.txt"]);
  await f.write("nested/repository/private.txt", "仓库独立更新\n");
  await f.write("other/.git/config", "元数据更新\n");
  assert.equal((await history.snapshot()).committed, false);
});

test("忽略规则排除内容，超限文件报告路径且等于上限的文件保留", async (t) => {
  const f = await fixture(t);
  await f.write(".gitignore", "ignored/\n*.secret\n");
  await f.write("ignored/private.txt", "秘密\n");
  await f.write("token.secret", "凭据\n");
  await f.write("large.bin", Buffer.alloc(65, 1));
  await f.write("boundary.bin", Buffer.alloc(64, 2));
  const history = await openHistory(f.space, { maxFileBytes: 64 });
  const snapshot = await history.snapshot();
  const paths = (await history.changesSince(null)).revisions.flatMap((revision) => revision.changes.map((change) => change.path));
  assert.deepEqual(paths.sort(), [".gitignore", "boundary.bin"]);
  assert.ok(snapshot.skipped.some((item) => item.path === "large.bin" && item.reason.length > 0));
  assert.equal(await readFile(f.file("large.bin")).then((bytes) => bytes.length), 65);
});

test("运行前的外部编辑与运行写入分属两个版本，空运行仍留下来源记录", async (t) => {
  const f = await fixture(t);
  const history = await openHistory(f.space);
  const baseline = await firstRevision(history);
  await f.write("human.txt", "外部编辑\n");
  const result = await history.record({ kind: "agent", runId: "run-1" }, async () => {
    await f.write("agent.txt", "运行编辑\n");
    return 42;
  });
  assert.equal(result.value, 42);
  const revisions = (await history.changesSince(baseline.id)).revisions;
  assert.equal(revisions.length, 2);
  assert.deepEqual(revisions[0]?.source, { kind: "external" });
  assert.deepEqual(revisions[0]?.changes, [{ kind: "added", path: "human.txt" }]);
  assert.deepEqual(revisions[1]?.source, { kind: "agent", runId: "run-1" });
  assert.deepEqual(revisions[1]?.changes, [{ kind: "added", path: "agent.txt" }]);
  assert.equal(revisions[1]?.id, result.snapshot.revision);
  const empty = await history.record({ kind: "agent", runId: "empty-run" }, async () => "无修改");
  assert.equal(empty.snapshot.committed, true);
  const emptyChanges = await history.changesSince(result.snapshot.revision);
  assert.deepEqual(emptyChanges.revisions[0]?.changes, []);
  assert.deepEqual(emptyChanges.revisions[0]?.source, { kind: "agent", runId: "empty-run" });
});

test("插件操作写入插件来源，失败运行仍保存已落盘内容并传播原异常", async (t) => {
  const f = await fixture(t);
  const history = await openHistory(f.space);
  const plugin = await history.record({ kind: "plugin", pluginId: "learning" }, async () => {
    await f.write("plugin.json", '{"step":1}\n');
    return { step: 1 };
  });
  assert.deepEqual(plugin.value, { step: 1 });
  assert.deepEqual((await firstRevision(history)).source, { kind: "plugin", pluginId: "learning" });
  const error = new Error("运行失败");
  await assert.rejects(history.record({ kind: "agent", runId: "failed-run" }, async () => {
    await f.write("partial.txt", "已经落盘\n");
    throw error;
  }), (actual: unknown) => actual === error);
  const captured = (await history.changesSince(plugin.snapshot.revision)).revisions;
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0]?.source, { kind: "agent", runId: "failed-run" });
  assert.deepEqual(captured[0]?.changes, [{ kind: "added", path: "partial.txt" }]);
});

test("撤销运行仅恢复该运行触碰的路径，外部文件内容与修改时间保持不变", async (t) => {
  const f = await fixture(t);
  await f.write("changed.txt", "原始\r\n");
  await f.write("removed.txt", "还原删除\n");
  await f.write("untouched.txt", "不要重写\n");
  const history = await openHistory(f.space);
  const run = await history.record({ kind: "agent", runId: "undo-run" }, async () => {
    await f.write("changed.txt", "运行修改\n");
    await f.write("created.txt", "运行新增\n");
    await rm(f.file("removed.txt"));
  });
  await f.write("human.txt", "后来外部写入\n");
  const fixedTime = new Date("2001-02-03T04:05:06.000Z");
  await utimes(f.file("untouched.txt"), fixedTime, fixedTime);
  await utimes(f.file("human.txt"), fixedTime, fixedTime);
  const beforeUntouched = await stat(f.file("untouched.txt"));
  const beforeHuman = await stat(f.file("human.txt"));
  const undone = await history.undo(run.snapshot.revision);
  assert.deepEqual(undone.conflicts, []);
  assert.deepEqual([...undone.restored].sort(), ["changed.txt", "created.txt", "removed.txt"]);
  assert.equal(await readFile(f.file("changed.txt"), "utf8"), "原始\r\n");
  assert.equal(await readFile(f.file("removed.txt"), "utf8"), "还原删除\n");
  await assert.rejects(readFile(f.file("created.txt")), { code: "ENOENT" });
  assert.equal(await readFile(f.file("human.txt"), "utf8"), "后来外部写入\n");
  assert.equal((await stat(f.file("untouched.txt"))).mtimeMs, beforeUntouched.mtimeMs);
  assert.equal((await stat(f.file("human.txt"))).mtimeMs, beforeHuman.mtimeMs);
  const undoUndo = await history.undo(undone.revision);
  assert.deepEqual(undoUndo.conflicts, []);
  assert.equal(await readFile(f.file("changed.txt"), "utf8"), "运行修改\n");
  assert.equal(await readFile(f.file("created.txt"), "utf8"), "运行新增\n");
  await assert.rejects(readFile(f.file("removed.txt")), { code: "ENOENT" });
});

test("后来版本触碰同一路径即冲突，改回相同字节也不允许早期撤销覆盖", async (t) => {
  const f = await fixture(t);
  await f.write("conflict.txt", "最初\n");
  await f.write("safe.txt", "最初\n");
  const history = await openHistory(f.space);
  const first = await history.record({ kind: "agent", runId: "first" }, async () => {
    await f.write("conflict.txt", "第一次\n");
    await f.write("safe.txt", "第一次\n");
  });
  await history.record({ kind: "agent", runId: "second" }, async () => {
    await f.write("conflict.txt", "第二次\n");
  });
  await history.record({ kind: "agent", runId: "third" }, async () => {
    await f.write("conflict.txt", "第一次\n");
  });
  const undone = await history.undo(first.snapshot.revision);
  assert.deepEqual(undone.conflicts, ["conflict.txt"]);
  assert.deepEqual(undone.restored, ["safe.txt"]);
  assert.equal(await readFile(f.file("conflict.txt"), "utf8"), "第一次\n");
  assert.equal(await readFile(f.file("safe.txt"), "utf8"), "最初\n");
});

test("连续提交保留新增、修改、重命名和删除，而不是只返回最终净差异", async (t) => {
  const f = await fixture(t);
  const history = await openHistory(f.space);
  const baseline = await firstRevision(history);
  await f.write("first.txt", "初稿\n");
  const added = await history.snapshot();
  await f.write("first.txt", "修改稿\n");
  const modified = await history.snapshot();
  await rename(f.file("first.txt"), f.file("second.txt"));
  const renamed = await history.snapshot();
  await rm(f.file("second.txt"));
  const deleted = await history.snapshot();
  const result = await history.changesSince(baseline.id);
  assert.equal(result.revision, deleted.revision);
  assert.deepEqual(result.revisions.map((revision) => revision.id), [added.revision, modified.revision, renamed.revision, deleted.revision]);
  assert.deepEqual(result.revisions.map((revision) => revision.changes), [
    [{ kind: "added", path: "first.txt" }],
    [{ kind: "modified", path: "first.txt" }],
    [{ kind: "renamed", path: "second.txt", previousPath: "first.txt" }],
    [{ kind: "deleted", path: "second.txt" }],
  ]);
  assert.deepEqual((await history.list(2)).map((revision) => revision.id), [deleted.revision, renamed.revision]);
  assert.deepEqual(await history.changesSince(deleted.revision), { revision: deleted.revision, revisions: [] });
});

test("撤销重命名时两端作为一组，任一端后来被修改就保持整个重命名", async (t) => {
  const f = await fixture(t);
  await f.write("before.txt", "内容\n");
  const history = await openHistory(f.space);
  const renamed = await history.record({ kind: "agent", runId: "rename" }, async () => {
    await rename(f.file("before.txt"), f.file("after.txt"));
  });
  await f.write("after.txt", "后来编辑\n");
  const undone = await history.undo(renamed.snapshot.revision);
  assert.deepEqual([...undone.conflicts].sort(), ["after.txt", "before.txt"]);
  assert.deepEqual(undone.restored, []);
  assert.equal(await readFile(f.file("after.txt"), "utf8"), "后来编辑\n");
  await assert.rejects(readFile(f.file("before.txt")), { code: "ENOENT" });
});

test("通知只唤醒订阅者，取消后错过的版本仍可用持久游标完整追上", async (t) => {
  const f = await fixture(t);
  const history = await openHistory(f.space);
  const baseline = await firstRevision(history);
  const notifications: string[] = [];
  const unsubscribe = history.onRevision((revision) => {
    notifications.push(revision);
  });
  assert.deepEqual(notifications, []);
  const removeThrowingListener = history.onRevision(() => {
    throw new Error("订阅者故障");
  });
  await f.write("one.txt", "一\n");
  const first = await history.snapshot();
  assert.deepEqual(notifications, [first.revision]);
  await history.snapshot();
  assert.deepEqual(notifications, [first.revision]);
  unsubscribe();
  removeThrowingListener();
  await f.write("two.txt", "二\n");
  const second = await history.snapshot();
  await f.write("three.txt", "三\n");
  const third = await history.snapshot();
  assert.deepEqual(notifications, [first.revision]);
  const reopened = await openHistory(f.space);
  assert.deepEqual((await reopened.changesSince(baseline.id)).revisions.map((revision) => revision.id), [first.revision, second.revision, third.revision]);
  assert.deepEqual((await reopened.changesSince(first.revision)).revisions.map((revision) => revision.id), [second.revision, third.revision]);
});

test("排队的快照与并发运行不会把另一个运行的写入混入当前来源", async (t) => {
  const f = await fixture(t);
  const history = await openHistory(f.space);
  const baseline = await firstRevision(history);
  let release = () => {};
  let entered = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const first = history.record({ kind: "agent", runId: "first" }, async () => {
    await f.write("first.txt", "第一个运行\n");
    entered();
    await gate;
  });
  await started;
  const queued = history.snapshot();
  const second = history.record({ kind: "agent", runId: "second" }, async () => {
    await f.write("second.txt", "第二个运行\n");
  });
  release();
  const [firstResult, queuedResult, secondResult] = await Promise.all([first, queued, second]);
  assert.equal(queuedResult.revision, firstResult.snapshot.revision);
  assert.equal(queuedResult.committed, false);
  const changes = (await history.changesSince(baseline.id)).revisions;
  assert.deepEqual(changes.map((revision) => revision.source), [
    { kind: "agent", runId: "first" },
    { kind: "agent", runId: "second" },
  ]);
  assert.deepEqual(changes.map((revision) => revision.changes), [
    [{ kind: "added", path: "first.txt" }],
    [{ kind: "added", path: "second.txt" }],
  ]);
  assert.equal(changes[1]?.id, secondResult.snapshot.revision);
});

test("已跟踪文件后来超限或被忽略，撤销不得删除仍在磁盘上的排除内容", async (t) => {
  const f = await fixture(t);
  const history = await openHistory(f.space, { maxFileBytes: 64 });
  const first = await history.record({ kind: "agent", runId: "create" }, async () => {
    await f.write("large.txt", "小文件\n");
    await f.write("ignored.txt", "可跟踪\n");
  });
  const large = Buffer.alloc(65, 7);
  await f.write("large.txt", large);
  await f.write(".gitignore", "ignored.txt\n");
  await f.write("ignored.txt", "后来用户保存的忽略内容\n");
  await history.snapshot();
  const result = await history.undo(first.snapshot.revision);
  assert.deepEqual([...result.conflicts].sort(), ["ignored.txt", "large.txt"]);
  assert.deepEqual(result.restored, []);
  assert.deepEqual(await readFile(f.file("large.txt")), large);
  assert.equal(await readFile(f.file("ignored.txt"), "utf8"), "后来用户保存的忽略内容\n");
});

test("原始 CRLF、二进制和换行文件名按字节恢复，符号链接不读取空间外内容", async (t) => {
  const f = await fixture(t);
  const filename = "行一\n行二.txt";
  const original = Buffer.from([0, 1, 13, 10, 255, 128]);
  await f.write(filename, original);
  await f.write("crlf.txt", "中文\r\n第二行\r\n");
  const outside = path.join(f.root, "outside.txt");
  await writeFile(outside, "空间外的秘密\n");
  await symlink(outside, f.file("outside-link"));
  const history = await openHistory(f.space);
  const baseline = await history.changesSince(null);
  assert.ok(baseline.revisions.flatMap((revision) => revision.changes).some((change) => change.path === "outside-link"));
  const changed = await history.record({ kind: "agent", runId: "bytes" }, async () => {
    await f.write(filename, Buffer.from([42, 10]));
    await f.write("crlf.txt", "换成 LF\n");
    await rm(f.file("outside-link"));
  });
  await history.undo(changed.snapshot.revision);
  assert.deepEqual(await readFile(f.file(filename)), original);
  assert.equal(await readFile(f.file("crlf.txt"), "utf8"), "中文\r\n第二行\r\n");
  assert.ok((await lstat(f.file("outside-link"))).isSymbolicLink());
  assert.equal(await readlink(f.file("outside-link")), outside);
  assert.equal(await readFile(outside, "utf8"), "空间外的秘密\n");
});

test("运行前外部修改同一文件后再由运行覆盖，撤销回到外部版本而非旧基线", async (t) => {
  const f = await fixture(t);
  await f.write("shared.txt", "旧基线\n");
  const history = await openHistory(f.space);
  const baseline = await firstRevision(history);
  await f.write("shared.txt", "用户外部编辑\r\n");
  const run = await history.record({ kind: "agent", runId: "shared" }, async () => {
    await f.write("shared.txt", "运行覆盖\n");
  });
  const revisions = (await history.changesSince(baseline.id)).revisions;
  assert.deepEqual(revisions.map((revision) => revision.source), [
    { kind: "external" },
    { kind: "agent", runId: "shared" },
  ]);
  const undone = await history.undo(run.snapshot.revision);
  assert.deepEqual(undone.conflicts, []);
  assert.deepEqual(undone.restored, ["shared.txt"]);
  assert.equal(await readFile(f.file("shared.txt"), "utf8"), "用户外部编辑\r\n");
});

test("未发生后续编辑的重命名可以撤销，原路径恢复且新路径移除", async (t) => {
  const f = await fixture(t);
  await f.write("before.txt", "重命名内容\r\n");
  const history = await openHistory(f.space);
  const renamed = await history.record({ kind: "agent", runId: "rename-clean" }, async () => {
    await rename(f.file("before.txt"), f.file("after.txt"));
  });
  const undone = await history.undo(renamed.snapshot.revision);
  assert.deepEqual(undone.conflicts, []);
  assert.deepEqual([...undone.restored].sort(), ["after.txt", "before.txt"]);
  assert.equal(await readFile(f.file("before.txt"), "utf8"), "重命名内容\r\n");
  await assert.rejects(readFile(f.file("after.txt")), { code: "ENOENT" });
});

test("无效游标和基线撤销被拒绝，不改变有效历史或空间内容", async (t) => {
  const f = await fixture(t);
  await f.write("content.txt", "保留内容\n");
  const history = await openHistory(f.space);
  const baseline = await firstRevision(history);
  await assert.rejects(history.changesSince("不存在的版本"));
  await assert.rejects(async () => history.undo("不存在的版本"));
  await assert.rejects(history.undo(baseline.id));
  assert.equal((await firstRevision(history)).id, baseline.id);
  assert.equal(await readFile(f.file("content.txt"), "utf8"), "保留内容\n");
});

test("用户 linked worktree 的 Git 指针与实际仓库元数据在历史操作后不变", async (t) => {
  const f = await fixture(t);
  const repository = path.join(f.root, "repository");
  await mkdir(repository);
  await git(repository, "init", "--initial-branch=main");
  await writeFile(path.join(repository, "initial.txt"), "初始文件\n");
  await git(repository, "add", "initial.txt");
  await git(repository, "-c", "user.name=History Test", "-c", "user.email=history@example.invalid", "commit", "-m", "fixture");
  await git(repository, "worktree", "add", "-b", "space", f.space);
  const gitPointer = await readFile(f.file(".git"));
  const metadata = await treeBytes(path.join(repository, ".git"));
  const history = await openHistory(f.space);
  const run = await history.record({ kind: "agent", runId: "worktree" }, async () => {
    await f.write("initial.txt", "运行修改\n");
  });
  await history.undo(run.snapshot.revision);
  assert.deepEqual(await readFile(f.file(".git")), gitPointer);
  assert.deepEqual(await treeBytes(path.join(repository, ".git")), metadata);
  assert.equal(await readFile(f.file("initial.txt"), "utf8"), "初始文件\n");
});

test("撤销遇到父目录变为符号链接时报告冲突，不穿透链接修改空间外文件", async (t) => {
  const f = await fixture(t);
  await f.write("notes/content.txt", "原内容\n");
  const history = await openHistory(f.space);
  const run = await history.record({ kind: "agent", runId: "nested-file" }, async () => {
    await f.write("notes/content.txt", "运行内容\n");
  });
  const outside = path.join(f.root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "content.txt"), "外部文件\n");
  await rm(f.file("notes"), { recursive: true });
  await symlink(outside, f.file("notes"));
  const undone = await history.undo(run.snapshot.revision);
  assert.deepEqual(undone.conflicts, ["notes/content.txt"]);
  assert.deepEqual(undone.restored, []);
  assert.ok((await lstat(f.file("notes"))).isSymbolicLink());
  assert.equal(await readFile(path.join(outside, "content.txt"), "utf8"), "外部文件\n");
});


test("重开已有历史时自动捕获离线编辑，并保留重开前游标的追赶路径", async (t) => {
  const f = await fixture(t);
  await f.write("content.txt", "旧内容\n");
  const history = await openHistory(f.space);
  const baseline = await firstRevision(history);
  await f.write("content.txt", "离线编辑\n");
  await f.write("offline.txt", "离线新增\n");
  const reopened = await openHistory(f.space);
  const caughtUp = await reopened.changesSince(baseline.id);
  assert.equal(caughtUp.revisions.length, 1);
  assert.deepEqual(caughtUp.revisions[0]?.source, { kind: "external" });
  assert.deepEqual(caughtUp.revisions[0]?.changes, [
    { kind: "modified", path: "content.txt" },
    { kind: "added", path: "offline.txt" },
  ]);
  assert.equal((await firstRevision(reopened)).id, caughtUp.revision);
});

test("层叠忽略规则允许否定普通文件，但不能重新纳入私有历史或嵌套 bare 仓库", async (t) => {
  const f = await fixture(t);
  await f.write(".gitignore", "*.tmp\n.repa/\n!.repa/\n!.repa/**\n");
  await f.write("notes/.gitignore", "*.txt\n!keep.txt\n!keep.tmp\n");
  await f.write("notes/keep.txt", "否定规则保留\n");
  await f.write("notes/drop.txt", "目录规则排除\n");
  await f.write("notes/keep.tmp", "覆盖上层忽略\n");
  await f.write("notes/drop.tmp", "上层规则排除\n");
  await f.write(".repa/private.txt", "不纳入历史\n");
  await mkdir(f.file("archives"));
  await git(f.space, "init", "--bare", "--initial-branch=main", f.file("archives/repository.git"));
  await f.write("archives/repository.git/private.txt", "bare 仓库内容\n");
  const history = await openHistory(f.space);
  const paths = (await history.changesSince(null)).revisions.flatMap((revision) => revision.changes.map((change) => change.path));
  assert.deepEqual(paths.sort(), [".gitignore", "notes/.gitignore", "notes/keep.tmp", "notes/keep.txt"]);
  await f.write(".repa/private.txt", "私有目录独立修改\n");
  await f.write("archives/repository.git/private.txt", "bare 仓库独立修改\n");
  assert.equal((await history.snapshot()).committed, false);
});

test("用户 Git 配置及 attributes 不触发过滤器，也不把历史中的 CRLF 规范化", async (t) => {
  const f = await fixture(t);
  await git(f.space, "init", "--initial-branch=main");
  await git(f.space, "config", "core.autocrlf", "true");
  await git(f.space, "config", "filter.history-test.clean", "sh -c 'printf triggered > filter-marker; cat'");
  await git(f.space, "config", "filter.history-test.smudge", "sh -c 'printf triggered > filter-marker; cat'");
  await git(f.space, "config", "filter.history-test.required", "true");
  await f.write(".gitattributes", "*.txt text eol=lf filter=history-test\n");
  const original = Buffer.from("中文\r\n原始第二行\r\n");
  await f.write("content.txt", original);
  const gitMetadata = await treeBytes(f.file(".git"));
  const history = await openHistory(f.space);
  const run = await history.record({ kind: "agent", runId: "unfiltered" }, async () => {
    await f.write("content.txt", "运行修改\n");
  });
  await history.undo(run.snapshot.revision);
  assert.deepEqual(await readFile(f.file("content.txt")), original);
  assert.deepEqual(await treeBytes(f.file(".git")), gitMetadata);
  await assert.rejects(readFile(f.file("filter-marker")), { code: "ENOENT" });
});

test("撤销保留现有文件的私有权限，恢复已删除文件时仅给予所有者权限", async (t) => {
  const f = await fixture(t);
  await f.write("private.txt", "私有原内容\n");
  await f.write("deleted.txt", "被删除的私有内容\n");
  await f.write("executable.sh", "#!/bin/sh\nexit 0\n");
  await chmod(f.file("private.txt"), 0o600);
  await chmod(f.file("deleted.txt"), 0o600);
  await chmod(f.file("executable.sh"), 0o700);
  const history = await openHistory(f.space);
  const run = await history.record({ kind: "agent", runId: "private-permissions" }, async () => {
    await f.write("private.txt", "运行修改\n");
    await rm(f.file("deleted.txt"));
    await rm(f.file("executable.sh"));
  });
  const undone = await history.undo(run.snapshot.revision);
  assert.deepEqual(undone.conflicts, []);
  assert.equal((await stat(f.file("private.txt"))).mode & 0o777, 0o600);
  assert.equal((await stat(f.file("deleted.txt"))).mode & 0o777, 0o600);
  assert.equal((await stat(f.file("executable.sh"))).mode & 0o777, 0o700);
  assert.equal(await readFile(f.file("private.txt"), "utf8"), "私有原内容\n");
  assert.equal(await readFile(f.file("deleted.txt"), "utf8"), "被删除的私有内容\n");
  assert.equal(await readFile(f.file("executable.sh"), "utf8"), "#!/bin/sh\nexit 0\n");
});

test("整个空间目录搬家后历史仍可重开，原游标可追赶且原运行可以撤销", async (t) => {
  const f = await fixture(t);
  await f.write("content.txt", "搬家前原内容\r\n");
  const history = await openHistory(f.space);
  const baseline = await firstRevision(history);
  const run = await history.record({ kind: "agent", runId: "portable" }, async () => {
    await f.write("content.txt", "运行修改\n");
    await f.write("new.txt", "运行新文件\n");
  });
  const relocated = path.join(f.root, "relocated-space");
  await rename(f.space, relocated);
  const reopened = await openHistory(relocated);
  const caughtUp = await reopened.changesSince(baseline.id);
  assert.equal(caughtUp.revision, run.snapshot.revision);
  assert.deepEqual(caughtUp.revisions.map((revision) => revision.id), [run.snapshot.revision]);
  assert.deepEqual(caughtUp.revisions[0]?.source, { kind: "agent", runId: "portable" });
  assert.deepEqual(caughtUp.revisions[0]?.changes, [
    { kind: "modified", path: "content.txt" },
    { kind: "added", path: "new.txt" },
  ]);
  const undone = await reopened.undo(run.snapshot.revision);
  assert.deepEqual(undone.conflicts, []);
  assert.deepEqual(undone.restored, ["content.txt", "new.txt"]);
  assert.equal(await readFile(path.join(relocated, "content.txt"), "utf8"), "搬家前原内容\r\n");
  await assert.rejects(readFile(path.join(relocated, "new.txt")), { code: "ENOENT" });
});

test("运行中的 shell 创建和删除进入运行来源，并可按该运行恢复", async (t) => {
  const f = await fixture(t);
  await f.write("removed.txt", "运行前保留内容\r\n");
  const history = await openHistory(f.space);
  const baseline = await firstRevision(history);
  const run = await history.record({ kind: "agent", runId: "shell-run" }, async () => {
    await execute("sh", ["-c", 'mkdir -p shell; printf "运行 shell 创建\\n" > "shell/created.txt"; rm "removed.txt"'], { cwd: f.space });
  });
  const caughtUp = await history.changesSince(baseline.id);
  assert.equal(caughtUp.revisions.length, 1);
  assert.deepEqual(caughtUp.revisions[0]?.source, { kind: "agent", runId: "shell-run" });
  assert.deepEqual(caughtUp.revisions[0]?.changes, [
    { kind: "deleted", path: "removed.txt" },
    { kind: "added", path: "shell/created.txt" },
  ]);
  const undone = await history.undo(run.snapshot.revision);
  assert.deepEqual(undone.conflicts, []);
  assert.deepEqual(undone.restored, ["removed.txt", "shell/created.txt"]);
  assert.equal(await readFile(f.file("removed.txt"), "utf8"), "运行前保留内容\r\n");
  await assert.rejects(readFile(f.file("shell/created.txt")), { code: "ENOENT" });
});

test("运行改变文件和目录形态后撤销完整恢复原形态与独立路径", async (t) => {
  for (const transition of ["文件变目录", "目录变文件", "文件变空目录"]) {
    await t.test(transition, async (context) => {
      const f = await fixture(context);
      await f.write("safe.txt", "独立路径原内容\n");
      if (transition === "目录变文件") {
        await f.write("node/child.txt", "原目录中文件\n");
      } else {
        await f.write("node", "原文件内容\n");
      }
      const history = await openHistory(f.space);
      const run = await history.record({ kind: "agent", runId: "shape-change" }, async () => {
        await rm(f.file("node"), { recursive: true });
        if (transition === "文件变目录") {
          await f.write("node/child.txt", "运行后目录中文件\n");
        } else if (transition === "目录变文件") {
          await f.write("node", "运行后单个文件\n");
        } else {
          await mkdir(f.file("node"));
        }
        await f.write("safe.txt", "运行修改独立路径\n");
      });
      const undone = await history.undo(run.snapshot.revision);
      assert.deepEqual(undone.conflicts, []);
      const restored = transition === "文件变空目录" ? ["node", "safe.txt"] : ["node", "node/child.txt", "safe.txt"];
      assert.deepEqual([...undone.restored].sort(), restored);
      assert.equal(await readFile(f.file("safe.txt"), "utf8"), "独立路径原内容\n");
      if (transition !== "目录变文件") {
        assert.ok((await lstat(f.file("node"))).isFile());
        assert.equal(await readFile(f.file("node"), "utf8"), "原文件内容\n");
      } else {
        assert.ok((await lstat(f.file("node"))).isDirectory());
        assert.equal(await readFile(f.file("node/child.txt"), "utf8"), "原目录中文件\n");
        assert.deepEqual(await readdir(f.file("node")), ["child.txt"]);
      }
    });
  }
});

test("文件变目录后出现被忽略的额外文件，撤销整组冲突并保留所有目录内容", async (t) => {
  const f = await fixture(t);
  await f.write(".gitignore", "*.tmp\n");
  await f.write("node", "原普通文件\n");
  const history = await openHistory(f.space);
  const run = await history.record({ kind: "agent", runId: "shape-with-ignored" }, async () => {
    await rm(f.file("node"));
    await f.write("node/child.txt", "运行新增目录中的文件\n");
  });
  await f.write("node/ignored.tmp", "后来的忽略内容\n");
  const undone = await history.undo(run.snapshot.revision);
  assert.deepEqual([...undone.conflicts].sort(), ["node", "node/child.txt"]);
  assert.deepEqual(undone.restored, []);
  assert.ok((await lstat(f.file("node"))).isDirectory());
  assert.deepEqual((await readdir(f.file("node"))).sort(), ["child.txt", "ignored.tmp"]);
  assert.equal(await readFile(f.file("node/child.txt"), "utf8"), "运行新增目录中的文件\n");
  assert.equal(await readFile(f.file("node/ignored.tmp"), "utf8"), "后来的忽略内容\n");
});

test("全冲突撤销和空运行撤销也生成独立的 undo 来源提交", async (t) => {
  const f = await fixture(t);
  await f.write("conflict.txt", "原内容\n");
  const history = await openHistory(f.space);
  const run = await history.record({ kind: "agent", runId: "all-conflicts" }, async () => {
    await f.write("conflict.txt", "运行内容\n");
  });
  await f.write("conflict.txt", "后来用户编辑\n");
  const external = await history.snapshot();
  const conflictedUndo = await history.undo(run.snapshot.revision);
  assert.deepEqual(conflictedUndo.conflicts, ["conflict.txt"]);
  assert.deepEqual(conflictedUndo.restored, []);
  assert.notEqual(conflictedUndo.revision, external.revision);
  const undoRevision = await firstRevision(history);
  assert.equal(undoRevision.id, conflictedUndo.revision);
  assert.equal(undoRevision.parent, external.revision);
  assert.deepEqual(undoRevision.source, { kind: "undo", revision: run.snapshot.revision });
  assert.deepEqual((await history.changesSince(external.revision)).revisions[0]?.changes, []);
  assert.equal(await readFile(f.file("conflict.txt"), "utf8"), "后来用户编辑\n");

  const emptyRun = await history.record({ kind: "agent", runId: "empty-to-undo" }, async () => {});
  const emptyUndo = await history.undo(emptyRun.snapshot.revision);
  assert.deepEqual(emptyUndo.conflicts, []);
  assert.deepEqual(emptyUndo.restored, []);
  assert.notEqual(emptyUndo.revision, emptyRun.snapshot.revision);
  const emptyRevision = await firstRevision(history);
  assert.equal(emptyRevision.id, emptyUndo.revision);
  assert.equal(emptyRevision.parent, emptyRun.snapshot.revision);
  assert.deepEqual(emptyRevision.source, { kind: "undo", revision: emptyRun.snapshot.revision });
  assert.deepEqual((await history.changesSince(emptyRun.snapshot.revision)).revisions[0]?.changes, []);
});
