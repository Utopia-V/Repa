import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";

import { Git, GitError, nul } from "../src/git.js";

async function fixture(t: TestContext) {
  const space = await mkdtemp(join(tmpdir(), "repa-history-git-"));
  const gitDir = join(space, ".repa", "history.git");
  await mkdir(join(space, ".repa"));
  t.after(async () => {
    await rm(space, { recursive: true, force: true });
  });
  const git = new Git(space, gitDir);
  await git.run(["init", "--bare", "--object-format=sha1", "--initial-branch=history", gitDir]);
  return { space, gitDir, git };
}

test("Git 可执行文件缺失时保留启动错误，调用立即结束", { timeout: 5_000 }, async (t) => {
  const f = await fixture(t);
  const git = new Git(f.space, f.gitDir, join(f.space, "missing-git"));
  await assert.rejects(git.run(["version"]), (error: unknown) => {
    assert.ok(error instanceof GitError);
    assert.equal(error.exitCode, null);
    assert.ok(error.cause instanceof Error);
    assert.ok("code" in error.cause);
    assert.equal(error.cause.code, "ENOENT");
    return true;
  });
});

test("忽略检查区分空结果 exit1 与命中路径的 NUL 输出", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.space, ".gitignore"), "*.log\n");
  await assert.rejects(f.git.run(["check-ignore", "--no-index", "-z", "--stdin"], "visible.txt\0"), (error: unknown) => {
    assert.ok(error instanceof GitError);
    assert.equal(error.exitCode, 1);
    return true;
  });
  const result = await f.git.run(["check-ignore", "--no-index", "-z", "--stdin"], "visible.txt\0error.log\0");
  assert.deepEqual(result, Buffer.from("error.log\0"));
  assert.deepEqual(nul(result), ["error.log"]);
  assert.deepEqual(nul(Buffer.alloc(0)), []);
});

test("NUL 路径解析拒绝非法 UTF8，并保留有效路径中的 BOM 与换行", () => {
  assert.throws(() => nul(Buffer.from([0xff, 0])), TypeError);
  assert.deepEqual(nul(Buffer.from("\uFEFF中文\n文件\0-dash\0")), ["\uFEFF中文\n文件", "-dash"]);
});

test("fast-import 流式输入保留跨块原始字节并完整排空输出", { timeout: 5_000 }, async (t) => {
  const f = await fixture(t);
  const data = Buffer.alloc(2 * 1024 * 1024, 0x7f);
  data.set(Buffer.from("\0\r\n"));
  async function* input() {
    yield `blob\nmark :1\ndata ${data.length}\n`;
    for (let offset = 0; offset < data.length; offset += 4096) {
      yield data.subarray(offset, offset + 4096);
    }
    yield "\nget-mark :1\ndone\n";
  }
  const oid = (await f.git.run(["fast-import", "--quiet", "--done"], input())).toString().trim();
  assert.match(oid, /^[0-9a-f]{40}$/);
  assert.deepEqual(await f.git.run(["cat-file", "blob", oid]), data);
});

test("继承的 Git 环境与默认全局忽略不改变 shadow 索引或空间候选", async (t) => {
  const f = await fixture(t);
  const globalDirectory = join(f.space, ".repa", "global", "git");
  await mkdir(globalDirectory, { recursive: true });
  await writeFile(join(globalDirectory, "ignore"), "visible.txt\n");
  const foreignIndex = join(f.space, ".repa", "foreign-index");
  await writeFile(foreignIndex, "existing index bytes");
  const overrides = {
    GIT_INDEX_FILE: foreignIndex,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.excludesFile",
    GIT_CONFIG_VALUE_0: join(globalDirectory, "ignore"),
    XDG_CONFIG_HOME: join(f.space, ".repa", "global"),
  };
  for (const [key, value] of Object.entries(overrides)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    });
  }
  await writeFile(join(f.space, "visible.txt"), "visible bytes");
  await f.git.run(["read-tree", "--empty"]);
  assert.deepEqual(nul(await f.git.run([
    "ls-files", "--others", "--exclude-standard", "--exclude=.repa", "-z",
  ])), ["visible.txt"]);
  assert.equal(await readFile(foreignIndex, "utf8"), "existing index bytes");
});

test("输入生成器失败后终止并等待子进程，保留生成器原因", { timeout: 5_000 }, async (t) => {
  const f = await fixture(t);
  const pidFile = join(f.space, "child.pid");
  const binary = join(f.space, "input-reader");
  await writeFile(binary, [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    'process.stdin.on("data", () => {});',
    'setInterval(() => {}, 1000);',
    "",
  ].join("\n"));
  await chmod(binary, 0o755);
  const failure = new Error("输入读取失败");
  let finalized = false;
  let pid: number | undefined;
  async function* input() {
    try {
      yield "first chunk";
      const deadline = Date.now() + 2_000;
      while (pid === undefined) {
        try {
          pid = Number(await readFile(pidFile, "utf8"));
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
          if (Date.now() >= deadline) throw new Error("子进程没有启动");
          await setTimeout(10);
        }
      }
      throw failure;
    } finally {
      finalized = true;
    }
  }
  await assert.rejects(new Git(f.space, f.gitDir, binary).run(["read"], input()), (error: unknown) => {
    assert.ok(error instanceof GitError);
    assert.equal(error.cause, failure);
    return true;
  });
  assert.equal(finalized, true);
  assert.ok(pid);
  const terminatedPid = pid;
  assert.throws(() => process.kill(terminatedPid, 0), { code: "ESRCH" });
});

test("Git 提前拒绝命令时关闭持续输入并传播退出码", { timeout: 5_000 }, async (t) => {
  const f = await fixture(t);
  let finalized = false;
  async function* input() {
    try {
      while (true) yield Buffer.alloc(64 * 1024);
    } finally {
      finalized = true;
    }
  }
  await assert.rejects(f.git.run(["not-a-git-command"], input()), (error: unknown) => {
    assert.ok(error instanceof GitError);
    assert.equal(error.exitCode, 1);
    return true;
  });
  assert.equal(finalized, true);
});
