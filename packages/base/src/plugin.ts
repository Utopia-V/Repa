import type { Static, TSchema } from "typebox";
import type { ActivitySource, ChangeFeed, Revision, Snapshot } from "@repa/space-history";
import type { MessageDecision, ModelRef } from "./schema.js";

export type { MessageDecision, ModelRef } from "./schema.js";
export type { ActivitySource, ChangeFeed, Revision } from "@repa/space-history";

export interface Tool {
  name: string;
  description: string;
  parameters: TSchema;
  execute(input: unknown, context: { signal: AbortSignal; callId: string }): Promise<{ text: string; data?: unknown }>;
}

export interface PluginMethod {
  parameters: TSchema;
  invoke(input: unknown): Promise<unknown>;
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
/** 插件工具不能使用的名称：内置工具、Pi 的 powershell 与底座的 subagent。 */
export const RESERVED_TOOL_NAMES: readonly string[] = [...BUILTIN_TOOLS, "powershell", "subagent"];

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
   * 可用工具的名称：BUILTIN_TOOLS 中除 grep 外的内置工具与任一插件的工具。
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
  emit(event: unknown): void;
}

export interface Plugin {
  id: string;
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
