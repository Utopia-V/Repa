import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BundledPluginRegistration } from "repa/plugin";
import { LEARNING_PLUGIN_ID } from "./settings.js";

const PACKAGES = [
  ["repa-teaching", "@repa/learning"],
  ["repa-materials", "@repa/materials"],
  ["repa-planning", "@repa/planning"],
  ["repa-review", "@repa/review"],
  ["repa-organization", "@repa/organization"],
] as const;

/** 装配只定位真实分发依赖；插件的入口、资源与快照继续由公共包约定解释。 */
export function bundledLearningPackages(disabled: readonly string[]): BundledPluginRegistration[] {
  return PACKAGES.map(([id, name]) => ({
    id,
    directory: path.dirname(fileURLToPath(import.meta.resolve(`${name}/package.json`))),
    enabled: !disabled.includes(LEARNING_PLUGIN_ID),
  }));
}
