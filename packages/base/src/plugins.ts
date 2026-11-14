import type { AgentTool } from "./agent.js";
import type { AskRoute } from "./ask.js";
import type { ExportSources } from "./feedback/export.js";
import type { AgentDefinition, MethodContext, Models, Plugin, Services } from "./plugin.js";
import type { Space } from "./space.js";

/** 空间中的插件宿主；装配层从这里取得插件声明、调用方法并等待变化处理。 */
export interface PluginHost {
  /** 让插件追赶已有的变化；追赶完成之前 onChange 出错的插件按打开失败停用，列进 disabled()。 */
  start(): Promise<void>;
  /**
   * 在打开着的宿主上加上一个插件：打开实例、核对声明，把它的工具、Agent、提示段与方法登记进宿主，完成后返回。
   * open() 在 Agent 运行的上下文之外执行，它此后的写入记在插件名下。声明与已有插件冲突时只有这个插件失败，失败的实例当场关闭。
   * 追赶空间历史发起后不等，有运行持着历史队列时排在运行之后。同一个 id 已经打开，或上一个实例的 close() 还没结束，立即失败。
   */
  add(plugin: Plugin): Promise<void>;
  /**
   * 撤下一个插件。同步完成的部分：它的工具、Agent、提示段与方法不再列出，交出去的工具、方法、Agent 闭包与整个 Host 一律失败，
   * 正在执行的调用立即失败，事件不再转发；撤下之前发起、还在等空间写锁的写空间与历史操作随之取消。返回的 Promise 到实例的 close() 结束为止，调用方可以不等；close() 出错时它失败，错误同时交给 onError。
   */
  remove(id: string): Promise<void>;
  /** 打开空间时失败、被停用的插件及原因，按 id 排列；运行中加上失败的插件不在这里，add 直接抛错。 */
  disabled(): { id: string; reason: { code: string; message: string } }[];
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
