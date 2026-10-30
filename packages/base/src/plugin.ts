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

/** 插件工具一次调用的上下文，提供取消信号、调用 id 和用户询问入口。 */
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

/** 插件向 Agent 声明的工具；宿主校验参数后调用 execute。 */
export interface Tool {
  name: string;
  description: string;
  parameters: TSchema;
  /** text 受宿主输出上限约束；大结果应分页。data 只放界面元数据，不复制正文。 */
  execute(input: unknown, context: ToolContext): Promise<{ text: string; data?: unknown }>;
}

/** 插件协议方法的调用上下文，用于读取发起连接的渲染能力。 */
export interface MethodContext {
  /** 经协议调用时是发起调用的连接；capabilities 是它在 initialize 里的声明，挑选交给前端的内容时用 canRender 过滤。 */
  caller?: { capabilities: ClientCapabilities };
}

/** 插件向协议客户端公开的方法，参数与可选结果 schema 由宿主校验。 */
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

/** 插件发起单次模型生成的请求，可指定系统提示、模型和取消信号。 */
export interface CompletionRequest {
  prompt: string;
  system?: string;
  model?: ModelRef;
  signal?: AbortSignal;
}

/** 插件交给 Agent 的任务，供后台运行及指定角色执行。 */
export interface AgentTask {
  text: string;
  model?: ModelRef;
  /** 运行哪个 Agent；省略时为通用 Agent。 */
  agent?: string;
}

/** 底座提供的 Pi 内置工具。通用 Agent 全部都有；插件 Agent 不能选 grep，见 AgentDefinition.tools。 */
export const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
/** Pi 内置工具的名称联合，供插件声明 Agent 工具范围。 */
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
   * 内置文件工具限在空间内，仅 read 可以读取 .repa/tool-output/；bash 仍按命令策略确认。列了 grep 时插件打开失败，
   * 需要搜索内容的插件提供自己的工具。
   */
  tools: string[];
  /** 可以启动的子 Agent；启动时子 Agent 的工具不能超过本 Agent。 */
  subagents?: string[];
  /** 用户能否直接与它建会话；装配可以另行指定。默认否。 */
  direct?: boolean;
  /** 只渲染本 Agent 的运行时状态，作为 view agent:<id>；运行限制放在 beforeRun。 */
  view?(): Promise<string | undefined>;
  /**
   * 用户消息进入会话前的判断。返回拒收时消息不写入会话，前端收到 message_rejected；
   * 不返回或返回 accepted 时照常处理，插件可以在这里只记下这次提问。抛错同样拒收。
   */
  beforeMessage?(message: UserMessage): Promise<MessageDecision | void>;
  /** 每条消息真正运行前判断，包括排队后的消息；拒收时不写会话、不启动模型。 */
  beforeRun?(): Promise<MessageDecision | void>;
}

// Host.models 返回的句柄由宿主持有并在关闭时取消、等待 result；插件可提前取消，重复调用共享同一次取消。
/** 宿主持有的 Agent 任务句柄，插件用它等待终态或提前取消。 */
export interface AgentWork {
  id: string;
  result: Promise<void>;
  cancel(): Promise<void>;
}

// Host.models 的工作由宿主拥有；关闭会取消请求并等待终态，再调用插件 close。
/** 插件可用的模型能力，统一提供文本生成、结构化生成和 Agent 任务。 */
export interface Models {
  complete(request: CompletionRequest): Promise<string>;
  completeStructured<S extends TSchema>(request: CompletionRequest, schema: S): Promise<Static<S>>;
  runAgent(task: AgentTask): Promise<AgentWork>;
  /**
   * 请求不指定模型时会用哪个模型；没有可用模型时为 undefined，这时不指定模型的请求以 model_required 拒绝。
   * 插件据此避开离不开模型的工作，例如不出要由模型判分的题。每次调用都按当前登录与设置读取。
   */
  defaultModel(): ModelRef | undefined;
}

/** 可提前关闭的一组模型工作，供父插件管理子插件的取消与等待。 */
export interface ModelScope {
  models: Models;
  close(): Promise<void>;
}

// 父插件可把 scope.models 转交子插件，提前关闭时先取消并等待模型工作，再关闭子实例。
export { createModelScope } from "./plugins/models.js";

// 工具在 Agent 运行内执行时，可读到本次运行与父运行的 id。
export { currentRun, type RunContext } from "./run-context.js";

/** 空间内的文本文件入口，写入接入空间历史，供插件读写领域资料。 */
export interface Files {
  read(file: string): Promise<string>;
  write(file: string, text: string): Promise<void>;
  list(directory?: string): Promise<string[]>;
}

/** 插件可用的空间历史入口，用于读取变化或记录带来源的一组操作。 */
export interface History {
  changes(since?: string): Promise<ChangeFeed>;
  list(limit?: number): Promise<Revision[]>;
  record<T>(source: ActivitySource, action: () => Promise<T>): Promise<{ value: T; snapshot: Snapshot }>;
}

/** 底座交给插件的空间能力，插件通过它访问文件、历史、模型和前端服务。 */
export interface Host {
  /** 底座与插件共用的当前时间，Unix 毫秒。 */
  now(): number;
  /** 空间根目录与本插件独占的数据目录；持久状态写入 dataDir。 */
  space: { root: string; dataDir: string };
  /** 读写空间内的文本文件，写入归属当前运行或插件。 */
  files: Files;
  /** 查询文件变化，或以指定来源记录一组空间操作。 */
  history: History;
  /** 发起由宿主持有生命周期的模型请求与 Agent 工作。 */
  models: Models;
  /** 调用前端声明的服务；输入与结果由插件和服务提供方约定。 */
  services: Services;
  /** 中止本插件声明的 Agent 的现有会话运行；等待 Pi 停稳并沿用原取消队列语义。 */
  abortAgent(agent: string): Promise<void>;
  /** 向订阅空间的连接发布本插件的事件，宿主补上插件 id。 */
  emit(event: unknown): void;
}

/** 可由底座加载的插件定义；open 为一个空间创建独立实例。 */
export interface Plugin {
  /** 插件唯一标识，用作协议命名空间与独占数据目录名。 */
  id: string;
  /** 为一个空间打开实例；返回前失败时，插件负责清理已打开的子实例与局部资源。 */
  open(host: Host): Promise<PluginInstance>;
}

/** 插件在一个空间中的实例，向宿主声明能力并持有相应的关闭责任。 */
export interface PluginInstance {
  /** 交给通用 Agent 的常驻说明，作为插件命名提示段。 */
  instructions?(): string;
  /** 本插件提供的 Agent 工具，打开时读取并校验名称与参数声明。 */
  tools?(): Tool[];
  /** 本领域的 Agent；打开插件时读取一次。 */
  agents?(): AgentDefinition[];
  /** 通用 Agent 当前需要的领域状态；undefined 表示本轮无可投影内容。 */
  view?(): Promise<string | undefined>;
  /** 按修订追赶空间文件变化；宿主串行调度并在关闭前等待。 */
  onChange?(revision: string): Promise<void>;
  /** 公开给协议客户端的方法，以本插件 id 作为命名空间。 */
  methods?: Record<string, PluginMethod>;
  /** 宿主取消模型并等待在途调用后关闭实例；此处还须等待插件自有通知与非模型后台工作。父插件自行关闭子实例时也负责先停止其工作。 */
  close?(): Promise<void>;
}

export { checkFormat } from "./space/format.js";
