import { formatSkillsForPrompt, type BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import type { PromptSettings } from "../configuration/schema.js";
import type { AssembledPrompt } from "../configuration/runtime.js";

/** 装配由 Repa 选择的来源，包括显式为空的基础提示。 */
export function assembleSystemPrompt(
  options: BuildSystemPromptOptions,
  settings: PromptSettings,
): string {
  const sections = [settings.base, ...settings.append];
  if (settings.projectInstructions && options.contextFiles?.length) {
    sections.push(
      [
        "<project_context>",
        "Project-specific instructions and guidelines:",
        ...options.contextFiles.map(
          ({ path, content }) =>
            `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
        ),
        "</project_context>",
      ].join("\n\n"),
    );
  }
  if (
    settings.skillCatalog &&
    (!options.selectedTools || options.selectedTools.includes("read"))
  ) {
    sections.push(formatSkillsForPrompt(options.skills ?? []).trim());
  }
  if (settings.environment) {
    sections.push(`Current working directory: ${options.cwd.replace(/\\/g, "/")}`);
  }
  return sections.filter((section) => section.length > 0).join("\n\n");
}
export function describePrompt(
  options: BuildSystemPromptOptions,
  settings: PromptSettings,
): AssembledPrompt {
  const empty: PromptSettings = {
    base: "", append: [], projectInstructions: false, skillCatalog: false,
    environment: false, learningContext: false, fileChanges: "on-demand",
  };
  return {
    system: assembleSystemPrompt(options, settings),
    sources: [
      { id: "base", enabled: true, content: settings.base },
      { id: "append", enabled: settings.append.length > 0, content: settings.append.join("\n\n") },
      ...(["projectInstructions", "skillCatalog", "environment"] as const).map(id => ({
        id, enabled: settings[id],
        content: assembleSystemPrompt(options, { ...empty, [id]: settings[id] }),
      })),
      { id: "fileChanges", enabled: settings.fileChanges !== "on-demand", dynamic: true, reference: "repa.file-changes" },
    ],
  };
}
