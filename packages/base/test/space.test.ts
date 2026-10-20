import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import { withRun } from "../src/run-context.js";
import type { Revision } from "../src/plugin.js";
import { createSpace, openSpace, type Space } from "../src/space.js";
import { RepaFault } from "../src/schema.js";

async function fixture(t: TestContext, watch = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-space-"));
  const space = await createSpace(path.join(directory, "space"), { watch });
  t.after(async () => {
    await space.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, space };
}

const fault = (code: string) => (error: unknown): boolean => error instanceof RepaFault && error.code === code;

test("同一空间通过符号链接打开仍共享排他锁，关闭后可以重开", async (t) => {
  const { directory, space } = await fixture(t);
  const alias = path.join(directory, "alias");
  await symlink(space.root, alias);
  await assert.rejects(openSpace(alias, { watch: false }), fault("space_locked"));
  await space.close();
  const reopened = await openSpace(alias, { watch: false });
  assert.equal(reopened.root, space.root);
  assert.equal(reopened.sessionsDir, path.join(space.root, ".repa", "sessions"));
  await reopened.close();
});

test("空间文件接口拒绝越界和控制目录链接，并保留中文原文", async (t) => {
  const { directory, space } = await fixture(t);
  await writeFile(path.join(directory, "secret.txt"), "外部内容");
  await symlink(directory, path.join(space.root, "escape"));
  await symlink(space.dataDir, path.join(space.root, "control"));
  for (const file of ["../secret.txt", "escape/secret.txt", "control/settings.json", ".repa/test.json"]) {
    await assert.rejects(space.files.read(file), fault("file_outside_space"));
    await assert.rejects(space.files.write(file, "覆盖"), fault("file_outside_space"));
  }
  assert.deepEqual(await space.files.list(), []);
  const original = "中文，（：全角标点\r\n第二行\n";
  await space.filesFor({ kind: "plugin", pluginId: "test" }).write("notes/原文.md", original);
  assert.equal(await space.files.read("notes/原文.md"), original);
  assert.deepEqual(await space.files.list("notes"), ["notes/原文.md"]);
  const [revision] = await space.history.list(1);
  assert.deepEqual(revision?.source, { kind: "plugin", pluginId: "test" });
  assert.equal(await readFile(path.join(directory, "secret.txt"), "utf8"), "外部内容");
});

test("Agent 活动中的插件写入归入同一记录，历史嵌套调用明确失败", async (t) => {
  const { space } = await fixture(t);
  const files = space.filesFor({ kind: "plugin", pluginId: "test" });
  const { snapshot } = await space.record({ kind: "agent", runId: "run-1" }, async () => {
    await files.write("one.txt", "第一份");
    await files.write("two.txt", "第二份");
    await assert.rejects(async () => space.history.changes(), fault("history_during_activity"));
    await assert.rejects(space.record({ kind: "plugin", pluginId: "test" }, async () => {}), fault("nested_history_activity"));
  });
  const feed = await space.history.changes();
  const run = feed.revisions.find((revision) => revision.id === snapshot.revision);
  assert.deepEqual(run?.source, { kind: "agent", runId: "run-1" });
  assert.deepEqual(run?.changes.map((change) => change.path).sort(), ["one.txt", "two.txt"]);
  assert.equal(feed.revisions.filter((revision) => revision.source.kind === "plugin").length, 0);
});

test("外部编辑由 watcher 通知，控制目录变化不会形成历史修订", async (t) => {
  const { space } = await fixture(t, true);
  let changed!: () => void;
  const observed = new Promise<void>((resolve) => { changed = resolve; });
  const remove = space.onRevision((revision) => {
    if (revision.source.kind === "external") changed();
  });
  t.after(remove);
  await writeFile(path.join(space.root, "external.txt"), "外部编辑");
  await Promise.race([
    observed,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等待外部编辑通知超时")), 5_000);
      timer.unref();
      observed.finally(() => clearTimeout(timer));
    }),
  ]);
  const before = await space.history.list();
  await mkdir(path.join(space.dataDir, "plugins", "test"));
  await writeFile(path.join(space.dataDir, "plugins", "test", "state.json"), "{}");
  await space.flush();
  assert.deepEqual(await space.history.list(), before);
});

function revisionChanges(space: Space, id: string | undefined) {
  return space.history.changes().then((feed) => feed.revisions.find((revision) => revision.id === id)?.changes.map((change) => change.path));
}

test("插件在运行之外的写入记在插件名下，只提交它写的路径；运行内的写入记到当前运行和祖先链，可按祖先运行撤回", async (t) => {
  const { space } = await fixture(t);
  const files = space.filesFor({ kind: "plugin", pluginId: "learning" });
  // watcher 关着，这两处外部改动只能由之后的快照发现。
  await writeFile(path.join(space.root, "elsewhere.txt"), "别处的改动");
  await mkdir(path.join(space.root, "notes"));
  await writeFile(path.join(space.root, "notes", "a.md"), "用户先改的");
  await files.write("notes/a.md", "插件写的");
  const [written, external] = await space.history.list(2);
  assert.deepEqual(written?.source, { kind: "plugin", pluginId: "learning" });
  assert.deepEqual(await revisionChanges(space, written?.id), ["notes/a.md"]);
  // 写入前这个路径上的改动先记成 external；别处的改动不混进来。
  assert.deepEqual(external?.source, { kind: "external" });
  assert.deepEqual(await revisionChanges(space, external?.id), ["notes/a.md"]);
  await withRun({ runId: "child", ancestorRunIds: ["parent"], sessionId: "session", agent: "writer" }, () => files.write("notes/b.md", "运行里调用插件写的"));
  const [inRun] = await space.history.list(1);
  assert.deepEqual(inRun?.source, { kind: "agent", runId: "child", ancestorRunIds: ["parent"] });
  assert.deepEqual(await revisionChanges(space, inRun?.id), ["notes/b.md"]);
  assert.equal((await space.history.changes()).revisions.some((revision) => revision.changes.some((change) => change.path === "elsewhere.txt")), false);
  // 按祖先运行撤回，连带它的子运行；插件名下的写入不受影响。
  const undone = await space.history.undoRun("parent");
  assert.deepEqual([undone.restored, undone.conflicts], [["notes/b.md"], []]);
  await assert.rejects(readFile(path.join(space.root, "notes", "b.md")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(space.root, "notes", "a.md"), "utf8"), "插件写的");
});

test("不透明写入者持有空间写锁时，按路径的写入等它结束；等待中取消的写入不再执行", async (t) => {
  const { space } = await fixture(t);
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const opaque = space.record({ kind: "agent", runId: "shell" }, async () => {
    enter();
    await released;
    await writeFile(path.join(space.root, "shell.txt"), "命令行写的");
  });
  await entered;
  const order: string[] = [];
  const waiting = space.filesFor({ kind: "plugin", pluginId: "learning" }).write("plugin.txt", "插件写的").then(() => { order.push("plugin"); });
  const controller = new AbortController();
  let ran = false;
  const cancelled = space.writes.lock(async () => { ran = true; }, controller.signal);
  controller.abort();
  await assert.rejects(cancelled, /Operation aborted/u);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(order.length, 0);
  release();
  await opaque.then(() => { order.push("shell"); });
  await waiting;
  assert.deepEqual(order, ["shell", "plugin"]);
  assert.equal(ran, false);
  const [plugin, shell] = await space.history.list(2);
  assert.deepEqual(shell?.source, { kind: "agent", runId: "shell" });
  assert.deepEqual(await revisionChanges(space, shell?.id), ["shell.txt"]);
  assert.deepEqual(plugin?.source, { kind: "plugin", pluginId: "learning" });
  assert.deepEqual(await revisionChanges(space, plugin?.id), ["plugin.txt"]);
});

async function executable(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(`PATH 中没有 ${name}`);
}

// 把 PATH 里的 git 换成先记下参数的包装脚本；整空间快照每次都以 read-tree --empty 开始，按路径的快照不用它。
async function recordGitCommands(t: TestContext): Promise<() => Promise<string[]>> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-git-commands-"));
  const log = path.join(directory, "commands.log");
  await writeFile(path.join(directory, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${await executable("git")}' "$@"\n`, { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = `${directory}${path.delimiter}${previous ?? ""}`;
  t.after(async () => {
    process.env.PATH = previous;
    await rm(directory, { recursive: true, force: true });
  });
  return async () => (await readFile(log, "utf8")).split("\n").filter((line) => line.length > 0);
}

test("watcher 只按变了的路径快照，整空间扫描只在打开空间和撤回之前", { skip: process.platform === "win32" }, async (t) => {
  const commands = await recordGitCommands(t);
  const wholeScans = async () => (await commands()).filter((line) => line.endsWith(" read-tree --empty")).length;
  const { space } = await fixture(t, true);
  assert.equal(await wholeScans(), 1);
  const observed = new Promise<Revision>((resolve) => {
    const remove = space.onRevision((revision) => {
      if (revision.source.kind !== "external") return;
      remove();
      resolve(revision);
    });
  });
  await writeFile(path.join(space.root, "external.txt"), "编辑器里的改动");
  const revision = await observed;
  assert.deepEqual(await revisionChanges(space, revision.id), ["external.txt"]);
  assert.ok((await commands()).some((line) => line.includes(" ls-files ") && line.endsWith(" -- external.txt")));
  await space.filesFor({ kind: "plugin", pluginId: "learning" }).write("plugin.txt", "插件写的");
  await space.flush();
  assert.equal(await wholeScans(), 1);
  await space.history.undo(revision.id);
  assert.equal(await wholeScans(), 2);
});

test("打开空间时在 .repa/ 放一份忽略全部内容的 .ignore，被改动后再次打开会恢复", async (t) => {
  const { space } = await fixture(t);
  const file = path.join(space.dataDir, ".ignore");
  assert.equal(await readFile(file, "utf8"), "*\n");
  await space.close();
  await writeFile(file, "!sessions\n");
  const reopened = await openSpace(space.root, { watch: false });
  await reopened.close();
  assert.equal(await readFile(file, "utf8"), "*\n");
});

test("控制目录不能通过符号链接指向空间以外", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-space-control-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "space");
  const outside = path.join(directory, "outside");
  await mkdir(root);
  await mkdir(outside);
  await symlink(outside, path.join(root, ".repa"));
  await assert.rejects(openSpace(root, { watch: false }), fault("invalid_control_directory"));
});


test("不同后端进程不能同时持有同一个空间锁", async (t) => {
  const { space } = await fixture(t);
  const script = `
    import { openSpace } from ${JSON.stringify(new URL("../src/space.ts", import.meta.url).href)};
    try {
      const space = await openSpace(process.argv[1], { watch: false });
      await space.close();
      console.log("opened");
    } catch (error) {
      console.log(error.code);
    }
  `;
  const run = () => promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, space.root]);
  assert.equal((await run()).stdout.trim(), "space_locked");
  await space.close();
  assert.equal((await run()).stdout.trim(), "opened");
});

test("关闭空间等已进入的活动完成后才释放锁", async (t) => {
  const { space } = await fixture(t);
  let enter!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const resumed = new Promise<void>((resolve) => { resume = resolve; });
  const recording = space.record({ kind: "agent", runId: "run-close" }, async () => {
    enter();
    await resumed;
    await space.files.write("saved.txt", "完整保存");
  });
  await entered;
  const closing = space.close();
  await assert.rejects(openSpace(space.root, { watch: false }), fault("space_locked"));
  resume();
  await recording;
  await closing;
  const reopened = await openSpace(space.root, { watch: false });
  assert.equal(await reopened.files.read("saved.txt"), "完整保存");
  assert.deepEqual((await reopened.history.list(1))[0]?.source, { kind: "agent", runId: "run-close" });
  await reopened.close();
});

async function seedLooseObjects(root: string): Promise<number> {
  // 批量生成不可达的小对象，模拟保存失败遗留；避免用一千次 Git 进程拖慢宿主回归。
  const input = Array.from({ length: 1_100 }, (_, i) => {
    const text = `maintenance-${i}\n`;
    return `blob\ndata ${Buffer.byteLength(text)}\n${text}\n`;
  }).join("") + "done\n";
  await new Promise<void>((resolve, reject) => {
    const child = execFile("git", [
      `--git-dir=${path.join(root, ".repa", "history.git")}`,
      "-c", "fastimport.unpackLimit=2000", "fast-import", "--quiet", "--done",
    ], (error) => { if (error) reject(error); else resolve(); });
    child.stdin?.end(input);
  });
  return looseObjects(root);
}

async function looseObjects(root: string): Promise<number> {
  const { stdout } = await promisify(execFile)("git", [
    `--git-dir=${path.join(root, ".repa", "history.git")}`, "count-objects", "-v",
  ]);
  const count = /^count: (\d+)$/m.exec(stdout)?.[1];
  assert.ok(count);
  return Number(count);
}

test("新的提交重新开始维护等待，静默三十秒后打包", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { space } = await fixture(t);
  assert.ok(await seedLooseObjects(space.root) >= 1_100);
  t.mock.timers.tick(20_000);
  await space.files.write("idle.txt", "重新开始等待\n");
  t.mock.timers.tick(29_999);
  await space.history.list();
  assert.ok(await looseObjects(space.root) >= 1_100);
  t.mock.timers.tick(1);
  // 维护与读取共享同一队列，读取完成就是维护已收尾的屏障。
  await space.history.list();
  assert.equal(await looseObjects(space.root), 0);
  assert.equal(await space.files.read("idle.txt"), "重新开始等待\n");
});

test("打开已有空间后即使没有新提交，也在闲置时维护旧对象", async (t) => {
  const { space } = await fixture(t);
  await space.close();
  assert.ok(await seedLooseObjects(space.root) >= 1_100);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reopened = await openSpace(space.root, { watch: false });
  try {
    t.mock.timers.tick(30_000);
    await reopened.history.list();
    assert.equal(await looseObjects(space.root), 0);
  } finally {
    await reopened.close();
  }
});

test("闲置维护遇到 Git 锁后报告错误，无新提交也会继续重试", async (t) => {
  const { space } = await fixture(t);
  await space.close();
  await seedLooseObjects(space.root);
  const lock = path.join(space.dataDir, "history.git", "gc.pid");
  await writeFile(lock, `${process.pid} ${os.hostname()}\n`);
  const errors: unknown[] = [];
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reopened = await openSpace(space.root, { watch: false, onError: error => { errors.push(error); } });
  try {
    t.mock.timers.tick(30_000);
    await reopened.history.list();
    assert.equal(errors.length, 1);
    assert.ok(await looseObjects(space.root) >= 1_100);
    await rm(lock);
    t.mock.timers.tick(30_000);
    await reopened.history.list();
    assert.equal(await looseObjects(space.root), 0);
    assert.equal(errors.length, 1);
  } finally {
    await rm(lock, { force: true });
    await reopened.close();
  }
});

test("关闭在释放空间锁前完成待维护对象打包，旧历史保持可读", async (t) => {
  const { space } = await fixture(t);
  await space.files.write("saved.txt", "历史原文\n");
  const before = await space.history.changes();
  assert.ok(await seedLooseObjects(space.root) >= 1_100);
  await space.close();
  assert.equal(await looseObjects(space.root), 0);
  const reopened = await openSpace(space.root, { watch: false });
  try {
    assert.deepEqual(await reopened.history.changes(), before);
    assert.equal(await reopened.files.read("saved.txt"), "历史原文\n");
  } finally {
    await reopened.close();
  }
});

test("闲置维护已排队但尚未开始时丢失空间锁，不再打包对象", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-space-maintenance-lock-"));
  let lockLost = false;
  let releaseActivity: () => void = () => undefined;
  let reportCompromise: (error: unknown) => void = () => undefined;
  const compromised = new Promise<unknown>(resolve => { reportCompromise = resolve; });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const space = await createSpace(path.join(directory, "space"), {
    watch: false,
    onError(error) {
      lockLost = true;
      reportCompromise(error);
    },
  });
  t.after(async () => {
    releaseActivity();
    try {
      if (lockLost) {
        await assert.rejects(space.close(), error => error !== null && typeof error === "object" && "code" in error && error.code === "ERELEASED");
      } else {
        await space.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  assert.ok(await seedLooseObjects(space.root) >= 1_100);
  let reportEntered: () => void = () => undefined;
  const entered = new Promise<void>(resolve => { reportEntered = resolve; });
  const released = new Promise<void>(resolve => { releaseActivity = resolve; });
  const active = space.record({ kind: "agent", runId: "maintenance-lock-loss" }, async () => {
    reportEntered();
    await released;
    await writeFile(path.join(space.root, "queued.txt"), "已进入队列的动作\n");
  });
  await entered;
  await rm(path.join(space.dataDir, "lock"), { recursive: true });
  // 维护先入队；同次 tick 启动的异步锁心跳随后确认失权，而活动仍占有历史队列。
  t.mock.timers.tick(30_000);
  const error = await compromised;
  assert.ok(error !== null && typeof error === "object" && "code" in error);
  assert.equal(error.code, "ECOMPROMISED");
  releaseActivity();
  // record 的 revision 通知排在维护后面，活动完成也确认已排队的维护收尾。
  await active;
  assert.ok(await looseObjects(space.root) >= 1_100);
});

test("空间独占打开时清理残留历史锁，正文与已有记录保留", async (t) => {
  const { space } = await fixture(t);
  const text = "作者原稿\r\n第二行\n";
  await space.filesFor({ kind: "plugin", pluginId: "writer" }).write("正文.md", text);
  const revisions = await space.history.list();
  await space.close();
  for (const file of ["index.lock", "config.lock", "refs/heads/history.lock"]) {
    await writeFile(path.join(space.dataDir, "history.git", file), "");
  }
  const reopened = await openSpace(space.root, { watch: false });
  try {
    assert.equal(await readFile(path.join(space.root, "正文.md"), "utf8"), text);
    assert.deepEqual(await reopened.history.list(), revisions);
    for (const file of ["index.lock", "config.lock", "refs/heads/history.lock"]) {
      await assert.rejects(access(path.join(space.dataDir, "history.git", file)), { code: "ENOENT" });
    }
  } finally {
    await reopened.close();
  }
});
