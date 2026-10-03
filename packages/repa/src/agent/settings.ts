import { SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";

/** 与 Pi 0.87.1 createAgentSession 一致：缺省为 medium，再按模型能力收敛。 */
export function defaultThinkingLevel(settings: SettingsManager, model: Model<Api>): ModelThinkingLevel {
  return clampThinkingLevel(model,
    settings.getModelThinkingLevel(model.provider, model.id) ?? settings.getDefaultThinkingLevel() ?? "medium");
}

/** 读取 Pi 的资源与运行默认值；单次运行的选择只写入 SDK 内存设置。 */
export function sessionSettings(cwd: string, agentDir: string | undefined, trusted: boolean): SettingsManager {
  const source = SettingsManager.create(cwd, agentDir ?? getAgentDir(), { projectTrusted: trusted });
  return snapshotSettings({ global: source.getGlobalSettings(), project: source.getProjectSettings() }, trusted);
}

export function snapshotSettings(source: {
  global: ReturnType<SettingsManager["getGlobalSettings"]>;
  project: ReturnType<SettingsManager["getProjectSettings"]>;
}, trusted: boolean): SettingsManager {
  const snapshots = {
    global: JSON.stringify(source.global),
    project: JSON.stringify(source.project),
  };
  return SettingsManager.fromStorage({
    withLock(scope, update) {
      const next = update(snapshots[scope]);
      if (next !== undefined) snapshots[scope] = next;
    },
  }, { projectTrusted: trusted });
}
