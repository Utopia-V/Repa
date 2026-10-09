import { pathToFileURL } from "node:url";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import { InstalledContributions } from "../agent/contributions.js";
import type { BackendPluginRegistration, PluginContributions } from "../capabilities/types.js";
import { CapabilitySelectionSchema } from "../capabilities/schema.js";
import type { PluginSettings } from "../configuration/plugins.js";
import { canonicalJson } from "../content/store.js";
import { RepaFault } from "../errors.js";
import { IdSchema } from "../schema.js";
import { SEARCH_PLUGIN_ID } from "../search/plugin.js";
import { packageMatches, type PluginResources } from "./resources.js";
import type { PluginPackage, PluginSelection } from "./schema.js";

type ContributionRegistration = Pick<BackendPluginRegistration, "id" | "enabled" | "backgrounds" | "formats">;
export interface PluginContributionIssue { pluginId: string; message: string }
export interface PluginContributionPlan {
  identity: string;
  registrations: ContributionRegistration[];
  entries: { pluginId: string; enabled: boolean; entry: string }[];
  issues: PluginContributionIssue[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** 不调用 codec、准备或重映射函数；这里只核对模块导出所需的最小契约。 */
function validateContributions(value: unknown): PluginContributions {
  if (!record(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(key => key !== "backgrounds" && key !== "formats") ||
    (value.backgrounds !== undefined && !Array.isArray(value.backgrounds)) ||
    (value.formats !== undefined && !Array.isArray(value.formats)))
    throw new RepaFault("invalid_plugin", "贡献入口必须默认导出仅包含背景与持久格式的轻量对象。");
  for (const background of value.backgrounds ?? []) {
    if (!record(background) || !record(background.codec) || !nonempty(background.codec.id) ||
      !nonempty(background.codec.customType) || typeof background.codec.snapshot !== "function" ||
      !Check(CapabilitySelectionSchema, background.selection) || !("input" in background) ||
      typeof background.prepare !== "function" || (background.enabled !== undefined && typeof background.enabled !== "function") ||
      (background.preview !== undefined && (!record(background.preview) || !nonempty(background.preview.implementationId) ||
        typeof background.preview.read !== "function")))
      throw new RepaFault("invalid_plugin", "贡献背景的 codec、能力选择或准备入口无效。");
  }
  for (const format of value.formats ?? []) {
    if (!record(format) || !nonempty(format.id) || !nonempty(format.field) || !record(format.schema) ||
      !("default" in format) || ["version", "items", "__proto__", "constructor", "prototype"].includes(format.field) ||
      ["references", "files", "remapMetadata", "remapFile"].some(key => typeof format[key] !== "function"))
      throw new RepaFault("invalid_plugin", "贡献持久格式的字段、schema 或处理入口无效。");
    try {
      if (!Check(format.schema as TSchema, format.default)) throw new Error("默认值不符合 schema");
    } catch {
      throw new RepaFault("invalid_plugin", "贡献持久格式的 schema 或默认值无效。");
    }
  }
  // 上面已按所有实际消费字段验证；函数签名属于模块的 TypeScript 契约。
  return value as PluginContributions;
}

/** 静态发现快照不受运行开关影响；变化后由应用要求重启，不能热换历史解释。 */
export function planPluginContributions(options: {
  resources: PluginResources;
  configuration: PluginSettings;
  plugins?: readonly BackendPluginRegistration[];
  trusted: boolean;
}): PluginContributionPlan {
  const { resources, configuration } = options;
  const plan: PluginContributionPlan = { identity: "", registrations: [], entries: [], issues: [] };
  const ids = new Set([SEARCH_PLUGIN_ID]);
  const checkId = (id: string) => {
    if (!Check(IdSchema, id)) throw new RepaFault("invalid_plugin", "插件身份无效。", { pluginId: id });
    if (ids.has(id)) throw new RepaFault("plugin_conflict", "后台插件标识重复。", { pluginId: id });
    ids.add(id);
  };
  for (const plugin of options.plugins ?? []) {
    checkId(plugin.id);
    if (typeof plugin.enabled !== "boolean" || typeof plugin.factory !== "function")
      throw new RepaFault("invalid_plugin", "插件启用状态或工厂无效。", { pluginId: plugin.id });
    const contributions = validateContributions({ backgrounds: plugin.backgrounds, formats: plugin.formats });
    plan.registrations.push({ id: plugin.id, enabled: plugin.enabled, ...contributions });
  }
  for (const { registration } of resources.bundledPackages) {
    checkId(registration.id);
    if (typeof registration.enabled !== "boolean") throw new RepaFault("invalid_plugin", "随应用包启用状态无效。");
  }
  for (const backend of configuration.backends) checkId(backend.id);
  const identities: unknown[] = [];
  const selection = (pluginId: string, selected: PluginSelection, enabled: boolean, bundled?: PluginPackage) => {
    const matches = bundled ? [bundled] : resources.catalog.filter(item => packageMatches(item, selected));
    if (!matches.some(item => item.contributions !== undefined)) return;
    const snapshots = matches.map(item => ({ source: item.source, scope: item.scope, status: item.status,
      installedPath: item.installedPath ?? null, name: item.name ?? null, version: item.version ?? null,
      manifestVersion: item.manifestVersion ?? null, entry: item.contributions ?? null,
      trusted: item.scope === "bundled" || options.trusted || configuration.trusted.some(trust => packageMatches(item, trust)),
    })).sort((a, b) => compare(canonicalJson(a), canonicalJson(b)));
    identities.push({ pluginId, selection: selected, matches: snapshots });
    if (matches.length !== 1) {
      plan.issues.push({ pluginId, message: "请选择唯一的贡献包来源与作用域。" });
      return;
    }
    const item = matches[0];
    if (!item || item.status !== "ready" || item.contributions?.status !== "ready") {
      plan.issues.push({ pluginId, message: "贡献入口缺失、无效或不兼容。" });
      return;
    }
    if (item.scope !== "bundled" && !options.trusted && !configuration.trusted.some(trust => packageMatches(item, trust))) {
      plan.issues.push({ pluginId, message: "贡献包尚未取得本机代码执行信任。" });
      return;
    }
    plan.entries.push({ pluginId, enabled, entry: item.contributions.entry });
  };
  for (const { registration, package: item } of resources.bundledPackages)
    selection(registration.id, { kind: "source", source: item.source, scope: item.scope }, registration.enabled, item);
  for (const backend of configuration.backends) selection(backend.id, backend.package, true);
  identities.sort((a, b) => compare(canonicalJson(a), canonicalJson(b)));
  plan.identity = canonicalJson(identities);
  return plan;
}

/** 只加载已由静态计划授权的轻量对象，不执行后台工厂。 */
export async function loadPluginContributions(plan: PluginContributionPlan): Promise<{
  contributions: InstalledContributions; issues: PluginContributionIssue[];
}> {
  const registrations = [...plan.registrations];
  const issues = [...plan.issues];
  for (const entry of plan.entries) {
    try {
      const imported: unknown = await import(pathToFileURL(entry.entry).href);
      if (!record(imported) || !Object.hasOwn(imported, "default"))
        throw new RepaFault("invalid_plugin", "贡献入口缺少 default 轻量对象。");
      registrations.push({ id: entry.pluginId, enabled: entry.enabled, ...validateContributions(imported.default) });
    } catch (error) {
      issues.push({ pluginId: entry.pluginId, message: error instanceof Error ? error.message : String(error) });
    }
  }
  // owner 冲突是整个装配失败，不能降级成某个包的普通加载 issue。
  return { contributions: new InstalledContributions(registrations), issues };
}
