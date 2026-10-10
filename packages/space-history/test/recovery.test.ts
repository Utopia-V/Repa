import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { GitError } from "../src/git.js";
import { openHistory } from "../src/index.js";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function fixture(t: TestContext, failure: "before" | "after") {
  const root = await mkdtemp(join(tmpdir(), "repa-history-recovery-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const space = join(root, "space");
  await mkdir(space);
  const flag = join(root, "fail-once");
  const wrapper = join(root, "git-wrapper");
  // 只在显式设置标记后注入一次错误，其余命令与恢复均使用真实 Git。
  await writeFile(wrapper, `#!/bin/sh
for argument in "$@"; do
  if [ "$argument" = update-ref ] && [ -f ${shellQuote(flag)} ]; then
    mv ${shellQuote(flag)} ${shellQuote(`${flag}.consumed`)} || exit 2
    ${failure === "after" ? 'git "$@" || exit $?\n    ' : ""}printf 'injected update-ref failure\\n' >&2
    exit 1
  fi
done
exec git "$@"
`);
  await chmod(wrapper, 0o700);
  const history = await openHistory(space, { gitPath: wrapper });
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
  const notifications: string[] = [];
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
  assert.deepEqual(notifications, [feed.revision]);
  const reopened = await openHistory(f.space);
  assert.deepEqual(await reopened.changesSince(f.baseline.id), feed);
});
