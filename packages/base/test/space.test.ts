import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import { createSpace, openSpace } from "../src/space.js";
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
