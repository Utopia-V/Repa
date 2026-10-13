import type { PromptOverride, PromptSection } from "@repa/base/protocol";

import { folderName } from "@/lib/paths";

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
      return { name: "基础说明", source: "Repa 内置" };
    case "space":
      return {
        name: "空间说明",
        source: `空间路径和 ${folderName(space)}/AGENTS.md`,
        generatedNote: `这段由空间路径和 ${folderName(space)}/AGENTS.md 生成。在这里改会盖住文件内容，之后再改 AGENTS.md 也不会生效，直到改回来。`,
      };
    case "skills":
      return {
        name: "Skill 目录",
        source: "应用和空间的 Skill 文件夹",
        generatedNote: "这段按 Skill 文件夹生成。在这里改会盖住它，之后增删 Skill 也不会反映出来，直到改回来。",
      };
    case "tools":
      return {
        name: "工具说明",
        source: "Repa 内置，列出可用工具",
        generatedNote: "这段列出当前可用的工具。在这里改会盖住它，之后工具有变化也不会反映出来，直到改回来。",
      };
  }
  if (id.startsWith("plugin:")) return { name: `插件 ${id.slice("plugin:".length)}`, source: "插件提供" };
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
