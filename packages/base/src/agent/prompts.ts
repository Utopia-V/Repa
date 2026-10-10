import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import type { AgentSpaceOptions } from "../agent.js";
import type { PromptSection } from "../schema.js";
import { sectionName } from "./views.js";

export const BASE_INSTRUCTIONS = "你是 Repa 中帮助用户持续开展工作的 Agent。读取当前空间的资料，使用已提供的工具推进用户目标，并尊重用户的授权与已有工作。插件说明提供领域知识，运行时视图提供当前状态；需要更多状态时使用工具查询。";

export async function promptSections(options: AgentSpaceOptions, defaults: { id: string; text: string }[] = []): Promise<PromptSection[]> {
  const overrides = await options.overrides();
  const sections = [{ id: "base", text: BASE_INSTRUCTIONS }, ...defaults, ...options.instructions()];
  const ids = new Set<string>();
  return sections.map(section => {
    if (ids.has(section.id)) throw new Error(`提示来源重复：${section.id}`);
    ids.add(section.id);
    const app = overrides.app[section.id];
    const space = overrides.space[section.id];
    return {
      id: section.id,
      defaultText: section.text,
      text: space?.text ?? app?.text ?? section.text,
      enabled: space?.enabled ?? app?.enabled ?? true,
    };
  });
}

export function applyPromptSections(input: BuildSystemPromptOptions, sections: PromptSection[]): void {
  // customPrompt 使用 Pi 的结构化提示入口，不是绕过 transcript 的 forceSystemPrompt。
  input.customPrompt = "Repa";
  input.sections = Object.fromEntries(sections.filter(section => section.enabled).map(section => [
    sectionName(section.id),
    `<repa-instructions source=${JSON.stringify(section.id)}>\n${section.text}\n</repa-instructions>`,
  ]));
  input.contextFiles = [];
  input.skills = [];
  input.appendSystemPrompt = "";
}
