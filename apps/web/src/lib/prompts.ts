import type { PromptOverride, PromptSection } from "@repa/base/protocol";

import { folderName } from "@/lib/paths";
import { t } from "@/lib/strings";

export type PromptSource = {
  name: string;
  source: string;
  /** 内容由文件或运行状态生成；覆盖后会盖住之后的变化，编辑时提醒。 */
  generatedNote?: string;
};

/**
 * 已知来源的名称和说明。后端只提供 id，这里没有的来源直接显示 id；
 * 后端给出名称和来源后，这份对照表就不再需要。
 */
export function promptSource(id: string, space: string): PromptSource {
  switch (id) {
    case "base":
      return { name: t("promptSettings.source.base.title"), source: t("promptSettings.source.base.label") };
    case "space":
      return {
        name: t("promptSettings.source.space.title"),
        source: t("promptSettings.source.space.label", { space: folderName(space) }),
        generatedNote: t("promptSettings.source.space.hint", { space: folderName(space) }),
      };
    case "skills":
      return {
        name: t("promptSettings.source.skills.title"),
        source: t("promptSettings.source.skills.label"),
        generatedNote: t("promptSettings.source.skills.hint"),
      };
    case "tools":
      return {
        name: t("promptSettings.source.tools.title"),
        source: t("promptSettings.source.tools.label"),
        generatedNote: t("promptSettings.source.tools.hint"),
      };
  }
  if (id.startsWith("plugin:")) return { name: t("promptSettings.source.plugin.title", { length: id.slice("plugin:".length) }), source: t("promptSettings.source.plugin.label") };
  return { name: id, source: "" };
}

/**
 * 一段提示在各级的覆盖。后端按默认、应用、空间依次合成；空间级覆盖协议读不到，
 * 由有效内容推出：和上一级相同的部分当作没有覆盖，对装配结果没有区别。
 */
export function promptLevels(section: PromptSection, app: PromptOverride = {}) {
  const inherited = { text: app.text ?? section.defaultText, enabled: app.enabled ?? true };
  const space: PromptOverride = {};
  if (section.text !== inherited.text) space.text = section.text;
  if (section.enabled !== inherited.enabled) space.enabled = section.enabled;
  return { app, space, inherited };
}
