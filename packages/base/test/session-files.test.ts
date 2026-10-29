import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { migrateSessionFiles } from "../src/agent/session-files.js";
import { RepaFault } from "../src/schema.js";

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

test("改名的目标已存在时保留两份文件，报告两条路径", async (t) => {
  const f = await fixture(t);
  const other = "已有文件，不能覆盖\r\n";
  await writeFile(f.target, other);
  await assert.rejects(migrateSessionFiles(f.directory), (error: unknown) => {
    assert(error instanceof RepaFault);
    assert.equal(error.code, "session_migration_conflict");
    assert.deepEqual(error.details, { source: f.source, target: f.target });
    return true;
  });
  assert.equal(await readFile(f.source, "utf8"), f.text);
  assert.equal(await readFile(f.target, "utf8"), other);
});

test("旧文件为空、头部损坏或含路径字符时报告错误并保留原文件", async (t) => {
  const f = await fixture(t);
  for (const text of ["", "{坏的 JSON\n", JSON.stringify({ type: "session", id: "../escape", timestamp: "2026-10-29T01:02:03.456Z" }), JSON.stringify({ type: "session", id: "valid", timestamp: "../escape" })]) {
    await writeFile(f.source, text);
    await assert.rejects(migrateSessionFiles(f.directory), (error: unknown) => error instanceof RepaFault && error.code === "invalid_session_header");
    assert.deepEqual(await readdir(f.directory), [path.basename(f.source)]);
    assert.equal(await readFile(f.source, "utf8"), text);
  }
});
