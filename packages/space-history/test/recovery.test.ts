import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { Git, GitError } from "../src/git.js";
import { openHistory, type ActivitySource, type Revision } from "../src/index.js";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// 整空间快照和按路径提交都由 fast-import 写入提交并更新引用，失败注入在它前后。
async function fixture(t: TestContext, failure: "before" | "after") {
  const root = await mkdtemp(join(tmpdir(), "repa-history-recovery-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const space = join(root, "space");
  await mkdir(space);
  const flag = join(root, "fail-once");
  const run = Git.prototype.run;
  // 在真实 Git 命令的前后注入一次失败，不依赖 shell 或可执行脚本权限。
  t.mock.method(Git.prototype, "run", async function (this: Git, ...args: Parameters<typeof run>) {
    if (args[0].includes("fast-import") && await stat(flag).then(() => true, (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    })) {
      await rename(flag, `${flag}.consumed`);
      if (failure === "after") await run.apply(this, args);
      throw new GitError("注入保存失败", 1);
    }
    return run.apply(this, args);
  });
  const history = await openHistory(space);
  const [baseline] = await history.list();
  assert.ok(baseline);
  return { space, flag, history, baseline };
}

function isInjectedFailure(error: unknown): boolean {
  assert.ok(error instanceof GitError);
  assert.equal(error.exitCode, 1);
  return true;
}

test("运行保存失败后排队快照先恢复原来源，不重跑活动或归为外部编辑", async (t) => {
  const f = await fixture(t, "before");
  const entered = deferred();
  const release = deferred();
  let actions = 0;
  const source = { kind: "agent", runId: "recover-before-update" } as const;
  const run = f.history.record(source, async () => {
    actions += 1;
    await writeFile(join(f.space, "agent.txt"), "运行已经落盘的内容\r\n");
    await writeFile(f.flag, "");
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const rejected = assert.rejects(run, isInjectedFailure);
  const queued = f.history.snapshot();
  release.resolve();
  const [, snapshot] = await Promise.all([rejected, queued]);
  const feed = await f.history.changesSince(f.baseline.id);
  assert.equal(actions, 1);
  assert.equal(feed.revisions.length, 1);
  assert.deepEqual(feed.revisions[0]?.source, source);
  assert.deepEqual(feed.revisions[0]?.changes, [{ kind: "added", path: "agent.txt" }]);
  assert.equal(snapshot.revision, feed.revision);
  assert.equal(snapshot.committed, false);
  assert.equal((await f.history.list()).length, 2);
  assert.equal(await readFile(join(f.space, "agent.txt"), "utf8"), "运行已经落盘的内容\r\n");
});

test("引用实际更新后报告失败，后续操作认领原提交而不重复保存运行", async (t) => {
  const f = await fixture(t, "after");
  const notifications: Revision[] = [];
  f.history.onRevision((revision) => { notifications.push(revision); });
  let actions = 0;
  const source = { kind: "agent", runId: "recover-after-update" } as const;
  await assert.rejects(f.history.record(source, async () => {
    actions += 1;
    await writeFile(join(f.space, "agent.txt"), "已提交的运行内容\n");
    await writeFile(f.flag, "");
  }), isInjectedFailure);
  const snapshot = await f.history.snapshot();
  const feed = await f.history.changesSince(f.baseline.id);
  assert.equal(actions, 1);
  assert.equal(feed.revisions.length, 1);
  assert.deepEqual(feed.revisions[0]?.source, source);
  assert.deepEqual(feed.revisions[0]?.changes, [{ kind: "added", path: "agent.txt" }]);
  assert.equal(snapshot.revision, feed.revision);
  assert.equal(snapshot.committed, false);
  assert.equal((await f.history.list()).length, 2);
  assert.deepEqual(notifications, await f.history.list(1));
  assert.equal(notifications[0]?.id, feed.revision);
  const reopened = await openHistory(f.space);
  assert.deepEqual(await reopened.changesSince(f.baseline.id), feed);
});

test("按路径提交失败后，后续操作先按原范围补完原来源，范围外的同期改动仍记为外部", async (t) => {
  for (const failure of ["before", "after"] as const) {
    await t.test(failure === "before" ? "引用更新前失败" : "引用更新后才报告失败", async (context) => {
      const f = await fixture(context, failure);
      let actions = 0;
      const source: ActivitySource = { kind: "agent", runId: `scoped-${failure}`, ancestorRunIds: ["lead"] };
      await assert.rejects(f.history.recordPaths(source, ["agent.txt"], async () => {
        actions += 1;
        await writeFile(join(f.space, "agent.txt"), "按路径写入的内容\r\n");
        await writeFile(join(f.space, "outside.txt"), "范围外的同期写入\n");
        await writeFile(f.flag, "");
      }), isInjectedFailure);
      const snapshot = await f.history.snapshot();
      const feed = await f.history.changesSince(f.baseline.id);
      assert.equal(actions, 1);
      assert.deepEqual(feed.revisions.map(({ source: saved, changes }) => ({ source: saved, changes })), [
        { source, changes: [{ kind: "added", path: "agent.txt" }] },
        { source: { kind: "external" }, changes: [{ kind: "added", path: "outside.txt" }] },
      ]);
      assert.equal(snapshot.revision, feed.revision);
      assert.equal(await readFile(join(f.space, "agent.txt"), "utf8"), "按路径写入的内容\r\n");
      const reopened = await openHistory(f.space);
      assert.deepEqual(await reopened.changesSince(f.baseline.id), feed);
    });
  }
});
