import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

import { copyStats } from "../src/backup/copy.js";
import { createAgentRuntimeForTest } from "../src/agent/runtime.js";
import { RepaClient, RpcError } from "../src/client.js";
import {
  enablementFile, readEnablement, withLoaded, withUnloaded, writeEnablement, type PluginEnablement,
} from "../src/plugins/enablement.js";
import { readPluginFolder } from "../src/plugins/manifest.js";
import { spacePlugins } from "../src/plugins/space-plugins.js";
import {
  checkSnapshot, cleanSnapshots, clearStaging, folderDigest, folderHashes, publishSnapshot, removeSnapshot, snapshotDirectory, snapshotGroup, SNAPSHOT_LIMITS, stageFolder,
} from "../src/plugins/snapshots.js";
import { startServer } from "../src/protocol/server.js";
import { RepaFault } from "../src/schema.js";
import { createSpace } from "../src/space.js";
import { startRepaProcess } from "../dist/process.js";

const AT = "2026-11-13T08:00:00.000Z";
const LATER = "2026-11-14T08:00:00.000Z";

// 一个只用 JavaScript、不导入任何东西的插件：本进程在 tsx 下运行，导入它不经过 tsx 的 .ts 处理。
function helloPlugin(id: string, greeting: string): Record<string, string> {
  return {
    "repa-plugin.json": JSON.stringify({ id, version: "0.1.0", baseVersion: "^0.1.0", entry: "index.js" }),
    "index.js": `export default { id: ${JSON.stringify(id)}, async open() { return { methods: { hello: { async invoke() { return ${JSON.stringify(greeting)}; } } } }; } };\n`,
  };
}

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-plugin-snapshots-")));
  const closers: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    await rm(directory, { recursive: true, force: true });
  });
  const home = path.join(directory, "home");
  const root = path.join(directory, "space");
  const dataDir = path.join(root, ".repa");
  await mkdir(dataDir, { recursive: true });
  /** 在 directory 下写一个插件文件夹，files 的键是以 / 分隔的相对路径。 */
  const folder = async (name: string, files: Record<string, string>) => {
    const target = path.join(directory, name);
    for (const [relative, text] of Object.entries(files)) {
      const file = path.join(target, ...relative.split("/"));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
    }
    return target;
  };
  /** 测试里代替批准：暂存、发布快照，并把启用记录改为运行这个版本。 */
  const approve = async (id: string, source: string, at = AT) => {
    const staged = await stageFolder(home, root, source);
    await publishSnapshot(home, root, id, staged);
    await writeEnablement(dataDir, withLoaded(await readEnablement(dataDir), id, staged.digest, at));
    return staged.digest;
  };
  return { directory, home, root, dataDir, folder, approve, closers };
}

test("摘要按规定的算法计算：路径按 UTF-8 字节序排列，与遍历次序无关；空目录不计，内容或路径一变摘要就变", async (t) => {
  const f = await fixture(t);
  // 逐层遍历时 a/ 下的文件排在 a-c 之前，UTF-16 下 😀 排在 ！ 之前；按 UTF-8 字节序两者都相反。
  const files: Record<string, string> = { "a/x.js": "x", "a-c": "c", "！": "全角", "😀": "表情", ".hidden": "点开头" };
  const source = await f.folder("plugin", files);
  await mkdir(path.join(source, "empty"));
  const order = [".hidden", "a-c", "a/x.js", "！", "😀"];
  const expected = createHash("sha256").update("repa-plugin-folder 1\n");
  for (const relative of order) {
    const content = Buffer.from(files[relative] ?? "", "utf8");
    expected.update(`${relative}\0${content.length}\0${createHash("sha256").update(content).digest("hex")}\n`, "utf8");
  }
  const digest = await folderDigest(source);
  assert.equal(digest, expected.digest("hex"));
  // 逐文件的摘要与摘要输入里的一致，批准时据此列出改动了哪些文件。
  const hashes = await folderHashes(source);
  assert.deepEqual([...hashes.keys()], order);
  assert.equal(hashes.get("a-c"), createHash("sha256").update("c").digest("hex"));
  // 文件按另一种先后写出，摘要相同。
  const reversed = await f.folder("reversed", Object.fromEntries(Object.entries(files).reverse()));
  assert.equal(await folderDigest(reversed), digest);
  await writeFile(path.join(reversed, "a-c"), "C");
  assert.notEqual(await folderDigest(reversed), digest);
  const moved = Object.fromEntries(Object.entries(files).map(([relative, text]) => [relative === "a/x.js" ? "a/y.js" : relative, text]));
  const renamed = await f.folder("renamed", moved);
  assert.notEqual(await folderDigest(renamed), digest);
});

test("插件文件夹里有符号链接、文件过多或过大时，暂存即拒绝，不留下暂存副本", async (t) => {
  const f = await fixture(t);
  const staging = path.join(snapshotGroup(f.home, f.root), ".staging");
  const linked = await f.folder("linked", helloPlugin("linked", "你好"));
  await writeFile(path.join(f.directory, "outside.js"), "export {};\n");
  await symlink(path.join(f.directory, "outside.js"), path.join(linked, "lib.js"));
  await assert.rejects(stageFolder(f.home, f.root, linked), (error: unknown) => error instanceof RepaFault && error.code === "invalid_plugin_folder");
  const many = await f.folder("many", helloPlugin("many", "你好"));
  await mkdir(path.join(many, "data"));
  for (let index = 0; index < SNAPSHOT_LIMITS.files; index++) await writeFile(path.join(many, "data", `${index}.txt`), "");
  await assert.rejects(stageFolder(f.home, f.root, many), (error: unknown) => error instanceof RepaFault && error.code === "plugin_folder_too_large");
  // 目录同样计数：空目录不进摘要，但每次复制与核对都要遍历它们。
  const empty = await f.folder("empty", helloPlugin("empty", "你好"));
  for (let index = 0; index < SNAPSHOT_LIMITS.files; index++) await mkdir(path.join(empty, `${index}`));
  await assert.rejects(stageFolder(f.home, f.root, empty), (error: unknown) => error instanceof RepaFault && error.code === "plugin_folder_too_large");
  const large = await f.folder("large", helloPlugin("large", "你好"));
  // 稀疏文件：大小超过上限而不占磁盘，复制之前按目录列表就拒绝。
  await writeFile(path.join(large, "blob.bin"), "");
  await truncate(path.join(large, "blob.bin"), SNAPSHOT_LIMITS.bytes + 1);
  const before = copyStats().bytes;
  await assert.rejects(stageFolder(f.home, f.root, large), (error: unknown) => error instanceof RepaFault && error.code === "plugin_folder_too_large");
  assert.equal(copyStats().bytes, before, "超限的文件夹不应复制");
  assert.deepEqual(await readdir(staging).catch(() => []), []);
});

test("发布快照：暂存副本先全部落盘，改名为以摘要命名的目录以后再同步插件目录；新建的上级目录也同步", async (t) => {
  const f = await fixture(t);
  const source = await f.folder("hello", { ...helloPlugin("hello", "你好"), "lib/text.js": "export const text = 1;\n" });
  const before = copyStats().synced;
  const staged = await stageFolder(f.home, f.root, source);
  const target = await publishSnapshot(f.home, f.root, "hello", staged);
  const order = [...copyStats().synced.keys()].filter((file) => !before.has(file));
  const group = snapshotGroup(f.home, f.root);
  assert.equal(target, snapshotDirectory(f.home, f.root, "hello", staged.digest));
  // 暂存时新建了 plugins/<空间键>/.staging，各层的上级依次同步；这时副本里的文件与目录都已同步。
  const stagedEntries = [path.join(staged.directory, "repa-plugin.json"), path.join(staged.directory, "index.js"), path.join(staged.directory, "lib", "text.js"), path.join(staged.directory, "lib"), staged.directory];
  for (const entry of stagedEntries) assert.ok(order.includes(entry), `${entry} 发布前没有同步`);
  // 新建 <id>/ 时同步它的上级，即空间键目录；改名以后同步 <id>/，排在副本的全部同步之后。
  const published = order.indexOf(path.dirname(target));
  assert.ok(published > Math.max(...stagedEntries.map((entry) => order.indexOf(entry))), "改名后的目录同步应排在最后");
  assert.equal(published, order.length - 1);
  assert.ok(order.includes(group) && order.indexOf(group) < published);
  assert.ok(order.includes(path.join(f.home, "plugins")) && order.includes(f.home));
  assert.equal(await checkSnapshot(f.home, f.root, "hello", staged.digest), "ok");
  assert.deepEqual(await readdir(path.join(group, ".staging")), []);
  assert.equal(await readFile(path.join(target, "lib", "text.js"), "utf8"), "export const text = 1;\n");
});

test("同一摘要的快照已在：完好就直接用它；被改动过就换成这次的副本", async (t) => {
  const f = await fixture(t);
  const source = await f.folder("hello", helloPlugin("hello", "你好"));
  const first = await stageFolder(f.home, f.root, source);
  const target = await publishSnapshot(f.home, f.root, "hello", first);
  const again = await stageFolder(f.home, f.root, source);
  assert.equal(await publishSnapshot(f.home, f.root, "hello", again), target);
  await assert.rejects(stat(again.directory), { code: "ENOENT" });
  await writeFile(path.join(target, "index.js"), "export default {};\n");
  await writeFile(path.join(target, "extra.js"), "");
  assert.equal(await publishSnapshot(f.home, f.root, "hello", await stageFolder(f.home, f.root, source)), target);
  assert.equal(await checkSnapshot(f.home, f.root, "hello", first.digest), "ok");
  assert.deepEqual((await readdir(target)).sort(), ["index.js", "repa-plugin.json"]);
});

test("核对快照：内容改了、多了文件或符号链接都算改动，目录不在算缺失", async (t) => {
  const f = await fixture(t);
  const digest = await f.approve("hello", await f.folder("hello", helloPlugin("hello", "你好")));
  const target = snapshotDirectory(f.home, f.root, "hello", digest);
  assert.equal(await checkSnapshot(f.home, f.root, "hello", digest), "ok");
  await writeFile(path.join(target, "data.json"), "{}");
  assert.equal(await checkSnapshot(f.home, f.root, "hello", digest), "modified");
  await rm(path.join(target, "data.json"));
  assert.equal(await checkSnapshot(f.home, f.root, "hello", digest), "ok");
  await symlink(path.join(target, "index.js"), path.join(target, "alias.js"));
  assert.equal(await checkSnapshot(f.home, f.root, "hello", digest), "modified");
  assert.equal(await checkSnapshot(f.home, f.root, "hello", "0".repeat(64)), "missing");
  await rm(target, { recursive: true });
  await writeFile(target, "");
  assert.equal(await checkSnapshot(f.home, f.root, "hello", digest), "modified");
});

test("快照路径上任何一层是符号链接时都算改动：打开空间时不运行，只删除链接本身，链接指向的文件不动；之后同一内容可以重新发布", async (t) => {
  const f = await fixture(t);
  const source = await f.folder("hello", helloPlugin("hello", "你好"));
  const digest = await f.approve("hello", source);
  const target = snapshotDirectory(f.home, f.root, "hello", digest);
  const open = () => spacePlugins({ home: f.home, space: { root: f.root, dataDir: f.dataDir }, bundled: [] });
  // 摘要目录换成指向源文件夹的链接：内容与摘要一致，但源文件夹之后的改动会被运行。
  await rm(target, { recursive: true });
  await symlink(source, target);
  assert.equal(await checkSnapshot(f.home, f.root, "hello", digest), "modified");
  let result = await open();
  assert.deepEqual(result.plugins, []);
  assert.deepEqual(result.unavailable.map(({ id, state, reason }) => [id, state, reason.code]), [["hello", "pending", "snapshot_modified"]]);
  await assert.rejects(stat(target), { code: "ENOENT" });
  assert.equal(await folderDigest(source), digest);
  // <id>/ 换成指向空间里一个文件夹的链接，那里放着一份内容相同的副本，文件工具能改它。
  const copy = await f.folder(path.join("space", "notes-hello", digest), helloPlugin("hello", "你好"));
  await rm(path.dirname(target), { recursive: true, force: true });
  await symlink(path.dirname(copy), path.dirname(target));
  // 记录外的一个版本名与清理规则相符，也不能经链接删掉空间里的文件。
  const stray = await f.folder(path.join("space", "notes-hello", "f".repeat(64)), { "note.md": "笔记" });
  assert.equal(await checkSnapshot(f.home, f.root, "hello", digest), "modified");
  result = await open();
  assert.deepEqual(result.plugins, []);
  assert.deepEqual(result.unavailable.map(({ state }) => state), ["pending"]);
  assert.equal(await folderDigest(copy), digest);
  assert.equal(await readFile(path.join(stray, "note.md"), "utf8"), "笔记");
  assert.ok(!(await stat(path.dirname(target)).then(() => true, () => false)));
  // 链接清掉以后，同一内容重新发布成真实目录，打开空间时运行。
  await publishSnapshot(f.home, f.root, "hello", await stageFolder(f.home, f.root, source));
  result = await open();
  assert.deepEqual(result.plugins.map((plugin) => plugin.id), ["hello"]);
  // 直接删除一份快照时同样只删链接：<id>/ 是链接，删的就是它。
  await rm(path.dirname(target), { recursive: true });
  await symlink(path.dirname(copy), path.dirname(target));
  await removeSnapshot(f.home, f.root, "hello", digest);
  assert.equal(await folderDigest(copy), digest);
  assert.ok(!(await stat(path.dirname(target)).then(() => true, () => false)));
  // 配置目录的 plugins/ 本身换成指向空间的链接：同样不运行，打开空间时只删这个链接（清暂存时就删了，于是报的是快照不在）。
  const plugins = path.join(f.home, "plugins");
  const moved = path.join(f.root, "moved-plugins");
  await publishSnapshot(f.home, f.root, "hello", await stageFolder(f.home, f.root, source));
  await rename(plugins, moved);
  await symlink(moved, plugins);
  // 链接指向处的 .staging/ 里有文件：清暂存只删链接，不经链接删掉空间里的它。
  const strayStaged = path.join(moved, path.basename(snapshotGroup(f.home, f.root)), ".staging", "note.md");
  await writeFile(strayStaged, "笔记");
  assert.equal(await checkSnapshot(f.home, f.root, "hello", digest), "modified");
  result = await open();
  assert.deepEqual(result.plugins, []);
  assert.deepEqual(result.unavailable.map(({ state }) => state), ["pending"]);
  assert.equal(await folderDigest(path.join(moved, path.relative(plugins, target))), digest);
  assert.ok(!(await stat(plugins).then(() => true, () => false)));
  assert.equal(await readFile(strayStaged, "utf8"), "笔记");
});

test("清理只留下启用记录里的当前与上一个版本，卸载的插件照样保留，记录里没有的插件整个删除，暂存副本全部删除", async (t) => {
  const f = await fixture(t);
  const one = await f.approve("hello", await f.folder("v1", helloPlugin("hello", "一")));
  assert.ok((await readdir(path.join(snapshotGroup(f.home, f.root), "hello"))).includes(one));
  const two = await f.approve("hello", await f.folder("v2", helloPlugin("hello", "二")), LATER);
  const three = await f.approve("hello", await f.folder("v3", helloPlugin("hello", "三")), LATER);
  const other = await f.approve("other", await f.folder("other", helloPlugin("other", "别的")));
  const staged = await stageFolder(f.home, f.root, await f.folder("leftover", helloPlugin("hello", "残留")));
  let record = await readEnablement(f.dataDir);
  assert.deepEqual(record.plugins.hello, { enabled: true, digest: three, previous: two, activatedAt: LATER });
  record = withUnloaded(record, "other");
  await writeEnablement(f.dataDir, record);
  await cleanSnapshots(f.home, f.root, record);
  await clearStaging(f.home, f.root);
  const group = snapshotGroup(f.home, f.root);
  assert.deepEqual((await readdir(path.join(group, "hello"))).sort(), [three, two].sort());
  assert.deepEqual(await readdir(path.join(group, "other")), [other]);
  assert.ok(!(await readdir(group)).includes(".staging"));
  await assert.rejects(stat(staged.directory), { code: "ENOENT" });
  // 记录里删掉 other 以后，other 整个删除，hello 不动。
  const rest = Object.fromEntries(Object.entries(record.plugins).filter(([id]) => id !== "other"));
  await cleanSnapshots(f.home, f.root, { plugins: rest });
  assert.deepEqual((await readdir(group)).sort(), ["hello"]);
  assert.deepEqual((await readdir(path.join(group, "hello"))).sort(), [three, two].sort());
});

test("加载、卸载对记录的改动：摘要变了才改 previous 与 activatedAt；同一摘要重新加载、卸载都不改它们", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  let record: PluginEnablement = { plugins: {} };
  record = withLoaded(record, "hello", a, AT);
  assert.deepEqual(record.plugins.hello, { enabled: true, digest: a, activatedAt: AT });
  record = withLoaded(record, "hello", a, LATER);
  assert.deepEqual(record.plugins.hello, { enabled: true, digest: a, activatedAt: AT });
  record = withLoaded(record, "hello", b, LATER);
  assert.deepEqual(record.plugins.hello, { enabled: true, digest: b, previous: a, activatedAt: LATER });
  record = withUnloaded(record, "hello");
  assert.deepEqual(record.plugins.hello, { enabled: false, digest: b, previous: a, activatedAt: LATER });
  // 让上一个版本重新生效：它成为当前版本，previous 回到刚才的版本。
  record = withLoaded(record, "hello", a, "2026-11-15T08:00:00.000Z");
  assert.deepEqual(record.plugins.hello, { enabled: true, digest: a, previous: b, activatedAt: "2026-11-15T08:00:00.000Z" });
});

// 用目录权限制造真实的写入故障：没有写权限时临时文件建不出来，失败在改名之前；
// 有写和进入权限、没有读权限时临时文件写好、改名成功，同步目录要以只读方式打开目录，失败在改名之后。
// 权限检查对 root 不起作用，Windows 也不按这些权限位控制目录。
const permissions = process.platform === "win32" || process.getuid?.() === 0 ? "目录权限位在这个环境里不限制访问" : false;

/** 在 directory 的权限为 mode 时执行 action，之后恢复。 */
async function withMode<T>(directory: string, mode: number, action: () => Promise<T>): Promise<T> {
  await chmod(directory, mode);
  try {
    return await action();
  } finally {
    await chmod(directory, 0o700);
  }
}

test("写启用记录失败：抛错，盘上仍是旧记录", { skip: permissions }, async (t) => {
  const f = await fixture(t);
  const before = withLoaded({ plugins: {} }, "hello", "a".repeat(64), AT);
  await writeEnablement(f.dataDir, before);
  const bytes = await readFile(enablementFile(f.dataDir));
  await assert.rejects(withMode(f.dataDir, 0o500, () => writeEnablement(f.dataDir, withLoaded(before, "hello", "b".repeat(64), LATER))), { code: "EACCES" });
  assert.deepEqual(await readFile(enablementFile(f.dataDir)), bytes);
  assert.deepEqual(await readdir(f.dataDir), ["plugins.json"]);
});

test("写启用记录在改名时失败：抛错，不留下临时文件", async (t) => {
  const f = await fixture(t);
  // plugins.json 是非空目录时，临时文件写好了，改名失败。
  await mkdir(path.join(enablementFile(f.dataDir), "occupied"), { recursive: true });
  await assert.rejects(writeEnablement(f.dataDir, withLoaded({ plugins: {} }, "hello", "a".repeat(64), AT)));
  assert.deepEqual(await readdir(f.dataDir), ["plugins.json"]);
  assert.deepEqual(await readdir(enablementFile(f.dataDir)), ["occupied"]);
});

test("不合格式的启用记录不写：抛错，盘上仍是旧记录", async (t) => {
  const f = await fixture(t);
  const before = withLoaded({ plugins: {} }, "hello", "a".repeat(64), AT);
  await writeEnablement(f.dataDir, before);
  const bytes = await readFile(enablementFile(f.dataDir));
  await assert.rejects(writeEnablement(f.dataDir, withLoaded(before, "hello", "not-a-digest", LATER)), (error: unknown) => error instanceof RepaFault && error.code === "invalid_plugin_enablement");
  assert.deepEqual(await readFile(enablementFile(f.dataDir)), bytes);
});

test("启用记录读取时忽略各项里不认识的字段，字段无效或不是 JSON 时报错而不当作空记录", async (t) => {
  const f = await fixture(t);
  const file = enablementFile(f.dataDir);
  assert.deepEqual(await readEnablement(f.dataDir), { plugins: {} });
  await writeFile(file, JSON.stringify({ plugins: { hello: { enabled: true, digest: "a".repeat(64), activatedAt: AT, later: 1 } } }));
  assert.deepEqual(await readEnablement(f.dataDir), { plugins: { hello: { enabled: true, digest: "a".repeat(64), activatedAt: AT } } });
  for (const text of ["{", JSON.stringify({ plugins: { Hello: { enabled: true, digest: "a".repeat(64), activatedAt: AT } } }), JSON.stringify({ plugins: { hello: { enabled: true, digest: "xyz", activatedAt: AT } } })]) {
    await writeFile(file, text);
    await assert.rejects(readEnablement(f.dataDir), (error: unknown) => error instanceof RepaFault && error.code === "invalid_plugin_enablement");
  }
});

test("打开空间时交给宿主的是随包插件加上启用且快照完好的自写插件；运行的是快照，源文件夹之后的改动不影响", async (t) => {
  const f = await fixture(t);
  const source = await f.folder("hello", helloPlugin("hello", "你好"));
  const digest = await f.approve("hello", source);
  await writeFile(path.join(source, "index.js"), "throw new Error('源文件夹里的改动不该运行');\n");
  const bundled = { id: "notes", open: async () => ({}) };
  const recordBytes = await readFile(enablementFile(f.dataDir));
  // 中途结束的暂存副本、记录里已不保留的版本，打开时都删除。
  const leftover = await stageFolder(f.home, f.root, source);
  const stale = await f.folder(path.join("home", "plugins", path.basename(snapshotGroup(f.home, f.root)), "hello", "e".repeat(64)), helloPlugin("hello", "旧"));
  const first = await spacePlugins({ home: f.home, space: { root: f.root, dataDir: f.dataDir }, bundled: [bundled] });
  assert.deepEqual(first.plugins.map((plugin) => plugin.id), ["notes", "hello"]);
  assert.deepEqual(first.unavailable, []);
  assert.deepEqual(first.record, await readEnablement(f.dataDir));
  assert.deepEqual(first.selfWritten.map(({ id, digest, manifest }) => [id, digest, manifest.version]), [["hello", digest, "0.1.0"]]);
  await assert.rejects(stat(leftover.directory), { code: "ENOENT" });
  await assert.rejects(stat(stale), { code: "ENOENT" });
  const instance = await first.plugins[1]?.open({} as never);
  assert.equal(await instance?.methods?.hello?.invoke({}, {} as never), "你好");
  // 打开只读记录，同一份记录打开两次，记录（含 activatedAt）不变。
  await spacePlugins({ home: f.home, space: { root: f.root, dataDir: f.dataDir }, bundled: [bundled] });
  assert.deepEqual(await readFile(enablementFile(f.dataDir)), recordBytes);
});

test("快照被改动时删除它、列为待批准；快照不在时列为待批准；卸载的不运行也不列出", async (t) => {
  const f = await fixture(t);
  const changed = await f.approve("changed", await f.folder("changed", helloPlugin("changed", "改")));
  await f.approve("missing", await f.folder("missing", helloPlugin("missing", "缺")));
  await f.approve("unloaded", await f.folder("unloaded", helloPlugin("unloaded", "卸")));
  await writeEnablement(f.dataDir, withUnloaded(await readEnablement(f.dataDir), "unloaded"));
  const record = await readEnablement(f.dataDir);
  const changedDirectory = snapshotDirectory(f.home, f.root, "changed", changed);
  await writeFile(path.join(changedDirectory, "index.js"), "export default { id: 'changed', open() { return {}; } };\n");
  await rm(snapshotDirectory(f.home, f.root, "missing", record.plugins.missing?.digest ?? ""), { recursive: true });
  const result = await spacePlugins({ home: f.home, space: { root: f.root, dataDir: f.dataDir }, bundled: [] });
  assert.deepEqual(result.plugins, []);
  assert.deepEqual(result.unavailable.map(({ id, state, reason }) => [id, state, reason.code]), [
    ["changed", "pending", "snapshot_modified"],
    ["missing", "pending", "snapshot_missing"],
  ]);
  await assert.rejects(stat(changedDirectory), { code: "ENOENT" });
  // 卸载的插件快照保留，记录不变。
  assert.ok((await stat(snapshotDirectory(f.home, f.root, "unloaded", record.plugins.unloaded?.digest ?? ""))).isDirectory());
  assert.deepEqual(await readEnablement(f.dataDir), record);
});

test("与随包插件同名、清单 id 与记录不符、导入失败的自写插件列为失败；记录读不了时抛错，也不清理快照", async (t) => {
  const f = await fixture(t);
  await f.approve("notes", await f.folder("notes", helloPlugin("notes", "同名")));
  // 清单 id 与记录不符的插件，入口一执行就留下标记文件：比较 id 要在导入之前。
  const marker = path.join(f.directory, "renamed-ran");
  await f.approve("renamed", await f.folder("renamed", {
    ...helloPlugin("other-id", "改名"),
    "index.js": `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "");\n${helloPlugin("other-id", "改名")["index.js"] ?? ""}`,
  }));
  await f.approve("broken", await f.folder("broken", { ...helloPlugin("broken", "坏"), "index.js": "export default {\n" }));
  const bundled = { id: "notes", open: async () => ({}) };
  const errors: unknown[] = [];
  const result = await spacePlugins({ home: f.home, space: { root: f.root, dataDir: f.dataDir }, bundled: [bundled], onError: (error) => errors.push(error) });
  assert.deepEqual(result.plugins.map((plugin) => plugin.id), ["notes"]);
  assert.deepEqual(result.selfWritten, []);
  assert.deepEqual(result.unavailable.map(({ id, state, reason }) => [id, state, reason.code]), [
    ["notes", "failed", "plugin_id_conflict"],
    ["renamed", "failed", "plugin_id_mismatch"],
    ["broken", "failed", "plugin_import_failed"],
  ]);
  assert.deepEqual(errors.map((error) => error instanceof RepaFault && error.code), ["plugin_id_mismatch", "plugin_import_failed"]);
  await assert.rejects(stat(marker), { code: "ENOENT" });
  const group = snapshotGroup(f.home, f.root);
  const kept = (await readdir(group)).sort();
  await writeFile(enablementFile(f.dataDir), "{");
  await assert.rejects(
    spacePlugins({ home: f.home, space: { root: f.root, dataDir: f.dataDir }, bundled: [bundled] }),
    (error: unknown) => error instanceof RepaFault && error.code === "invalid_plugin_enablement",
  );
  assert.deepEqual((await readdir(group)).sort(), kept);
});

test("只读插件文件夹的清单时不执行入口模块", async (t) => {
  const f = await fixture(t);
  const source = await f.folder("loud", {
    "repa-plugin.json": JSON.stringify({ id: "loud", version: "0.2.0", baseVersion: "^0.1.0", entry: "index.js", title: "响" }),
    "index.js": "throw new Error('读清单时不该执行');\n",
  });
  const folder = await readPluginFolder(source);
  assert.deepEqual([folder.manifest.id, folder.manifest.version, folder.manifest.title], ["loud", "0.2.0", "响"]);
  assert.equal(folder.entry, path.join(source, "index.js"));
});

const ECHO_MANIFEST = { id: "echo-folder", version: "0.1.0", baseVersion: "^0.1.0", entry: "index.ts" };
const ECHO_INDEX = `import { Type } from "@repa/base/plugin";
import type { Plugin } from "@repa/base/plugin";

export default {
  id: "echo-folder",
  async open() {
    return {
      methods: { echo: { parameters: Type.Object({ text: Type.String() }), async invoke(input: unknown): Promise<unknown> { return \`回声：\${(input as { text: string }).text}\`; } } },
    };
  },
} satisfies Plugin;
`;

test("构建后的后端打开空间时运行启用的自写插件；快照被改动以后重开空间，它列为待批准，不再运行", async (t) => {
  const f = await fixture(t);
  await rm(f.root, { recursive: true });
  const space = await createSpace(f.root, { watch: false });
  await space.close();
  // 快照里有 package.json 也不按 npm 包加载：@repa/base/plugin 仍解析到宿主自己的那一份。
  const source = await f.folder("echo-folder", {
    "repa-plugin.json": JSON.stringify(ECHO_MANIFEST),
    "index.ts": ECHO_INDEX,
    "package.json": JSON.stringify({ type: "commonjs" }),
  });
  const digest = await f.approve("echo-folder", source);
  const backend = await startRepaProcess({ home: f.home });
  f.closers.push(() => backend.close());
  const client = await RepaClient.connect(backend.connection);
  f.closers.push(() => client.close());

  const opened = await client.call("space.open", { root: f.root });
  assert.deepEqual(opened.disabledPlugins, []);
  assert.deepEqual(await client.call("plugin.list", {}), [{ id: "echo-folder", methods: ["echo"], tools: [] }]);
  assert.equal(await client.call("plugin.call", { pluginId: "echo-folder", method: "echo", input: { text: "你好" } }), "回声：你好");
  await client.call("space.close", {});

  await writeFile(path.join(snapshotDirectory(f.home, f.root, "echo-folder", digest), "index.ts"), ECHO_INDEX.replace("回声", "篡改"));
  const reopened = await client.call("space.open", { root: f.root });
  assert.deepEqual(reopened.disabledPlugins.map((plugin) => [plugin.id, plugin.reason.code]), [["echo-folder", "snapshot_modified"]]);
  assert.deepEqual(await client.call("plugin.disabled", {}), reopened.disabledPlugins);
  assert.deepEqual(await client.call("plugin.list", {}), []);
  await assert.rejects(client.call("plugin.call", { pluginId: "echo-folder", method: "echo", input: { text: "你好" } }), (error: unknown) => {
    assert(error instanceof RpcError);
    assert.equal((error.data as { code?: string } | undefined)?.code, "plugin_not_found");
    return true;
  });
});

test("启用记录读不了时打开空间失败，报告 invalid_plugin_enablement，空间没有打开", async (t) => {
  const f = await fixture(t);
  await rm(f.root, { recursive: true });
  await (await createSpace(f.root, { watch: false })).close();
  await writeFile(enablementFile(f.dataDir), "{");
  const server = await startServer({ home: f.home });
  f.closers.push(() => server.close());
  const client = await RepaClient.connect(server.connection);
  f.closers.push(() => client.close());
  await assert.rejects(client.call("space.open", { root: f.root }), (error: unknown) => {
    assert(error instanceof RpcError);
    assert.equal((error.data as { code?: string } | undefined)?.code, "invalid_plugin_enablement");
    return true;
  });
  await assert.rejects(client.call("plugin.list", {}), (error: unknown) => error instanceof RpcError && (error.data as { code?: string } | undefined)?.code === "space_not_open");
});

test("后端交给 Agent 运行时的控制目录是配置目录的 plugins/：完全访问模式下通用 Agent 也写不进快照", async (t) => {
  const f = await fixture(t);
  await rm(f.root, { recursive: true });
  await (await createSpace(f.root, { watch: false })).close();
  const digest = await f.approve("hello", await f.folder("hello", helloPlugin("hello", "你好")));
  const snapshot = path.join(snapshotDirectory(f.home, f.root, "hello", digest), "index.js");
  const original = await readFile(snapshot, "utf8");
  await mkdir(path.join(f.home, "agent"), { recursive: true });
  const faux = fauxProvider({ api: `snapshots-${randomUUID()}`, provider: `snapshots-${randomUUID()}`, models: [{ id: "scripted", contextWindow: 16384, maxTokens: 256 }], tokensPerSecond: 0 });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(f.home, "agent", "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const runtime = await createAgentRuntimeForTest({
    agentDir: path.join(f.home, "agent"),
    modelRuntime,
    defaultModel: { provider: faux.getModel().provider, id: "scripted" },
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
  });
  const server = await startServer({ home: f.home, runtime });
  f.closers.push(() => server.close());
  const client = await RepaClient.connect(server.connection);
  f.closers.push(() => client.close());
  await client.call("space.open", { root: f.root });
  await client.call("settings.set", { commandPolicy: "fullAccess" });
  faux.setResponses([fauxAssistantMessage(fauxToolCall("write", { path: snapshot, content: "篡改" })), fauxAssistantMessage("已尝试")]);
  const session = await client.call("session.create", {});
  await client.call("session.send", { sessionId: session.id, text: "改快照" });
  const history = await client.call("session.history", { sessionId: session.id });
  assert.ok(JSON.stringify(history).includes("不能写入 Repa 保管已批准插件的目录"), "写入应以控制目录拒绝");
  assert.equal(await readFile(snapshot, "utf8"), original);
});
