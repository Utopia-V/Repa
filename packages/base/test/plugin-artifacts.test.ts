import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadPlugin } from "../src/plugins/manifest.js";
import { openPluginHost } from "../src/plugins.js";
import { createSpace, openSpace } from "../src/space.js";
import { createPluginTestHost, ModelTestDriver } from "../src/testing.js";
import { RepaFault } from "../src/schema.js";

const manifest = { id: "fixture", version: "0.1.0", baseVersion: "^0.1.0", dataVersion: 1, entry: "index.mjs" };
const fault = (code: string) => (error: unknown) => error instanceof RepaFault && error.code === code;

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-artifacts-"));
  const cleanups: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await rm(root, { recursive: true, force: true });
  });
  const sentinel = path.join(root, "executed");
  const directory = path.join(root, "build");
  await mkdir(directory);
  await writeFile(path.join(directory, "index.mjs"), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'executed'); export default {id:'fixture', async open(){return {}}};`);
  const save = (value: unknown) => writeFile(path.join(directory, "repa-plugin.json"), JSON.stringify(value));
  return { root, directory, sentinel, save, cleanups };
}

test("清单及底座版本错误在执行顶层代码前拒绝，合法构建才执行模块", async (t) => {
  const f = await fixture(t);
  for (const change of [
    { id: "Bad" }, { version: "bad" }, { baseVersion: "bad" }, { dataVersion: 0 }, { dataVersion: 1e20 }, { baseVersion: "" },
    { entry: "index.ts" }, { entry: "missing.mjs" }, { entry: "../outside.mjs" }, { entry: "/tmp/outside.mjs" }, { extra: true },
  ]) {
    await f.save({ ...manifest, ...change });
    await assert.rejects(loadPlugin(f.directory), fault("invalid_plugin_manifest"));
  }
  await f.save({ ...manifest, baseVersion: ">=99.0.0" });
  await assert.rejects(loadPlugin(f.directory), fault("incompatible_base_version"));
  await assert.rejects(readFile(f.sentinel), { code: "ENOENT" });
  await f.save(manifest);
  assert.equal((await loadPlugin(f.directory)).dataVersion, 1);
  assert.equal(await readFile(f.sentinel, "utf8"), "executed");
});

test("损坏清单、源码文件、目录外链接及不一致的导出 id 均被拒绝", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "repa-plugin.json"), "{");
  await assert.rejects(loadPlugin(f.directory), fault("invalid_plugin_manifest"));
  await assert.rejects(loadPlugin(path.join(f.directory, "index.mjs")), fault("invalid_plugin_manifest"));
  const outside = path.join(f.root, "outside.mjs");
  await writeFile(outside, "throw new Error('不应执行');");
  await symlink(outside, path.join(f.directory, "link.mjs"));
  await f.save({ ...manifest, entry: "link.mjs" });
  await assert.rejects(loadPlugin(f.directory), fault("invalid_plugin_manifest"));
  await writeFile(path.join(f.directory, "source.ts"), "throw new Error('不应执行源码');");
  await symlink("source.ts", path.join(f.directory, "source.js"));
  await f.save({ ...manifest, entry: "source.js" });
  await assert.rejects(loadPlugin(f.directory), fault("invalid_plugin_manifest"));
  await f.save({ ...manifest, id: "different" });
  await assert.rejects(loadPlugin(f.directory), fault("invalid_plugin_export"));
});

test("无版本空间补标记并保留文件，插件关闭重开能读取原数据，异版拒绝且原字节不变", async (t) => {
  const f = await fixture(t);
  const root = path.join(f.root, "space");
  await mkdir(path.join(root, ".repa", "plugins", "fixture"), { recursive: true });
  const original = "旧数据，中文。\r\n";
  const file = path.join(root, ".repa", "plugins", "fixture", "answers.txt");
  await writeFile(file, original);
  await writeFile(path.join(root, "note.txt"), original);
  let space = await openSpace(root, { watch: false });
  let opened = 0;
  const reads: string[] = [];
  const plugin = {
    id: "fixture", dataVersion: 1,
    async open() {
      opened++;
      reads.push(await readFile(file, "utf8"));
      return {};
    },
  };
  const open = (plugins = [plugin]) => openPluginHost({ space, plugins, models: new ModelTestDriver(), emit() {}, onError() {} });
  let host: Awaited<ReturnType<typeof open>> | undefined;
  f.cleanups.push(async () => {
    await host?.close();
    await space.close();
  });
  host = await open();
  await host.close();
  await space.close();
  space = await openSpace(root, { watch: false });
  host = await open();
  assert.deepEqual(reads, [original, original]);
  await host.close();
  const marker = path.join(root, ".repa", "plugin-versions", "fixture.json");
  const before = await readFile(marker);
  await assert.rejects(open([{ ...plugin, id: "earlier" }, { ...plugin, dataVersion: 2 }]), fault("incompatible_data_version"));
  await writeFile(marker, "{");
  await assert.rejects(open(), fault("invalid_data_version"));
  assert.equal(await readFile(marker, "utf8"), "{");
  await writeFile(marker, before);
  assert.equal(opened, 2);
  assert.deepEqual(await readFile(marker), before);
  assert.equal(await readFile(file, "utf8"), original);
  assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), original);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, ".repa", "format.json"), "utf8")), { version: 1 });
});

test("空间版本损坏或不兼容时拒绝打开并保留原标记，失败后释放锁", async (t) => {
  const f = await fixture(t);
  const root = path.join(f.root, "space");
  const space = await createSpace(root, { watch: false });
  await space.close();
  const file = path.join(root, ".repa", "format.json");
  for (const [text, code] of [
    ["{", "invalid_data_version"],
    [JSON.stringify({ version: 0 }), "invalid_data_version"],
    [JSON.stringify({ version: 2 }), "incompatible_data_version"],
  ] as const) {
    await writeFile(file, text);
    await assert.rejects(openSpace(root, { watch: false }), fault(code));
    assert.equal(await readFile(file, "utf8"), text);
  }
  await writeFile(file, JSON.stringify({ version: 1 }));
  await (await openSpace(root, { watch: false })).close();
});

test("离线测试宿主复用插件数据版本检查", async () => {
  await assert.rejects(createPluginTestHost({ plugins: [{ id: "invalid", dataVersion: 0, async open() { assert.fail("不能打开"); } }] }), fault("invalid_data_version"));
});
