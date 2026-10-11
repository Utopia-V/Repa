import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import { openHistory, type ActivitySource } from "../src/index.js";

const execute = promisify(execFile);

async function fixture(t: TestContext, files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-space-history-undo-run-"));
  const space = path.join(root, "space");
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(space);
  const file = (relative: string) => path.join(space, relative);
  const write = async (relative: string, value: string) => {
    await mkdir(path.dirname(file(relative)), { recursive: true });
    await writeFile(file(relative), value);
  };
  for (const [relative, value] of Object.entries(files)) await write(relative, value);
  const history = await openHistory(space);
  // 每次写入只记这个文件，与底座按写入点记账的用法相同。
  const save = (source: ActivitySource, relative: string, value: string) =>
    history.recordPaths(source, [relative], () => write(relative, value));
  const read = (relative: string) => readFile(file(relative), "utf8");
  return { space, file, write, history, save, read };
}

const lead = { kind: "agent", runId: "lead" } as const;
const helper: ActivitySource = { kind: "agent", runId: "helper", ancestorRunIds: ["lead"] };
const detail: ActivitySource = { kind: "agent", runId: "detail", ancestorRunIds: ["helper", "lead"] };
const other = { kind: "agent", runId: "other" } as const;

test("按运行撤回连带全部子孙运行，每个文件回到它们第一次修改之前，其他运行与外部改动不动", async (t) => {
  const f = await fixture(t, { "plan.md": "原计划\n", "notes.md": "原笔记\r\n", "shared.md": "共享原文\n" });
  await f.save(lead, "plan.md", "主运行第一次\n");
  await f.save(helper, "notes.md", "子运行修改\n");
  await f.save(other, "other.md", "另一个运行\n");
  await f.save(detail, "detail/new.md", "孙运行新增\n");
  await f.save(lead, "plan.md", "主运行第二次\n");
  await f.write("user.md", "用户新建\n");
  await f.history.snapshot();
  await f.history.record(detail, async () => {
    await execute("sh", ["-c", "rm shared.md"], { cwd: f.space });
  });
  const before = (await f.history.list(1))[0];
  assert.ok(before);
  const undone = await f.history.undoRun("lead");
  assert.deepEqual(undone.conflicts, []);
  assert.deepEqual(undone.restored, ["detail/new.md", "notes.md", "plan.md", "shared.md"]);
  assert.equal(await f.read("plan.md"), "原计划\n");
  assert.equal(await f.read("notes.md"), "原笔记\r\n");
  assert.equal(await f.read("shared.md"), "共享原文\n");
  await assert.rejects(f.read("detail/new.md"), { code: "ENOENT" });
  assert.equal(await f.read("other.md"), "另一个运行\n");
  assert.equal(await f.read("user.md"), "用户新建\n");
  const feed = await f.history.changesSince(before.id);
  assert.deepEqual(feed.revisions.map(({ source, changes }) => ({ source, changes })), [{
    source: { kind: "undo", runId: "lead" },
    changes: [
      { kind: "deleted", path: "detail/new.md" },
      { kind: "modified", path: "notes.md" },
      { kind: "modified", path: "plan.md" },
      { kind: "added", path: "shared.md" },
    ],
  }]);
  assert.equal(feed.revision, undone.revision);
});

test("撤回子运行只撤它和它的子孙，父运行与兄弟运行的改动保留", async (t) => {
  const f = await fixture(t, { "plan.md": "原计划\n" });
  const sibling: ActivitySource = { kind: "agent", runId: "sibling", ancestorRunIds: ["lead"] };
  await f.save(lead, "plan.md", "主运行修改\n");
  await f.save(helper, "helper.md", "子运行新增\n");
  await f.save(sibling, "sibling.md", "兄弟运行新增\n");
  await f.save(detail, "detail.md", "孙运行新增\n");
  const undone = await f.history.undoRun("helper");
  assert.deepEqual(undone.conflicts, []);
  assert.deepEqual(undone.restored, ["detail.md", "helper.md"]);
  await assert.rejects(f.read("helper.md"), { code: "ENOENT" });
  await assert.rejects(f.read("detail.md"), { code: "ENOENT" });
  assert.equal(await f.read("plan.md"), "主运行修改\n");
  assert.equal(await f.read("sibling.md"), "兄弟运行新增\n");
});

test("中间运行自己没有提交时，撤回更上层的运行仍能撤掉它子孙的改动", async (t) => {
  const f = await fixture(t, { "c.md": "原文\n", "other.md": "无关原文\n" });
  // G 起 P，P 只调度、没有提交；P 起 C，只有 C 写了文件。
  const child: ActivitySource = { kind: "agent", runId: "C", ancestorRunIds: ["P", "G"] };
  await f.save(child, "c.md", "C 写入\n");
  await f.save(other, "other.md", "另一个运行\n");
  const undone = await f.history.undoRun("G");
  assert.deepEqual(undone.conflicts, []);
  assert.deepEqual(undone.restored, ["c.md"]);
  assert.equal(await f.read("c.md"), "原文\n");
  assert.equal(await f.read("other.md"), "另一个运行\n");
  const [revision] = await f.history.list(1);
  assert.equal(revision?.id, undone.revision);
  assert.deepEqual(revision?.source, { kind: "undo", runId: "G" });
});

test("第一次修改之后被其他来源碰过的文件报冲突且不还原，夹在两次写入之间的改动也算，之前的改动不算", async (t) => {
  const f = await fixture(t, { "a.md": "a 原文\n", "b.md": "b 原文\n", "c.md": "c 原文\n", "d.md": "d 原文\n", "dir/e.md": "e 原文\n" });
  const run = { kind: "agent", runId: "run" } as const;
  await f.save(run, "a.md", "a 第一次\n");
  // 运行已经开始，但这时还没有碰 d.md；这次外部改动属于撤回目标之前的状态。
  await f.write("d.md", "d 外部先改\n");
  await f.history.snapshot();
  await f.save(run, "b.md", "b 运行\n");
  await f.save(run, "dir/e.md", "e 运行\n");
  await f.write("a.md", "a 夹在中间的外部编辑\n");
  await f.history.snapshot();
  await f.save(run, "a.md", "a 第二次\n");
  await f.save(other, "b.md", "b 另一个运行\n");
  await f.history.record(other, async () => {
    await rm(f.file("dir"), { recursive: true });
    await f.write("dir", "目录换成文件\n");
  });
  await f.save(run, "c.md", "c 运行\n");
  await f.save(run, "d.md", "d 运行\n");
  const undone = await f.history.undoRun("run");
  assert.deepEqual([...undone.conflicts].sort(), ["a.md", "b.md", "dir/e.md"]);
  assert.deepEqual(undone.restored, ["c.md", "d.md"]);
  assert.equal(await f.read("a.md"), "a 第二次\n");
  assert.equal(await f.read("b.md"), "b 另一个运行\n");
  assert.equal(await f.read("dir"), "目录换成文件\n");
  assert.equal(await f.read("c.md"), "c 原文\n");
  assert.equal(await f.read("d.md"), "d 外部先改\n");
});

test("按运行撤回同时覆盖 record 与按路径提交，结果还能按修订撤回以重做", async (t) => {
  const f = await fixture(t, { "draft.md": "初稿\n" });
  const run = { kind: "agent", runId: "mixed" } as const;
  await f.save(run, "draft.md", "按路径修改\n");
  await f.history.record(run, async () => {
    await execute("sh", ["-c", 'printf "命令生成\\n" > generated.txt'], { cwd: f.space });
  });
  await f.history.record(run, async () => {});
  const undone = await f.history.undoRun("mixed");
  assert.deepEqual(undone.conflicts, []);
  assert.deepEqual(undone.restored, ["draft.md", "generated.txt"]);
  assert.equal(await f.read("draft.md"), "初稿\n");
  await assert.rejects(f.read("generated.txt"), { code: "ENOENT" });
  const redone = await f.history.undo(undone.revision);
  assert.deepEqual(redone.conflicts, []);
  assert.equal(await f.read("draft.md"), "按路径修改\n");
  assert.equal(await f.read("generated.txt"), "命令生成\n");
});

test("只作为父运行出现的运行可以撤回它的子运行；历史中没有的运行报错且不写入提交", async (t) => {
  const f = await fixture(t, { "plan.md": "原计划\n" });
  const worker: ActivitySource = { kind: "agent", runId: "worker", ancestorRunIds: ["orchestrator"] };
  await f.save(worker, "plan.md", "子运行修改\n");
  const count = (await f.history.list()).length;
  await assert.rejects(f.history.undoRun("missing"));
  await assert.rejects(async () => f.history.undoRun(""));
  assert.equal((await f.history.list()).length, count);
  const undone = await f.history.undoRun("orchestrator");
  assert.deepEqual(undone.restored, ["plan.md"]);
  assert.equal(await f.read("plan.md"), "原计划\n");
  const [revision] = await f.history.list(1);
  assert.deepEqual(revision?.source, { kind: "undo", runId: "orchestrator" });
});
