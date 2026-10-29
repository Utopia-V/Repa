import type { AgentTool } from "./agent.js";
import type { AskRoute } from "./ask.js";
import type { AgentDefinition, MethodContext, Models, Plugin, Services } from "./plugin.js";
import type { Space } from "./space.js";

export interface PluginHost {
  start(): Promise<void>;
  list(): { id: string; methods: string[]; tools: string[] }[];
  instructions(): { id: string; text: string }[];
  /** 包装后的插件工具：宿主校验参数，并给上下文补上 ask。 */
  tools(): AgentTool[];
  /** 全部插件声明的 Agent，按 id 排序；引用的工具与子 Agent 已在打开时核对。 */
  agents(): AgentDefinition[];
  views(): Promise<{ id: string; text: string }[]>;
  /** caller 是经协议发起调用的连接；方法声明了 result 时按它校验返回值。 */
  call(pluginId: string, method: string, input: unknown, caller?: MethodContext["caller"]): Promise<unknown>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface PluginHostOptions {
  /** 当前时间，Unix 毫秒；省略时使用系统时钟。 */
  now?: () => number;
  space: Space;
  plugins: Plugin[];
  models: Models;
  /** 装配到当前空间的会话取消路径。 */
  abortAgent?(agent: string): Promise<void>;
  /** 对话里的询问，绑定发起运行的连接。省略时 ToolContext.ask 以 ask_unavailable 拒绝。 */
  ask?: AskRoute;
  /** 前端声明的服务。省略时调用以 service_unavailable 拒绝。 */
  services?: Services;
  emit(pluginId: string, event: unknown): void;
  onError(error: unknown): void;
}

export { openPluginHost } from "./plugins/host.js";
