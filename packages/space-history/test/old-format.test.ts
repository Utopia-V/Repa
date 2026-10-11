import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { Git } from "../src/git.js";
import { openHistory } from "../src/index.js";

// 样本最后一个提交的原始 ID；重新导入后相同，说明旧提交逐字节保留。
const OLD_HEAD = "58feeba191c9aa1996d689cb5efe9b537b527d56";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-space-history-old-format-"));
  const space = path.join(root, "space");
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const gitDir = path.join(space, ".repa", "history.git");
  await mkdir(path.dirname(gitDir), { recursive: true });
  const git = new Git(space, gitDir);
  await git.run(["init", "--bare", "--object-format=sha1", "--initial-branch=history", gitDir]);
  await git.run(["fast-import", "--quiet"], await readFile(new URL("./fixtures/old-format-history.fast-export", import.meta.url)));
  const file = (relative: string) => path.join(space, relative);
  const write = async (relative: string, value: string) => {
    await mkdir(path.dirname(file(relative)), { recursive: true });
    await writeFile(file(relative), value);
  };
  // 工作文件与样本最后一个提交一致，打开历史时不应产生新的外部提交。
  await write("notes/keep.txt", "外部修改\n");
  await write("notes/plan.md", "旧运行修改\n");
  await write("notes/renamed.md", "旧运行新增\n");
  await write("progress.json", "{\"step\":1}\n");
  const read = (relative: string) => readFile(file(relative), "utf8");
  return { space, file, write, read };
}

test("旧格式历史照常读取、按修订和按运行撤回，旧运行还能继续提交并挂上新的子运行", async (t) => {
  const f = await fixture(t);
  const history = await openHistory(f.space);
  const revisions = await history.list();
  assert.equal(revisions[0]?.id, OLD_HEAD);
  assert.deepEqual(revisions.map(({ source }) => source), [
    { kind: "agent", runId: "old-rename" },
    { kind: "undo", revision: revisions[2]?.id },
    { kind: "agent", runId: "old-undone" },
    { kind: "agent", runId: "old-empty" },
    { kind: "plugin", pluginId: "learning" },
    { kind: "agent", runId: "old-run" },
    { kind: "external" },
    { kind: "external" },
  ]);
  const feed = await history.changesSince(null);
  assert.deepEqual(feed.revisions.find(({ source }) => source.kind === "agent" && source.runId === "old-run")?.changes, [
    { kind: "deleted", path: "draft.txt" },
    { kind: "added", path: "notes/new.md" },
    { kind: "modified", path: "notes/plan.md" },
  ]);

  const run = await history.undoRun("old-run");
  assert.deepEqual(run.conflicts, ["notes/new.md"]);
  assert.deepEqual(run.restored, ["draft.txt", "notes/plan.md"]);
  assert.equal(await f.read("draft.txt"), "草稿\n");
  assert.equal(await f.read("notes/plan.md"), "旧计划\r\n第二行\r\n");
  const rename = await history.undo(OLD_HEAD);
  assert.deepEqual(rename.conflicts, []);
  assert.deepEqual(rename.restored, ["notes/new.md", "notes/renamed.md"]);
  assert.equal(await f.read("notes/new.md"), "旧运行新增\n");
  await assert.rejects(f.read("notes/renamed.md"), { code: "ENOENT" });

  const reused = { kind: "agent", runId: "old-empty" } as const;
  const child = { kind: "agent", runId: "new-child", parentRunId: "old-empty" } as const;
  await history.record(reused, () => f.write("notes/keep.txt", "沿用旧运行\n"));
  await history.record(child, () => f.write("progress.json", "{\"step\":2}\n"));
  const extended = await history.undoRun("old-empty");
  assert.deepEqual(extended.conflicts, []);
  assert.deepEqual(extended.restored, ["notes/keep.txt", "progress.json"]);
  assert.equal(await f.read("notes/keep.txt"), "外部修改\n");
  assert.equal(await f.read("progress.json"), "{\"step\":1}\n");
  assert.equal((await history.snapshot()).committed, false);
  assert.ok((await history.list(20)).some(({ id }) => id === OLD_HEAD));
});
