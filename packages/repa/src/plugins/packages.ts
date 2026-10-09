import { readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DefaultPackageManager, SettingsManager, type PackageSource } from "@earendil-works/pi-coding-agent";
import { satisfies, validRange } from "semver";
import { Check } from "typebox/value";
import { snapshotSettings } from "../agent/settings.js";
import { RepaFault } from "../errors.js";
import {
  PluginManifestSchema,
  type PluginEntry, type PluginPackage, type PluginSelection,
} from "./schema.js";

export const PLUGIN_API_VERSION = "1.0.0";
type PiSettings = ReturnType<SettingsManager["getGlobalSettings"]>;
export type PiSettingsSnapshots = { global: PiSettings; project: PiSettings };
type ConfiguredPackage = ReturnType<DefaultPackageManager["listConfiguredPackages"]>[number];
type PackageScope = ConfiguredPackage["scope"];
type ResolvedEntry = NonNullable<PluginPackage["backend"]>;
const RESOURCE_TYPES = ["extensions", "skills", "prompts", "themes"] as const;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function inside(directory: string, target: string): boolean {
  const relative = path.relative(directory, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function exists(directory: string): Promise<boolean> {
  try { return (await stat(directory)).isDirectory(); } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

function selected(item: PluginPackage, selections: readonly PluginSelection[]): boolean {
  return selections.some((selection) => selection.kind === "package"
    ? item.name === selection.name
    : item.source === selection.source && item.scope === selection.scope);
}

/** 后台包不能触发 Pi 的 Extension 目录回退；两类包来源复用相同过滤。 */
export function piPackageResources(source: PackageSource, item: PluginPackage): PackageSource {
  if (item.manifestVersion !== 1 || item.piResources) return source;
  const filtered = typeof source === "string" ? { source } : source;
  return { ...filtered, extensions: [], skills: [], prompts: [], themes: [] };
}

/** 仅投影已有包选择；不写安装设置，也不授予发现到的代码执行权限。 */
export function projectPiPackages(
  snapshots: PiSettingsSnapshots,
  catalog: readonly PluginPackage[],
  selection: { enabled: readonly PluginSelection[]; trusted: readonly PluginSelection[] },
): PiSettingsSnapshots {
  const result = structuredClone(snapshots);
  for (const scope of ["global", "project"] as const) {
    const packageScope = scope === "global" ? "user" : "project";
    const packages = result[scope].packages;
    if (!packages) continue;
    result[scope].packages = packages.flatMap((source): PackageSource[] => {
      const identity = typeof source === "string" ? source : source.source;
      const item = catalog.find((entry) => entry.source === identity && entry.scope === packageScope);
      if (!item || item.status !== "ready" || !selected(item, selection.enabled) || !selected(item, selection.trusted)) return [];
      return [piPackageResources(source, item)];
    });
  }
  return result;
}

async function inspectEntry(directory: string, definition: PluginEntry, issues: PluginPackage["issues"]): Promise<ResolvedEntry> {
  const entry = path.resolve(directory, definition.entry);
  const result: ResolvedEntry = { entry, api: definition.api, status: "ready" };
  if (path.isAbsolute(definition.entry) || !inside(directory, entry)) {
    result.status = "invalid";
    issues.push({ code: "entry_outside_package", message: "包入口必须是包目录中的相对文件。" });
  } else {
    try {
      const resolved = await realpath(entry);
      if (!inside(directory, resolved) || !(await stat(resolved)).isFile()) {
        result.status = "invalid";
        issues.push({ code: "entry_invalid", message: "包入口不是包内的普通文件。" });
      } else result.entry = resolved;
    } catch (error) {
      if (!missing(error)) throw error;
      result.status = "missing";
      issues.push({ code: "entry_missing", message: "声明的包入口文件不存在。" });
    }
  }
  const range = validRange(definition.api);
  if (!range || !satisfies(PLUGIN_API_VERSION, range)) {
    if (result.status === "ready") result.status = "incompatible";
    issues.push({ code: range ? "api_incompatible" : "api_invalid", message: `包入口 API 范围不能由宿主 ${PLUGIN_API_VERSION} 满足。` });
  }
  return result;
}

export async function inspectPluginPackage(configured: Pick<PluginPackage, "source" | "scope" | "installedPath" | "registrationId">): Promise<PluginPackage> {
  const item: PluginPackage = {
    source: configured.source, scope: configured.scope, status: "missing",
    piResources: false, frontends: [], issues: [],
    ...(configured.registrationId ? { registrationId: configured.registrationId } : {}),
    ...(configured.installedPath ? { installedPath: configured.installedPath } : {}),
  };
  if (!configured.installedPath) {
    item.issues.push({ code: "package_missing", message: "包来源尚未安装或本地路径不存在。" });
    return item;
  }
  let directory: string;
  let isDirectory: boolean;
  try {
    directory = await realpath(configured.installedPath);
    isDirectory = (await stat(directory)).isDirectory();
  } catch (error) {
    if (!missing(error)) throw error;
    item.issues.push({ code: "package_missing", message: "包来源在发现期间已被移除。" });
    return item;
  }
  item.installedPath = directory;
  if (!isDirectory) {
    // 普通 Pi 单文件扩展没有 package.json，也无需伪造 Repa 包入口。
    item.status = "ready";
    item.piResources = true;
    return item;
  }
  let manifest: unknown;
  try {
    const bytes = await readFile(path.join(directory, "package.json"), "utf8");
    try { manifest = JSON.parse(bytes.replace(/^\uFEFF/, "")); } catch {
      item.status = "invalid";
      item.issues.push({ code: "package_manifest", message: "package.json 不是有效 JSON。" });
      return item;
    }
  } catch (error) {
    if (!missing(error)) throw error;
    item.status = "ready";
    item.piResources = true;
    return item;
  }
  if (!record(manifest)) {
    item.status = "invalid";
    item.issues.push({ code: "package_manifest", message: "package.json 必须是对象。" });
    return item;
  }
  if (typeof manifest.name === "string" && manifest.name.length) item.name = manifest.name;
  if (typeof manifest.version === "string" && manifest.version.length) item.version = manifest.version;
  // 与 SDK 的声明和约定目录并行判断；只有 Repa 入口时才禁止 Extension 目录回退。
  const directories = await Promise.all(RESOURCE_TYPES.map((kind) => exists(path.join(directory, kind))));
  const pi = manifest.pi;
  const declaredResources = record(pi) && RESOURCE_TYPES.some((kind) => {
    const entries = pi[kind];
    return Array.isArray(entries) && entries.length > 0 && entries.every((entry: unknown) => typeof entry === "string");
  });
  item.piResources = manifest.repa === undefined || declaredResources || directories.some(Boolean);
  item.status = "ready";
  if (configured.source.startsWith("npm:")) {
    const spec = configured.source.slice(4);
    const separator = spec.lastIndexOf("@");
    const range = separator > 0 ? validRange(spec.slice(separator + 1)) : null;
    if (range && (!item.version || !satisfies(item.version, range))) {
      item.status = "missing";
      item.issues.push({ code: "package_version", message: "已安装版本不满足配置来源，需显式安装相应版本。" });
    }
  }
  if (manifest.repa === undefined) return item;
  if (record(manifest.repa) && typeof manifest.repa.manifestVersion === "number" && Number.isInteger(manifest.repa.manifestVersion))
    item.manifestVersion = manifest.repa.manifestVersion;
  if (!Check(PluginManifestSchema, manifest.repa)) {
    item.status = "invalid";
    item.issues.push({ code: "repa_manifest", message: "Repa 包声明无效，宿主仅支持 manifestVersion 1。" });
    return item;
  }
  item.manifestVersion = 1;
  if (manifest.repa.backend) item.backend = await inspectEntry(directory, manifest.repa.backend, item.issues);
  if (manifest.repa.snapshot) item.snapshot = await inspectEntry(directory, manifest.repa.snapshot, item.issues);
  if (manifest.repa.contributions) item.contributions = await inspectEntry(directory, manifest.repa.contributions, item.issues);
  item.frontends = await Promise.all((manifest.repa.frontends ?? []).map(async (frontend) => ({
    ...await inspectEntry(directory, frontend, item.issues), environment: frontend.environment,
  })));
  return item;
}

export class PluginPackages {
  readonly #cwd: string;
  readonly #agentDir: string;
  readonly #settings: SettingsManager;
  readonly #trusted: boolean;

  constructor(options: { cwd: string; agentDir: string; trusted?: boolean; settingsManager?: SettingsManager }) {
    this.#cwd = path.resolve(options.cwd);
    this.#agentDir = path.resolve(options.agentDir);
    this.#trusted = options.trusted ?? false;
    // 原设置 owner 仅负责文件读写；其项目内容不会直接交给包执行器。
    this.#settings = options.settingsManager ?? SettingsManager.create(this.#cwd, this.#agentDir, { projectTrusted: true });
    this.#settings.setProjectTrusted(true);
  }

  #settingsErrors(): void {
    const errors = this.#settings.drainErrors();
    if (errors.length) throw new RepaFault("package_settings", "包配置未能完整读取或保存，请核对配置文件。", {
      scopes: [...new Set(errors.map((error) => error.scope))],
    });
  }

  async #refresh(): Promise<void> {
    await this.#settings.reload();
    this.#settingsErrors();
  }

  #execution(scope?: PackageScope): { settings: SettingsManager; manager: DefaultPackageManager } {
    const project = this.#settings.getProjectSettings();
    const snapshots: PiSettingsSnapshots = {
      global: this.#settings.getGlobalSettings(),
      project: this.#trusted ? project : project.packages ? { packages: project.packages } : {},
    };
    if (scope === "project") snapshots.global.packages = [];
    if (scope === "user") snapshots.project.packages = [];
    const settings = snapshotSettings(snapshots, true);
    return { settings, manager: new DefaultPackageManager({ cwd: this.#cwd, agentDir: this.#agentDir, settingsManager: settings }) };
  }

  async list(): Promise<PluginPackage[]> {
    await this.#refresh();
    const { manager } = this.#execution();
    let packages: ConfiguredPackage[];
    try {
      // resolve 的缺包默认行为是安装；目录查询必须显式跳过，不能执行安装脚本。
      await manager.resolve(async () => "skip");
      packages = manager.listConfiguredPackages();
    } catch (error) {
      const fault = new RepaFault("package_discovery", "无法解析包来源或资源过滤，请检查配置与实际安装位置。");
      fault.cause = error;
      throw fault;
    }
    return Promise.all(packages.map(async (item) => {
      try {
        return await inspectPluginPackage(item);
      } catch (error) {
        const fault = new RepaFault("package_access", "读取插件包元数据或入口位置失败。", { source: item.source, scope: item.scope });
        fault.cause = error;
        throw fault;
      }
    }));
  }

  #absolute(source: string, scope: PackageScope): string {
    const expanded = source.startsWith("~/") ? path.join(os.homedir(), source.slice(2)) : source;
    return path.resolve(scope === "user" ? this.#agentDir : path.join(this.#cwd, ".pi"), expanded);
  }

  #operationSource(manager: DefaultPackageManager, source: string, scope: PackageScope): string {
    const configured = manager.listConfiguredPackages().find((item) => item.source === source && item.scope === scope);
    if (!configured) return source;
    const absolute = this.#absolute(source, scope);
    // SDK 保存 local source 时相对所属设置目录，操作输入则相对 cwd。
    if (configured.installedPath && path.resolve(configured.installedPath) === absolute) return absolute;
    return source;
  }

  async #finish(scope: PackageScope, persist: boolean, work: (manager: DefaultPackageManager) => Promise<unknown>): Promise<PluginPackage[]> {
    await this.#refresh();
    const { manager, settings } = this.#execution(scope);
    try {
      await work(manager);
      await settings.flush();
      const errors = settings.drainErrors();
      if (errors.length) throw new RepaFault("package_settings", "包来源的内存设置未能完整保存。");
      if (persist) {
        if (scope === "project") this.#settings.setProjectPackages(settings.getProjectSettings().packages ?? []);
        else this.#settings.setPackages(settings.getGlobalSettings().packages ?? []);
      }
    } catch (error) {
      if (error instanceof RepaFault) throw error;
      const fault = new RepaFault("package_operation", "包管理操作未能完整确认，请重新发现来源并检查实际状态。");
      fault.cause = error;
      throw fault;
    }
    await this.#settings.flush();
    this.#settingsErrors();
    return this.list();
  }

  async install(source: string, options?: { local?: boolean }): Promise<PluginPackage[]> {
    const scope = options?.local ? "project" : "user";
    return this.#finish(scope, true, manager => manager.installAndPersist(this.#operationSource(manager, source, scope), options));
  }

  async update(source?: string, options?: { local?: boolean }): Promise<PluginPackage[]> {
    const scope = options?.local ? "project" : "user";
    return this.#finish(scope, false, manager => manager.update(source ? this.#operationSource(manager, source, scope) : source));
  }

  async remove(source: string, options?: { local?: boolean }): Promise<PluginPackage[]> {
    const scope = options?.local ? "project" : "user";
    return this.#finish(scope, true, async manager => {
      const configured = manager.listConfiguredPackages().some((item) => item.source === source && item.scope === scope);
      const changed = await manager.removeAndPersist(this.#operationSource(manager, source, scope), options);
      // 缺失 local 目录也要能解除配置，不让重开宿主再次尝试同一来源。
      if (!changed && configured && !manager.removeSourceFromSettings(this.#absolute(source, scope), options))
        throw new RepaFault("package_source", "包来源与所属设置目录不一致，请重新读取来源后再移除。");
    });
  }
}
