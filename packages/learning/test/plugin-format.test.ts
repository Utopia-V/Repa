import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
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

test("学习插件坏版本、更新版本或记录损坏时停用，已有数据逐字节保留", async (t) => {
  for (const [marker, code] of [
    [undefined, "invalid_learning_log"],
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
    assert.deepEqual((await readdir(directory)).sort(), marker === undefined ? [...before, "format.json"].sort() : before.sort());
    assert.equal(await readFile(path.join(directory, "records.jsonl"), "utf8"), records);
    assert.equal(await readFile(path.join(directory, "format.json"), "utf8"), marker ?? '{"version":1}\n');
  }
});

test("旧学习数据缺少插件标记时补版本 1，恢复状态且不改写已有记录", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-learning-legacy-format-")));
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
  const state = await host.call("learning", "state.get", {});
  await host.close();
  const directory = path.join(space.dataDir, "plugins", "learning");
  await rm(path.join(directory, "format.json"));
  const records = await readFile(path.join(directory, "records.jsonl"));
  const legacy = path.join(space.dataDir, "plugin-versions");
  await mkdir(legacy);
  const oldMarker = '{"version":1}\n';
  await writeFile(path.join(legacy, "learning.json"), oldMarker);

  host = await open();
  assert.deepEqual(host.disabled(), []);
  const restored = await host.call("learning", "state.get", {});
  assert.ok(state !== null && typeof state === "object");
  assert.ok(restored !== null && typeof restored === "object");
  // serverNow 是查询时刻，不属于盘上恢复的学习状态。
  const withoutNow = (value: object) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "serverNow"));
  assert.deepEqual(withoutNow(restored), withoutNow(state));
  assert.deepEqual(await readFile(path.join(directory, "records.jsonl")), records);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, "format.json"), "utf8")), { version: 1 });
  assert.equal(await readFile(path.join(legacy, "learning.json"), "utf8"), oldMarker);
});
