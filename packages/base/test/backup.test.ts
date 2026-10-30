import assert from "node:assert/strict";
import fs from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { gitStarts } from "@repa/space-history";

import { copyStats } from "../src/backup/copy.js";
import { restoreInPlace, restoreToNew } from "../src/backup/restore.js";
import { SpaceBackups } from "../src/backup/schedule.js";
import { checkBackup, createBackup, deleteBackup, groupDirectory, listBackups, type BackupSource } from "../src/backup/store.js";
import { RepaFault, type BackupStatus } from "../src/schema.js";
import { createSpace, openSpace, type Space } from "../src/space.js";
import { writeJson } from "../src/storage.js";

const fault = (code: string) => (error: unknown): boolean => error instanceof RepaFault && error.code === code;

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-backup-")));
  const home = path.join(directory, "home");
  const space = await createSpace(path.join(directory, "space"), { watch: false });
  t.after(async () => {
    await space.close();
    // Windows 上刚结束的 Git 子进程可能还短暂占用目录，删除时报 EBUSY；稍候重试。
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  let now = Date.UTC(2026, 9, 31, 8, 0, 0);
  // 每次取时向后拨一秒，各份备份的时间先后分明。
  const clock = () => (now += 1000);
  const records = path.join(await space.pluginDataDir("learning"), "records.jsonl");
  return { directory, home, space, clock, records };
}

// 按学习插件的写法追加事实：以追加方式打开，一次写入若干完整的行。
async function append(file: string, text: string): Promise<void> {
  const handle = await open(file, "a", 0o600);
  try {
    await handle.writeFile(text);
  } finally {
    await handle.close();
  }
}

const fact = (seq: number, text: string) => `${JSON.stringify({ seq, text })}\n`;

// 一份备份中 data/ 下的文件及原始字节，路径用 / 分隔。
async function backupFiles(directory: string, relative = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const name = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(result, await backupFiles(directory, name));
    else result[name] = await readFile(path.join(directory, name), "utf8");
  }
  return result;
}

function latestDirectory(home: string, root: string, id: string): string {
  return path.join(groupDirectory(home, root), id, "data");
}

test("备份收下学习记录、会话、提示覆盖与历史库；日志只收到最后一个换行符，空间锁、写到一半的临时文件和符号链接不收", async (t) => {
  const f = await fixture(t);
  await f.space.filesFor({ kind: "plugin", pluginId: "notes" }).write("notes/a.md", "空间笔记\n");
  await append(f.records, fact(1, "第一题"));
  // 学习插件正在追加第二条时备份：半行不收。
  await append(f.records, fact(2, "第二题").slice(0, 10));
  const session = path.join(f.space.sessionsDir, "2026-10-31T08-00-00-000Z_s1.jsonl");
  await writeFile(session, `${JSON.stringify({ type: "session", id: "s1" })}\n{"type":"message","id":"半`);
  await writeJson(path.join(f.space.dataDir, "prompts.json"), { base: { text: "空间说明" } });
  await writeFile(path.join(f.space.dataDir, ".repa-half.tmp"), "写到一半");
  if (process.platform !== "win32") {
    await writeFile(path.join(f.directory, "outside.txt"), "空间之外");
    await symlink(path.join(f.directory, "outside.txt"), path.join(path.dirname(f.records), "outside.txt"));
  }
  const { created, backup } = await checkBackup(f.home, f.space, 5, f.clock());
  assert.equal(created, true);
  assert.equal(backup.kind, "regular");
  const files = await backupFiles(latestDirectory(f.home, f.space.root, backup.id));
  assert.equal(files["plugins/learning/records.jsonl"], fact(1, "第一题"));
  assert.equal(files["sessions/2026-10-31T08-00-00-000Z_s1.jsonl"], `${JSON.stringify({ type: "session", id: "s1" })}\n`);
  assert.equal(files["prompts.json"], `${JSON.stringify({ base: { text: "空间说明" } }, null, 2)}\n`);
  assert.equal(files["format.json"], `${JSON.stringify({ version: 1 })}\n`);
  assert.ok(files["history.git/HEAD"]);
  const names = Object.keys(files);
  assert.ok(!names.some((name) => name === "lock" || name.startsWith("lock/")), "空间锁不收");
  assert.ok(!names.includes(".repa-half.tmp"), "写到一半的临时文件不收");
  assert.ok(!names.includes("plugins/learning/outside.txt"), "符号链接不跟随");
  const manifest = JSON.parse(await readFile(path.join(groupDirectory(f.home, f.space.root), backup.id, "manifest.json"), "utf8")) as { root: string; files: { path: string }[] };
  assert.equal(manifest.root, f.space.root);
  assert.deepEqual(manifest.files.map((file) => file.path).sort(), names.sort());
});

test("代价关卡：没有变化时不复制任何文件；有变化时每个文件只复制一次，字节数等于所收文件大小之和，按块读写，不启动 Git", async (t) => {
  // 定时器换成假的，空间闲置维护不会在统计期间启动 Git。
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t);
  await f.space.filesFor({ kind: "plugin", pluginId: "notes" }).write("notes/a.md", "空间笔记\n");
  await append(f.records, fact(1, "第一题") + fact(2, "第二题"));
  // 比一块大得多的文件：读写次数随大小增加，单次读取不超过一块。
  await mkdir(path.join(f.space.dataDir, "tool-output", "s1"), { recursive: true });
  await writeFile(path.join(f.space.dataDir, "tool-output", "s1", "call.txt"), Buffer.alloc(3 * 1024 * 1024, "全"));
  const startsBefore = gitStarts();
  const before = copyStats();
  const first = await checkBackup(f.home, f.space, 5, f.clock());
  const after = copyStats();
  assert.equal(first.created, true);
  assert.deepEqual(gitStarts(), startsBefore);
  const manifest = JSON.parse(await readFile(path.join(groupDirectory(f.home, f.space.root), first.backup.id, "manifest.json"), "utf8")) as { files: { path: string; size: number }[] };
  const copied = [...after.files].filter(([file, count]) => count !== (before.files.get(file) ?? 0));
  assert.equal(copied.length, manifest.files.length);
  for (const [file, count] of copied) assert.equal(count - (before.files.get(file) ?? 0), 1, `${file} 只复制一次`);
  const total = manifest.files.reduce((sum, file) => sum + file.size, 0);
  assert.equal(after.bytes - before.bytes, total);
  assert.equal(first.backup.bytes, total);
  assert.ok(after.largestRead <= 256 * 1024, `单次读取 ${after.largestRead} 字节，超过一块`);

  const idle = copyStats();
  const second = await checkBackup(f.home, f.space, 5, f.clock());
  assert.deepEqual(second, { created: false, backup: first.backup });
  assert.deepEqual(copyStats(), idle);
  assert.deepEqual(gitStarts(), startsBefore);
  assert.equal((await listBackups(f.home))[0]?.backups.length, 1);

  // 空间文件的改动记入历史以后，历史库随之变化，下一次检查即备份。
  await f.space.filesFor({ kind: "plugin", pluginId: "notes" }).write("notes/a.md", "改过的笔记\n");
  assert.equal((await checkBackup(f.home, f.space, 5, f.clock())).created, true);
});

test("打开以后、每隔设定的间隔、关闭之前各检查一次；应用空闲时不新增备份", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t);
  const errors: unknown[] = [];
  const statuses: BackupStatus[] = [];
  const backups = new SpaceBackups({
    home: f.home, space: f.space, now: f.clock,
    settings: () => ({ intervalMinutes: 30, keep: 5 }),
    onUpdate: (status) => { statuses.push(status); },
    onError: (error) => { errors.push(error); },
  });
  const count = async () => (await listBackups(f.home))[0]?.backups.length ?? 0;
  backups.start();
  // 检查依次进行：排在后面的检查返回时，前面那次已经结束。这次没有变化，说明打开时的检查已经备份过。
  assert.equal((await backups.check()).created, false);
  assert.equal(await count(), 1);
  await append(f.records, fact(1, "第一题"));
  t.mock.timers.tick(30 * 60_000);
  assert.equal((await backups.check()).created, false, "间隔到了的那次检查应当已经备份");
  assert.equal(await count(), 2);
  const idle = copyStats();
  t.mock.timers.tick(30 * 60_000);
  assert.equal((await backups.check()).created, false);
  assert.deepEqual(copyStats(), idle);
  assert.equal(await count(), 2);
  await append(f.records, fact(2, "第二题"));
  await backups.close();
  assert.equal(await count(), 3);
  assert.equal(statuses.length, 3);
  assert.deepEqual(errors, []);
});

test("每个空间只保留设定份数的定期备份，最旧的先删；恢复前的备份不参与轮换", async (t) => {
  const f = await fixture(t);
  const source: BackupSource = { root: f.space.root, dataDir: f.space.dataDir, withHistory: (action) => action() };
  const kept = await createBackup(f.home, source, "beforeRestore", f.clock());
  const ids: string[] = [];
  for (let seq = 1; seq <= 4; seq++) {
    await append(f.records, fact(seq, `第 ${seq} 题`));
    ids.push((await checkBackup(f.home, f.space, 2, f.clock())).backup.id);
  }
  const [listed] = await listBackups(f.home);
  assert.equal(listed?.root, f.space.root);
  assert.equal(listed?.exists, true);
  assert.deepEqual(listed?.backups.map((backup) => backup.id), [ids[3], ids[2], kept.id]);
  assert.deepEqual(listed?.backups.map((backup) => backup.kind), ["regular", "regular", "beforeRestore"]);
  await deleteBackup(f.home, f.space.root, kept.id);
  assert.deepEqual((await listBackups(f.home))[0]?.backups.map((backup) => backup.id), [ids[3], ids[2]]);
  await assert.rejects(deleteBackup(f.home, f.space.root, kept.id), fault("backup_not_found"));
  await assert.rejects(deleteBackup(f.home, f.space.root, "../escape"), fault("backup_not_found"));
});

test("备份失败时删除临时目录，已有的备份全部保留，状态给出失败原因与最近一次成功的时间；下一次检查再试", async (t) => {
  const f = await fixture(t);
  const statuses: BackupStatus[] = [];
  let full = false;
  const space: Space = {
    ...f.space,
    // 复制历史库时磁盘已满：前面的文件已经复制进临时目录。
    withHistory: (action) => (full ? Promise.reject(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" })) : f.space.withHistory(action)),
  };
  const backups = new SpaceBackups({
    home: f.home, space, now: f.clock,
    settings: () => ({ intervalMinutes: 30, keep: 5 }),
    onUpdate: (status) => { statuses.push(status); },
    onError: () => {},
  });
  await append(f.records, fact(1, "第一题"));
  const first = await backups.check();
  await append(f.records, fact(2, "第二题"));
  full = true;
  await assert.rejects(backups.check(), /ENOSPC/u);
  const group = groupDirectory(f.home, f.space.root);
  assert.deepEqual(await readdir(group), [first.backup.id]);
  const failed = await backups.status();
  assert.equal(failed.lastSuccess, first.backup.createdAt);
  assert.equal(failed.failure?.code, "ENOSPC");
  assert.match(failed.failure?.message ?? "", /备份没有完成/u);
  assert.deepEqual(statuses.at(-1), failed);
  full = false;
  const retried = await backups.check();
  assert.equal(retried.created, true);
  assert.deepEqual(await backups.status(), { root: f.space.root, lastSuccess: retried.backup.createdAt, failure: null });
  assert.deepEqual(statuses.at(-1), await backups.status());
  await backups.close();
});

test("备份中途结束进程不留下不完整的备份：复制完成之前只有临时目录，列表看不到它；下一次备份清理它", async (t) => {
  const f = await fixture(t);
  await append(f.records, fact(1, "第一题"));
  const first = await checkBackup(f.home, f.space, 5, f.clock());
  await append(f.records, fact(2, "第二题"));
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const pending = checkBackup(f.home, {
    ...f.space,
    withHistory: async (action) => {
      enter();
      await finished;
      return f.space.withHistory(action);
    },
  }, 5, f.clock());
  await entered;
  const group = groupDirectory(f.home, f.space.root);
  const during = await readdir(group);
  assert.equal(during.length, 2);
  assert.ok(during.some((name) => name.startsWith(".tmp-")));
  assert.deepEqual((await listBackups(f.home))[0]?.backups.map((backup) => backup.id), [first.backup.id]);
  finish();
  const second = await pending;
  // 进程在复制中途被结束时留下的临时目录：下一次备份先清理它。
  await mkdir(path.join(group, ".tmp-left-behind", "data"), { recursive: true });
  await writeFile(path.join(group, ".tmp-left-behind", "data", "format.json"), "{");
  assert.deepEqual((await listBackups(f.home))[0]?.backups.map((backup) => backup.id), [second.backup.id, first.backup.id]);
  await append(f.records, fact(3, "第三题"));
  const third = await checkBackup(f.home, f.space, 5, f.clock());
  assert.deepEqual((await readdir(group)).sort(), [first.backup.id, second.backup.id, third.backup.id].sort());
});

// 状态一：一条事实、第一版笔记，备份为 B1；状态二：两条事实、第二版笔记，尚未备份。空间已关闭。
async function restoreFixture(t: TestContext) {
  const f = await fixture(t);
  const notes = f.space.filesFor({ kind: "plugin", pluginId: "notes" });
  await notes.write("notes/a.md", "第一版\n");
  await append(f.records, fact(1, "第一题"));
  await writeFile(path.join(f.space.sessionsDir, "2026-10-31T08-00-00-000Z_s1.jsonl"), `${JSON.stringify({ type: "session", id: "s1" })}\n`);
  const first = await checkBackup(f.home, f.space, 5, f.clock());
  await notes.write("notes/a.md", "第二版\n");
  await append(f.records, fact(2, "第二题"));
  await writeJson(path.join(f.space.dataDir, "prompts.json"), { base: { text: "状态二的说明" } });
  const before = await readFile(f.records, "utf8");
  await f.space.close();
  return { ...f, root: f.space.root, backup: first.backup, before, options: { home: f.home, root: f.space.root, id: first.backup.id } };
}

test("恢复到原位置：学习记录与文件历史回到备份时的状态，空间文件保持原样并在打开时记为外部改动；空间打开时拒绝恢复", async (t) => {
  const f = await restoreFixture(t);
  const busy = await openSpace(f.root, { watch: false });
  await assert.rejects(restoreInPlace({ ...f.options, now: f.clock() }), fault("space_locked"));
  await busy.close();
  assert.deepEqual((await listBackups(f.home))[0]?.backups.length, 1);

  const before = await restoreInPlace({
    ...f.options,
    now: f.clock(),
    // 换入换出都不碰空间锁：删除标记之前，锁仍在 .repa/ 中原处。
    step: async (name) => {
      if (name === "unmark") assert.ok((await lstat(path.join(f.root, ".repa", "lock"))).isDirectory());
    },
  });
  assert.equal(before.kind, "beforeRestore");
  for (const name of ["restore.json", "restore-staging", "restore-replaced"]) {
    await assert.rejects(lstat(path.join(f.root, ".repa", name)), { code: "ENOENT" });
  }
  const reopened = await openSpace(f.root, { watch: false });
  try {
    assert.equal(await readFile(f.records, "utf8"), fact(1, "第一题"));
    await assert.rejects(lstat(path.join(f.root, ".repa", "prompts.json")), { code: "ENOENT" });
    // 空间文件仍是第二版；历史回到备份时，打开空间把第二版记为外部改动。
    assert.equal(await reopened.files.read("notes/a.md"), "第二版\n");
    const [latest] = await reopened.history.list(1);
    assert.deepEqual(latest?.source, { kind: "external" });
  } finally {
    await reopened.close();
  }
});

test("保留份数为 1 时，恢复以后的备份不会挤掉恢复前的备份，用它可以撤回这次恢复", async (t) => {
  const f = await restoreFixture(t);
  const before = await restoreInPlace({ ...f.options, now: f.clock() });
  const reopened = await openSpace(f.root, { watch: false });
  try {
    // 恢复后的使用期间照常备份，保留份数为 1，定期备份只剩最新一份。
    await append(f.records, fact(2, "恢复后作答"));
    await checkBackup(f.home, reopened, 1, f.clock());
    await append(f.records, fact(3, "又一次作答"));
    await checkBackup(f.home, reopened, 1, f.clock());
  } finally {
    await reopened.close();
  }
  const [listed] = await listBackups(f.home);
  assert.deepEqual(listed?.backups.map((backup) => backup.kind), ["regular", "beforeRestore"]);
  assert.equal(listed?.backups[1]?.id, before.id);
  await restoreInPlace({ ...f.options, id: before.id, now: f.clock() });
  assert.equal(await readFile(f.records, "utf8"), f.before);
  assert.equal(await readFile(path.join(f.root, ".repa", "prompts.json"), "utf8"), `${JSON.stringify({ base: { text: "状态二的说明" } }, null, 2)}\n`);
  const undone = await openSpace(f.root, { watch: false });
  await undone.close();
});

test("恢复到原位置的任一步中断：标记写下以后空间不打开；重新恢复从头做起，之后空间可以打开、内容与选中的备份一致", async (t) => {
  const reference = await restoreFixture(t);
  const steps: string[] = [];
  await restoreInPlace({ ...reference.options, now: reference.clock(), step: (name) => { steps.push(name); } });
  const mark = steps.indexOf("mark");
  assert.deepEqual(steps.slice(0, mark + 1), ["backup", "clean", "stage", "mark"]);
  assert.ok(steps.includes("move-out:history.git") && steps.includes("move-in:history.git"));
  assert.deepEqual(steps.slice(-3), ["remove-replaced", "remove-staging", "unmark"]);
  for (const [index, name] of steps.entries()) {
    const f = await restoreFixture(t);
    let calls = 0;
    const interrupted = restoreInPlace({
      ...f.options,
      now: f.clock(),
      step: () => {
        if (calls++ === index) throw new Error(`在 ${name} 之前中断`);
      },
    });
    await assert.rejects(interrupted, /之前中断/u);
    if (index > mark) {
      await assert.rejects(openSpace(f.root, { watch: false }), fault("restore_incomplete"));
    } else {
      // 标记写下之前中断，空间保持原样。
      const untouched = await openSpace(f.root, { watch: false });
      await untouched.close();
      assert.equal(await readFile(f.records, "utf8"), f.before, `在 ${name} 之前中断后学习记录应保持原样`);
    }
    await restoreInPlace({ ...f.options, now: f.clock() });
    const reopened = await openSpace(f.root, { watch: false });
    await reopened.close();
    assert.equal(await readFile(f.records, "utf8"), fact(1, "第一题"), `在 ${name} 之前中断、重新恢复后学习记录应为备份时的内容`);
    for (const leftover of ["restore.json", "restore-staging", "restore-replaced"]) {
      await assert.rejects(lstat(path.join(f.root, ".repa", leftover)), { code: "ENOENT" });
    }
    // 中断前的状态完整保存在第一份"恢复前"备份里。
    if (index > 0) {
      const [listed] = await listBackups(f.home);
      const oldest = listed?.backups.filter((backup) => backup.kind === "beforeRestore").at(-1);
      assert.ok(oldest);
      assert.equal(await readFile(path.join(latestDirectory(f.home, f.root, oldest.id), "plugins", "learning", "records.jsonl"), "utf8"), f.before);
    }
  }
});

test("删除空间文件夹以后恢复到新文件夹：学习记录与备份时一致，空间文件为备份时历史中的最近一次修订", async (t) => {
  const f = await restoreFixture(t);
  await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  const [listed] = await listBackups(f.home);
  assert.equal(listed?.exists, false);
  await assert.rejects(restoreInPlace({ ...f.options, now: f.clock() }), fault("space_not_found"));
  const target = path.join(f.directory, "恢复的空间");
  assert.equal(await restoreToNew({ ...f.options, target }), target);
  await assert.rejects(restoreToNew({ ...f.options, target }), fault("restore_target_exists"));
  await assert.rejects(restoreToNew({ ...f.options, target: "relative/space" }), fault("invalid_path"));
  const restored = await openSpace(target, { watch: false });
  try {
    assert.equal(await readFile(path.join(target, ".repa", "plugins", "learning", "records.jsonl"), "utf8"), fact(1, "第一题"));
    assert.equal(await restored.files.read("notes/a.md"), "第一版\n");
    // 空间文件与历史的最近一次修订一致，打开时没有外部改动要记。
    const [latest] = await restored.history.list(1);
    assert.deepEqual(latest?.source, { kind: "plugin", pluginId: "notes" });
  } finally {
    await restored.close();
  }
});

test("恢复到新文件夹的任一步中断，选定的名称处不出现不完整的空间；再次恢复先清理留下的临时文件夹", async (t) => {
  const f = await restoreFixture(t);
  const target = path.join(f.directory, "新空间");
  const temporary = path.join(f.directory, ".新空间.restoring");
  for (const name of ["clean", "copy", "checkout", "publish"]) {
    await assert.rejects(restoreToNew({
      ...f.options, target,
      step: (current) => {
        if (current === name) throw new Error(`在 ${name} 之前中断`);
      },
    }), /之前中断/u);
    await assert.rejects(lstat(target), { code: "ENOENT" });
  }
  // 进程在复制中途被结束时，只留下临时文件夹。
  await mkdir(path.join(temporary, ".repa"), { recursive: true });
  await writeFile(path.join(temporary, "残留.txt"), "上次中断留下的");
  await restoreToNew({ ...f.options, target });
  await assert.rejects(lstat(temporary), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(target, "残留.txt")), { code: "ENOENT" });
  const restored = await openSpace(target, { watch: false });
  await restored.close();
});

// 复制读到 directory 之前，把整份备份改名移走，与轮换删除备份的第一步相同。复制按名称顺序进行，读 plugins/ 时历史库已经复制完。
// fs/promises 的具名导出是活绑定，改写 readdir 以后用 syncBuiltinESMExports 同步到已加载的模块；测试结束时还原。
function discardWhenReading(t: TestContext, directory: string, selected: string): void {
  const original = fs.promises.readdir;
  let discarded = false;
  const intercepted = async (...args: unknown[]): Promise<unknown> => {
    if (!discarded && args[0] === directory) {
      discarded = true;
      await rename(selected, `${selected}-discarded`);
    }
    return Reflect.apply(original, fs.promises, args) as unknown;
  };
  Object.assign(fs.promises, { readdir: intercepted });
  syncBuiltinESMExports();
  t.after(() => {
    Object.assign(fs.promises, { readdir: original });
    syncBuiltinESMExports();
  });
}

test("恢复到新文件夹时所选备份在复制中途被轮换删除：报错，不发布，消失的目录不当作空目录", async (t) => {
  const f = await restoreFixture(t);
  const selected = path.join(groupDirectory(f.home, f.root), f.backup.id);
  discardWhenReading(t, path.join(selected, "data", "plugins"), selected);
  const target = path.join(f.directory, "新空间");
  await assert.rejects(restoreToNew({ ...f.options, target }), { code: "ENOENT" });
  await assert.rejects(lstat(target), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(f.directory, ".新空间.restoring")), { code: "ENOENT" });
});

test("恢复到原位置时所选备份在复制中途被删除：报错，空间保持原样，学习记录还在", async (t) => {
  const f = await restoreFixture(t);
  const selected = path.join(groupDirectory(f.home, f.root), f.backup.id);
  discardWhenReading(t, path.join(selected, "data", "plugins"), selected);
  await assert.rejects(restoreInPlace({ ...f.options, now: f.clock() }), { code: "ENOENT" });
  for (const name of ["restore.json", "restore-staging", "restore-replaced"]) {
    await assert.rejects(lstat(path.join(f.root, ".repa", name)), { code: "ENOENT" });
  }
  assert.equal(await readFile(f.records, "utf8"), f.before);
  const reopened = await openSpace(f.root, { watch: false });
  await reopened.close();
});

test("恢复到新文件夹时，检出的空间文件与新建的目录在发布之前同步落盘，自底向上直到临时文件夹本身", async (t) => {
  const f = await restoreFixture(t);
  const target = path.join(f.directory, "新空间");
  const temporary = path.join(f.directory, ".新空间.restoring");
  const before = copyStats().synced;
  await restoreToNew({ ...f.options, target });
  // 这次恢复中第一次同步的路径，按同步的先后排列；发布以前它们都在临时文件夹里。
  const order = [...copyStats().synced.keys()].filter((file) => !before.has(file));
  const expected = [temporary];
  const visit = async (relative: string) => {
    for (const entry of await readdir(path.join(target, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      expected.push(path.join(temporary, name));
      if (entry.isDirectory()) await visit(name);
    }
  };
  await visit("");
  assert.deepEqual(expected.filter((file) => !order.includes(file)), [], "这些路径发布前没有同步");
  // 目录在其中的内容都同步以后才同步，临时文件夹本身最后同步。
  for (const directory of expected) {
    const inside = order.filter((file) => file.startsWith(`${directory}${path.sep}`));
    assert.ok(inside.every((file) => order.indexOf(file) < order.indexOf(directory)), `${directory} 早于其中的内容同步`);
  }
  assert.equal(order.at(-1), temporary);
});

test("“恢复前”的备份按原始字节保存：日志与会话的最后一条只缺换行时也不截掉，撤回后逐字节还原", async (t) => {
  const f = await restoreFixture(t);
  // 空间已经关闭，没有写入者：最后一条是完整的 JSON，只是没有换行。
  await append(f.records, JSON.stringify({ seq: 3, text: "只缺换行" }));
  const original = await readFile(f.records, "utf8");
  const session = path.join(f.root, ".repa", "sessions", "2026-10-31T08-00-00-000Z_s1.jsonl");
  await append(session, JSON.stringify({ type: "message", id: "只缺换行" }));
  const sessionBytes = await readFile(session, "utf8");
  const before = await restoreInPlace({ ...f.options, now: f.clock() });
  const saved = await backupFiles(latestDirectory(f.home, f.root, before.id));
  assert.equal(saved["plugins/learning/records.jsonl"], original);
  assert.equal(saved["sessions/2026-10-31T08-00-00-000Z_s1.jsonl"], sessionBytes);
  await restoreInPlace({ ...f.options, id: before.id, now: f.clock() });
  assert.equal(await readFile(f.records, "utf8"), original);
  assert.equal(await readFile(session, "utf8"), sessionBytes);
});
