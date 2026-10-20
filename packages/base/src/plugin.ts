import type { Static, TSchema } from "typebox";
import type { ActivitySource, ChangeFeed, Revision, Snapshot } from "@repa/space-history";
import type { AskSubmitResult, Item, ItemDraft, ItemResponse } from "./interaction.js";
import type { ClientCapabilities } from "./protocol.js";
import type { MessageDecision, ModelRef } from "./schema.js";

export type { MessageDecision, ModelRef } from "./schema.js";
export type { ActivitySource, ChangeFeed, Revision } from "@repa/space-history";
export type { ClientCapabilities } from "./protocol.js";
// 交互词汇：Item 和作答的 schema 与类型，以及 contentVersion 等纯函数。
export * from "./interaction.js";

/** 工具在对话里向用户要输入时交给 ToolContext.ask 的内容。 */
export interface AskOptions {
  /** 可以带插件对完整定义算好的 version；没有时底座对公开内容计算。requires 由底座计算。 */
  item: ItemDraft | Item;
  /**
   * 作答通过结构检查后交给插件，二选一：返回 invalid 时交回问题列表，卡片保持打开，用户改好可以再交；
   * 返回 accepted 时接受这次作答，可以附一段内容显示在卡片上，然后卡片关闭。省略时通过结构检查就接受。
   * 它在提问时的运行上下文里执行，期间的写入仍记在这次运行名下。
   */
  onSubmit?(response: ItemResponse): Promise<AskSubmitResult>;
}

/** 询问的结局。decline 是用户不按卡片作答，可以附一句话；unsupported 表示前端不能显示这张卡片。 */
export type AskOutcome =
  | { action: "submit"; response: ItemResponse }
  | { action: "decline"; message?: string }
  | { action: "cancel" }
  | { action: "unsupported" };

export interface ToolContext {
  signal: AbortSignal;
  callId: string;
  /**
   * 向发起这次运行的连接提问，等用户作答。只发给这一个连接；它没有声明 Item 所需的能力时直接得到 unsupported。
   * 没有发起连接时以 ask_unavailable 拒绝，Item 不合词汇时以 invalid_item 拒绝；
   * 运行中止、断线或空间关闭时以 ask_cancelled 拒绝，details.reason 说明原因。默认不设超时。
   */
  ask(options: AskOptions): Promise<AskOutcome>;
}

export interface Tool {
  name: string;
  description: string;
  parameters: TSchema;
  /** text 受宿主输出上限约束；大结果应分页。data 只放界面元数据，不复制正文。 */
  execute(input: unknown, context: ToolContext): Promise<{ text: string; data?: unknown }>;
}

export interface MethodContext {
  /** 经协议调用时是发起调用的连接；capabilities 是它在 initialize 里的声明，挑选交给前端的内容时用 canRender 过滤。 */
  caller?: { capabilities: ClientCapabilities };
}

export interface PluginMethod {
  parameters: TSchema;
  /** 返回值的 schema。宿主交回前按它校验，不符合时以 invalid_plugin_result 拒绝；严格对象能拦住多带的字段。 */
  result?: TSchema;
  invoke(input: unknown, context: MethodContext): Promise<unknown>;
}

/**
 * 前端声明的服务，例如浏览器隔离环境里的 python.run。底座只负责路由：优先交给发起当前操作的连接，
 * 它没有声明时交给最近声明这项服务的连接。结果由调用方自己校验。
 */
export interface Services {
  /**
   * 没有任何连接声明这项服务时以 service_unavailable 拒绝；signal 中止、连接断开或空间关闭时以 service_cancelled 拒绝，
   * details.reason 说明原因；前端报告失败时以 service_failed 拒绝。工具里调用时传入 ToolContext.signal，运行取消时一起取消。
   */
  call(service: string, input: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
}

export interface CompletionRequest {
  prompt: string;
  system?: string;
  model?: ModelRef;
  signal?: AbortSignal;
}

export interface AgentTask {
  text: string;
  model?: ModelRef;
  /** 运行哪个 Agent；省略时为通用 Agent。 */
  agent?: string;
}

/** 底座提供的 Pi 内置工具。通用 Agent 全部都有；插件 Agent 不能选 grep，见 AgentDefinition.tools。 */
export const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];
/** 底座的询问工具：通用 Agent 默认带上，插件 Agent 在 tools 里列出才有。 */
export const ASK_USER_TOOL = "ask_user";
/** 插件工具不能使用的名称：内置工具、Pi 的 powershell 与底座的 subagent、ask_user。 */
export const RESERVED_TOOL_NAMES: readonly string[] = [...BUILTIN_TOOLS, "powershell", "subagent", ASK_USER_TOOL];

/** 用户经前端发给插件 Agent 会话的一条消息。后台任务与子 Agent 收到的任务不经过这里。 */
export interface UserMessage {
  sessionId: string;
  agent: string;
  /** send 开始新运行；steer、followUp 在运行中排队，会话空闲时也开始新运行。 */
  mode: "send" | "steer" | "followUp";
  text: string;
  /** 会话正在运行时为当前 runId。 */
  runId?: string;
}

/** 插件声明的 Agent。会话创建后工具与 view 来源固定，中途不换 Agent。 */
export interface AgentDefinition {
  /** 所有插件间唯一，仅含小写字母、数字和连字符；general 留给底座的通用 Agent。 */
  id: string;
  /** 简短用途，交给前端显示，也写进父 Agent 的子 Agent 工具说明。 */
  description?: string;
  /** 职责说明，作为提示段 agent:<id>。 */
  instructions(): string;
  /**
   * 可用工具的名称：BUILTIN_TOOLS 中除 grep 外的内置工具、ask_user 与任一插件的工具。
   * 内置文件工具限在空间内且不进 .repa/；bash 仍按命令策略确认。列了 grep 时插件打开失败，
   * 需要搜索内容的插件提供自己的工具。
   */
  tools: string[];
  /** 可以启动的子 Agent；启动时子 Agent 的工具不能超过本 Agent。 */
  subagents?: string[];
  /** 用户能否直接与它建会话；装配可以另行指定。默认否。 */
  direct?: boolean;
  /** 本 Agent 的运行时状态，作为 view agent:<id>。 */
  view?(): Promise<string | undefined>;
  /**
   * 用户消息进入会话前的判断。返回拒收时消息不写入会话，前端收到 message_rejected；
   * 不返回或返回 accepted 时照常处理，插件可以在这里只记下这次提问。抛错同样拒收。
   */
  beforeMessage?(message: UserMessage): Promise<MessageDecision | void>;
}

// Host.models 返回的句柄由宿主持有并在关闭时取消、等待 result；插件可提前取消，重复调用共享同一次取消。
export interface AgentWork {
  id: string;
  result: Promise<void>;
  cancel(): Promise<void>;
}

// Host.models 的工作由宿主拥有；关闭会取消请求并等待终态，再调用插件 close。
export interface Models {
  complete(request: CompletionRequest): Promise<string>;
  completeStructured<S extends TSchema>(request: CompletionRequest, schema: S): Promise<Static<S>>;
  runAgent(task: AgentTask): Promise<AgentWork>;
}

export interface ModelScope {
  models: Models;
  close(): Promise<void>;
}

// 父插件可把 scope.models 转交子插件，提前关闭时先取消并等待模型工作，再关闭子实例。
export { createModelScope } from "./plugins/models.js";

// 工具在 Agent 运行内执行时，可读到本次运行与父运行的 id。
export { currentRun, type RunContext } from "./run-context.js";

export interface Files {
  read(file: string): Promise<string>;
  write(file: string, text: string): Promise<void>;
  list(directory?: string): Promise<string[]>;
}

export interface History {
  changes(since?: string): Promise<ChangeFeed>;
  list(limit?: number): Promise<Revision[]>;
  record<T>(source: ActivitySource, action: () => Promise<T>): Promise<{ value: T; snapshot: Snapshot }>;
}

export interface Host {
  space: { root: string; dataDir: string };
  files: Files;
  history: History;
  models: Models;
  services: Services;
  emit(event: unknown): void;
}

export interface Plugin {
  id: string;
  /** 构建加载时来自静态清单；直接装配和测试宿主省略时使用当前初始版本 1。 */
  dataVersion?: number;
  // open 尚未返回实例时，插件负责清理自己已经打开的子实例与其他局部资源。
  open(host: Host): Promise<PluginInstance>;
}

export interface PluginInstance {
  instructions?(): string;
  tools?(): Tool[];
  /** 本领域的 Agent；打开插件时读取一次。 */
  agents?(): AgentDefinition[];
  view?(): Promise<string | undefined>;
  onChange?(revision: string): Promise<void>;
  methods?: Record<string, PluginMethod>;
  // 宿主先取消模型、等在途调用，再关闭直接加载的实例；父插件另行关闭子实例时也负责停止它的工作。
  // close 必须等待插件自有的通知与非模型后台工作完成。
  close?(): Promise<void>;
}
