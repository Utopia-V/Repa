import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { RepaFault } from "../src/schema.js";
import { browseDirectory, listRoots, parseDrives, parseHiddenListing } from "../src/space/browse.js";

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

test("要求列出文件时，文件排在文件夹后面并带大小，隐藏文件与断开的链接不列", async (t) => {
  const directory = await fixture(t, ["课件"]);
  await writeFile(path.join(directory, "第2章.pdf"), "12345");
  await writeFile(path.join(directory, "第10章.pdf"), "1");
  await writeFile(path.join(directory, ".DS_Store"), "");
  await symlink(path.join(directory, "第2章.pdf"), path.join(directory, "链接.pdf"));
  await symlink(path.join(directory, "missing"), path.join(directory, "broken"));

  const listing = await browseDirectory(directory, { files: true });

  assert.deepEqual(listing.entries.map((entry) => [entry.name, entry.file ?? false, entry.size]), [
    ["课件", false, undefined], ["第2章.pdf", true, 5], ["第10章.pdf", true, 1], ["链接.pdf", true, 5],
  ]);
  assert.equal(listing.entries[1]?.path, path.join(directory, "第2章.pdf"));
});

test("给了扩展名时只列这些格式的文件，不分大小写；文件夹照列，Office 的锁文件不列", async (t) => {
  const directory = await fixture(t, ["课件.pdf 旧版"]);
  for (const name of ["第1章.PDF", "引论.pptx", "~$引论.pptx", "NTUSER.DAT", "ntuser.dat.LOG1", "笔记.txt"]) {
    await writeFile(path.join(directory, name), "");
  }

  const listing = await browseDirectory(directory, { files: true, extensions: [".pdf", ".pptx"] });

  assert.deepEqual(listing.entries.map((entry) => entry.name), ["课件.pdf 旧版", "引论.pptx", "第1章.PDF"]);
});

test("文件夹超过上限时只返回上限数量并标记截断", async (t) => {
  const directory = await fixture(t, ["a", "b", "c"]);

  const limited = await browseDirectory(directory, { limit: 2 });
  assert.equal(limited.entries.length, 2);
  assert.equal(limited.truncated, true);
  assert.equal((await browseDirectory(directory, { limit: 3 })).truncated, false);
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

test("dir /a:h /b 的输出按行读成隐藏条目名，中文名、开头的空格都保留，不分大小写", () => {
  // cmd /u 写进管道的是 UTF-16LE；这里按同样的编码往返一次。
  const output = Buffer.from("AppData\r\n「开始」菜单\r\n WPS Cloud Files\r\nNTUSER.DAT\r\n", "utf16le").toString("utf16le");
  assert.deepEqual([...parseHiddenListing(output)], ["appdata", "「开始」菜单", " wps cloud files", "ntuser.dat"]);
  assert.deepEqual([...parseHiddenListing("")], []);
});

test("带隐藏属性的条目不列，链接和普通文件夹一样；读属性用的是解析链接以后的文件夹", async (t) => {
  // 相当于中文 Windows 的用户目录：AppData、WPS Cloud Files 是带隐藏属性的普通文件夹，“「开始」菜单”是带隐藏属性的联接。
  const directory = await fixture(t, ["AppData", "WPS Cloud Files", "Documents", "target"]);
  await symlink(path.join(directory, "target"), path.join(directory, "「开始」菜单"));
  await writeFile(path.join(directory, "NTUSER.DAT"), "");
  await writeFile(path.join(directory, "笔记.pdf"), "");
  const asked: string[] = [];
  const hidden = (folder: string) => {
    asked.push(folder);
    return Promise.resolve(new Set(["appdata", "wps cloud files", "「开始」菜单", "ntuser.dat"]));
  };

  const listing = await browseDirectory(directory, { files: true, hidden });

  assert.deepEqual(listing.entries.map((entry) => entry.name), ["Documents", "target", "笔记.pdf"]);
  assert.deepEqual(asked, [directory]);
});

test("Windows 上按隐藏属性过滤：attrib +h 的文件夹和文件不列，名字里有中文和空格也一样", {
  skip: process.platform === "win32" ? false : "隐藏属性只在 Windows 上有",
}, async (t) => {
  const directory = await fixture(t, ["隐藏 文件夹", "看得见 的文件夹"]);
  await writeFile(path.join(directory, "隐藏 课件.pdf"), "");
  await writeFile(path.join(directory, "课件.pdf"), "");
  for (const name of ["隐藏 文件夹", "隐藏 课件.pdf"]) await promisify(execFile)("attrib", ["+h", path.join(directory, name)]);

  const listing = await browseDirectory(directory, { files: true });

  assert.deepEqual(listing.entries.map((entry) => entry.name), ["看得见 的文件夹", "课件.pdf"]);
  // 没有隐藏条目时 dir 以 1 退出，照常列出。
  assert.deepEqual((await browseDirectory(path.join(directory, "看得见 的文件夹"))).entries, []);
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
