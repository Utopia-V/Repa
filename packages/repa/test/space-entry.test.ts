import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { RepaClient, RpcError } from "../src/client.js";
import type { SettingsView } from "../src/protocol.js";
import { startRepaServer, type RepaServer } from "../src/server.js";

const scope = { kind: "application" as const };
const code = (expected: string) => (error: unknown) => error instanceof RpcError &&
  typeof error.data === "object" && error.data !== null && "code" in error.data && error.data.code === expected;

function parentEntry(view: SettingsView) {
  const entry = view.entries.find(item => item.key === "parentDirectory");
  assert(entry);
  return entry;
}

async function setParent(client: RepaClient, directory: string) {
  const current = await client.call("settings.get", { scope, namespace: "spaces" });
  return client.call("settings.set", {
    scope, namespace: "spaces", key: "parentDirectory", value: directory,
    base: parentEntry(current).revision,
  });
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-space-entry-"));
  const appDirectory = path.join(root, "app");
  const active: { server: RepaServer; client: RepaClient }[] = [];
  t.after(async () => {
    for (const item of active) {
      await item.server.close();
      await item.client.close();
    }
    await rm(root, { recursive: true, force: true });
  });
  const open = async () => {
    const server = await startRepaServer({ appDirectory, agentDir: path.join(root, "agent") });
    const client = await RepaClient.connect(server.connection);
    const connection = { server, client };
    active.push(connection);
    return connection;
  };
  return { root, appDirectory, open, ...await open() };
}

test("空间父目录使用应用设置，重启保留并支持恢复默认", async t => {
  const f = await fixture(t);
  const initial = await f.client.call("settings.get", { scope, namespace: "spaces" });
  assert.equal(parentEntry(initial).effective, null);
  assert.deepEqual(initial.definitions.find(item => item.key === "parentDirectory")?.scopes, ["application"]);
  await assert.rejects(stat(path.join(f.appDirectory, "repa-settings.json")), { code: "ENOENT" });

  const directory = path.join(f.root, "学习空间");
  await mkdir(directory);
  const saved = await setParent(f.client, directory);
  assert.equal(parentEntry(saved).effective, directory);
  const space = await f.client.call("space.open", { path: path.join(f.root, "existing") });
  await assert.rejects(f.client.call("settings.set", {
    scope: { kind: "space", spaceId: space.id }, namespace: "spaces", key: "parentDirectory",
    value: directory, base: "unset",
  }), code("configuration"));

  await f.server.close();
  const reopened = await f.open();
  const restored = await reopened.client.call("settings.get", { scope, namespace: "spaces" });
  assert.equal(parentEntry(restored).effective, directory);
  const reset = await reopened.client.call("settings.reset", {
    scope, namespace: "spaces", key: "parentDirectory", base: parentEntry(restored).revision,
  });
  assert.equal(parentEntry(reset).effective, null);
});

test("目录浏览从 HOME 开始，分页返回元信息和链接而不改变材料授权", async t => {
  const f = await fixture(t);
  const directory = path.join(f.root, "browse");
  await mkdir(path.join(directory, "alpha"), { recursive: true });
  await writeFile(path.join(directory, "beta.md"), "学习材料");
  await symlink("alpha", path.join(directory, "gamma"));
  await writeFile(path.join(directory, ".hidden"), "hidden");
  t.mock.method(os, "homedir", () => directory);

  const space = await f.client.call("space.open", { path: path.join(f.root, "space") });
  await f.client.call("content.associate", {
    spaceId: space.id, role: "material", operationId: randomUUID(),
    location: { kind: "external", path: path.join(directory, "beta.md") },
  });
  const accessFile = path.join(f.appDirectory, "repa-content-access.json");
  const before = await readFile(accessFile, "utf8");

  const first = await f.client.call("space.browse", { limit: 2 });
  assert.equal(first.path, directory);
  assert.equal(first.parent, path.dirname(directory));
  assert.deepEqual(first.entries, [
    { name: "alpha", path: path.join(directory, "alpha"), kind: "directory" },
    { name: "beta.md", path: path.join(directory, "beta.md"), kind: "file", size: Buffer.byteLength("学习材料") },
  ]);
  assert.equal(first.nextCursor, "beta.md");
  const second = await f.client.call("space.browse", { path: first.path, cursor: first.nextCursor, limit: 2 });
  assert.deepEqual(second.entries, [{ name: "gamma", path: path.join(directory, "gamma"), kind: "symlink", targetKind: "directory" }]);
  assert.equal(second.nextCursor, undefined);
  const linked = await f.client.call("space.browse", { path: path.join(directory, "gamma") });
  assert.equal(linked.path, path.join(directory, "alpha"));
  const hidden = await f.client.call("space.browse", { path: directory, includeHidden: true });
  assert.deepEqual(hidden.entries.map(entry => entry.name), [".hidden", "alpha", "beta.md", "gamma"]);
  assert.equal(await readFile(accessFile, "utf8"), before);
});

test("目录浏览明确区分缺失路径和普通文件", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "file.txt"), "file");
  await assert.rejects(f.client.call("space.browse", { path: path.join(f.root, "missing") }), code("not_found"));
  await assert.rejects(f.client.call("space.browse", { path: path.join(f.root, "file.txt") }), code("not_directory"));
});

test("没有目录访问权限时返回明确错误", async t => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("需要普通 POSIX 用户验证目录权限。");
    return;
  }
  const f = await fixture(t);
  const directory = path.join(f.root, "private");
  await mkdir(directory, { mode: 0o000 });
  try {
    await assert.rejects(f.client.call("space.browse", { path: directory }), code("permission_denied"));
  } finally {
    await chmod(directory, 0o700);
  }
});

test("按目标创建独立空间，重名和长目标不会覆盖已有目录", async t => {
  const f = await fixture(t);
  await assert.rejects(f.client.call("space.create", { hint: "微积分" }), code("parent_directory_required"));
  const parent = path.join(f.root, "spaces");
  const existing = path.join(parent, "微积分");
  await mkdir(existing, { recursive: true });
  await writeFile(path.join(existing, "notes.md"), "原有内容");
  await setParent(f.client, parent);

  const first = await f.client.call("space.create", { hint: "微积分" });
  const second = await f.client.call("space.create", { hint: "微积分" });
  assert.equal(first.path, path.join(parent, "微积分 (2)"));
  assert.equal(second.path, path.join(parent, "微积分 (3)"));
  assert.notEqual(first.id, second.id);
  assert.deepEqual(await readdir(existing), ["notes.md"]);
  assert.equal(await readFile(path.join(existing, "notes.md"), "utf8"), "原有内容");

  const long = await f.client.call("space.create", { hint: "期末复习: 线性代数 / 特征值? ".repeat(30) });
  const name = path.basename(long.path);
  assert.equal(path.dirname(long.path), parent);
  assert(name.length > 0);
  assert(Buffer.byteLength(name) <= 255);
  assert(!/[<>:"/\\|?*]/u.test(name));
  assert((await f.client.call("space.list", {})).some(space => space.id === long.id));
});

test("并发按同一目标创建空间，各自获得独立目录", async t => {
  const f = await fixture(t);
  const parent = path.join(f.root, "spaces");
  await mkdir(parent);
  await setParent(f.client, parent);
  const spaces = await Promise.all([
    f.client.call("space.create", { hint: "离散数学" }),
    f.client.call("space.create", { hint: "离散数学" }),
  ]);
  assert.notEqual(spaces[0].id, spaces[1].id);
  assert.deepEqual(spaces.map(space => path.basename(space.path)).sort(), ["离散数学", "离散数学 (2)"]);
  assert.deepEqual((await f.client.call("space.list", {})).map(space => space.id).sort(), spaces.map(space => space.id).sort());
});

test("已设置的父目录失效时，创建报告错误而不重建父目录", async t => {
  const f = await fixture(t);
  const parent = path.join(f.root, "spaces");
  await mkdir(parent);
  await setParent(f.client, parent);
  await rm(parent, { recursive: true });
  await assert.rejects(f.client.call("space.create", { hint: "物理" }), code("not_found"));
  await assert.rejects(stat(parent), { code: "ENOENT" });
  await writeFile(parent, "当前位置是普通文件");
  await assert.rejects(f.client.call("space.create", { hint: "物理" }), code("not_directory"));
  assert.equal(await readFile(parent, "utf8"), "当前位置是普通文件");
  assert.deepEqual(await f.client.call("space.recent", {}), []);
});

test("最近空间按成功打开排序并跨重启保留，已移除的目录只标记不可用", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.client.call("space.recent", {}), []);
  const first = await f.client.call("space.open", { path: path.join(f.root, "first") });
  const second = await f.client.call("space.open", { path: path.join(f.root, "second") });
  await symlink(first.path, path.join(f.root, "alias"));
  await f.client.call("space.open", { path: path.join(f.root, "alias") });
  const current = await f.client.call("space.recent", {});
  assert.deepEqual(current.map(item => item.path), [first.path, second.path]);
  assert(current.every(item => item.available && item.lastOpenedAt > 0));
  assert.deepEqual(await f.client.call("space.recent", { limit: 1 }), current.slice(0, 1));
  const stored = JSON.parse(await readFile(path.join(f.appDirectory, "repa-recent-spaces.json"), "utf8")) as { entries: unknown[] };
  assert.deepEqual(stored.entries, current.map(({ path: directory, lastOpenedAt }) => ({ path: directory, lastOpenedAt })));

  await f.server.close();
  await rm(second.path, { recursive: true });
  const reopened = await f.open();
  assert.deepEqual(await reopened.client.call("space.list", {}), []);
  const recent = await reopened.client.call("space.recent", {});
  assert.deepEqual(recent, [current[0], { ...current[1], available: false }]);
  await assert.rejects(stat(second.path), { code: "ENOENT" });
});

test("两个后端共享应用目录时，最近空间保留双方成功打开的路径", async t => {
  const f = await fixture(t);
  const other = await f.open();
  const spaces = await Promise.all([
    f.client.call("space.open", { path: path.join(f.root, "one") }),
    other.client.call("space.open", { path: path.join(f.root, "two") }),
  ]);
  const recent = await f.client.call("space.recent", {});
  assert.deepEqual(recent.map(item => item.path).sort(), spaces.map(space => space.path).sort());
});
