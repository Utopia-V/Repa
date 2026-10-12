import type { AgentDefinition, MethodContext, Models, Plugin, Tool } from "./plugin.js";
import type { Space } from "./space.js";

export interface PluginHost {
  start(): Promise<void>;
  list(): { id: string; methods: string[]; tools: string[] }[];
  instructions(): { id: string; text: string }[];
  tools(): Tool[];
  /** 全部插件声明的 Agent，按 id 排序；引用的工具与子 Agent 已在打开时核对。 */
  agents(): AgentDefinition[];
  views(): Promise<{ id: string; text: string }[]>;
  /** caller 是经协议发起调用的连接；方法声明了 result 时按它校验返回值。 */
  call(pluginId: string, method: string, input: unknown, caller?: MethodContext["caller"]): Promise<unknown>;
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
