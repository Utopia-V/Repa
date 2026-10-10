import type { Models, Plugin, Tool } from "./plugin.js";
import type { Space } from "./space.js";

export interface PluginHost {
  start(): Promise<void>;
  list(): { id: string; methods: string[]; tools: string[] }[];
  instructions(): { id: string; text: string }[];
  tools(): Tool[];
  views(): Promise<{ id: string; text: string }[]>;
  call(pluginId: string, method: string, input: unknown): Promise<unknown>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface PluginHostOptions {
  space: Space;
  plugins: Plugin[];
  models: Models;
  emit(pluginId: string, event: unknown): void;
  onError(error: unknown): void;
}

export { openPluginHost } from "./plugins/host.js";
