import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { PluginSettings } from "../src/configuration/plugins.js";
import { discoverPluginResources, type PluginResources } from "../src/plugins/resources.js";
import { PluginRuntime } from "../src/plugins/runtime.js";
import { RepaFault } from "../src/errors.js";
import type { PiSettingsSnapshots } from "../src/plugins/packages.js";

const configuration: PluginSettings = { backends: [], disabled: [], trusted: [], implementations: {} };
const localOff = { extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"] };

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-plugin-resources-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "space");
  const agentDir = path.join(root, "agent");
  const loaded = path.join(root, "loaded.txt");
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await mkdir(path.join(cwd, ".git"));
  await mkdir(agentDir);
  const settings = async (snapshots: PiSettingsSnapshots) => {
    await writeFile(path.join(agentDir, "settings.json"), JSON.stringify(snapshots.global));
    await writeFile(path.join(cwd, ".pi/settings.json"), JSON.stringify(snapshots.project));
  };
  const extension = (name: string) => `import { appendFileSync } from "node:fs";\nexport default function () { appendFileSync(${JSON.stringify(loaded)}, ${JSON.stringify(`${name}\n`)}); }\n`;
  const packageDirectory = async (name: string) => {
    const directory = path.join(root, "packages", name);
    await mkdir(path.join(directory, "skills", `${name}-skill`), { recursive: true });
    await mkdir(path.join(directory, "prompts"));
    await writeFile(path.join(directory, "package.json"), JSON.stringify({
      name, version: "1.0.0", type: "module",
      pi: { extensions: ["./extension.js"], skills: ["./skills"], prompts: ["./prompts"] },
      repa: { manifestVersion: 1, backend: { entry: "./backend.js", api: "^1.0.0" } },
    }));
    await writeFile(path.join(directory, "backend.js"), "throw new Error('静态资源发现不能加载后台工厂');\n");
    await writeFile(path.join(directory, "extension.js"), extension(name));
    await writeFile(path.join(directory, "skills", `${name}-skill`, "SKILL.md"), `---\nname: ${name}-skill\ndescription: 来自 ${name} 的测试技能\n---\n技能正文。\n`);
    await writeFile(path.join(directory, "prompts", `${name}.md`), `---\ndescription: 来自 ${name} 的测试模板\n---\n模板正文。\n`);
    return directory;
  };
  const loader = (resources: PluginResources, trusted: boolean) => {
    const values = { global: JSON.stringify(resources.snapshots.global), project: JSON.stringify(resources.snapshots.project) };
    const settingsManager = SettingsManager.fromStorage({
      withLock(scope, update) {
        const next = update(values[scope]);
        if (next !== undefined) values[scope] = next;
      },
    }, { projectTrusted: trusted });
    return new DefaultResourceLoader({
      cwd, agentDir, settingsManager,
      noExtensions: !trusted, noSkills: !trusted, noPromptTemplates: !trusted,
      noContextFiles: true, noThemes: true, systemPrompt: "", appendSystemPrompt: [],
      additionalExtensionPaths: resources.additionalExtensions,
      additionalSkillPaths: resources.additionalSkills,
      additionalPromptTemplatePaths: resources.additionalPrompts,
    });
  };
  return { root, cwd, agentDir, loaded, settings, packageDirectory, extension, loader };
}

test("未信任整个项目时只装载明确受信任包的 Pi 资源，不执行后台工厂或项目 npmCommand", async (t) => {
  const f = await fixture(t);
  const user = await f.packageDirectory("trusted-user");
  const project = await f.packageDirectory("trusted-project");
  const untrusted = await f.packageDirectory("untrusted");
  const disabled = await f.packageDirectory("disabled");
  const local = path.join(f.cwd, ".pi", "local-extension.js");
  await writeFile(local, f.extension("local-project"));
  const npmMarker = path.join(f.root, "project-npm-command");
  const raw: PiSettingsSnapshots = {
    global: { ...localOff, packages: [user, untrusted, disabled], defaultThinkingLevel: "high", retry: { enabled: false } },
    project: {
      packages: [project, "npm:repa-fixture-never-installed@1.0.0"], extensions: [local], defaultThinkingLevel: "low",
      npmCommand: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(npmMarker)}, '不应执行'); console.log('/not-installed');`],
    },
  };
  await f.settings(raw);
  const resources = await discoverPluginResources({
    cwd: f.cwd, agentDir: f.agentDir, trusted: false,
    configuration: {
      ...configuration,
      trusted: ["trusted-user", "trusted-project", "disabled"].map(name => ({ kind: "package", name })),
      backends: [{ id: "disabled", package: { kind: "package", name: "disabled" } }], disabled: ["disabled"],
    },
  });
  assert(resources.catalog.some(item => item.name === "trusted-project" && item.scope === "project"));
  assert.deepEqual(resources.snapshots.project, {});
  assert.equal(resources.snapshots.global.defaultThinkingLevel, "high");
  assert.deepEqual(resources.snapshots.global.retry, { enabled: false });
  assert.deepEqual(new Set(resources.additionalExtensions), new Set([user, project].map(directory => path.join(directory, "extension.js"))));
  assert.equal(resources.additionalSkills.length, 2);
  assert.equal(resources.additionalPrompts.length, 2);
  assert(!existsSync(f.loaded), "发现不能执行任何入口");
  assert(!existsSync(npmMarker));
  const loader = f.loader(resources, false);
  await loader.reload({ resolveProjectTrust: async () => false });
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.deepEqual(new Set((await readFile(f.loaded, "utf8")).trimEnd().split("\n")), new Set(["trusted-user", "trusted-project"]));
  assert.deepEqual(new Set(loader.getSkills().skills.map(skill => skill.name)), new Set(["trusted-user-skill", "trusted-project-skill"]));
  assert.deepEqual(new Set(loader.getPrompts().prompts.map(prompt => prompt.name)), new Set(["trusted-user", "trusted-project"]));
  assert.deepEqual(JSON.parse(await readFile(path.join(f.cwd, ".pi/settings.json"), "utf8")), raw.project);
  assert(!existsSync(npmMarker));
});

test("完整项目信任仍遵守禁用包与 SDK project delta，静态 Skill 和实际 Loader 使用同一投影", async (t) => {
  const f = await fixture(t);
  const enabled = await f.packageDirectory("enabled");
  const disabled = await f.packageDirectory("disabled");
  const raw: PiSettingsSnapshots = {
    global: { ...localOff, packages: [enabled, disabled], defaultThinkingLevel: "medium" },
    project: { packages: [{ source: enabled, autoload: false, extensions: ["!**/*"], skills: ["./skills/**/*"], prompts: ["!**/*"] }], defaultThinkingLevel: "high" },
  };
  await f.settings(raw);
  const resources = await discoverPluginResources({
    cwd: f.cwd, agentDir: f.agentDir, trusted: true,
    configuration: { ...configuration, backends: [{ id: "disabled", package: { kind: "package", name: "disabled" } }], disabled: ["disabled"] },
  });
  assert.deepEqual(resources.snapshots.global.packages, [enabled]);
  assert.deepEqual(resources.snapshots.project, raw.project);
  assert.deepEqual(resources.additionalExtensions, []);
  assert(!existsSync(f.loaded));
  const loader = f.loader(resources, true);
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 0);
  assert.deepEqual(loader.getSkills().skills.map(skill => skill.name), ["enabled-skill"]);
  assert.deepEqual(loader.getPrompts().prompts, []);
  assert(!existsSync(f.loaded));
});

test("缺少来源与版本的包保持动态缺口，不在发现或随后装载时补装", async (t) => {
  const f = await fixture(t);
  const stale = path.join(f.agentDir, "npm/node_modules/repa-resource-stale");
  await mkdir(stale, { recursive: true });
  const bytes = JSON.stringify({ name: "repa-resource-stale", version: "1.0.0" });
  await writeFile(path.join(stale, "package.json"), bytes);
  const absent = path.join(f.root, "missing-local-package");
  const npmSource = "npm:repa-resource-stale@2.0.0";
  await f.settings({ global: { ...localOff, packages: [npmSource, absent] }, project: {} });
  const resources = await discoverPluginResources({ cwd: f.cwd, agentDir: f.agentDir, trusted: true, configuration });
  assert.deepEqual(new Set(resources.missingPackages), new Set([npmSource, absent]));
  assert(resources.catalog.every(item => item.status === "missing"));
  assert.deepEqual(resources.snapshots.global.packages, []);
  await f.loader(resources, true).reload();
  assert.equal(await readFile(path.join(stale, "package.json"), "utf8"), bytes);
  assert(!existsSync(path.join(f.agentDir, "npm/package.json")));
  assert(!existsSync(absent));
});


test("随应用提供的包默认装载 Skill 与后台，共用禁用门且后台专用包不触发 Extension 回退", async (t) => {
  const f = await fixture(t);
  const mixed = await f.packageDirectory("bundled-mixed");
  const backend = path.join(f.root, "packages", "bundled-backend");
  const skill = path.join(f.root, "packages", "bundled-skill");
  await mkdir(backend);
  await mkdir(path.join(skill, "skills"), { recursive: true });
  await writeFile(path.join(backend, "package.json"), JSON.stringify({
    name: "bundled-backend", type: "module", repa: { manifestVersion: 1, backend: { entry: "./backend.js", api: "^1.0.0" } },
  }));
  const backendLoaded = path.join(f.root, "backend-loaded.txt");
  const factory = `import { appendFileSync } from "node:fs";\nexport default function () { appendFileSync(${JSON.stringify(backendLoaded)}, "backend\\n"); return { capabilities: [] }; }\n`;
  await writeFile(path.join(backend, "backend.js"), factory);
  await writeFile(path.join(mixed, "backend.js"), factory);
  await writeFile(path.join(backend, "index.js"), "throw new Error('后台包不能作为 Extension 装载');\n");
  await writeFile(path.join(skill, "package.json"), JSON.stringify({ name: "bundled-skill", pi: { skills: ["./skills"] } }));
  await writeFile(path.join(skill, "skills", "SKILL.md"), "---\nname: bundled-skill\ndescription: 纯技能包\n---\n技能正文。\n");
  await mkdir(path.join(f.root, ".agents", "skills", "ancestor"), { recursive: true });
  await writeFile(path.join(f.root, ".agents", "skills", "ancestor", "SKILL.md"), "---\nname: ancestor\ndescription: 祖先技能\n---\n不属于包。\n");
  const raw: PiSettingsSnapshots = { global: { ...localOff, defaultThinkingLevel: "high" }, project: {} };
  await f.settings(raw);
  const bundledPackages = [
    { id: "mixed", directory: mixed, enabled: true },
    { id: "backend", directory: backend, enabled: true },
    { id: "skill", directory: skill, enabled: true },
  ];
  const options = { cwd: f.cwd, agentDir: f.agentDir, trusted: false, configuration, bundledPackages };
  const resources = await discoverPluginResources(options);
  assert.equal(resources.catalog.length, 3);
  assert(resources.catalog.every(item => item.scope === "bundled" && item.registrationId));
  assert.equal(resources.catalog.find(item => item.registrationId === "backend")?.piResources, false);
  assert.equal(resources.catalog.find(item => item.registrationId === "skill")?.backend, undefined);
  assert.deepEqual(resources.additionalExtensions, [path.join(mixed, "extension.js")]);
  assert.equal(resources.additionalSkills.length, 2);
  assert(!existsSync(backendLoaded));
  const projectTrusted = await discoverPluginResources({ ...options, trusted: true });
  assert.deepEqual(projectTrusted.additionalSkills, resources.additionalSkills);
  assert.deepEqual(projectTrusted.additionalExtensions, resources.additionalExtensions);
  const runtime = await PluginRuntime.open(options);
  t.after(() => runtime.capabilities.close());
  assert.deepEqual(runtime.issues, []);
  assert.equal(await readFile(backendLoaded, "utf8"), "backend\nbackend\n");
  const loader = f.loader(runtime.resources, false);
  await loader.reload({ resolveProjectTrust: async () => false });
  assert.deepEqual(loader.getSkills().skills.map(item => item.name).sort(), ["bundled-mixed-skill", "bundled-skill"]);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.agentDir, "settings.json"), "utf8")), raw.global);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.cwd, ".pi/settings.json"), "utf8")), raw.project);
  assert.equal(runtime.resourceSettings().getGlobalSettings().packages, undefined);
  const disabled = await PluginRuntime.open({ ...options, configuration: { ...configuration, disabled: ["mixed", "skill"] } });
  t.after(() => disabled.capabilities.close());
  assert.equal(disabled.resources.catalog.length, 3);
  assert.deepEqual(disabled.resources.additionalSkills, []);
  assert.deepEqual(disabled.resources.additionalExtensions, []);
  assert.equal(await readFile(backendLoaded, "utf8"), "backend\nbackend\nbackend\n");
});

test("禁用的随应用包保留安装级快照入口，只在数据目录存在时加载且不启动后台", async (t) => {
  const f = await fixture(t);
  const directory = await f.packageDirectory("bundled-snapshot");
  await writeFile(path.join(directory, "package.json"), JSON.stringify({
    name: "bundled-snapshot", type: "module", pi: { skills: ["./skills"] },
    repa: {
      manifestVersion: 1, backend: { entry: "./backend.js", api: "^1.0.0" }, snapshot: { entry: "./snapshot.js", api: "^1.0.0" },
    },
  }));
  const snapshotLoaded = path.join(f.root, "snapshot-loaded.txt");
  await writeFile(path.join(directory, "snapshot.js"), `import { appendFileSync } from "node:fs";\nexport default function (id) { appendFileSync(${JSON.stringify(snapshotLoaded)}, id); return { id, version: "1", directory: \`.repa/plugins/\${id}\`, capture: async () => [] }; }\n`);
  const runtime = await PluginRuntime.open({
    cwd: f.cwd, agentDir: f.agentDir, trusted: false, configuration,
    bundledPackages: [{ id: "snapshot-owner", directory, enabled: false }],
  });
  t.after(() => runtime.capabilities.close());
  assert.equal(runtime.resources.catalog[0]?.registrationId, "snapshot-owner");
  assert.deepEqual(runtime.resources.additionalSkills, []);
  assert.deepEqual(runtime.issues, []);
  assert(!(await runtime.snapshotParticipants()).some(owner => owner.id === "snapshot-owner"));
  assert(!existsSync(snapshotLoaded));
  await mkdir(path.join(f.cwd, ".repa", "plugins", "snapshot-owner"), { recursive: true });
  assert((await runtime.snapshotParticipants()).some(owner => owner.id === "snapshot-owner"));
  assert.equal(await readFile(snapshotLoaded, "utf8"), "snapshot-owner");
});

test("随应用包的信任不传给同名项目包，重复后台标识仍明确冲突", async (t) => {
  const f = await fixture(t);
  const directory = await f.packageDirectory("bundled-original");
  const project = await f.packageDirectory("project-copy");
  await writeFile(path.join(directory, "backend.js"), "export default function () { return { capabilities: [] }; }\n");
  await writeFile(path.join(project, "package.json"), JSON.stringify({
    name: "bundled-original", type: "module", pi: { extensions: ["./extension.js"], skills: ["./skills"] },
    repa: { manifestVersion: 1, backend: { entry: "./backend.js", api: "^1.0.0" } },
  }));
  await f.settings({ global: {}, project: { packages: [project] } });
  const options = {
    cwd: f.cwd, agentDir: f.agentDir, trusted: false,
    bundledPackages: [{ id: "original", directory, enabled: true }],
  };
  const runtime = await PluginRuntime.open({ ...options, configuration: {
    ...configuration, backends: [{ id: "third-party", package: { kind: "source", source: project, scope: "project" } }],
  } });
  t.after(() => runtime.capabilities.close());
  assert.deepEqual(runtime.issues.map(issue => issue.pluginId), ["third-party"]);
  assert.deepEqual(runtime.resources.additionalExtensions, [path.join(directory, "extension.js")]);
  assert.equal(runtime.resources.additionalSkills.length, 1);
  assert.deepEqual(runtime.resources.snapshots.project, {});
  assert(!existsSync(f.loaded));
  await assert.rejects(PluginRuntime.open({ ...options, configuration: {
    ...configuration, backends: [{ id: "original", package: { kind: "source", source: project, scope: "project" } }],
  } }), error => error instanceof RepaFault && error.code === "plugin_conflict");
  await assert.rejects(PluginRuntime.open({ ...options, configuration,
    plugins: [{ id: "original", enabled: true, factory: () => ({ capabilities: [] }) }],
  }), error => error instanceof RepaFault && error.code === "plugin_conflict");
});
