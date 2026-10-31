import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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

test("gitPath 不是绝对路径时拒绝：Windows 上按名称启动会先在空间里找同名程序", async (t) => {
  const f = await fixture(t);
  await assert.rejects(openHistory(f.space, { gitPath: "git" }), /绝对路径/);
  await assert.rejects(checkoutLatest(f.space, { gitPath: path.join("bin", "git") }), /绝对路径/);
});

// 安装包只带 git 主程序，子命令目录要由 --exec-path 指回它所在的目录。这里在临时目录放一个名为 git 的脚本，
// 记下每次调用的参数再转给系统的 git；Git 内部起的子进程也按 exec-path 找到这个脚本，所以记录里能看出它们走了这条路。
// Windows 上 spawn 不能直接运行脚本，只在其他平台运行。
test("给了 gitPath 时用它保存、维护和写出，Git 内部的子进程也按 --exec-path 找回它", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const real = path.join(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "git");
  const bin = path.join(f.root, "bin");
  const log = path.join(f.root, "git.log");
  await mkdir(bin);
  const wrapper = path.join(bin, "git");
  await writeFile(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`);
  await chmod(wrapper, 0o755);

  await writeFile(path.join(f.space, "note.md"), "第一版\n");
  const history = await openHistory(f.space, { exclusive: true, gitPath: wrapper });
  await history.snapshot();
  await writeFile(path.join(f.space, "note.md"), "第二版\n");
  await history.snapshot();
  assert.equal(await history.maintain({ force: true }), true);
  const copy = path.join(f.root, "copy");
  await mkdir(path.join(copy, ".repa"), { recursive: true });
  execFileSync("cp", ["-R", path.join(f.space, ".repa", "history.git"), path.join(copy, ".repa", "history.git")]);
  await checkoutLatest(copy, { gitPath: wrapper });
  assert.equal(await readFile(path.join(copy, "note.md"), "utf8"), "第二版\n");

  const calls = (await readFile(log, "utf8")).trim().split("\n");
  // 我们直接发起的调用都带着 --exec-path；Git 自己起的子进程（保存时的 unpack-objects、维护时的 repack）不带，但也经过了这个脚本。
  const direct = calls.filter((call) => call.startsWith("--exec-path="));
  assert.ok(direct.length > 0);
  assert.ok(direct.every((call) => call.startsWith(`--exec-path=${bin} `)));
  assert.ok(calls.some((call) => call.startsWith("unpack-objects")), calls.join("\n"));
  assert.ok(calls.some((call) => call.startsWith("repack")), calls.join("\n"));
});
