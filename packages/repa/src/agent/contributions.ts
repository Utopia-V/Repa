import type { CapabilityBackground, BackendPluginRegistration } from "../capabilities/types.js";
import type { CapabilitySelection } from "../capabilities/schema.js";
import type { PluginSettings } from "../configuration/plugins.js";
import type { ContentStore } from "../content/store.js";
import type { ContentFormat } from "../content/formats.js";
import { RepaFault } from "../errors.js";
import type { BackgroundSource } from "./background.js";

/** 安装级贡献持有 codec 和格式；能力运行实例只在实际运行时使用。 */
export class InstalledContributions {
  readonly formats: readonly ContentFormat[];
  readonly #plugins: readonly BackendPluginRegistration[];

  constructor(plugins: readonly BackendPluginRegistration[]) {
    const sources = new Set<string>();
    const customTypes = new Set<string>();
    const formats = new Set<string>();
    const fields = new Set<string>();
    for (const plugin of plugins) {
      for (const { codec } of plugin.backgrounds ?? []) {
        if (!codec.id || !codec.customType || sources.has(codec.id) || customTypes.has(codec.customType))
          throw new RepaFault("background_conflict", "背景来源标识或历史消息类型重复。", { sourceId: codec.id });
        sources.add(codec.id);
        customTypes.add(codec.customType);
      }
      for (const format of plugin.formats ?? []) {
        if (formats.has(format.id) || fields.has(format.field))
          throw new RepaFault("content_format_conflict", "持久格式标识或字段重复。", { formatId: format.id, field: format.field });
        formats.add(format.id);
        fields.add(format.field);
      }
    }
    this.#plugins = [...plugins];
    this.formats = plugins.flatMap(plugin => [...plugin.formats ?? []]);
  }

  backgrounds(configuration: PluginSettings, options: {
    content: ContentStore;
    invoke?(selection: CapabilitySelection, input: unknown): Promise<unknown>;
  }): BackgroundSource[] {
    return this.#plugins.flatMap(plugin => (plugin.backgrounds ?? []).map(background => {
      const selection = this.#selection(background, configuration);
      const preview = background.preview;
      return {
        codec: background.codec,
        reference: selection.implementationId ? `${selection.contract.id}:${selection.implementationId}` : background.codec.customType,
        enabled: settings => {
          if (!plugin.enabled || configuration.disabled.includes(plugin.id)) return false;
          const selected = settings.backgrounds;
          if (selected && Object.hasOwn(selected, background.codec.id)) return selected[background.codec.id] === true;
          return background.enabled?.(settings) ?? true;
        },
        prepare: async () => {
          if (!options.invoke) throw new RepaFault("background_not_running", "背景准备需要实际运行的能力入口。");
          return background.prepare(await options.invoke(selection, structuredClone(background.input)));
        },
        ...(preview && selection.implementationId === preview.implementationId
          ? { preview: async () => preview.read(options.content) } : {}),
      };
    }));
  }

  #selection(background: CapabilityBackground, configuration: PluginSettings): CapabilitySelection {
    return {
      ...background.selection,
      implementationId: configuration.implementations[background.selection.contract.id] ?? background.selection.implementationId,
    };
  }
}
