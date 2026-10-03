import path from "node:path";
import { DefaultPackageManager, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import type { PluginSettings } from "../configuration/plugins.js";
import { RepaFault } from "../errors.js";
import { PluginPackages, inspectPluginPackage, piPackageResources, projectPiPackages, type PiSettingsSnapshots } from "./packages.js";
import { BundledPluginRegistrationSchema, type BundledPluginRegistration, type PluginPackage, type PluginSelection } from "./schema.js";

export interface PluginResources {
  catalog: PluginPackage[];
  bundledPackages: { registration: BundledPluginRegistration; package: PluginPackage }[];
  snapshots: PiSettingsSnapshots;
  additionalExtensions: string[];
  additionalSkills: string[];
  additionalPrompts: string[];
  missingPackages: string[];
}

export function packageMatches(item: PluginPackage, selection: PluginSelection): boolean {
  return selection.kind === "package" ? item.name === selection.name : item.source === selection.source && item.scope === selection.scope;
}

/** 预览与运行共用静态选择；此处只核对目录，不执行包入口。 */
export function selectBackendEntry(resources: PluginResources, selection: PluginSelection,
  configuration: PluginSettings, trustAll: boolean): NonNullable<PluginPackage["backend"]> {
  const matches = resources.catalog.filter(item => packageMatches(item, selection));
  if (matches.length !== 1) throw new RepaFault("package_selection", "请选择唯一的包来源与作用域。");
  const item = matches[0];
  if (!item || item.status !== "ready" || item.backend?.status !== "ready")
    throw new RepaFault("plugin_unavailable", "后台入口缺失、无效或不兼容。");
  if (item.scope === "bundled") {
    if (!resources.bundledPackages.some(entry => entry.package === item && entry.registration.enabled))
      throw new RepaFault("plugin_unavailable", "随应用提供的包已关闭。");
  } else if (!trustAll && !configuration.trusted.some(trusted => packageMatches(item, trusted))) {
    throw new RepaFault("plugin_untrusted", "该包尚未取得本机代码执行信任。");
  }
  return item.backend;
}

function memorySettings(snapshots: PiSettingsSnapshots): SettingsManager {
  const values = { global: JSON.stringify(snapshots.global), project: JSON.stringify(snapshots.project) };
  return SettingsManager.fromStorage({
    withLock(scope, update) {
      const next = update(values[scope]);
      if (next !== undefined) values[scope] = next;
    },
  }, { projectTrusted: true });
}

/** 只发现包及静态资源，不导入入口、不安装缺包，也不放行未受信任的项目设置。 */
export async function discoverPluginResources(options: {
  cwd: string;
  agentDir?: string;
  trusted: boolean;
  configuration: PluginSettings;
  bundledPackages?: readonly BundledPluginRegistration[];
}): Promise<PluginResources> {
  const cwd = path.resolve(options.cwd);
  const agentDir = path.resolve(options.agentDir ?? getAgentDir());
  // SDK 不提供未受信任项目的原始快照；这里只读取，交给 resolver 前剔除项目执行性设置。
  const source = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const errors = source.drainErrors();
  if (errors.length) throw new RepaFault("package_settings", "包配置未能完整读取，请核对配置文件。", {
    scopes: [...new Set(errors.map(error => error.scope))],
  });
  const project = source.getProjectSettings();
  const discovery: PiSettingsSnapshots = {
    global: source.getGlobalSettings(),
    project: options.trusted ? project : project.packages ? { packages: project.packages } : {},
  };
  const catalog = await new PluginPackages({ cwd, agentDir, settingsManager: memorySettings(discovery) }).list();
  const ids = new Set<string>();
  const bundledPackages = await Promise.all((options.bundledPackages ?? []).map(async registration => {
    if (!Check(BundledPluginRegistrationSchema, registration) || !path.isAbsolute(registration.directory))
      throw new RepaFault("invalid_plugin", "随应用提供的包必须声明标识及绝对包目录。");
    if (ids.has(registration.id)) throw new RepaFault("plugin_conflict", "随应用提供的包标识重复。", { pluginId: registration.id });
    ids.add(registration.id);
    const item = await inspectPluginPackage({
      source: registration.directory, scope: "bundled", installedPath: registration.directory, registrationId: registration.id,
    });
    return {
      registration: { ...registration, enabled: registration.enabled && !options.configuration.disabled.includes(registration.id) },
      package: item,
    };
  }));
  const trusted: readonly PluginSelection[] = options.trusted
    ? catalog.map(item => ({ kind: "source", source: item.source, scope: item.scope }))
    : options.configuration.trusted;
  const disabled = options.configuration.backends.filter(item => options.configuration.disabled.includes(item.id));
  const enabled = catalog.filter(item => !disabled.some(entry => packageMatches(item, entry.package)))
    .map(item => ({ kind: "source" as const, source: item.source, scope: item.scope }));
  const selected = projectPiPackages(discovery, catalog, { enabled, trusted });
  const missingPackages = new Set(catalog.filter(item => item.status === "missing" &&
    enabled.some(selection => packageMatches(item, selection)) && trusted.some(selection => packageMatches(item, selection)))
    .map(item => item.source));
  const paths = await new DefaultPackageManager({ cwd, agentDir, settingsManager: memorySettings(selected) }).resolve(async missing => {
    missingPackages.add(missing);
    return "skip";
  });
  // Pi 只认识 user/project；这份独立内存输入不进入用户快照，来源仍由 bundled catalog 持有。
  const bundledSources = bundledPackages.filter(({ registration, package: item }) => registration.enabled && item.status === "ready")
    .map(({ package: item }) => piPackageResources(item.source, item));
  const bundledPaths = bundledSources.length ? await new DefaultPackageManager({
    cwd, agentDir, settingsManager: memorySettings({ global: { packages: bundledSources }, project: {} }),
  }).resolve(async missing => {
    missingPackages.add(missing);
    return "skip";
  }) : { extensions: [], skills: [], prompts: [], themes: [] };
  for (const { registration, package: item } of bundledPackages)
    if (registration.enabled && item.status === "missing") missingPackages.add(item.source);
  const bundledIdentities = new Set(bundledSources.map(source => typeof source === "string" ? source : source.source));
  const additional = (kind: "extensions" | "skills" | "prompts") => [...new Set([
    ...(options.trusted ? [] : paths[kind].filter(resource => resource.enabled && resource.metadata.origin === "package").map(resource => resource.path)),
    ...bundledPaths[kind].filter(resource => resource.enabled && resource.metadata.origin === "package" && bundledIdentities.has(resource.metadata.source))
      .map(resource => resource.path),
  ])];
  return {
    catalog: [...catalog, ...bundledPackages.map(item => item.package)],
    bundledPackages,
    snapshots: { global: selected.global, project: options.trusted ? selected.project : {} },
    additionalExtensions: additional("extensions"),
    additionalSkills: additional("skills"),
    additionalPrompts: additional("prompts"),
    missingPackages: [...missingPackages],
  };
}
