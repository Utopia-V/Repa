import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { Git, GitError } from "../src/git.js";
import { openHistory } from "../src/index.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function fixture(t: TestContext, wrapperBody?: (root: string) => string) {
  const root = await mkdtemp(join(tmpdir(), "repa-history-maintenance-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const space = join(root, "space");
  await mkdir(space);
  let gitPath: string | undefined;
  if (wrapperBody) {
    gitPath = join(root, "git-wrapper");
    await writeFile(gitPath, `#!/bin/sh\n${wrapperBody(root)}\nexec git "$@"\n`);
    await chmod(gitPath, 0o700);
  }
  const history = await openHistory(space, gitPath ? { gitPath } : {});
  const gitDir = join(space, ".repa", "history.git");
  const git = new Git(space, gitDir);
  return { root, space, history, gitDir, git };
}

async function counts(git: Git) {
  const output = (await git.run(["count-objects", "-v"])).toString();
  const count = /^count: (\d+)$/m.exec(output)?.[1];
  const packs = /^packs: (\d+)$/m.exec(output)?.[1];
  assert.ok(count);
  assert.ok(packs);
  return { loose: Number(count), packs: Number(packs) };
}

async function objects(git: Git) {
  return (await git.run(["cat-file", "--batch-all-objects", "--batch-check"]))
    .toString().split("\n").filter(Boolean).sort();
}

async function assertObjectsRetained(git: Git, before: string[]) {
  const after = new Set(await objects(git));
  assert.deepEqual(before.filter((object) => !after.has(object)), []);
}

async function importBlobs(git: Git, start: number, count: number, unpackLimit: number) {
  const stream = Array.from({ length: count }, (_, offset) => {
    const data = `独特的历史资产 ${start + offset}\n`;
    return `blob\ndata ${Buffer.byteLength(data)}\n${data}\n`;
  }).join("") + "done\n";
  await git.run(["-c", `fastimport.unpackLimit=${unpackLimit}`, "fast-import", "--quiet", "--done"], stream);
}

test("小批量快照留下松散对象，超过导入阈值的批量快照留下 pack", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await counts(f.git), { loose: 1, packs: 0 });
  await writeFile(join(f.space, "one.txt"), "小批量内容\n");
  await f.history.snapshot();
  assert.deepEqual(await counts(f.git), { loose: 4, packs: 0 });
  for (let index = 0; index < 128; index++) {
    await writeFile(join(f.space, `batch-${index}.txt`), `独特的批量内容 ${index}\n`);
  }
  await f.history.snapshot();
  assert.deepEqual(await counts(f.git), { loose: 6, packs: 1 });
});

test("松散对象达到门槛后重开仍维护，打包后再次检查跳过", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.history.maintain(), false);
  await importBlobs(f.git, 0, 1023, 2048);
  assert.deepEqual(await counts(f.git), { loose: 1024, packs: 0 });
  const before = await objects(f.git);
  const reopened = await openHistory(f.space);
  assert.equal(await reopened.maintain(), true);
  assert.equal((await counts(f.git)).loose, 0);
  await assertObjectsRetained(f.git, before);
  assert.equal(await reopened.maintain(), false);
});

test("小 pack 达到门槛时合并，不依赖松散对象达到门槛", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 31; index++) {
    await importBlobs(f.git, index, 1, 0);
  }
  assert.deepEqual(await counts(f.git), { loose: 1, packs: 31 });
  assert.equal(await f.history.maintain(), false);
  await importBlobs(f.git, 31, 1, 0);
  assert.deepEqual(await counts(f.git), { loose: 1, packs: 32 });
  const before = await objects(f.git);
  assert.equal(await f.history.maintain(), true);
  assert.equal((await counts(f.git)).packs, 2);
  await assertObjectsRetained(f.git, before);
});

test("维护永久保留旧提交、不可达对象和过期 reflog，旧版本仍可撤销", async (t) => {
  const f = await fixture(t);
  const baseline = (await f.history.snapshot()).revision;
  await writeFile(join(f.space, "asset.txt"), "原始内容\r\n");
  const original = await f.history.snapshot({ kind: "plugin", pluginId: "assets" });
  await writeFile(join(f.space, "asset.txt"), "修改后的内容\n");
  const changed = await f.history.snapshot({ kind: "plugin", pluginId: "assets" });
  const tree = (await f.git.run(["rev-parse", `${baseline}^{tree}`])).toString().trim();
  const dangling = (await f.git.run(["commit-tree", tree], "未挂接的旧提交\n")).toString().trim();
  const unreachable = (await f.git.run(["commit-tree", tree], "没有引用或 reflog 的旧提交\n")).toString().trim();
  await f.git.run(["hash-object", "-w", "--stdin"], "未挂接的旧资产\r\n");
  await f.git.run(["update-ref", "--create-reflog", "refs/heads/retained", dangling]);
  await f.git.run(["update-ref", "refs/heads/retained", baseline]);
  const reflogPath = join(f.gitDir, "logs", "refs", "heads", "retained");
  const reflog = (await readFile(reflogPath, "utf8")).replace(/> \d+ [+-]\d{4}/g, "> 946684800 +0000");
  await writeFile(reflogPath, reflog);
  const age = new Date("2000-01-01T00:00:00Z");
  for (const directory of await readdir(join(f.gitDir, "objects"))) {
    if (!/^[0-9a-f]{2}$/.test(directory)) continue;
    for (const file of await readdir(join(f.gitDir, "objects", directory))) {
      await utimes(join(f.gitDir, "objects", directory, file), age, age);
    }
  }
  await f.git.run(["config", "gc.pruneExpire", "now"]);
  await f.git.run(["config", "gc.reflogExpire", "now"]);
  await f.git.run(["config", "gc.reflogExpireUnreachable", "now"]);
  await f.git.run(["config", "gc.cruftPacks", "false"]);
  const before = await objects(f.git);
  const feed = await f.history.changesSince(null);
  const revisions = await f.history.list();
  assert.equal(await f.history.maintain({ force: true }), true);
  await assertObjectsRetained(f.git, before);
  assert.equal(await readFile(reflogPath, "utf8"), reflog);
  assert.deepEqual(await f.history.list(), revisions);
  assert.deepEqual(await f.history.changesSince(null), feed);
  assert.equal((await f.git.run(["show", `${original.revision}:asset.txt`])).toString(), "原始内容\r\n");
  assert.equal((await f.git.run(["cat-file", "-t", dangling])).toString().trim(), "commit");
  assert.equal((await f.git.run(["cat-file", "-t", unreachable])).toString().trim(), "commit");
  await f.git.run(["fsck", "--full"]);
  const undone = await f.history.undo(changed.revision);
  assert.deepEqual(undone.conflicts, []);
  assert.deepEqual(undone.restored, ["asset.txt"]);
  assert.equal(await readFile(join(f.space, "asset.txt"), "utf8"), "原始内容\r\n");
  assert.equal(await f.history.maintain({ force: true }), true);
  assert.ok((await f.history.list()).some(({ id }) => id === changed.revision));
  await assertObjectsRetained(f.git, before);
});

test("维护排在活动保存之后并在后续活动之前完成，不后台脱离队列", async (t) => {
  const f = await fixture(t, (root) => `
for argument in "$@"; do
  if [ "$argument" = gc ]; then
    git "$@" || exit $?
    printf 'finished\\n' >> ${shellQuote(join(root, "maintenance"))}
    exit 0
  fi
done`);
  let enter = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const first = f.history.record({ kind: "plugin", pluginId: "before-maintenance" }, async () => {
    enter();
    await blocked;
    await writeFile(join(f.space, "first.txt"), "维护前\n");
  });
  await entered;
  const maintenance = f.history.maintain({ force: true });
  const after = f.history.record({ kind: "plugin", pluginId: "after-maintenance" }, async () => {
    assert.equal(await readFile(join(f.root, "maintenance"), "utf8"), "finished\n");
    await writeFile(join(f.space, "after.txt"), "维护后\n");
  });
  await assert.rejects(readFile(join(f.root, "maintenance")), { code: "ENOENT" });
  release();
  const [, maintained] = await Promise.all([first, maintenance, after]);
  assert.equal(maintained, true);
  assert.equal((await f.history.changesSince(null)).revisions.length, 3);
  assert.equal(await readFile(join(f.space, "first.txt"), "utf8"), "维护前\n");
  await f.git.run(["fsck", "--full"]);
});

test("维护失败保留重试机会，force 不绕过 Git 自身维护锁", async (t) => {
  const f = await fixture(t, (root) => `
for argument in "$@"; do
  if [ "$argument" = --force ]; then exit 2; fi
  if [ "$argument" = gc ] && [ -f ${shellQuote(join(root, "fail-once"))} ]; then
    rm ${shellQuote(join(root, "fail-once"))}
    printf 'injected maintenance failure\\n' >&2
    exit 1
  fi
done`);
  await importBlobs(f.git, 0, 1023, 2048);
  const before = await objects(f.git);
  await writeFile(join(f.root, "fail-once"), "");
  await assert.rejects(f.history.maintain(), (error: unknown) => {
    assert.ok(error instanceof GitError);
    assert.equal(error.exitCode, 1);
    return true;
  });
  await assertObjectsRetained(f.git, before);
  assert.equal(await f.history.maintain(), true);
  await writeFile(join(f.gitDir, "gc.pid"), `${process.pid} ${hostname()}\n`);
  await assert.rejects(f.history.maintain({ force: true }), (error: unknown) => {
    assert.ok(error instanceof GitError);
    assert.equal(error.exitCode, 128);
    return true;
  });
  await rm(join(f.gitDir, "gc.pid"));
  assert.equal(await f.history.maintain({ force: true }), true);
  await assertObjectsRetained(f.git, before);
  await writeFile(join(f.space, "after-failure.txt"), "后续快照\n");
  assert.equal((await f.history.snapshot()).committed, true);
});
