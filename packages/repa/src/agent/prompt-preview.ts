import { DefaultPackageManager, DefaultResourceLoader, getAgentDir, loadProjectContextFiles, type BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import type { AssembledPrompt } from "../configuration/runtime.js";
import type { PromptSettings } from "../configuration/schema.js";
import type { ContentStore } from "../content/store.js";
import { describePrompt } from "./context.js";
import { createContentTools } from "./tools.js";
import { FileChanges } from "./file-changes.js";
import { sessionSettings } from "./settings.js";
import type { BackgroundSource } from "./background.js";
import type { SettingsManager, ToolDefinition } from "@earendil-works/pi-coding-agent";

/** 预览只发现静态资源，不建立 Agent 或执行扩展工厂。 */
export async function previewPrompt(options: {
  content: ContentStore;
  agentDir?: string;
  trusted: boolean;
  settings: PromptSettings;
  tools?: string[];
  backgroundSources?: readonly BackgroundSource[];
  resourceSettings?: SettingsManager;
  additionalSkills?: readonly string[];
  additionalTools?: readonly Pick<ToolDefinition, "name" | "description" | "parameters">[];
  dynamicTools?: readonly string[];
  dynamicExtensions?: boolean;
  missingPackages?: readonly string[];
}): Promise<AssembledPrompt> {
  const cwd = options.content.options.root;
  const agentDir = options.agentDir ?? getAgentDir();
  const settingsManager = options.resourceSettings ?? sessionSettings(cwd, agentDir, options.trusted);
  const loader = new DefaultResourceLoader({
    cwd, agentDir,
    settingsManager,
    noExtensions: true, noSkills: !options.trusted, noPromptTemplates: true,
    noThemes: true, noContextFiles: true, systemPrompt: "", appendSystemPrompt: [],
  });
  const missingPackages: string[] = [...options.missingPackages ?? []];
  if (options.trusted) {
    // reload 会安装缺失包；预览通过公开静态入口发现资源，只装配已存在的 Skill。
    const paths = await new DefaultPackageManager({ cwd, agentDir, settingsManager }).resolve(async (source) => {
      missingPackages.push(source);
      return "skip";
    });
    loader.extendResources({ skillPaths: paths.skills.filter(resource => resource.enabled) });
  }
  loader.extendResources({ skillPaths: (options.additionalSkills ?? []).map(file => ({
    path: file, metadata: { source: "trusted-package", scope: "user" as const, origin: "package" as const },
  })) });
  const definitions = [
    ...await createContentTools(cwd, options.content, loader, new FileChanges(options.content)),
    ...options.additionalTools ?? [],
  ];
  const selectedTools = options.tools ?? definitions.map(tool => tool.name);
  const inputs: BuildSystemPromptOptions = {
    cwd, selectedTools, skills: loader.getSkills().skills,
    contextFiles: options.trusted && options.settings.projectInstructions
      ? loadProjectContextFiles({ cwd, agentDir }) : [],
  };
  const result = describePrompt(inputs, options.settings);
  for (const source of options.backgroundSources ?? []) {
    const enabled = source.enabled(options.settings);
    const prepared = enabled && source.preview ? await source.preview() : undefined;
    result.sources.push({ id: source.codec.id, enabled, dynamic: true, reference: source.reference ?? source.codec.customType,
      ...(prepared ? { content: prepared.text, revision: prepared.revision } : {}) });
  }
  result.sources.push({
    id: "toolDefinitions", enabled: selectedTools.length > 0,
    content: JSON.stringify(definitions.filter(tool => selectedTools.includes(tool.name)).map(tool => ({
      name: tool.name, description: tool.description, parameters: tool.parameters,
    }))),
  });
  if (options.trusted || options.dynamicExtensions) result.sources.push({ id: "extensionContributions", enabled: true, dynamic: true });
  for (const pluginId of options.dynamicTools ?? []) result.sources.push({
    id: `capabilityPlugin:${pluginId}`, enabled: true, dynamic: true, reference: pluginId,
  });
  for (const source of missingPackages) result.sources.push({
    id: `package:${source}`, enabled: true, dynamic: true, reference: source,
  });
  return result;
}
