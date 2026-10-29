import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSpace, openPluginHost } from "@repa/base";
import { ModelTestDriver } from "@repa/base/testing";
import { createLearningPlugin } from "../src/plugin.js";
import { setup } from "./fixtures/learning-records.js";

test("学习插件为新数据写自己的版本，重开兼容可忽略字段并保持原标记", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-learning-format-")));
  const space = await createSpace(path.join(root, "space"), { watch: false });
  let host: Awaited<ReturnType<typeof openPluginHost>> | undefined;
  t.after(async () => {
    await host?.close();
    await space.close();
    await rm(root, { recursive: true, force: true });
  });
  const plugin = createLearningPlugin({ async connect(records, course) {
    if (!records.current()) await setup(records, course);
    return {};
  } });
  const open = () => openPluginHost({ space, plugins: [plugin], models: new ModelTestDriver(), emit() {}, onError() {} });
  host = await open();
  assert.deepEqual(host.disabled(), []);
  const format = path.join(space.dataDir, "plugins", "learning", "format.json");
  assert.deepEqual(JSON.parse(await readFile(format, "utf8")), { version: 1 });
  await host.close();
  const marker = '{"version":1,"futureOptional":"可忽略"}\n';
  await writeFile(format, marker);
  host = await open();
  assert.deepEqual(host.disabled(), []);
  assert.equal(await readFile(format, "utf8"), marker);
});

test("学习插件缺版本、坏版本、更新版本或记录损坏时停用，数据目录逐字节保留", async (t) => {
  for (const [marker, code] of [
    [undefined, "unknown_data_format"],
    ["{损坏", "invalid_data_version"],
    ['{"version":1}\n', "invalid_learning_log"],
    ['{"version":2}\n', "incompatible_data_version"],
  ] as const) {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-learning-format-")));
    const space = await createSpace(path.join(root, "space"), { watch: false });
    const directory = await space.pluginDataDir("learning");
    const records = "已有学习数据，保持原样。\r\n";
    await writeFile(path.join(directory, "records.jsonl"), records);
    if (marker !== undefined) await writeFile(path.join(directory, "format.json"), marker);
    const before = await readdir(directory);
    const host = await openPluginHost({ space, plugins: [createLearningPlugin()], models: new ModelTestDriver(), emit() {}, onError() {} });
    t.after(async () => {
      await host.close();
      await space.close();
      await rm(root, { recursive: true, force: true });
    });
    assert.equal(host.disabled()[0]?.reason.code, code);
    assert.deepEqual(host.list(), []);
    assert.deepEqual(await readdir(directory), before);
    assert.equal(await readFile(path.join(directory, "records.jsonl"), "utf8"), records);
    if (marker !== undefined) assert.equal(await readFile(path.join(directory, "format.json"), "utf8"), marker);
  }
});
