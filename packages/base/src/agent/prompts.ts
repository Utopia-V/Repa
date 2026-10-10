import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type { AgentSpaceOptions } from "../agent.js";
import type { PromptSection } from "../schema.js";
import { sectionId, sectionName } from "./views.js";

export const BASE_INSTRUCTIONS = "你是 Repa 中帮助用户持续开展工作的 Agent。读取当前空间的资料，使用已提供的工具推进用户目标，并尊重用户的授权与已有工作。插件说明提供领域知识，运行时视图提供当前状态；需要更多状态时使用工具查询。";

export async function promptSections(options: AgentSpaceOptions, defaults: { id: string; text: string }[] = []): Promise<PromptSection[]> {
  const overrides = await options.overrides();
  const instructions = [...options.instructions()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const sections = [{ id: "base", text: BASE_INSTRUCTIONS }, ...defaults, ...instructions];
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
  input.sections = renderedSections(sections);
  input.contextFiles = [];
  input.skills = [];
  input.appendSystemPrompt = "";
}

function renderedSections(sections: PromptSection[]): Record<string, string> {
  return Object.fromEntries(sections.filter(section => section.enabled).map(section => [
    sectionName(section.id),
    `<repa-instructions source=${JSON.stringify(section.id)}>\n${section.text}\n</repa-instructions>`,
  ]));
}

function instructionText(name: string, rendered: string): string {
  // Pi 会包裹命名段；只读取 Repa 自己的来源标记，不复制或匹配 SDK 的外层渲染格式。
  const start = `<repa-instructions source=${JSON.stringify(sectionId(name))}>\n`;
  const end = "\n</repa-instructions>";
  const from = rendered.indexOf(start);
  const to = rendered.lastIndexOf(end);
  return from >= 0 && to >= from + start.length ? rendered.slice(from + start.length, to) : rendered;
}

/** 从 Pi 当前投影比较有效提示，重开、分支和压缩都不需要第二份版本状态。 */
export function promptChangeNotice(messages: readonly { role: string }[], sections: PromptSection[]): string | undefined {
  const system = getCurrentSystemMessage(messages);
  if (!system) return undefined;
  const previous = system.sections ?? {};
  const current = Object.fromEntries(sections.filter(section => section.enabled).map(section => [sectionName(section.id), section.text]));
  const changes: string[] = [];
  for (const name of [...new Set([...Object.keys(previous), ...Object.keys(current)])].sort()) {
    if (!name.startsWith("repa-")) continue;
    const rendered = previous[name];
    const before = rendered == null ? null : instructionText(name, rendered);
    const after = current[name] ?? null;
    if (before === after) continue;
    // 仅省略两边完全相同的首尾行，不推断含义；变化行保留原文和上下文。
    const oldLines = before?.split("\n") ?? [];
    const newLines = after?.split("\n") ?? [];
    while (oldLines.length > 0 && newLines.length > 0 && oldLines[0] === newLines[0]) {
      oldLines.shift();
      newLines.shift();
    }
    while (oldLines.length > 0 && newLines.length > 0 && oldLines.at(-1) === newLines.at(-1)) {
      oldLines.pop();
      newLines.pop();
    }
    changes.push(`来源：${JSON.stringify(sectionId(name))}\n旧文本片段（已失效）：${JSON.stringify(oldLines.join("\n"))}\n新文本片段（当前生效）：${JSON.stringify(newLines.join("\n"))}${after === null ? "\n该提示段已停用或移除。" : ""}`);
  }
  if (changes.length === 0) return undefined;
  return `提示变更说明：以下提示段已更新。后续回答以当前有效提示为准，不要沿用此前回复中的旧规则。下面仅省略了完全相同的首尾行；旧片段已失效，新片段替代旧片段，其余内容不变。\n\n${changes.join("\n\n")}`;
}
