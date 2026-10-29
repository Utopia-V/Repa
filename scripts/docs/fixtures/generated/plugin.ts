/** 夹具的 Host。 */
export interface Host {
  /** 发出事件。 */
  emit(value: unknown): void;
}
export interface Plugin { id: string; }
export interface PluginInstance { tools?(): string[]; }
export interface AgentDefinition { instructions(): string; }
