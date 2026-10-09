import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Type } from "typebox";
import type { ContentFormat } from "../src/content/formats.js";
import type { BackendPluginRegistration, CapabilityBackground } from "../src/capabilities/types.js";
import type { PromptSettings } from "../src/configuration/schema.js";
import type { PluginSettings } from "../src/configuration/plugins.js";
import { ContentStore } from "../src/content/store.js";
import { RepaFault } from "../src/errors.js";
import { planPluginContributions, loadPluginContributions } from "../src/plugins/contributions.js";
import { inspectPluginPackage } from "../src/plugins/packages.js";
import type { PluginResources } from "../src/plugins/resources.js";
import type { PluginPackage } from "../src/plugins/schema.js";

const configuration = (): PluginSettings => ({ backends: [], disabled: [], trusted: [], implementations: {} });
const settings: PromptSettings = { base: "", append: [], projectInstructions: false, skillCatalog: false,
  environment: false, learningContext: false, fileChanges: "on-demand" };
const emptyFactory = () => ({ capabilities: [] });
const fault = (code: string) => (error: unknown) => error instanceof RepaFault && error.code === code;
const source = (item: PluginPackage) => ({ kind: "source" as const, source: item.source, scope: item.scope });
const background = (id: string) => `{
  codec: { id: ${JSON.stringify(id)}, customType: ${JSON.stringify(`${id}-history`)}, snapshot() {} },
  selection: { contract: { id: "fixture.background", version: "1" }, implementationId: "local" },
  input: null, prepare() { throw new Error("prepare不应运行"); }
}`;
const format = (id: string) => `{
  id: ${JSON.stringify(id)}, field: ${JSON.stringify(`${id}Field`)}, schema: { type: "null" }, default: null,
  references() { return []; }, files() { return []; }, remapMetadata(value) { return value; }, remapFile(bytes) { return bytes; }
}`;

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-plugin-contributions-"));
  const contentRoot = path.join(root, "space");
  await mkdir(contentRoot);
  const content = await ContentStore.open({ root: contentRoot, spaceId: randomUUID(), assertOwned() {} });
  t.after(async () => { await content.settled(); await rm(root, { recursive: true, force: true }); });
  const resources: PluginResources = { catalog: [], bundledPackages: [], snapshots: { global: {}, project: {} },
    additionalExtensions: [], additionalSkills: [], additionalPrompts: [], missingPackages: [] };
  const create = async (name: string, value = `{backgrounds:[${background(name)}],formats:[${format(name)}]}`,
    options: { api?: string; entry?: string; scope?: "user" | "project" | "bundled"; contribution?: boolean; version?: string } = {}) => {
    const directory = path.join(root, name);
    await mkdir(directory);
    const marker = path.join(directory, "imported");
    const backendMarker = path.join(directory, "backend-ran");
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ name, type: "module", version: options.version ?? "1.0.0", repa: {
      manifestVersion: 1, backend: { entry: "./backend.js", api: "^2" },
      ...(options.contribution === false ? {} : { contributions: { entry: options.entry ?? "./contributions.js", api: options.api ?? "^1" } }),
    } }));
    await writeFile(path.join(directory, "backend.js"), `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(backendMarker)},"imported"); export default ()=>{throw Error("factory不应运行")};`);
    await writeFile(path.join(directory, "contributions.js"), `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)},"imported"); export default ${value};`);
    const item = await inspectPluginPackage({ source: directory, scope: options.scope ?? "user", installedPath: directory });
    resources.catalog.push(item);
    return { item, marker, backendMarker };
  };
  return { root, content, resources, create };
}

test("静态计划无执行，信任已配置的禁用包仍加载格式codec且不运行backend", async t => {
  const f = await fixture(t);
  const selected = await f.create("selected");
  const other = await f.create("unselected");
  const config = configuration();
  config.backends = [{ id: "selected", package: source(selected.item) }];
  config.trusted = [source(selected.item), source(other.item)];
  config.disabled = ["selected"];
  const plan = planPluginContributions({ resources: f.resources, configuration: config, trusted: false });
  assert(!existsSync(selected.marker));
  const enabledPlan = planPluginContributions({ resources: f.resources, configuration: { ...config, disabled: [] }, trusted: false });
  assert.equal(enabledPlan.identity, plan.identity);
  assert.equal(plan.entries.length, 1);
  const loaded = await loadPluginContributions(plan);
  assert.deepEqual(loaded.issues, []);
  assert.equal(loaded.contributions.formats[0]?.id, "selected");
  const sources = loaded.contributions.backgrounds(config, { content: f.content });
  assert.equal(sources[0]?.codec.id, "selected");
  assert.equal(sources[0]?.enabled(settings), false);
  assert(existsSync(selected.marker));
  assert(!existsSync(selected.backendMarker));
  assert(!existsSync(other.marker));
});

test("不信任零import，应用授权bundled关闭后仍提供贡献，direct贡献不运行factory", async t => {
  const f = await fixture(t);
  const selected = await f.create("untrusted");
  const config = configuration();
  config.backends = [{ id: "untrusted", package: source(selected.item) }];
  const denied = planPluginContributions({ resources: f.resources, configuration: config, trusted: false });
  assert.equal(denied.entries.length, 0);
  assert.equal((await loadPluginContributions(denied)).issues.length, 1);
  assert(!existsSync(selected.marker));
  const trusted = planPluginContributions({ resources: f.resources, configuration: config, trusted: true });
  assert.notEqual(trusted.identity, denied.identity);
  const bundled = await f.create("bundled", undefined, { scope: "bundled" });
  f.resources.bundledPackages.push({ registration: { id: "bundled", directory: bundled.item.installedPath ?? "", enabled: false }, package: bundled.item });
  let factoryCalls = 0;
  const direct: BackendPluginRegistration = { id: "direct", enabled: false,
    factory() { factoryCalls++; return { capabilities: [] }; }, formats: [], backgrounds: [] };
  const installed = await loadPluginContributions(planPluginContributions({ resources: f.resources,
    configuration: configuration(), plugins: [direct], trusted: false }));
  assert.deepEqual(installed.issues, []);
  assert.equal(installed.contributions.formats[0]?.id, "bundled");
  assert.equal(installed.contributions.backgrounds(configuration(), { content: f.content })[0]?.enabled(settings), false);
  assert(existsSync(bundled.marker));
  assert.equal(factoryCalls, 0);
});

test("来源歧义、入口API和缺失独立报告，身份忽略backend-only与运行开关", async t => {
  const f = await fixture(t);
  const first = await f.create("ambiguous");
  const duplicate = { ...first.item, source: `${first.item.source}-project`, scope: "project" as const };
  f.resources.catalog.push(duplicate);
  const config = configuration();
  config.backends = [{ id: "ambiguous", package: { kind: "package", name: "ambiguous" } }];
  const ambiguous = planPluginContributions({ resources: f.resources, configuration: config, trusted: true });
  assert.equal(ambiguous.entries.length, 0);
  assert.equal((await loadPluginContributions(ambiguous)).issues.length, 1);
  assert(!existsSync(first.marker));
  f.resources.catalog.pop();
  const unique = planPluginContributions({ resources: f.resources, configuration: config, trusted: true });
  assert.notEqual(unique.identity, ambiguous.identity);
  assert.equal(unique.entries.length, 1);
  for (const options of [{ api: "^2" }, { entry: "./missing.js" }, { entry: "../../outside.js" }]) {
    const pkg = await f.create(`invalid-${f.resources.catalog.length}`, undefined, options);
    const cfg = { ...configuration(), backends: [{ id: "invalid", package: source(pkg.item) }] };
    const planned = planPluginContributions({ resources: f.resources, configuration: cfg, trusted: true });
    assert.equal(planned.entries.length, 0);
    assert.equal((await loadPluginContributions(planned)).issues.length, 1);
    assert(!existsSync(pkg.marker));
  }
  const backendOnly = await f.create("backend-only", undefined, { contribution: false });
  const noContribution = planPluginContributions({ resources: f.resources, configuration: {
    ...configuration(), backends: [{ id: "backend-only", package: source(backendOnly.item) }],
  }, trusted: true });
  assert.equal(noContribution.identity, "[]");
  assert.deepEqual(noContribution.entries, []);
  const disappeared = planPluginContributions({ resources: { ...f.resources, catalog: [] }, configuration: config, trusted: true });
  assert.notEqual(disappeared.identity, unique.identity);
  const changed = planPluginContributions({ resources: { ...f.resources, catalog: [{ ...first.item, version: "2.0.0" }] }, configuration: config, trusted: true });
  assert.notEqual(changed.identity, unique.identity);
});

test("所有插件标识含内建ID统一拒绝冲突，坏default成为issue而背景格式冲突使装配失败", async t => {
  const f = await fixture(t);
  for (const id of ["repa-search", "bad/id"]) {
    assert.throws(() => planPluginContributions({ resources: f.resources, configuration: configuration(), trusted: true,
      plugins: [{ id, enabled: true, factory: emptyFactory }] }), fault(id === "repa-search" ? "plugin_conflict" : "invalid_plugin"));
  }
  assert.throws(() => planPluginContributions({ resources: f.resources,
    configuration: { ...configuration(), backends: [{ id: "duplicate", package: { kind: "package", name: "absent" } }] },
    plugins: [{ id: "duplicate", enabled: true, factory: emptyFactory }], trusted: true,
  }), fault("plugin_conflict"));
  for (const [index, value] of ["()=>({})", "[]", "null", "new Map()", "Promise.resolve({})", "(()=>{throw new Error(\"加载失败\")})()", "{formats:{}}", "{backgrounds:[{}]}",
    "{capabilities:[]}", `{formats:[{...${format("bad")},default:1}]}`].entries()) {
    const pkg = await f.create(`bad-${index}`, value);
    const cfg = { ...configuration(), backends: [{ id: `bad-${index}`, package: source(pkg.item) }] };
    const loaded = await loadPluginContributions(planPluginContributions({ resources: f.resources, configuration: cfg, trusted: true }));
    assert.equal(loaded.issues.length, 1);
    assert.deepEqual(loaded.contributions.formats, []);
    assert(existsSync(pkg.marker));
    assert(!existsSync(pkg.backendMarker));
  }
  for (const [kind, value, code] of [
    ["background", `{backgrounds:[${background("shared")}]}`, "background_conflict"],
    ["format", `{formats:[${format("shared")}]}`, "content_format_conflict"],
  ]) {
    const a = await f.create(`${kind}-one`, value);
    const b = await f.create(`${kind}-two`, value);
    const cfg = { ...configuration(), backends: [a, b].map(({ item }) => ({ id: item.name ?? "", package: source(item) })) };
    await assert.rejects(loadPluginContributions(planPluginContributions({ resources: f.resources, configuration: cfg, trusted: true })), fault(code ?? ""));
  }
  assert.equal(await readFile(path.join(f.root, "bad-0", "imported"), "utf8"), "imported");
});


test("贡献格式与背景保留class及prototype getter的实际接口，与direct注册一致", async t => {
  const f = await fixture(t);
  class DirectFormat implements ContentFormat {
    id = "prototype-direct";
    field = "prototypeDirect";
    schema = Type.Null();
    get default() { return null; }
    references() { return []; }
    files() { return []; }
    remapMetadata(value: unknown) { return value; }
    remapFile(bytes: Buffer) { return bytes; }
  }
  class DirectBackground implements CapabilityBackground {
    codec = { id: "prototype-direct", customType: "prototype-direct-history", snapshot() {} };
    selection = { contract: { id: "fixture.background", version: "1" }, implementationId: "local" };
    get input() { return null; }
    prepare(): never { throw new Error("prepare不应运行"); }
  }
  const pkg = await f.create("prototype-module", `{
    formats: [new (class {
      id="prototype-module"; field="prototypeModule"; schema={type:"null"};
      get default() { return null; }
      references() { return []; } files() { return []; }
      remapMetadata(value) { return value; } remapFile(bytes) { return bytes; }
    })()],
    backgrounds: [new (class {
      codec={id:"prototype-module",customType:"prototype-module-history",snapshot(){}};
      selection={contract:{id:"fixture.background",version:"1"},implementationId:"local"};
      get input(){return null;} prepare(){throw Error("prepare不应运行");}
    })()]
  }`);
  const cfg = { ...configuration(), backends: [{ id: "prototype-module", package: source(pkg.item) }] };
  const loaded = await loadPluginContributions(planPluginContributions({ resources: f.resources, configuration: cfg, trusted: true,
    plugins: [{ id: "prototype-direct", enabled: true, factory: emptyFactory,
      formats: [new DirectFormat()], backgrounds: [new DirectBackground()] }],
  }));
  assert.deepEqual(loaded.issues, []);
  assert.deepEqual(loaded.contributions.formats.map(item => item.default), [null, null]);
  assert.deepEqual(loaded.contributions.backgrounds(cfg, { content: f.content }).map(item => item.codec.id),
    ["prototype-direct", "prototype-module"]);
});
