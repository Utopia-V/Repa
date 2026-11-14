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
  await mkdir(path.join(directory, "page"));
  await writeFile(path.join(directory, "page", "index.html"), "<!doctype html>\n");
  await writeFile(path.join(directory, "page", "index.mjs"), "export default {id:'fixture', async open(){return {}}};");
  await writeFile(path.join(directory, "index.html"), "<!doctype html>\n");
  const save = (value: unknown) => writeFile(path.join(directory, "repa-plugin.json"), JSON.stringify(value));
  return { root, directory, sentinel, save, cleanups };
}

test("清单及底座版本错误在执行顶层代码前拒绝，合法构建才执行模块", async (t) => {
  const f = await fixture(t);
  for (const change of [
    { id: "Bad" }, { version: "bad" }, { baseVersion: "bad" }, { baseVersion: "" },
    { entry: "index.cjs" }, { entry: "missing.mjs" }, { entry: "missing.ts" }, { entry: "../outside.mjs" }, { entry: "/tmp/outside.mjs" },
    { entry: ".\\index.mjs" }, { entry: "C:index.mjs" }, { extra: true }, { jobs: [] }, { title: "" },
    { pages: [{ id: "main", title: "主页", entry: "../page.html" }] },
    { pages: [{ id: "main", title: "主页", entry: "page\\index.html" }] },
    { pages: [{ id: "main", title: "主页", entry: "index.mjs" }] },
    { pages: [{ id: "main", title: "主页", entry: "missing.html" }] },
    { pages: [{ id: "main", title: "主页", entry: "page/index.html", place: "sidebar" }] },
    { pages: [{ id: "main", title: "主页", entry: "page/index.html" }, { id: "main", title: "又一页", entry: "page/index.html" }] },
    // 页面目录里只放页面的文件：入口文档不能在根目录，页面目录里不能有入口模块。
    { pages: [{ id: "main", title: "主页", entry: "index.html" }] },
    { entry: "page/index.mjs", pages: [{ id: "main", title: "主页", entry: "page/index.html" }] },
  ]) {
    await f.save({ ...manifest, ...change });
    await assert.rejects(loadPlugin(f.directory), fault("invalid_plugin_manifest"));
  }
  // 写清单的多半是模型，它只读得到 message：说明要指出哪个字段出了什么问题。
  await f.save({ ...manifest, id: "Bad", extra: true });
  await assert.rejects(loadPlugin(f.directory), /清单多了 extra[^]*\/id：/u);
  await f.save({ id: "fixture", entry: "index.mjs" });
  await assert.rejects(loadPlugin(f.directory), /清单缺少 version。字段为 id、version、entry，可选 baseVersion/u);
  await f.save({ ...manifest, version: "1" });
  await assert.rejects(loadPlugin(f.directory), /version 要是 SemVer 版本号，例如 0\.1\.0，现在是 "1"/u);
  // 在不区分大小写的文件系统上 Index.mjs 也能打开，但同一份清单换到 Linux 就找不到文件，所以各系统一律拒绝。
  await f.save({ ...manifest, entry: "Index.mjs" });
  await assert.rejects(loadPlugin(f.directory), /入口模块 Index\.mjs 不存在；文件名的大小写要与文件夹里的一致/u);
  await f.save({ ...manifest, baseVersion: ">=99.0.0" });
  await assert.rejects(loadPlugin(f.directory), fault("incompatible_base_version"));
  await assert.rejects(loadPlugin(f.directory), /插件要求底座版本 >=99\.0\.0，当前底座是 \d/u);
  await assert.rejects(readFile(f.sentinel), { code: "ENOENT" });
  const declared = { ...manifest, entry: "./index.mjs", title: "测试插件", pages: [{ id: "main", title: "主页", entry: "page/index.html" }] };
  await f.save(declared);
  const loaded = await loadPlugin(f.directory);
  assert.equal(loaded.plugin.id, "fixture");
  assert.deepEqual(loaded.manifest, declared);
  assert.equal(loaded.root, f.directory);
  assert.equal(await readFile(f.sentinel, "utf8"), "executed");
});

test("清单不写 baseVersion 时不检查底座版本，照常加载", async (t) => {
  const f = await fixture(t);
  const { baseVersion: _omitted, ...unversioned } = manifest;
  await f.save(unversioned);
  const loaded = await loadPlugin(f.directory);
  assert.deepEqual(loaded.manifest, unversioned);
  assert.equal(await readFile(f.sentinel, "utf8"), "executed");
});

test("损坏清单、指向非模块文件或目录外的链接及不一致的导出 id 均被拒绝", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "repa-plugin.json"), "{");
  await assert.rejects(loadPlugin(f.directory), fault("invalid_plugin_manifest"));
  await assert.rejects(loadPlugin(f.directory), /无法读取插件清单 repa-plugin\.json：.*JSON/u);
  await assert.rejects(loadPlugin(path.join(f.directory, "index.mjs")), fault("invalid_plugin_manifest"));
  const outside = path.join(f.root, "outside.mjs");
  await writeFile(outside, "throw new Error('不应执行');");
  await symlink(outside, path.join(f.directory, "link.mjs"));
  await f.save({ ...manifest, entry: "link.mjs" });
  await assert.rejects(loadPlugin(f.directory), fault("invalid_plugin_manifest"));
  await writeFile(path.join(f.directory, "notes.txt"), "throw new Error('不应执行');");
  await symlink("notes.txt", path.join(f.directory, "notes.js"));
  await f.save({ ...manifest, entry: "notes.js" });
  await assert.rejects(loadPlugin(f.directory), fault("invalid_plugin_manifest"));
  await f.save({ ...manifest, id: "different" });
  await assert.rejects(loadPlugin(f.directory), fault("invalid_plugin_export"));
  await assert.rejects(loadPlugin(f.directory), /插件定义的 id 是 "fixture"，清单里是 "different"/u);
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
