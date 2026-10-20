import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, readlink, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

import { Git } from "../src/git.js";
import { openHistory, type ActivitySource, type ChangeFeed } from "../src/index.js";

const execute = promisify(execFile);
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-space-history-paths-"));
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
  return { space, file, write };
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function head(history: Awaited<ReturnType<typeof openHistory>>) {
  const [revision] = await history.list(1);
  assert.ok(revision);
  return revision;
}

function summary(feed: ChangeFeed) {
  return feed.revisions.map(({ source, changes }) => ({ source, changes }));
}

test("按路径记账只提交给定路径，范围外同期的改动留给之后的外部快照，内容不变则不提交", async (t) => {
  const f = await fixture(t);
  await f.write("notes/a.md", "原稿\n");
  const history = await openHistory(f.space);
  const baseline = await head(history);
  await f.write("other.txt", "未记录的外部改动\n");
  const source = { kind: "agent", runId: "writer" } as const;
  const result = await history.recordPaths(source, ["notes/a.md"], async () => {
    await f.write("notes/a.md", "运行修改\n");
    await f.write("editor.txt", "动作期间别处的写入\n");
    return "完成";
  });
  assert.equal(result.value, "完成");
  assert.equal(result.snapshot.committed, true);
  const written = await history.changesSince(baseline.id);
  assert.equal(written.revision, result.snapshot.revision);
  assert.deepEqual(summary(written), [{ source, changes: [{ kind: "modified", path: "notes/a.md" }] }]);
  const unchanged = await history.recordPaths(source, ["notes/a.md"], async () => {
    await f.write("notes/a.md", "运行修改\n");
  });
  assert.deepEqual(unchanged.snapshot, { revision: result.snapshot.revision, committed: false, skipped: [] });
  const external = await history.snapshot();
  assert.deepEqual(summary(await history.changesSince(result.snapshot.revision)), [{
    source: { kind: "external" },
    changes: [{ kind: "added", path: "editor.txt" }, { kind: "added", path: "other.txt" }],
  }]);
  assert.equal(external.committed, true);
});

test("写入前给定路径上已有的外部改动先记为 external，撤回运行回到这个外部版本", async (t) => {
  const f = await fixture(t);
  await f.write("shared.txt", "旧基线\n");
  const history = await openHistory(f.space);
  const baseline = await head(history);
  await f.write("shared.txt", "用户外部编辑\r\n");
  await f.write("unrelated.txt", "另一个外部改动\n");
  const source = { kind: "agent", runId: "overwrite" } as const;
  await history.recordPaths(source, ["shared.txt"], async () => {
    await f.write("shared.txt", "运行覆盖\n");
  });
  assert.deepEqual(summary(await history.changesSince(baseline.id)), [
    { source: { kind: "external" }, changes: [{ kind: "modified", path: "shared.txt" }] },
    { source, changes: [{ kind: "modified", path: "shared.txt" }] },
  ]);
  const undone = await history.undoRun("overwrite");
  assert.deepEqual(undone.conflicts, []);
  assert.deepEqual(undone.restored, ["shared.txt"]);
  assert.equal(await readFile(f.file("shared.txt"), "utf8"), "用户外部编辑\r\n");
  assert.equal(await readFile(f.file("unrelated.txt"), "utf8"), "另一个外部改动\n");
});

test("给定路径的上级被外部从文件换成目录时，这次替换记为 external，运行只记自己写的文件", async (t) => {
  const f = await fixture(t);
  await f.write("node", "原来是文件\n");
  const history = await openHistory(f.space);
  const baseline = await head(history);
  await rm(f.file("node"));
  await f.write("node/external.txt", "外部放进新目录\n");
  const source = { kind: "agent", runId: "inside" } as const;
  await history.recordPaths(source, ["node/child.txt"], () => f.write("node/child.txt", "运行写入\n"));
  assert.deepEqual(summary(await history.changesSince(baseline.id)), [
    { source: { kind: "external" }, changes: [{ kind: "deleted", path: "node" }] },
    { source, changes: [{ kind: "added", path: "node/child.txt" }] },
  ]);
  const written = await head(history);
  await history.snapshot();
  assert.deepEqual(summary(await history.changesSince(written.id)), [
    { source: { kind: "external" }, changes: [{ kind: "added", path: "node/external.txt" }] },
  ]);
});

test("不同来源并发写不同文件时，各自的动作依次执行，每个来源只记到自己的文件", async (t) => {
  const f = await fixture(t);
  const history = await openHistory(f.space);
  const baseline = await head(history);
  const entered = deferred();
  const release = deferred();
  let active = 0;
  let most = 0;
  const writer = (source: Parameters<typeof history.recordPaths>[0], file: string, hold = false) =>
    history.recordPaths(source, [file], async () => {
      active += 1;
      most = Math.max(most, active);
      await f.write(file, `${file} 的内容\n`);
      if (hold) {
        entered.resolve();
        await release.promise;
      }
      active -= 1;
    });
  const lead = { kind: "agent", runId: "lead" } as const;
  const helper: ActivitySource = { kind: "agent", runId: "helper", ancestorRunIds: ["lead"] };
  const plugin = { kind: "plugin", pluginId: "learning" } as const;
  const other = { kind: "agent", runId: "other" } as const;
  const first = writer(lead, "lead-1.md", true);
  await entered.promise;
  const rest = [writer(helper, "helper.md"), writer(plugin, "progress.json"), writer(other, "other.md"), writer(lead, "lead-2.md")];
  await f.write("editor.txt", "队列外的同期写入\n");
  release.resolve();
  await Promise.all([first, ...rest]);
  assert.equal(most, 1);
  const recorded = summary(await history.changesSince(baseline.id))
    .sort((a, b) => (a.changes[0]?.path ?? "").localeCompare(b.changes[0]?.path ?? ""));
  assert.deepEqual(recorded, [
    { source: helper, changes: [{ kind: "added", path: "helper.md" }] },
    { source: lead, changes: [{ kind: "added", path: "lead-1.md" }] },
    { source: lead, changes: [{ kind: "added", path: "lead-2.md" }] },
    { source: other, changes: [{ kind: "added", path: "other.md" }] },
    { source: plugin, changes: [{ kind: "added", path: "progress.json" }] },
  ]);
  const written = await head(history);
  assert.equal((await history.snapshot()).committed, true);
  assert.deepEqual(summary(await history.changesSince(written.id)), [
    { source: { kind: "external" }, changes: [{ kind: "added", path: "editor.txt" }] },
  ]);
});

test("路径可以是目录；文件与目录互换时上级条目一并更新，按运行撤回恢复原形态", async (t) => {
  const f = await fixture(t);
  await f.write("dir/a.txt", "alpha in directory\n");
  await f.write("dir/sub/b.txt", "beta in subdirectory\n");
  await f.write("node", "original plain file\n");
  await f.write("keep.txt", "范围外\n");
  const history = await openHistory(f.space);
  const baseline = await head(history);
  const source = { kind: "agent", runId: "shape" } as const;
  await history.recordPaths(source, ["dir"], async () => {
    await rm(f.file("dir"), { recursive: true });
    await f.write("dir/new.txt", "replacement content\n");
  });
  await history.recordPaths(source, ["node/child.txt"], async () => {
    await rm(f.file("node"));
    await f.write("node/child.txt", "file became directory\n");
  });
  await history.recordPaths(source, ["dir"], async () => {
    await rm(f.file("dir"), { recursive: true });
    await f.write("dir", "directory became file\n");
  });
  assert.deepEqual(summary(await history.changesSince(baseline.id)).map(({ changes }) => changes), [
    [{ kind: "deleted", path: "dir/a.txt" }, { kind: "added", path: "dir/new.txt" }, { kind: "deleted", path: "dir/sub/b.txt" }],
    [{ kind: "deleted", path: "node" }, { kind: "added", path: "node/child.txt" }],
    [{ kind: "added", path: "dir" }, { kind: "deleted", path: "dir/new.txt" }],
  ]);
  // 当前实例按内存中的树比较，重开的实例从 Git 读取树；两者都不应发现未记录的差异。
  const written = await head(history);
  assert.equal((await history.snapshot()).committed, false);
  assert.equal((await head(await openHistory(f.space))).id, written.id);
  const undone = await history.undoRun("shape");
  assert.deepEqual(undone.conflicts, []);
  assert.deepEqual(undone.restored, ["dir", "dir/a.txt", "dir/sub/b.txt", "node", "node/child.txt"]);
  assert.equal(await readFile(f.file("dir/a.txt"), "utf8"), "alpha in directory\n");
  assert.equal(await readFile(f.file("dir/sub/b.txt"), "utf8"), "beta in subdirectory\n");
  assert.equal(await readFile(f.file("node"), "utf8"), "original plain file\n");
  assert.equal(await readFile(f.file("keep.txt"), "utf8"), "范围外\n");
  assert.equal((await history.snapshot()).committed, false);
  assert.equal((await head(await openHistory(f.space))).id, undone.revision);
});

test("文件名含双引号、反斜杠、换行和中文时按原样提交与撤回，可执行位一并记录", { skip: process.platform === "win32" ? "Windows 不允许这些文件名，也不支持 POSIX 可执行位" : false }, async (t) => {
  const f = await fixture(t);
  const odd = "引\"号\\反斜杠\n换行.md";
  const script = "tools/run.sh";
  await f.write(odd, "原始字节\r\n");
  await f.write(script, "#!/bin/sh\nexit 0\n");
  const history = await openHistory(f.space);
  const baseline = await head(history);
  const source = { kind: "agent", runId: "names" } as const;
  await history.recordPaths(source, [odd, script, "新\"建\n文件.txt"], async () => {
    await f.write(odd, "运行修改\n");
    await f.write("新\"建\n文件.txt", "运行新增\n");
    await chmod(f.file(script), 0o700);
  });
  assert.deepEqual(summary(await history.changesSince(baseline.id)), [{
    source,
    changes: [
      { kind: "modified", path: script },
      { kind: "modified", path: odd },
      { kind: "added", path: "新\"建\n文件.txt" },
    ],
  }]);
  const written = await head(history);
  assert.equal((await head(await openHistory(f.space))).id, written.id);
  const undone = await history.undoRun("names");
  assert.deepEqual(undone.conflicts, []);
  assert.deepEqual(await readFile(f.file(odd)), Buffer.from("原始字节\r\n"));
  await assert.rejects(readFile(f.file("新\"建\n文件.txt")), { code: "ENOENT" });
  assert.equal((await stat(f.file(script))).mode & 0o111, 0);
  assert.equal((await head(await openHistory(f.space))).id, undone.revision);
});

test("给定路径的上级被换成指向空间外的符号链接时，只记录链接本身，不读取空间外的内容", async (t) => {
  const f = await fixture(t);
  await f.write("notes/content.txt", "空间内原文\n");
  await f.write("notes/other.txt", "同目录另一文件\n");
  const history = await openHistory(f.space);
  const baseline = await head(history);
  const outside = path.join(path.dirname(f.space), "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "content.txt"), "空间外的秘密\n");
  const source = { kind: "agent", runId: "linked" } as const;
  const result = await history.recordPaths(source, ["notes/content.txt"], async () => {
    await rm(f.file("notes"), { recursive: true });
    await symlink(outside, f.file("notes"), process.platform === "win32" ? "junction" : "dir");
  });
  assert.deepEqual(result.snapshot.skipped, [{ path: "notes/content.txt", reason: "repository" }]);
  // Git for Windows 把 junction 当作目录列出它里面的文件，不列 junction 本身，所以 Windows 上链接本身不进历史；
  // 空间外的内容照样不读，原来的文件照样记为删除。
  const linkRecorded = process.platform !== "win32";
  assert.deepEqual(summary(await history.changesSince(baseline.id)), [{
    source,
    changes: [
      ...(linkRecorded ? [{ kind: "added", path: "notes" }] : []),
      { kind: "deleted", path: "notes/content.txt" },
      { kind: "deleted", path: "notes/other.txt" },
    ],
  }]);
  const [revision] = await history.list(1);
  assert.ok(revision);
  if (linkRecorded) {
    const git = new Git(f.space, path.join(f.space, ".repa", "history.git"));
    const [entry] = (await git.run(["ls-tree", revision.id, "notes"])).toString().split("\t");
    assert.match(entry ?? "", /^120000 blob /);
    assert.equal((await git.run(["cat-file", "blob", `${revision.id}:notes`])).toString(), await readlink(f.file("notes")));
  }
  assert.equal(await readFile(path.join(outside, "content.txt"), "utf8"), "空间外的秘密\n");
  assert.equal((await history.snapshot()).committed, false);
  assert.equal((await head(await openHistory(f.space))).id, revision.id);
});

test("忽略规则、大小上限、嵌套仓库与 .repa 同样适用，存在却未记入的路径在 skipped 中报告", async (t) => {
  const f = await fixture(t);
  await f.write(".gitignore", "*.tmp\n");
  await f.write("tracked.bin", "小文件\n");
  await mkdir(f.file("nested/repository"), { recursive: true });
  await execute("git", ["init", "--initial-branch=main"], { cwd: f.file("nested/repository"), env: gitEnv });
  const history = await openHistory(f.space, { maxFileBytes: 64 });
  const baseline = await head(history);
  const source = { kind: "agent", runId: "excluded" } as const;
  const scope = ["cache.tmp", "tracked.bin", "large.bin", "nested/repository/inside.txt", ".repa/private.txt", "visible.txt"];
  const result = await history.recordPaths(source, scope, async () => {
    await f.write("cache.tmp", "忽略的内容\n");
    await f.write("tracked.bin", Buffer.alloc(65, 1));
    await f.write("large.bin", Buffer.alloc(65, 2));
    await f.write("nested/repository/inside.txt", "嵌套仓库\n");
    await f.write(".repa/private.txt", "私有目录\n");
    await f.write("visible.txt", "可见\n");
  });
  assert.deepEqual([...result.snapshot.skipped].sort((a, b) => a.path.localeCompare(b.path)), [
    { path: ".repa/private.txt", reason: "repository" },
    { path: "large.bin", reason: "large" },
    { path: "nested/repository/inside.txt", reason: "repository" },
    { path: "tracked.bin", reason: "large" },
  ]);
  assert.deepEqual(summary(await history.changesSince(baseline.id)), [{
    source,
    changes: [{ kind: "deleted", path: "tracked.bin" }, { kind: "added", path: "visible.txt" }],
  }]);
  assert.equal((await history.snapshot()).committed, false);
  assert.deepEqual(await readFile(f.file("tracked.bin")), Buffer.alloc(65, 1));
});

test("动作失败时仍保存给定路径已落盘的内容并传播原异常", async (t) => {
  const f = await fixture(t);
  const history = await openHistory(f.space);
  const baseline = await head(history);
  const source = { kind: "agent", runId: "failed" } as const;
  const error = new Error("写入中途失败");
  await assert.rejects(history.recordPaths(source, ["partial.txt"], async () => {
    await f.write("partial.txt", "已经落盘\n");
    throw error;
  }), (actual: unknown) => actual === error);
  assert.deepEqual(summary(await history.changesSince(baseline.id)), [
    { source, changes: [{ kind: "added", path: "partial.txt" }] },
  ]);
});

test("按路径写入同样检查运行来源与路径格式，拒绝时不执行写入", async (t) => {
  const f = await fixture(t);
  const history = await openHistory(f.space);
  const lead = { kind: "agent", runId: "lead" } as const;
  await history.recordPaths(lead, ["one.txt"], () => f.write("one.txt", "一\n"));
  await history.recordPaths(lead, ["two.txt"], () => f.write("two.txt", "二\n"));
  let actions = 0;
  const action = async () => {
    actions += 1;
  };
  await assert.rejects(history.recordPaths({ kind: "agent", runId: "lead", ancestorRunIds: ["other"] }, ["never.txt"], action));
  await assert.rejects(async () => history.recordPaths({ kind: "agent", runId: "self", ancestorRunIds: ["self"] }, ["never.txt"], action));
  for (const paths of [[], [""], ["../outside.txt"], ["/absolute.txt"], ["a//b.txt"], ["./a.txt"], ["dir/"]]) {
    await assert.rejects(async () => history.recordPaths(lead, paths, action));
  }
  assert.equal(actions, 0);
  assert.equal((await history.list()).length, 3);
});

test("与 record 混用时按队列顺序执行：record 期间的按路径写入等它结束，各自只记自己的改动", async (t) => {
  const f = await fixture(t);
  const history = await openHistory(f.space);
  const baseline = await head(history);
  const shell = { kind: "agent", runId: "shell" } as const;
  const editor: ActivitySource = { kind: "agent", runId: "editor", ancestorRunIds: ["shell"] };
  const entered = deferred();
  const release = deferred();
  const events: string[] = [];
  const opaque = history.record(shell, async () => {
    events.push("record 开始");
    await execute(process.execPath, ["-e", 'require("node:fs").writeFileSync("shell.txt", "命令输出\\n")'], { cwd: f.space });
    entered.resolve();
    await release.promise;
    events.push("record 结束");
  });
  await Promise.race([entered.promise, opaque]);
  const scoped = history.recordPaths(editor, ["edit.md"], async () => {
    events.push("按路径写入");
    await f.write("edit.md", "编辑内容\n");
  });
  // 给错误实现留出插队的时间；正确实现在 record 结束前不会进入动作。
  await setTimeout(100);
  assert.deepEqual(events, ["record 开始"]);
  release.resolve();
  await Promise.all([opaque, scoped]);
  assert.deepEqual(events, ["record 开始", "record 结束", "按路径写入"]);
  assert.deepEqual(summary(await history.changesSince(baseline.id)), [
    { source: shell, changes: [{ kind: "added", path: "shell.txt" }] },
    { source: editor, changes: [{ kind: "added", path: "edit.md" }] },
  ]);
});
