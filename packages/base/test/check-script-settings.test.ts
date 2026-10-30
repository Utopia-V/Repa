import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { leaseSettings } from "../scripts/real-model/settings.js";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "repa-probe-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agent = path.join(dir, "agent");
  const recovery = path.join(dir, "recovery");
  await mkdir(agent);
  await mkdir(recovery);
  return { agent, recovery, file: path.join(agent, "settings.json") };
}

test("核实设置在结束后按原字节恢复，并保留原凭据文件", async (t) => {
  const f = await fixture(t);
  const original = "{\n  \"theme\": \"dark\"\n}\n";
  await writeFile(f.file, original);
  await writeFile(path.join(f.agent, "auth.json"), "仅供夹具比较");
  const lease = await leaseSettings(f.agent, f.recovery);
  assert.equal(JSON.parse(await readFile(f.file, "utf8")).transport, "sse");
  await lease.restore();
  assert.equal(await readFile(f.file, "utf8"), original);
  assert.equal(await readFile(path.join(f.agent, "auth.json"), "utf8"), "仅供夹具比较");
});

test("核实期间设置被编辑时不覆盖新内容，并留下恢复副本", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, "{}\n");
  const lease = await leaseSettings(f.agent, f.recovery);
  const changed = '{"theme":"new"}\n';
  await writeFile(f.file, changed);
  await assert.rejects(lease.restore(), /settings_changed_during_probe/);
  assert.equal(await readFile(f.file, "utf8"), changed);
  assert.equal(await readFile(lease.backup, "utf8"), "{}\n");
});

test("原先没有设置文件时恢复文件缺失状态", async (t) => {
  const f = await fixture(t);
  const lease = await leaseSettings(f.agent, f.recovery);
  await lease.restore();
  await assert.rejects(readFile(f.file), { code: "ENOENT" });
});
