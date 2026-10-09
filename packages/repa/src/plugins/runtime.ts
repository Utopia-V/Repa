import { pathToFileURL } from "node:url";
import path from "node:path";
import { stat } from "node:fs/promises";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { CapabilityHost } from "../capabilities/host.js";
import type { BackendPluginFactory, BackendPluginRegistration } from "../capabilities/types.js";
import type { PluginSettings } from "../configuration/plugins.js";
import { RepaFault } from "../errors.js";
import { createSearchPlugin, SEARCH_PLUGIN_ID } from "../search/plugin.js";
import { discoverPluginResources, packageMatches, selectBackendEntry, type PluginResources } from "./resources.js";
import { snapshotSettings } from "../agent/settings.js";
import type { BundledPluginRegistration, PluginPackage, PluginSelection } from "./schema.js";
import type { SpaceSnapshotParticipant } from "../spaces/schema.js";

export class PluginRuntime {
  readonly capabilities = new CapabilityHost();
  readonly issues: { pluginId: string; message: string }[] = [];
  readonly packages: PluginPackage[] = [];
  #installedSnapshots: SpaceSnapshotParticipant[] = [];
  #cwd = "";
  #trusted: readonly PluginSelection[] = [];

  private constructor(readonly configuration: PluginSettings, readonly trusted: boolean, readonly resources: PluginResources) {}

  static async open(options: {
    cwd: string;
    agentDir?: string;
    trusted: boolean;
    configuration: PluginSettings;
    plugins?: readonly BackendPluginRegistration[];
    bundledPackages?: readonly BundledPluginRegistration[];
  }): Promise<PluginRuntime> {
    const resources = await discoverPluginResources(options);
    const runtime = new PluginRuntime(options.configuration, options.trusted, resources);
    runtime.#cwd = options.cwd;
    runtime.packages.push(...resources.catalog);
    const trusted = options.trusted ? runtime.packages.map(item => ({ kind: "source" as const, source: item.source, scope: item.scope })) : options.configuration.trusted;
    runtime.#trusted = [
      ...trusted,
      ...resources.bundledPackages.map(({ package: item }) => ({ kind: "source" as const, source: item.source, scope: item.scope })),
    ];
    runtime.#installedSnapshots = (options.plugins ?? []).flatMap(plugin => plugin.snapshot ? [plugin.snapshot] : []);
    const ids = new Set([SEARCH_PLUGIN_ID]);
    const registrations = [...(options.plugins ?? []), ...resources.bundledPackages.map(item => item.registration), ...options.configuration.backends];
    for (const registration of registrations) {
      if (ids.has(registration.id)) throw new RepaFault("plugin_conflict", "后台插件标识重复。", { pluginId: registration.id });
      ids.add(registration.id);
    }
    await runtime.capabilities.register({ id: SEARCH_PLUGIN_ID, enabled: !options.configuration.disabled.includes(SEARCH_PLUGIN_ID), factory: createSearchPlugin });
    for (const plugin of options.plugins ?? []) await runtime.capabilities.register({
      ...plugin, enabled: plugin.enabled && !options.configuration.disabled.includes(plugin.id),
    });
    for (const { registration, package: item } of resources.bundledPackages) {
      if (!registration.enabled || !item.backend) continue;
      await runtime.#registerBackend(registration.id, { kind: "source", source: item.source, scope: item.scope });
    }
    for (const configured of options.configuration.backends) {
      if (options.configuration.disabled.includes(configured.id)) continue;
      await runtime.#registerBackend(configured.id, configured.package);
    }
    return runtime;
  }

  async #registerBackend(pluginId: string, selection: PluginSelection): Promise<void> {
    try {
      const entry = selectBackendEntry(this.resources, selection, this.configuration, this.trusted);
      const module: unknown = await import(pathToFileURL(entry.entry).href);
      if (!module || typeof module !== "object" || !("default" in module) || typeof module.default !== "function")
        throw new RepaFault("invalid_plugin", "后台入口必须默认导出插件工厂。");
      await this.capabilities.register({ id: pluginId, enabled: true, factory: module.default as BackendPluginFactory });
    } catch (error) {
      this.issues.push({ pluginId, message: error instanceof Error ? error.message : String(error) });
    }
  }

  resourceSettings(): SettingsManager {
    return snapshotSettings(this.resources.snapshots, this.trusted);
  }

  async snapshotParticipants(): Promise<SpaceSnapshotParticipant[]> {
    const owners = new Map(this.capabilities.snapshotParticipants().map(owner => [owner.id, owner]));
    for (const owner of this.#installedSnapshots) owners.set(owner.id, owner);
    const installed = [
      ...this.configuration.backends,
      ...this.resources.bundledPackages.map(({ registration, package: item }) => ({
        id: registration.id, package: { kind: "source" as const, source: item.source, scope: item.scope },
      })),
    ];
    for (const configured of installed) {
      try { if (!(await stat(path.join(this.#cwd, ".repa", "plugins", configured.id))).isDirectory()) continue; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const matches = this.packages.filter(item => packageMatches(item, configured.package));
      if (matches.length !== 1) continue;
      const item = matches[0];
      if (item?.status !== "ready" || item.snapshot?.status !== "ready" || !this.#trusted.some(selection => packageMatches(item, selection))) continue;
      const module: unknown = await import(pathToFileURL(item.snapshot.entry).href);
      if (!module || typeof module !== "object" || !("default" in module) || typeof module.default !== "function")
        throw new RepaFault("invalid_snapshot_owner", "快照入口必须默认导出所属插件的快照工厂。");
      const factory = module.default as (pluginId: string) => SpaceSnapshotParticipant | Promise<SpaceSnapshotParticipant>;
      const owner = await factory(configured.id);
      if (owner.id !== configured.id || owner.directory !== `.repa/plugins/${configured.id}`)
        throw new RepaFault("invalid_snapshot_owner", "快照入口必须持有自身插件的数据目录。");
      owners.set(owner.id, owner);
    }
    return [...owners.values()];
  }
}
