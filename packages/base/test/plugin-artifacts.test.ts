import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadPlugin } from "../src/plugins/manifest.js";
import { openPluginHost } from "../src/plugins.js";
import { createSpace, openSpace } from "../src/space.js";
import { createPluginTestHost, ModelTestDriver } from "../src/testing.js";
import { RepaFault } from "../src/schema.js";

const manifest = { id: "fixture", version: "0.1.0", baseVersion: "^0.1.0", entry: "index.mjs" };
const fault = (code: string) => (error: unknown) => error instanceof RepaFault && error.code === code;

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-artifacts-")));
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
    { id: "Bad" }, { version: "bad" }, { baseVersion: "bad" }, { baseVersion: "" },
    { entry: "index.ts" }, { entry: "missing.mjs" }, { entry: "../outside.mjs" }, { entry: "/tmp/outside.mjs" }, { extra: true },
  ]) {
    await f.save({ ...manifest, ...change });
    await assert.rejects(loadPlugin(f.directory), fault("invalid_plugin_manifest"));
  }
  await f.save({ ...manifest, baseVersion: ">=99.0.0" });
  await assert.rejects(loadPlugin(f.directory), fault("incompatible_base_version"));
  await assert.rejects(readFile(f.sentinel), { code: "ENOENT" });
  await f.save(manifest);
  assert.equal((await loadPlugin(f.directory)).id, "fixture");
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

test("插件自行检查数据版本，失败只停对应插件，旧底座的 plugin-versions 不再读取", async (t) => {
  const f = await fixture(t);
  const space = await createSpace(path.join(f.root, "space"), { watch: false });
  const legacy = path.join(space.dataDir, "plugin-versions");
  await mkdir(legacy);
  await writeFile(path.join(legacy, "good.json"), "{损坏但不再读取");
  const host = await openPluginHost({
    space, models: new ModelTestDriver(), emit() {}, onError() {},
    plugins: [
      { id: "newer", async open() { throw new RepaFault("incompatible_data_version", "需要更新插件"); } },
      { id: "broken", async open() { throw new SyntaxError("数据损坏"); } },
      { id: "good", async open() { return { instructions: () => "可用插件" }; } },
    ],
  });
  f.cleanups.push(async () => { await host.close(); await space.close(); });
  assert.deepEqual(host.list().map((plugin) => plugin.id), ["good"]);
  assert.deepEqual(host.disabled().map(({ id, reason }) => [id, reason.code]), [["broken", "plugin_open_failed"], ["newer", "incompatible_data_version"]]);
  assert.deepEqual(host.instructions(), [{ id: "plugin:good", text: "可用插件" }]);
  assert.deepEqual(await readdir(legacy), ["good.json"]);
  assert.equal(await readFile(path.join(legacy, "good.json"), "utf8"), "{损坏但不再读取");
  await space.files.write("note.txt", "继续写文件");
  assert.ok((await space.history.list()).length > 0);
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

test("离线测试宿主打开失败插件后仍可关闭，错误保留供检查", async () => {
  const testing = await createPluginTestHost({ plugins: [{ id: "invalid", async open() { throw new RepaFault("invalid_data_version", "插件数据损坏"); } }] });
  assert.equal(testing.host.disabled()[0]?.reason.code, "invalid_data_version");
  assert.equal(testing.errors.length, 1);
  await testing.close();
});
