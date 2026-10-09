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
  readonly #plugins: readonly Pick<BackendPluginRegistration, "id" | "enabled" | "backgrounds" | "formats">[];
  readonly #pending = new Set<Promise<unknown>>();
  #active = true;

  constructor(plugins: readonly Pick<BackendPluginRegistration, "id" | "enabled" | "backgrounds" | "formats">[]) {
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

  assertActive(): void {
    if (!this.#active)
      throw new RepaFault("plugin_restart_required", "安装声明已经失效，请重新装配或重启后端。");
  }

  /** 先停止旧背景的使用，已有预览和准备由 settled 等待收尾。 */
  invalidate(): void {
    this.#active = false;
  }

  use<T>(work: () => Promise<T>): Promise<T> {
    this.assertActive();
    const pending = (async () => {
      const result = await work();
      this.assertActive();
      return result;
    })();
    this.#pending.add(pending);
    void pending.then(() => this.#pending.delete(pending), () => this.#pending.delete(pending));
    return pending;
  }

  async settled(): Promise<void> {
    await Promise.allSettled(this.#pending);
  }

  backgrounds(configuration: PluginSettings, options: {
    content: ContentStore;
    invoke?(selection: CapabilitySelection, input: unknown): Promise<unknown>;
  }): BackgroundSource[] {
    this.assertActive();
    return this.#plugins.flatMap(plugin => (plugin.backgrounds ?? []).map(background => {
      const selection = this.#selection(background, configuration);
      const preview = background.preview;
      const codec = background.codec;
      return {
        codec: {
          id: codec.id,
          customType: codec.customType,
          snapshot: message => {
            this.assertActive();
            return codec.snapshot(message);
          },
        },
        reference: selection.implementationId ? `${selection.contract.id}:${selection.implementationId}` : background.codec.customType,
        enabled: settings => {
          this.assertActive();
          if (!plugin.enabled || configuration.disabled.includes(plugin.id)) return false;
          const selected = settings.backgrounds;
          if (selected && Object.hasOwn(selected, background.codec.id)) return selected[background.codec.id] === true;
          return background.enabled?.(settings) ?? true;
        },
        prepare: () => this.use(async () => {
          if (!options.invoke) throw new RepaFault("background_not_running", "背景准备需要实际运行的能力入口。");
          const result = await options.invoke(selection, structuredClone(background.input));
          this.assertActive();
          return background.prepare(result);
        }),
        ...(preview && selection.implementationId === preview.implementationId
          ? { preview: () => this.use(async () => preview.read(options.content)) } : {}),
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
