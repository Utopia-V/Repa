import assert from "node:assert/strict";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { checkoutLatest, openHistory } from "../src/index.js";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-history-checkout-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const space = path.join(root, "space");
  await mkdir(space);
  const write = async (relative: string, value: string | Uint8Array) => {
    await mkdir(path.dirname(path.join(space, relative)), { recursive: true });
    await writeFile(path.join(space, relative), value);
  };
  return { root, space, write };
}

// 空间文件的原始字节，不含 .repa/；符号链接记为链接目标。
async function spaceFiles(directory: string, relative = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const name = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (name === ".repa") continue;
    const absolute = path.join(directory, name);
    if (entry.isDirectory()) Object.assign(result, await spaceFiles(directory, name));
    else if (entry.isSymbolicLink()) result[name] = `-> ${await readlink(absolute)}`;
    else result[name] = (await readFile(absolute)).toString("base64");
  }
  return result;
}

const links = process.platform !== "win32";

test("按历史的最近一次修订写出空间文件：字节、可执行位与符号链接原样，忽略项与大文件不在其中，同名路径已存在时不覆盖", async (t) => {
  const f = await fixture(t);
  await f.write("notes/中文.md", "第一行\r\n第二行，全角标点\n");
  await f.write("data/blob.bin", Buffer.from([0, 255, 13, 10, 128]));
  await f.write("run.sh", "#!/bin/sh\necho hi\n");
  if (process.platform !== "win32") await chmod(path.join(f.space, "run.sh"), 0o755);
  if (links) await symlink("notes/中文.md", path.join(f.space, "link"));
  await f.write(".gitignore", "ignored.txt\n");
  await f.write("ignored.txt", "忽略项\n");
  await f.write("large.bin", Buffer.alloc(2048, 1));
  const history = await openHistory(f.space, { maxFileBytes: 1024 });
  await f.write("notes/中文.md", "改过的内容\r\n");
  assert.equal((await history.snapshot()).committed, true);
  const expected = await spaceFiles(f.space);
  delete expected["ignored.txt"];
  delete expected["large.bin"];

  // 只有 .repa/ 的新文件夹，相当于从备份恢复时的临时文件夹。
  const copy = path.join(f.root, "copy");
  await mkdir(copy);
  await cp(path.join(f.space, ".repa"), path.join(copy, ".repa"), { recursive: true });
  assert.deepEqual(await checkoutLatest(copy), { files: Object.keys(expected).length });
  assert.deepEqual(await spaceFiles(copy), expected);
  if (process.platform !== "win32") {
    assert.equal((await stat(path.join(copy, "run.sh"))).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(copy, "notes/中文.md"))).mode & 0o777, 0o600);
  }
  if (links) assert.ok((await lstat(path.join(copy, "link"))).isSymbolicLink());

  // 写出的文件与历史一致，打开历史不产生新的提交。
  const reopened = await openHistory(copy, { maxFileBytes: 1024 });
  assert.equal((await reopened.list(1))[0]?.id, (await history.list(1))[0]?.id);

  await writeFile(path.join(copy, "notes/中文.md"), "恢复后又改的\n");
  await assert.rejects(checkoutLatest(copy), (error: unknown) => error instanceof Error && "code" in error && error.code === "EEXIST");
  assert.equal(await readFile(path.join(copy, "notes/中文.md"), "utf8"), "恢复后又改的\n");
});

test("在历史队列中复制历史库期间，排在后面的写入等复制结束才执行", async (t) => {
  const f = await fixture(t);
  const history = await openHistory(f.space);
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const order: string[] = [];
  const holding = history.withRepository(async (gitDir) => {
    enter();
    await released;
    order.push("copied");
    return readdir(gitDir);
  });
  await entered;
  const writing = history.recordPaths({ kind: "plugin", pluginId: "notes" }, ["note.md"], async () => {
    order.push("written");
    await f.write("note.md", "排队的写入\n");
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(order, []);
  release();
  assert.ok((await holding).includes("HEAD"));
  assert.equal((await writing).snapshot.committed, true);
  assert.deepEqual(order, ["copied", "written"]);
});
