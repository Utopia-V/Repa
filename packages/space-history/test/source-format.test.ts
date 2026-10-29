import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { Git } from "../src/git.js";
import { openHistory, type Source } from "../src/index.js";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-history-source-format-")));
  const space = path.join(root, "space");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(space);
  const history = await openHistory(space);
  const git = new Git(space, path.join(space, ".repa", "history.git"));
  const append = async (source: unknown) => {
    const head = (await git.run(["rev-parse", "refs/heads/history"])).toString().trim();
    const tree = (await git.run(["rev-parse", `${head}^{tree}`])).toString().trim();
    const message = JSON.stringify(source) + "\n";
    const id = (await git.run(["commit-tree", tree, "-p", head], message)).toString().trim();
    await git.run(["update-ref", "refs/heads/history", id, head]);
    return { id, message };
  };
  return { space, history, git, append };
}

test("历史来源读取忽略新可选字段，各类来源和原提交保持不变", async t => {
  const f = await fixture(t);
  const baseline = (await f.history.list())[0];
  assert.ok(baseline);
  const sources: Source[] = [
    { kind: "agent", runId: "run", ancestorRunIds: ["parent"] },
    { kind: "plugin", pluginId: "course" },
    { kind: "external" },
    { kind: "undo", revision: baseline.id },
    { kind: "undo", runId: "run" },
  ];
  const commits = [];
  for (const source of sources) {
    commits.push(await f.append({ ...source, optionalNote: { text: "新版本的附加说明" } }));
  }
  const reopened = await openHistory(f.space);
  assert.deepEqual((await reopened.list()).slice(0, sources.length).map(({ source }) => source), sources.toReversed());
  assert.deepEqual((await reopened.changesSince(baseline.id)).revisions.map(({ source }) => source), sources);
  for (const { id, message } of commits) {
    assert.equal((await f.git.run(["show", "-s", "--format=%B", id])).toString(), message + "\n");
  }
});

test("历史来源的已知字段损坏仍报错，写入来源仍拒绝未知字段", async t => {
  const f = await fixture(t);
  const extended = { kind: "agent", runId: "run", optionalNote: "不能从当前接口写入" } as const;
  assert.throws(() => f.history.snapshot(extended), /无效的快照来源/u);
  assert.throws(() => f.history.record(extended, async () => undefined), /无效的活动来源/u);
  const before = await f.history.list();
  assert.equal(before.length, 1);
  await f.append({ kind: "agent", runId: 42, optionalNote: "不能掩盖已知字段错误" });
  const reopened = await openHistory(f.space);
  await assert.rejects(reopened.list(), /历史来源格式损坏/u);
});
