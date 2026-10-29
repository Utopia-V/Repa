import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { checkFormat } from "../src/space/format.js";
import { createSpace, openSpace } from "../src/space.js";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-format-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// 同时检查内容、目录项与修改时间，拒绝打开时连临时锁目录也不应留下写入痕迹。
async function snapshot(directory: string): Promise<unknown> {
  const info = await stat(directory);
  if (!info.isDirectory()) return { mtime: info.mtimeMs, data: await readFile(directory, "utf8") };
  const entries = await readdir(directory);
  return { mtime: info.mtimeMs, entries: await Promise.all(entries.sort().map(async (name) => [name, await snapshot(path.join(directory, name))])) };
}

test("全新目录建立版本 1，重开旧版本保留标记中的可选扩展字段", async (t) => {
  const root = await fixture(t);
  const space = await createSpace(root, { watch: false });
  try {
    await space.files.write("笔记.md", "旧版内容\r\n");
  } finally {
    await space.close();
  }
  const marker = path.join(root, ".repa", "format.json");
  assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), { version: 1 });
  const original = '{"version":1,"futureOptional":true}\n';
  await writeFile(marker, original);
  const reopened = await openSpace(root, { watch: false });
  try {
    assert.equal(await reopened.files.read("笔记.md"), "旧版内容\r\n");
    assert((await reopened.history.list()).length > 0);
    assert.equal(await readFile(marker, "utf8"), original);
  } finally {
    await reopened.close();
  }
});

test("未知、损坏或更新格式在创建锁和任何辅助文件前拒绝，原目录逐项保持不变", async (t) => {
  const directory = await fixture(t);
  const scenarios = [
    { marker: undefined, code: "unknown_data_format" },
    { marker: "{", code: "invalid_data_version" },
    { marker: '{"version":0}', code: "invalid_data_version" },
    { marker: '{"version":2}', code: "incompatible_data_version" },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const root = path.join(directory, String(index));
    await mkdir(path.join(root, ".repa"), { recursive: true });
    await writeFile(path.join(root, ".repa", "书稿.txt"), "不是 Repa 的数据");
    if (scenario.marker !== undefined) await writeFile(path.join(root, ".repa", "format.json"), scenario.marker);
    const before = await snapshot(root);
    await assert.rejects(openSpace(root, { watch: false }), { code: scenario.code });
    await assert.rejects(createSpace(root, { watch: false }), { code: scenario.code });
    assert.deepEqual(await snapshot(root), before);
  }
});

test("共享格式检查只读接受旧版本，版本号不必相等", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "format.json");
  await writeFile(file, '{"version":1,"futureOptional":true}');
  const before = await snapshot(root);
  assert.equal(await checkFormat(file, 2), 1);
  assert.deepEqual(await snapshot(root), before);
  await assert.rejects(checkFormat(path.join(root, "missing.json"), 2), { code: "unknown_data_format" });
  assert.deepEqual(await snapshot(root), before);
});
