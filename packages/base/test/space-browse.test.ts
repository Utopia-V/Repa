import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { RepaFault } from "../src/schema.js";
import { browseDirectory, hiddenEntry, listRoots, parseDrives } from "../src/space/browse.js";

async function fixture(t: TestContext, folders: string[] = []) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-browse-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const folder of folders) await mkdir(path.join(directory, folder), { recursive: true });
  return directory;
}

const fault = (code: string) => (error: unknown): boolean => error instanceof RepaFault && error.code === code;

test("只列出子文件夹并按自然顺序排列，隐藏点开头的文件夹", async (t) => {
  const directory = await fixture(t, ["chapter 10", "chapter 2", "物理", ".git"]);
  await writeFile(path.join(directory, "notes.md"), "笔记");

  const listing = await browseDirectory(directory);

  assert.deepEqual(listing.entries.map((entry) => entry.name), ["chapter 2", "chapter 10", "物理"]);
  assert.equal(listing.entries[0]?.path, path.join(directory, "chapter 2"));
  assert.equal(listing.path, directory);
  assert.equal(listing.parent, path.dirname(directory));
  assert.equal(listing.truncated, false);
});

test("只有有效格式标记的子文件夹和当前文件夹标为已有空间", async (t) => {
  const directory = await fixture(t, ["physics/.repa", "history"]);
  await writeFile(path.join(directory, "history", ".repa"), "不是文件夹");

  await writeFile(path.join(directory, "physics", ".repa", "format.json"), '{"version":1,"future":true}');
  const listing = await browseDirectory(directory);
  assert.deepEqual(listing.entries.map((entry) => [entry.name, entry.space]), [["history", false], ["physics", true]]);
  assert.equal(listing.space, false);
  assert.equal((await browseDirectory(path.join(directory, "physics"))).space, true);
});

test("跟随指向文件夹的链接，跳过断开的链接和指向文件的链接", async (t) => {
  const directory = await fixture(t, ["target"]);
  await writeFile(path.join(directory, "file.txt"), "");
  await symlink(path.join(directory, "target"), path.join(directory, "linked"));
  await symlink(path.join(directory, "missing"), path.join(directory, "broken"));
  await symlink(path.join(directory, "file.txt"), path.join(directory, "file-link"));

  const listing = await browseDirectory(directory);

  assert.deepEqual(listing.entries.map((entry) => entry.name), ["linked", "target"]);
});

test("文件夹超过上限时只返回上限数量并标记截断", async (t) => {
  const directory = await fixture(t, ["a", "b", "c"]);

  const limited = await browseDirectory(directory, 2);
  assert.equal(limited.entries.length, 2);
  assert.equal(limited.truncated, true);
  assert.equal((await browseDirectory(directory, 3)).truncated, false);
});

test("相对路径、不存在的路径和文件分别返回可处理的错误码", async (t) => {
  const directory = await fixture(t);
  await writeFile(path.join(directory, "file.txt"), "");

  await assert.rejects(browseDirectory("relative/path"), fault("invalid_path"));
  await assert.rejects(browseDirectory(path.join(directory, "missing")), fault("not_found"));
  await assert.rejects(browseDirectory(path.join(directory, "file.txt")), fault("not_directory"));
});

test("没有读取权限的文件夹返回 permission_denied", {
  skip: process.platform === "win32" ? "Windows 上 chmod 只改只读属性，去不掉读取权限" : process.getuid?.() === 0 ? "root 不受权限位限制" : false,
}, async (t) => {
  const directory = await fixture(t, ["locked/inner"]);
  const locked = path.join(directory, "locked");
  await chmod(locked, 0o000);
  try {
    await assert.rejects(browseDirectory(locked), fault("permission_denied"));
    // 上级仍能列出它，进入时才报告权限错误。
    assert.deepEqual((await browseDirectory(directory)).entries.map((entry) => entry.name), ["locked"]);
  } finally {
    // 先恢复权限，夹具才能删除临时目录。
    await chmod(locked, 0o755);
  }
});

test("Windows 按名称隐藏系统目录，兼容链接只在确实是链接时隐藏", () => {
  assert.equal(hiddenEntry("$Recycle.Bin", false, "win32"), true);
  assert.equal(hiddenEntry("System Volume Information", false, "win32"), true);
  assert.equal(hiddenEntry("AppData", false, "win32"), true);
  assert.equal(hiddenEntry("My Documents", true, "win32"), true);
  assert.equal(hiddenEntry("Templates", false, "win32"), false);
  assert.equal(hiddenEntry("Documents", false, "win32"), false);
  assert.equal(hiddenEntry(".vscode", false, "win32"), true);
  assert.equal(hiddenEntry("$Recycle.Bin", false, "darwin"), false);
  assert.equal(hiddenEntry("AppData", false, "linux"), false);
});

test("解析 PowerShell 输出的盘符，忽略其他行", () => {
  assert.deepEqual(parseDrives("C:\\\r\nd:\\\r\n\r\nWARNING\r\n"), [
    { path: "C:\\", label: "C:" },
    { path: "D:\\", label: "D:" },
  ]);
});

test("非 Windows 平台只有根目录一个起点", { skip: process.platform === "win32" ? "Windows 的起点是各个盘符" : false }, async () => {
  assert.deepEqual(await listRoots(), [{ path: "/", label: "/" }]);
});


test("只有旧应用配置或无效标记的主目录不标为空间，更新格式仍标为空间", async (t) => {
  const directory = await fixture(t, [".repa/agent"]);
  await writeFile(path.join(directory, ".repa", "settings.json"), "{}");
  assert.equal((await browseDirectory(directory)).space, false);
  for (const marker of ["{", '{"version":0}', '{"version":1.5}']) {
    await writeFile(path.join(directory, ".repa", "format.json"), marker);
    assert.equal((await browseDirectory(directory)).space, false);
  }
  await writeFile(path.join(directory, ".repa", "format.json"), '{"version":2}');
  assert.equal((await browseDirectory(directory)).space, true);
});
