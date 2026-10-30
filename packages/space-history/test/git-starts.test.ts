import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { gitStarts } from "../src/git.js";
import { openHistory, type ActivitySource } from "../src/index.js";

// Windows 上每启动一个 Git 进程要数十毫秒，历史操作的耗时主要由启动次数决定。这里按次数而不是按耗时设上限：
// 上限为推算出的最少次数加少量余量，改动使次数超出时测试失败，并列出各子命令的次数。

async function fixture(t: TestContext, files: Record<string, string> = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-history-git-starts-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const space = path.join(root, "space");
  await mkdir(space);
  const write = async (relative: string, value: string) => {
    await mkdir(path.dirname(path.join(space, relative)), { recursive: true });
    await writeFile(path.join(space, relative), value);
  };
  for (const [relative, value] of Object.entries(files)) await write(relative, value);
  return { space, write };
}

// 统计 operation 期间启动 Git 的次数；只在本文件中顺序运行的测试里使用，没有其他 Git 活动混入。
async function started<T>(operation: () => Promise<T>): Promise<{ value: T; count: number; commands: Record<string, number> }> {
  const before = gitStarts();
  const value = await operation();
  const commands: Record<string, number> = {};
  let count = 0;
  for (const [command, total] of gitStarts()) {
    const delta = total - (before.get(command) ?? 0);
    if (delta > 0) {
      commands[command] = delta;
      count += delta;
    }
  }
  return { value, count, commands };
}

function atMost(result: { count: number; commands: Record<string, number> }, limit: number, operation: string): void {
  assert.ok(result.count <= limit, `${operation}启动了 ${result.count} 次 Git，上限为 ${limit}：${JSON.stringify(result.commands)}`);
}

const notes = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`notes/${index}.md`, `笔记 ${index}\n`]));

test("打开空间：新建历史、重开没有改动和重开时有离线改动，各自启动 Git 的次数有上限", async (t) => {
  const f = await fixture(t, notes);
  // 建库、写入本地身份、确认没有旧引用、列出文件、导入基线。
  atMost(await started(() => openHistory(f.space)), 7, "新建历史");
  // 读引用、读树、列出文件；没有改动时不导入。
  atMost(await started(() => openHistory(f.space)), 4, "重开没有改动的空间");
  await f.write("notes/0.md", "离线编辑\n");
  atMost(await started(() => openHistory(f.space)), 5, "重开有离线改动的空间");
});

test("整空间快照不随改动文件数增加 Git 进程：没有改动只列文件，二十个文件改动也只多一次导入", async (t) => {
  const f = await fixture(t, notes);
  const history = await openHistory(f.space);
  // 监听拿不到路径时、record 动作之前都要扫描整个空间，大多没有改动。
  const idle = await started(async () => {
    for (let round = 0; round < 10; round++) assert.equal((await history.snapshot()).committed, false);
  });
  atMost(idle, 10 * 1 + 1, "十次没有改动的快照");
  for (let index = 0; index < 20; index++) await f.write(`notes/${index}.md`, `改过的笔记 ${index}\n`);
  const changed = await started(() => history.snapshot());
  assert.equal(changed.value.committed, true);
  atMost(changed, 3, "二十个文件改动的快照");
});

test("运行提交：按路径写入每次列出给定路径并导入一次，不透明运行前后各扫描一次", async (t) => {
  const f = await fixture(t, notes);
  const history = await openHistory(f.space);
  const run: ActivitySource = { kind: "agent", runId: "writer" };
  // 第一次带 agent 来源的写入还要读一次全部提交，建立运行树。
  await history.recordPaths(run, ["notes/0.md"], () => f.write("notes/0.md", "第 0 次\n"));
  const edits = await started(async () => {
    for (let round = 1; round <= 10; round++) {
      await history.recordPaths(run, ["notes/0.md"], () => f.write("notes/0.md", `第 ${round} 次\n`));
    }
  });
  atMost(edits, 10 * 3 + 2, "同一文件的十次按路径写入");
  const created = await started(async () => {
    for (let index = 0; index < 10; index++) {
      await history.recordPaths(run, [`new/${index}.md`], () => f.write(`new/${index}.md`, `新文件 ${index}\n`));
    }
  });
  atMost(created, 10 * 2 + 2, "十次新建文件的按路径写入");
  // 监听在写入之后报告同一路径；内容已经记过，不再导入。
  atMost(await started(() => history.snapshotPaths(["notes/0.md"])), 1, "写入后的按路径快照");
  // 写入用的临时文件改名后已不存在，没有可列出的内容。
  atMost(await started(() => history.snapshotPaths(["notes/.repa-write-gone"])), 0, "已不存在的路径的按路径快照");
  const opaque = await started(() => history.record({ kind: "agent", runId: "shell" }, () => f.write("notes/1.md", "命令输出\n")));
  assert.equal(opaque.value.snapshot.committed, true);
  atMost(opaque, 4, "不透明运行");
});

test("按运行撤回与按修订撤回启动 Git 的次数有上限", async (t) => {
  const f = await fixture(t, notes);
  const history = await openHistory(f.space);
  const run: ActivitySource = { kind: "agent", runId: "undo-me" };
  await history.recordPaths(run, ["notes/0.md"], () => f.write("notes/0.md", "运行修改\n"));
  await history.recordPaths(run, ["created.md"], () => f.write("created.md", "运行新增\n"));
  // 扫描整个空间保存外部改动，读提交与差异，取回旧内容，列出恢复后的文件，导入 undo 提交。
  // 要恢复的文件都在刚才的扫描里，已知没有被忽略，不必再检查。
  const byRun = await started(() => history.undoRun("undo-me"));
  assert.deepEqual(byRun.value.restored, ["created.md", "notes/0.md"]);
  atMost(byRun, 6 + 1, "按运行撤回");
  // 撤销这次撤回：修订检查多两次，即对象存在且在历史线上；重新创建的 created.md 不在磁盘上，要检查它是否被忽略。
  const redo = await started(() => history.undo(byRun.value.revision));
  assert.deepEqual(redo.value.restored, ["created.md", "notes/0.md"]);
  atMost(redo, 9 + 1, "按修订撤回");
});

test("维护：无需维护时只检查对象布局，需要维护时再运行一次 gc", async (t) => {
  const f = await fixture(t, notes);
  const history = await openHistory(f.space);
  const check = await started(() => history.maintain());
  assert.equal(check.value, false);
  atMost(check, 1, "无需维护的检查");
  const forced = await started(() => history.maintain({ force: true }));
  assert.equal(forced.value, true);
  // gc 自己再启动的 repack、pack-objects 等子进程不经过这里，不在计数之内。
  atMost(forced, 2, "维护");
});

test("插件追赶：已追到当前版本时不启动 Git，落后时读一次提交和差异", async (t) => {
  const f = await fixture(t, notes);
  const history = await openHistory(f.space);
  await f.write("notes/0.md", "外部改动\n");
  const { revision: cursor } = await history.snapshot();
  atMost(await started(() => history.changesSince(cursor)), 0, "已追到当前版本的追赶");
  await f.write("notes/1.md", "又一次外部改动\n");
  await history.snapshot();
  const behind = await started(() => history.changesSince(cursor));
  assert.equal(behind.value.revisions.length, 1);
  // 确认游标对象存在，读游标之后的提交与差异。
  atMost(behind, 4, "落后一个版本的追赶");
});
