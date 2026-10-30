import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { Git, gitStarts } from "../src/git.js";
import { openHistory, type ActivitySource } from "../src/index.js";

// Windows 上每启动一个 Git 进程要数十毫秒，历史操作的耗时主要由启动次数决定，因此这里断言次数，不断言耗时。
// 上限写成"推算出的最少次数 + 余量"；频繁的操作连做多次再统计，每次多启动一个进程就会超出余量。超出时列出各子命令的次数。

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
  atMost(await started(() => openHistory(f.space)), 6 + 1, "新建历史");
  // 读引用、读树、列出文件；没有改动时不导入。
  atMost(await started(() => openHistory(f.space)), 3 + 1, "重开没有改动的空间");
  await f.write("notes/0.md", "离线编辑\n");
  atMost(await started(() => openHistory(f.space)), 4 + 1, "重开有离线改动的空间");
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
  atMost(changed, 2 + 1, "二十个文件改动的快照");
});

test("按路径写入：同一文件再次写入只导入一次，新文件多一次列出，写入后监听报告的路径不再启动 Git", async (t) => {
  const f = await fixture(t, notes);
  const history = await openHistory(f.space);
  const run: ActivitySource = { kind: "agent", runId: "writer" };
  // 打开后第一次带 agent 来源的写入：读全部提交建立运行树，由 Git 判断这个文件是否被忽略，导入。
  const first = await started(() => history.recordPaths(run, ["notes/0.md"], () => f.write("notes/0.md", "第 0 次\n")));
  atMost(first, 3 + 1, "打开后第一次按路径写入");
  // 决定这个文件是否被忽略的 .gitignore 没有变化，沿用上次的判断，只导入。
  const edits = await started(async () => {
    for (let round = 1; round <= 10; round++) {
      await history.recordPaths(run, ["notes/0.md"], () => f.write("notes/0.md", `第 ${round} 次\n`));
    }
  });
  atMost(edits, 10 * 1 + 1, "同一文件的十次按路径写入");
  const created = await started(async () => {
    for (let index = 0; index < 10; index++) {
      await history.recordPaths(run, [`new/${index}.md`], () => f.write(`new/${index}.md`, `新文件 ${index}\n`));
    }
  });
  atMost(created, 10 * 2 + 1, "十次新建文件的按路径写入");
  // 监听随后报告写入的文件和已改名的临时文件：内容已经记过，临时文件已不存在。
  const reported = await started(async () => {
    for (let index = 0; index < 10; index++) {
      assert.equal((await history.snapshotPaths([`new/${index}.md`, `new/.repa-write-${index}`])).committed, false);
    }
  });
  atMost(reported, 10 * 0 + 1, "写入后监听报告的十次按路径快照");
});

test("不透明运行在动作前后各扫描一次整个空间，只导入一次", async (t) => {
  const f = await fixture(t, notes);
  const history = await openHistory(f.space);
  const runs = await started(async () => {
    for (let index = 0; index < 5; index++) {
      const result = await history.record({ kind: "agent", runId: `shell-${index}` }, () => f.write(`notes/${index}.md`, "命令输出\n"));
      assert.equal(result.snapshot.committed, true);
    }
  });
  atMost(runs, 5 * 3 + 1, "五次不透明运行");
});

test("按运行撤回与按修订撤回启动 Git 的次数有上限", async (t) => {
  const f = await fixture(t, notes);
  const history = await openHistory(f.space);
  const run: ActivitySource = { kind: "agent", runId: "undo-me" };
  await history.recordPaths(run, ["notes/0.md"], () => f.write("notes/0.md", "运行修改\n"));
  await history.recordPaths(run, ["created.md"], () => f.write("created.md", "运行新增\n"));
  // 扫描整个空间保存外部改动，读提交与差异，取回旧内容，导入 undo 提交。要恢复的文件都在刚才的扫描里，
  // 已知没有被忽略；恢复后也不必再列出它们，因为它们都写过，沿用写入时的判断。
  const byRun = await started(() => history.undoRun("undo-me"));
  assert.deepEqual(byRun.value.restored, ["created.md", "notes/0.md"]);
  atMost(byRun, 5 + 1, "按运行撤回");
  // 撤销这次撤回：修订检查多两次，即对象存在且在历史线上；要重新创建的 created.md 不在磁盘上，要由 Git 检查它是否被忽略。
  const redo = await started(() => history.undo(byRun.value.revision));
  assert.deepEqual(redo.value.restored, ["created.md", "notes/0.md"]);
  atMost(redo, 8 + 1, "按修订撤回");
});

test("维护：无需维护时只检查对象布局，需要维护时再运行一次 gc", async (t) => {
  const f = await fixture(t, notes);
  const history = await openHistory(f.space);
  // 宿主在每段无提交的空闲之后检查一次，大多无需维护。
  const checks = await started(async () => {
    for (let round = 0; round < 10; round++) assert.equal(await history.maintain(), false);
  });
  atMost(checks, 10 * 1 + 1, "十次无需维护的检查");
  // 一次导入里每个 checkpoint 结束一个 pack，凑足 32 个 pack 的维护门槛。
  const stream = Array.from({ length: 32 }, (_, index) => `blob\ndata ${String(index).length}\n${index}\ncheckpoint\n`).join("");
  await new Git(f.space, path.join(f.space, ".repa", "history.git"))
    .run(["-c", "fastimport.unpackLimit=0", "fast-import", "--quiet", "--done"], `${stream}done\n`);
  // gc 自己再启动的 repack、pack-objects 等子进程不经过这里，不在计数之内。
  const due = await started(() => history.maintain());
  assert.equal(due.value, true);
  atMost(due, 2 + 1, "需要维护时的维护");
});

test("插件追赶：已追到当前版本时不启动 Git，落后时读一次提交和差异", async (t) => {
  const f = await fixture(t, notes);
  const history = await openHistory(f.space);
  await f.write("notes/0.md", "外部改动\n");
  const { revision: cursor } = await history.snapshot();
  // 每次提交都会唤醒插件追赶；追上之后再查询，没有新的提交。
  const current = await started(async () => {
    for (let round = 0; round < 10; round++) assert.deepEqual((await history.changesSince(cursor)).revisions, []);
  });
  atMost(current, 10 * 0 + 1, "十次已追到当前版本的追赶");
  await f.write("notes/1.md", "又一次外部改动\n");
  await history.snapshot();
  const behind = await started(() => history.changesSince(cursor));
  assert.equal(behind.value.revisions.length, 1);
  // 确认游标对象存在，读游标之后的提交与差异。
  atMost(behind, 3 + 1, "落后一个版本的追赶");
});
