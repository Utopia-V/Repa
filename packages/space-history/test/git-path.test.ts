import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { checkoutLatest, openHistory } from "../src/index.js";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-history-git-path-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const space = path.join(root, "space");
  await mkdir(space);
  return { root, space };
}

/**
 * 系统 Git 的主程序，与安装包带的布局相同：Mac、Linux 上在 exec-path 目录里；Windows 上是 Git for Windows 的
 * mingw64/bin/git.exe，旁边是它依赖的 DLL，与 dugite-native 的 ucrt64/bin 一样。Windows runner 上它在
 * C:\Program Files 下，路径里带空格。
 */
function systemGit(): string {
  const execPath = path.resolve(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim());
  return process.platform === "win32" ? path.join(execPath, "..", "..", "bin", "git.exe") : path.join(execPath, "git");
}

/** 保存两次、强制维护一次，再把历史复制到新目录写出空间文件：覆盖 fast-import、unpack-objects、gc 与 checkoutLatest。 */
async function saveMaintainCheckout(root: string, space: string, gitPath: string): Promise<void> {
  await writeFile(path.join(space, "笔记 一.md"), "第一版\n");
  const history = await openHistory(space, { exclusive: true, gitPath });
  await history.snapshot();
  await writeFile(path.join(space, "笔记 一.md"), "第二版\n");
  await history.snapshot();
  assert.equal(await history.maintain({ force: true }), true);
  const copy = path.join(root, "copy");
  await mkdir(path.join(copy, ".repa"), { recursive: true });
  await cp(path.join(space, ".repa", "history.git"), path.join(copy, ".repa", "history.git"), { recursive: true });
  await checkoutLatest(copy, { gitPath });
  assert.equal(await readFile(path.join(copy, "笔记 一.md"), "utf8"), "第二版\n");
}

test("gitPath 不是绝对路径时拒绝：Windows 上按名称启动会先在空间里找同名程序", async (t) => {
  const f = await fixture(t);
  await assert.rejects(openHistory(f.space, { gitPath: "git" }), /绝对路径/);
  await assert.rejects(checkoutLatest(f.space, { gitPath: path.join("bin", "git") }), /绝对路径/);
});

test("给系统 Git 主程序的绝对路径时，保存、维护和写出都正常", async (t) => {
  const f = await fixture(t);
  await saveMaintainCheckout(f.root, f.space, systemGit());
});

// 安装包只带 git 主程序，子命令目录要由 --exec-path 指回它所在的目录。这里在名字带空格和中文的目录放一个名为 git 的脚本，
// 记下每次调用的参数再转给系统的 git；Git 内部起的子进程也按 exec-path 找到这个脚本，所以记录里能看出它们走了这条路。
// Windows 上 spawn 不能直接运行脚本，只在其他平台运行；Windows 由上一个测试和安装包的核对覆盖。
test("给了 gitPath 时 Git 内部的子进程也按 --exec-path 找回它，目录名带空格和中文也可以", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const bin = path.join(f.root, "Git 程序");
  const log = path.join(f.root, "git.log");
  await mkdir(bin);
  const wrapper = path.join(bin, "git");
  await writeFile(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${systemGit()}' "$@"\n`);
  await chmod(wrapper, 0o755);

  await saveMaintainCheckout(f.root, f.space, wrapper);

  const calls = (await readFile(log, "utf8")).trim().split("\n");
  // 历史直接发起的调用都带 --git-dir，也都带着 --exec-path；Git 自己起的子进程（保存时的 unpack-objects、维护时的 repack）不带，但也经过了这个脚本。
  const direct = calls.filter((call) => call.includes("--git-dir="));
  assert.ok(direct.length > 0 && direct.every((call) => call.startsWith(`--exec-path=${bin} `)), calls.join("\n"));
  assert.ok(calls.some((call) => call.startsWith("unpack-objects")), calls.join("\n"));
  assert.ok(calls.some((call) => call.startsWith("repack")), calls.join("\n"));
});
