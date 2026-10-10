import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { DefaultPackageManager, DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { satisfies } from "semver";
import { RepaFault } from "../src/errors.js";
import { PLUGIN_API_VERSION, PluginPackages, projectPiPackages } from "../src/plugins/packages.js";
import { PluginManifestSchema, PluginPackageSchema, type PluginSelection } from "../src/plugins/schema.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-plugin-packages-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "space");
  const agentDir = path.join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  const packageDirectory = path.join(root, "packages");
  await mkdir(packageDirectory);
  return {
    root, cwd, agentDir,
    async package(name: string, repa?: unknown, pi?: unknown) {
      const directory = path.join(packageDirectory, name);
      await mkdir(directory);
      await writeFile(path.join(directory, "package.json"), JSON.stringify({ name, version: "1.0.0", type: "module", ...(repa === undefined ? {} : { repa }), ...(pi === undefined ? {} : { pi }) }));
      await writeFile(path.join(directory, "backend.js"), "throw new Error('后台入口不应在发现阶段加载');\n");
      await writeFile(path.join(directory, "web.js"), "throw new Error('前端入口不能在后端执行');\n");
      return directory;
    },
  };
}

function manifest(api = "^1.0.0") {
  return { manifestVersion: 1, backend: { entry: "./backend.js", api }, frontends: [{ environment: "web", entry: "./web.js", api }] };
}

const byName = (name: string): PluginSelection => ({ kind: "package", name });
const runFile = promisify(execFile);

test("插件API兼容旧minor范围，要求限额读取的材料包不接受旧宿主", async t => {
  const f = await fixture(t);
  const legacy = await f.package("legacy-range", manifest("^1.0.0"));
  const bounded = await f.package("bounded-range", manifest("^1.1.0"));
  const pinned = await f.package("legacy-pinned", manifest("1.0.0"));
  const settings = SettingsManager.inMemory({ packages: [legacy, bounded, pinned] });
  const packages = new PluginPackages({ cwd: f.cwd, agentDir: f.agentDir, settingsManager: settings });
  const catalog = await packages.list();
  assert.equal(catalog.find(item => item.name === "legacy-range")?.backend?.status, "ready");
  assert.equal(catalog.find(item => item.name === "bounded-range")?.backend?.status, "ready");
  assert.equal(catalog.find(item => item.name === "legacy-pinned")?.backend?.status, "incompatible");
  const material: unknown = JSON.parse(await readFile(new URL("../../materials/package.json", import.meta.url), "utf8"));
  assert(material && typeof material === "object" && "repa" in material);
  assert(Check(PluginManifestSchema, material.repa));
  assert(material.repa.backend);
  assert.equal(satisfies("1.0.0", material.repa.backend.api), false);
  assert.equal(satisfies(PLUGIN_API_VERSION, material.repa.backend.api), true);
});

test("只读包发现不加载代码，返回独立入口状态与真正 semver 兼容结果", async (t) => {
  const f = await fixture(t);
  const ready = await f.package("repa-ready", manifest(">=1.0.0 <2"));
  const incompatible = await f.package("repa-next", { ...manifest(), frontends: [{ environment: "web", entry: "./web.js", api: "^2.0.0" }] });
  const missingEntry = await f.package("repa-missing-entry", { manifestVersion: 1, backend: { entry: "./missing.js", api: "^1.0.0" } });
  const invalid = await f.package("repa-invalid", { ...manifest(), manifestVersion: 2 });
  const missingSource = path.join(f.root, "not-installed");
  const stale = path.join(f.agentDir, "npm", "node_modules", "repa-stale-test");
  await mkdir(stale, { recursive: true });
  const staleManifest = JSON.stringify({ name: "repa-stale-test", version: "1.0.0" });
  await writeFile(path.join(stale, "package.json"), staleManifest);
  // 已有安装目录但目标版本缺失，真实 SDK 会进入 onMissing；发现不能补装。
  const npmSource = "npm:repa-stale-test@2.0.0";
  const settings = SettingsManager.inMemory({ packages: [ready, incompatible, missingEntry, invalid, missingSource, npmSource] });
  const packages = new PluginPackages({ cwd: f.cwd, agentDir: f.agentDir, settingsManager: settings });
  const catalog = await packages.list();
  assert.equal(catalog.length, 6);
  for (const item of catalog) assert(Check(PluginPackageSchema, JSON.parse(JSON.stringify(item))), "目录响应必须满足公共可序列化 schema");
  const first = catalog.find((item) => item.name === "repa-ready");
  assert.equal(first?.status, "ready");
  assert.equal(first?.backend?.entry, path.join(ready, "backend.js"));
  assert.equal(first?.backend?.status, "ready");
  assert.equal(first?.frontends[0]?.entry, path.join(ready, "web.js"));
  assert.equal(first?.piResources, false);
  const next = catalog.find((item) => item.name === "repa-next");
  assert.equal(next?.backend?.status, "ready");
  assert.equal(next?.frontends[0]?.status, "incompatible");
  assert(next?.issues.some((issue) => issue.code === "api_incompatible"));
  assert.equal(catalog.find((item) => item.name === "repa-missing-entry")?.backend?.status, "missing");
  assert.equal(catalog.find((item) => item.name === "repa-invalid")?.status, "invalid");
  assert.equal(catalog.find((item) => item.source === missingSource)?.status, "missing");
  await assert.rejects(stat(missingSource), { code: "ENOENT" });
  assert.equal(catalog.find((item) => item.source === npmSource)?.status, "missing");
  assert.equal(await readFile(path.join(stale, "package.json"), "utf8"), staleManifest);
  await assert.rejects(stat(path.join(f.agentDir, "npm", "package.json")), { code: "ENOENT" });
  assert.deepEqual(await readFile(path.join(ready, "backend.js"), "utf8"), "throw new Error('后台入口不应在发现阶段加载');\n");
});

test("纯 Repa 包不进入 Extension 回退，混合 Pi 包与 project delta 仍由真实 Loader 解析", async (t) => {
  const f = await fixture(t);
  const pure = await f.package("repa-only", manifest());
  const mixed = await f.package("repa-mixed", manifest(), { extensions: ["./agent.js"], skills: ["./skills"] });
  const ordinary = await f.package("ordinary-pi", undefined, { extensions: ["./agent.js"] });
  const untrusted = await f.package("untrusted", manifest());
  const disabled = await f.package("disabled", manifest());
  const loaded = path.join(f.root, "loaded.txt");
  const extension = `import { appendFileSync } from "node:fs";\nexport default function () { appendFileSync(${JSON.stringify(loaded)}, "loaded\\n"); }\n`;
  await writeFile(path.join(mixed, "agent.js"), extension);
  await writeFile(path.join(ordinary, "agent.js"), extension);
  for (const directory of [pure, untrusted, disabled]) await writeFile(path.join(directory, "index.js"), "throw new Error('纯 Repa 包不得回退加载');\n");
  await mkdir(path.join(mixed, "skills"));
  await writeFile(path.join(mixed, "skills", "SKILL.md"), "---\nname: fixture-skill\ndescription: 测试资源过滤\n---\n测试技能。\n");
  const snapshots = {
    global: { packages: [pure, mixed, ordinary, untrusted, disabled, path.join(f.root, "missing")] },
    project: { packages: [{ source: mixed, autoload: false, extensions: ["!**/*"], skills: ["!**/*"] }] },
  };
  const settings = SettingsManager.fromStorage({
    withLock(scope, fn) { fn(JSON.stringify(snapshots[scope])); },
  }, { projectTrusted: true });
  const packages = new PluginPackages({ cwd: f.cwd, agentDir: f.agentDir, settingsManager: settings });
  const catalog = await packages.list();
  const selection = {
    enabled: [{ kind: "source" as const, source: pure, scope: "user" as const }, byName("repa-mixed"), byName("ordinary-pi"), byName("untrusted")],
    trusted: [{ kind: "source" as const, source: pure, scope: "user" as const }, byName("repa-mixed"), byName("ordinary-pi"), byName("disabled")],
  };
  const projected = projectPiPackages(snapshots, catalog, selection);
  assert.deepEqual(snapshots.global.packages, [pure, mixed, ordinary, untrusted, disabled, path.join(f.root, "missing")]);
  assert.deepEqual(projected.global.packages, [{ source: pure, extensions: [], skills: [], prompts: [], themes: [] }, mixed, ordinary]);
  assert.deepEqual(projected.project.packages, snapshots.project.packages);
  const wrongScope = projectPiPackages(snapshots, catalog, {
    enabled: [{ kind: "source", source: pure, scope: "project" }], trusted: [byName("repa-only")],
  });
  assert.deepEqual(wrongScope.global.packages, []);
  const filteredSettings = SettingsManager.fromStorage({
    withLock(scope, fn) { fn(JSON.stringify(projected[scope])); },
  }, { projectTrusted: true });
  const manager = new DefaultPackageManager({ cwd: f.cwd, agentDir: f.agentDir, settingsManager: filteredSettings });
  const paths = await manager.resolve(async () => "skip");
  assert.equal(paths.extensions.some((item) => item.path === pure), false);
  assert.equal(paths.extensions.filter((item) => item.enabled).length, 1);
  assert.equal(paths.skills.filter((item) => item.enabled).length, 0);
  const loader = new DefaultResourceLoader({ cwd: f.cwd, agentDir: f.agentDir, settingsManager: filteredSettings, noContextFiles: true, noThemes: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 1);
  assert.equal(await readFile(loaded, "utf8"), "loaded\n");
});

test("包入口路径不能越出包目录或通过符号链接加载其他位置", async (t) => {
  const f = await fixture(t);
  const escaped = await f.package("escaped", { manifestVersion: 1, backend: { entry: "../../outside.js", api: "^1" } });
  const linked = await f.package("linked", { manifestVersion: 1, backend: { entry: "./linked.js", api: "^1" } });
  const outside = path.join(f.root, "outside.js");
  await writeFile(outside, "throw new Error('不能加载包外文件');\n");
  await symlink(outside, path.join(linked, "linked.js"));
  const packages = new PluginPackages({ cwd: f.cwd, agentDir: f.agentDir, settingsManager: SettingsManager.inMemory({ packages: [escaped, linked] }) });
  const catalog = await packages.list();
  assert.equal(catalog[0]?.backend?.status, "invalid");
  assert.equal(catalog[1]?.backend?.status, "invalid");
});

test("独立快照入口只被发现，不加载后台代码；快照不兼容不影响其他入口", async (t) => {
  const f = await fixture(t);
  const ready = await f.package("snapshot-owner", { ...manifest(), snapshot: { entry: "./snapshot.js", api: "^1.0.0" } });
  const incompatible = await f.package("snapshot-next", { ...manifest(), snapshot: { entry: "./snapshot.js", api: "^2.0.0" } });
  const only = await f.package("snapshot-only", { manifestVersion: 1, snapshot: { entry: "./snapshot.js", api: ">=1.0.0 <2" } });
  for (const directory of [ready, incompatible, only])
    await writeFile(path.join(directory, "snapshot.js"), "throw new Error('快照入口不应在发现阶段加载');\n");
  const settings = SettingsManager.inMemory({ packages: [ready, incompatible, only] });
  const packages = new PluginPackages({ cwd: f.cwd, agentDir: f.agentDir, settingsManager: settings });
  const catalog = await packages.list();
  for (const item of catalog) assert(Check(PluginPackageSchema, JSON.parse(JSON.stringify(item))));
  assert.equal(catalog[0]?.snapshot?.entry, path.join(ready, "snapshot.js"));
  assert.equal(catalog[0]?.snapshot?.status, "ready");
  assert.equal(catalog[0]?.backend?.status, "ready");
  assert.equal(catalog[1]?.status, "ready");
  assert.equal(catalog[1]?.snapshot?.status, "incompatible");
  assert.equal(catalog[1]?.backend?.status, "ready");
  assert.equal(catalog[1]?.frontends[0]?.status, "ready");
  assert.equal(catalog[2]?.backend, undefined);
  assert.equal(catalog[2]?.snapshot?.status, "ready");
  const projected = projectPiPackages({ global: { packages: [only] }, project: {} }, catalog, {
    enabled: [byName("snapshot-only")], trusted: [byName("snapshot-only")],
  });
  assert.deepEqual(projected.global.packages, [{ source: only, extensions: [], skills: [], prompts: [], themes: [] }]);
});

test("SDK local 安装、更新和移除等待实际设置保存，移除保留包文件及独立能力数据", async (t) => {
  const f = await fixture(t);
  const source = await f.package("managed-local", manifest());
  const settings = SettingsManager.create(f.cwd, f.agentDir, { projectTrusted: true });
  const packages = new PluginPackages({ cwd: f.cwd, agentDir: f.agentDir, settingsManager: settings });
  const installed = await packages.install(source);
  const configured = installed[0];
  assert(configured);
  assert.equal(configured.installedPath, source);
  const userFile: unknown = JSON.parse(await readFile(path.join(f.agentDir, "settings.json"), "utf8"));
  assert(Check(Type.Object({ packages: Type.Array(Type.String()) }), userFile));
  assert.deepEqual(userFile.packages, [configured.source]);
  assert.equal((await packages.update(configured.source))[0]?.name, "managed-local");
  const retained = path.join(f.root, "capability-data.json");
  await writeFile(retained, "{\"retained\":true}\n");
  assert.deepEqual(await packages.remove(configured.source), []);
  assert.equal(await readFile(retained, "utf8"), "{\"retained\":true}\n");
  assert((await stat(source)).isDirectory());
  const project = await packages.install(source, { local: true });
  assert.equal(project[0]?.scope, "project");
  const projectSource = project[0]?.source;
  assert(projectSource);
  await rm(source, { recursive: true });
  assert.deepEqual(await packages.remove(projectSource, { local: true }), []);
  const projectFile: unknown = JSON.parse(await readFile(path.join(f.cwd, ".pi", "settings.json"), "utf8"));
  assert(Check(Type.Object({ packages: Type.Array(Type.String()) }), projectFile));
  assert.deepEqual(projectFile.packages, []);
});

test("SDK 设置保存失败不返回包管理成功", async (t) => {
  const f = await fixture(t);
  const source = await f.package("storage-failure", manifest());
  const settings = SettingsManager.fromStorage({
    withLock(_scope, fn) {
      const next = fn(undefined);
      if (next !== undefined) throw new Error("测试存储拒绝写入");
    },
  });
  const packages = new PluginPackages({ cwd: f.cwd, agentDir: f.agentDir, settingsManager: settings });
  await assert.rejects(packages.install(source), (error) => error instanceof RepaFault && error.code === "package_settings");
});

test("未整体信任项目仍可发现和明确管理项目包，只写包字段且不执行项目 npmCommand", async (t) => {
  const f = await fixture(t);
  const original = await f.package("existing-project", manifest());
  const added = await f.package("added-project", manifest());
  await mkdir(path.join(f.cwd, ".pi"));
  const marker = path.join(f.root, "project-command-ran");
  const npmUserConfig = path.join(f.root, "npm-user.config");
  const npmGlobalConfig = path.join(f.root, "npm-global.config");
  await writeFile(npmUserConfig, "");
  await writeFile(npmGlobalConfig, "");
  const global = {
    // 缺少的 user 包让真实 SDK 查询 npm root；项目 npmCommand 不能介入这一调用。
    packages: ["npm:repa-fixture-uninstalled-scope@1.0.0"], defaultThinkingLevel: "high",
    npmCommand: ["npm", "--offline", "--userconfig", npmUserConfig, "--globalconfig", npmGlobalConfig],
  };
  const project = {
    packages: [original], defaultThinkingLevel: "low", extensions: ["./local-extension.js"],
    npmCommand: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '不应执行'); console.log('/not-installed');`],
  };
  const globalFile = path.join(f.agentDir, "settings.json");
  const projectFile = path.join(f.cwd, ".pi/settings.json");
  const globalBytes = `${JSON.stringify(global)}\n`;
  await writeFile(globalFile, globalBytes);
  await writeFile(projectFile, JSON.stringify(project));
  const packages = new PluginPackages({ cwd: f.cwd, agentDir: f.agentDir, trusted: false });
  const initial = await packages.list();
  assert(initial.some(item => item.name === "existing-project" && item.scope === "project"));
  assert(!existsSync(marker));
  const installed = await packages.install(added, { local: true });
  const configured = installed.find(item => item.name === "added-project");
  assert(configured);
  assert.equal(configured.scope, "project");
  const saved: unknown = JSON.parse(await readFile(projectFile, "utf8"));
  assert.deepEqual(saved, { ...project, packages: [original, configured.source] });
  assert.equal(await readFile(globalFile, "utf8"), globalBytes);
  const removed = await packages.remove(configured.source, { local: true });
  assert(!removed.some(item => item.name === "added-project"));
  assert.deepEqual(JSON.parse(await readFile(projectFile, "utf8")), project);
  assert.equal(await readFile(globalFile, "utf8"), globalBytes);
  assert((await stat(added)).isDirectory());
  assert(!existsSync(marker));
});

test("真实本地 Git 更新只作用于选定包 scope，同源的其他安装和设置保持不变", async (t) => {
  const f = await fixture(t);
  const remote = path.join(f.root, "remote");
  await mkdir(remote);
  const git = async (args: string[], cwd: string) => runFile("git", [
    "-c", "user.name=Package Test", "-c", "user.email=package-test@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args,
  ], { cwd });
  await git(["init", "--initial-branch=main"], remote);
  const commit = async (text: string) => {
    await writeFile(path.join(remote, "version.txt"), text);
    await git(["add", "version.txt"], remote);
    await git(["commit", "-m", text], remote);
  };
  await commit("第一版");
  const source = "git:fixture.invalid/owner/shared";
  // Pi 0.87.1 的真实安装目录；origin 指向临时本地仓库，fetch/reset 不使用网络。
  const userDirectory = path.join(f.agentDir, "git/fixture.invalid/owner/shared");
  const projectDirectory = path.join(f.cwd, ".pi/git/fixture.invalid/owner/shared");
  await mkdir(path.dirname(userDirectory), { recursive: true });
  await mkdir(path.dirname(projectDirectory), { recursive: true });
  await git(["clone", "--no-hardlinks", remote, userDirectory], f.root);
  await git(["clone", "--no-hardlinks", remote, projectDirectory], f.root);
  const globalFile = path.join(f.agentDir, "settings.json");
  const projectFile = path.join(f.cwd, ".pi/settings.json");
  const globalBytes = JSON.stringify({ packages: [source], defaultThinkingLevel: "medium" });
  const projectBytes = JSON.stringify({ packages: [source], defaultThinkingLevel: "high" });
  await writeFile(globalFile, globalBytes);
  await writeFile(projectFile, projectBytes);
  const packages = new PluginPackages({ cwd: f.cwd, agentDir: f.agentDir, trusted: false });
  assert.deepEqual((await packages.list()).map(item => [item.scope, item.installedPath]), [["user", userDirectory], ["project", projectDirectory]]);
  await commit("第二版");
  await packages.update(undefined, { local: true });
  assert.equal(await readFile(path.join(projectDirectory, "version.txt"), "utf8"), "第二版");
  assert.equal(await readFile(path.join(userDirectory, "version.txt"), "utf8"), "第一版");
  await commit("第三版");
  await packages.update(source);
  assert.equal(await readFile(path.join(userDirectory, "version.txt"), "utf8"), "第三版");
  assert.equal(await readFile(path.join(projectDirectory, "version.txt"), "utf8"), "第二版");
  assert.equal(await readFile(globalFile, "utf8"), globalBytes);
  assert.equal(await readFile(projectFile, "utf8"), projectBytes);
});


test("轻量贡献入口只读发现并保留纯Repa包的Pi过滤，不执行模块", async t => {
  const f = await fixture(t);
  const contribution = { entry: "./contributions.js", api: "^1.0.0" };
  const pure = await f.package("contributions-only", { manifestVersion: 1, contributions: contribution });
  const mixed = await f.package("contributions-mixed", { ...manifest(), contributions: contribution }, { skills: ["./skills"] });
  const marker = path.join(f.root, "contributions-imported");
  const bytes = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "imported");\nthrow new Error("发现不能加载轻量入口");\n`;
  for (const directory of [pure, mixed]) await writeFile(path.join(directory, "contributions.js"), bytes);
  const catalog = await new PluginPackages({ cwd: f.cwd, agentDir: f.agentDir,
    settingsManager: SettingsManager.inMemory({ packages: [pure, mixed] }),
  }).list();
  assert.equal(catalog.length, 2);
  for (const item of catalog) {
    assert(Check(PluginPackageSchema, item));
    assert.equal(item.status, "ready");
    assert.equal(item.contributions?.status, "ready");
    assert(item.installedPath);
    assert.equal(item.contributions?.entry, path.join(item.installedPath, "contributions.js"));
  }
  assert.equal(catalog[0]?.piResources, false);
  assert.equal(catalog[1]?.piResources, true);
  const selections = [byName("contributions-only"), byName("contributions-mixed")];
  const projected = projectPiPackages({ global: { packages: [pure, mixed] }, project: {} }, catalog,
    { enabled: selections, trusted: selections });
  assert.deepEqual(projected.global.packages, [
    { source: pure, extensions: [], skills: [], prompts: [], themes: [] }, mixed,
  ]);
  assert.equal(existsSync(marker), false);
  assert.equal(await readFile(path.join(pure, "contributions.js"), "utf8"), bytes);
});

test("贡献入口的路径与API状态独立，不使可用后台快照前端入口失效", async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside-contributions.js");
  await writeFile(outside, "throw new Error('不能加载包外入口');\n");
  const cases = [
    { name: "missing", entry: "./absent.js", api: "^1", status: "missing", issue: "entry_missing" },
    { name: "incompatible", entry: "./contributions.js", api: "^2", status: "incompatible", issue: "api_incompatible" },
    { name: "invalid-api", entry: "./contributions.js", api: "not a range", status: "incompatible", issue: "api_invalid" },
    { name: "escaped", entry: "../../outside-contributions.js", api: "^1", status: "invalid", issue: "entry_outside_package" },
    { name: "absolute", entry: outside, api: "^1", status: "invalid", issue: "entry_outside_package" },
    { name: "linked", entry: "./linked.js", api: "^1", status: "invalid", issue: "entry_invalid" },
  ];
  const directories: string[] = [];
  for (const item of cases) {
    const directory = await f.package(`contributions-${item.name}`, { ...manifest(),
      snapshot: { entry: "./snapshot.js", api: "^1" }, contributions: { entry: item.entry, api: item.api },
    });
    await writeFile(path.join(directory, "snapshot.js"), "throw new Error('发现不能加载snapshot');\n");
    await writeFile(path.join(directory, "contributions.js"), "throw new Error('发现不能加载contributions');\n");
    if (item.name === "linked") await symlink(outside, path.join(directory, "linked.js"));
    directories.push(directory);
  }
  const catalog = await new PluginPackages({ cwd: f.cwd, agentDir: f.agentDir,
    settingsManager: SettingsManager.inMemory({ packages: directories }),
  }).list();
  for (const item of cases) {
    const found = catalog.find(pkg => pkg.name === `contributions-${item.name}`);
    assert(found && Check(PluginPackageSchema, found));
    assert.equal(found.status, "ready");
    assert.equal(found.contributions?.status, item.status);
    assert(found.issues.some(issue => issue.code === item.issue));
    assert.equal(found.backend?.status, "ready");
    assert.equal(found.snapshot?.status, "ready");
    assert.equal(found.frontends[0]?.status, "ready");
  }
});

test("贡献声明使用共享入口schema，缺字段与未知字段不能成为有效manifest", () => {
  assert(Check(PluginManifestSchema, { manifestVersion: 1, contributions: { entry: "./contributions.js", api: "^1" } }));
  for (const contributions of [{ entry: "./contributions.js" }, { api: "^1" },
    { entry: "./contributions.js", api: "^1", factory: true }, null])
    assert.equal(Check(PluginManifestSchema, { manifestVersion: 1, contributions }), false);
});
