import type { SettingsView } from "../configuration/schema.js";
import { DEFAULT_LEARNING_PROMPT } from "./default-prompt.js";

export const LEARNING_PLUGIN_ID = "repa-learning";

/** 官方组合提供默认教学提示；明确写入的覆盖在关闭组合后仍归用户所有。 */
export function learningPromptDefaults(view: SettingsView, enabled: boolean): SettingsView {
  if (view.namespace !== "prompts") return view;
  const result = structuredClone(view);
  const base = result.entries.find(entry => entry.key === "base");
  const definition = result.definitions.find(item => item.key === "base");
  const value = enabled ? DEFAULT_LEARNING_PROMPT : "";
  if (base?.source === "default") base.effective = value;
  if (definition) definition.default = value;
  return result;
}
