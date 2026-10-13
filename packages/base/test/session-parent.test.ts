import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { readParent, saveParent } from "../src/agent/parent.js";
import { RepaFault } from "../src/schema.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-session-parent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("父关联独立于对话保存，旧会话缺少关联文件时省略 parent", async t => {
  const directory = await fixture(t);
  assert.equal(await readParent(directory, "old-session"), undefined);
  const parent = { sessionId: "parent", runId: "run", callId: "call" };
  await saveParent(directory, "child", parent);
  assert.deepEqual(await readParent(directory, "child"), parent);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, "child.parent.json"), "utf8")), parent);
});

test("父关联损坏或读取失败时报告错误，不把子会话伪装成用户会话", async t => {
  const directory = await fixture(t);
  const file = path.join(directory, "child.parent.json");
  for (const text of ["{", JSON.stringify({ sessionId: "parent", runId: "run" }), JSON.stringify({ sessionId: "", runId: "run", callId: "call" })]) {
    await writeFile(file, text);
    await assert.rejects(readParent(directory, "child"), (error: unknown) => error instanceof RepaFault && error.code === "invalid_session_parent");
  }
  await rm(file);
  await mkdir(file);
  await assert.rejects(readParent(directory, "child"), { code: "EISDIR" });
});
