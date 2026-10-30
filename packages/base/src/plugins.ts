import type { AgentTool } from "./agent.js";
import type { AskRoute } from "./ask.js";
import type { ExportSources } from "./feedback/export.js";
import type { AgentDefinition, MethodContext, Models, Plugin, Services } from "./plugin.js";
import type { DisabledPlugin } from "./protocol.js";
import type { Space } from "./space.js";

/** 空间中的插件宿主；装配层从这里取得插件声明、调用方法并等待变化处理。 */
export interface PluginHost {
  /** 让插件追赶已有的变化；追赶完成之前 onChange 出错的插件按打开失败停用，列进 disabled()。 */
  start(): Promise<void>;
  disabled(): DisabledPlugin[];
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
  models: Models | ((pluginId: string) => Models);
  /** 装配到当前空间的会话取消路径。 */
  abortAgent?(agent: string): Promise<void>;
  /** 对话里的询问，绑定发起运行的连接。省略时 ToolContext.ask 以 ask_unavailable 拒绝。 */
  ask?: AskRoute;
  /** 前端声明的服务。省略时调用以 service_unavailable 拒绝。 */
  services?: Services;
  /** 导出用到的应用配置目录与保存的凭据。省略时 Host.prepareExport 以 export_unavailable 拒绝。 */
  exports?: ExportSources;
  emit(pluginId: string, event: unknown): void;
  onError(error: unknown): void;
}

export { openPluginHost } from "./plugins/host.js";
