import type { PromptSettings } from "repa/protocol";
import type { PluginSettings } from "repa/plugin";
import { DEFAULT_LEARNING_PROMPT } from "./default-prompt.js";

export const LEARNING_PLUGIN_ID = "repa-learning";

/** 产品只提供默认值，用户明确保存的覆盖仍由通用配置入口解析。 */
export function learningPromptDefaults(configuration: PluginSettings): Partial<PromptSettings> {
  return { base: configuration.disabled.includes(LEARNING_PLUGIN_ID) ? "" : DEFAULT_LEARNING_PROMPT };
}
