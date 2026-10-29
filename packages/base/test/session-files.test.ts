import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { link, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { migrateSessionFiles } from "../src/agent/session-files.js";

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-session-files-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const id = randomUUID();
  const timestamp = "2026-10-29T01:02:03.456Z";
  const source = path.join(directory, `${randomUUID()}.jsonl`);
  const target = path.join(directory, `${timestamp.replace(/[:.]/gu, "-")}_${id}.jsonl`);
  const text = `${JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: "/old-space" })}\n原始条目保持原样\r\n`;
  await writeFile(source, text);
  return { directory, source, target, text };
}

test("旧文件改名取会话头里的编号和时间，文件内容逐字保留", async (t) => {
  const f = await fixture(t);
  await migrateSessionFiles(f.directory);
  assert.deepEqual(await readdir(f.directory), [path.basename(f.target)]);
  assert.equal(await readFile(f.target, "utf8"), f.text);
  await migrateSessionFiles(f.directory);
  assert.equal(await readFile(f.target, "utf8"), f.text);
});

test("上次改名在建链之后中断，再打开时补完", async (t) => {
  const f = await fixture(t);
  await link(f.source, f.target);
  await migrateSessionFiles(f.directory);
  assert.deepEqual(await readdir(f.directory), [path.basename(f.target)]);
  assert.equal(await readFile(f.target, "utf8"), f.text);
});

test("改名的目标已存在且内容不同时，两份文件都保留，不覆盖", async (t) => {
  const f = await fixture(t);
  const other = "已有文件，不能覆盖\r\n";
  await writeFile(f.target, other);
  await migrateSessionFiles(f.directory);
  assert.equal(await readFile(f.source, "utf8"), f.text);
  assert.equal(await readFile(f.target, "utf8"), other);
});

test("旧文件为空、头部损坏或含路径字符时原样保留，不妨碍打开空间", async (t) => {
  const f = await fixture(t);
  for (const text of ["", "{坏的 JSON\n", JSON.stringify({ type: "session", id: "../escape", timestamp: "2026-10-29T01:02:03.456Z" }), JSON.stringify({ type: "session", id: "valid", timestamp: "../escape" })]) {
    await writeFile(f.source, text);
    await migrateSessionFiles(f.directory);
    assert.deepEqual(await readdir(f.directory), [path.basename(f.source)]);
    assert.equal(await readFile(f.source, "utf8"), text);
  }
});
