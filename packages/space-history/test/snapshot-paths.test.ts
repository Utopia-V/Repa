import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { openHistory, watchHistory, type ChangeFeed } from "../src/index.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-space-history-snapshot-paths-"));
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

async function head(history: Awaited<ReturnType<typeof openHistory>>) {
  const [revision] = await history.list(1);
  assert.ok(revision);
  return revision;
}

function summary(feed: ChangeFeed) {
  return feed.revisions.map(({ source, changes }) => ({ source, changes }));
}

test("按路径的外部快照只记给定路径，范围外的改动留给之后的整空间扫描", async (t) => {
  const f = await fixture(t);
  await f.write("a.md", "a 原文\n");
  await f.write("b.md", "b 原文\n");
  const history = await openHistory(f.space);
  const baseline = await head(history);
  await f.write("a.md", "a 外部修改\n");
  await f.write("b.md", "b 外部修改\n");
  const result = await history.snapshotPaths(["a.md"]);
  assert.equal(result.committed, true);
  assert.deepEqual(summary(await history.changesSince(baseline.id)), [
    { source: { kind: "external" }, changes: [{ kind: "modified", path: "a.md" }] },
  ]);
  assert.deepEqual(await history.snapshotPaths(["a.md"]), { revision: result.revision, committed: false, skipped: [] });
  assert.equal((await history.snapshot()).committed, true);
  assert.deepEqual(summary(await history.changesSince(result.revision)), [
    { source: { kind: "external" }, changes: [{ kind: "modified", path: "b.md" }] },
  ]);
  for (const paths of [[], ["../outside.md"], ["/absolute.md"], ["a//b.md"]]) {
    await assert.rejects(async () => history.snapshotPaths(paths));
  }
});

test("按路径的外部快照处理删除、目录和上级变化并沿用排除规则，之后的整空间扫描没有遗漏", async (t) => {
  const f = await fixture(t);
  await f.write(".gitignore", "*.tmp\n");
  await f.write("gone.md", "will be deleted\n");
  await f.write("dir/a.md", "alpha in directory\n");
  await f.write("dir/sub/b.md", "beta in subdirectory\n");
  await f.write("node", "plain file before\n");
  const history = await openHistory(f.space, { maxFileBytes: 64 });
  const baseline = await head(history);
  await rm(f.file("gone.md"));
  await rm(f.file("dir"), { recursive: true });
  await f.write("dir/new.md", "replacement content\n");
  await rm(f.file("node"));
  await f.write("node/child.md", "file became directory\n");
  await f.write("cache.tmp", "忽略的内容\n");
  await f.write("large.bin", Buffer.alloc(65, 1));
  const result = await history.snapshotPaths(["gone.md", "dir", "node/child.md", "cache.tmp", "large.bin"]);
  assert.deepEqual(result.skipped, [{ path: "large.bin", reason: "large" }]);
  assert.deepEqual(summary(await history.changesSince(baseline.id)), [{
    source: { kind: "external" },
    changes: [
      { kind: "deleted", path: "dir/a.md" },
      { kind: "added", path: "dir/new.md" },
      { kind: "deleted", path: "dir/sub/b.md" },
      { kind: "deleted", path: "gone.md" },
      { kind: "deleted", path: "node" },
      { kind: "added", path: "node/child.md" },
    ],
  }]);
  // 当前实例按内存中的树比较，重开的实例从 Git 读取树；两者都不应发现遗漏。
  assert.equal((await history.snapshot()).committed, false);
  assert.equal((await head(await openHistory(f.space, { maxFileBytes: 64 }))).id, result.revision);
});

test("监听报告具体路径时只记这些路径，不带路径的通知改为扫描整个空间", async (t) => {
  const f = await fixture(t);
  await f.write("a.md", "a 原文\n");
  const history = await openHistory(f.space);
  const baseline = await head(history);
  let notify: (path?: string) => void = () => {};
  const watcher = watchHistory(history, (callback) => {
    notify = callback;
    return () => {};
  }, { onError: (error) => assert.fail(String(error)) });
  await f.write("a.md", "a 外部修改\n");
  await f.write("b.md", "没有报告路径的外部改动\n");
  notify("a.md");
  await watcher.flush();
  assert.deepEqual(summary(await history.changesSince(baseline.id)), [
    { source: { kind: "external" }, changes: [{ kind: "modified", path: "a.md" }] },
  ]);
  const scoped = await head(history);
  notify();
  await watcher.close();
  assert.deepEqual(summary(await history.changesSince(scoped.id)), [
    { source: { kind: "external" }, changes: [{ kind: "added", path: "b.md" }] },
  ]);
});
