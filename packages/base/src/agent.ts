import type { Static, TSchema } from "typebox";
import type { AskRoute } from "./ask.js";
import type { AgentDefinition, AgentTask, AgentWork, CompletionRequest } from "./plugin.js";
import type { AgentEvent, AgentInfo, Confirm, ModelRef, PromptOverrides, PromptSection, ProviderInfo, SessionEntry, SessionInfo } from "./schema.js";
import type { SpaceWrites } from "./space.js";

/** 交给运行时的工具。运行时只提供 signal 与 callId；插件工具的参数校验和 ToolContext.ask 由插件宿主补上。 */
export interface AgentTool {
  name: string;
  description: string;
  parameters: TSchema;
  execute(input: unknown, context: { signal: AbortSignal; callId: string }): Promise<{ text: string; data?: unknown }>;
}

export interface AgentSession {
  info(): SessionInfo;
  history(): SessionEntry[];
  send(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  setModel(model: ModelRef): Promise<void>;
  compact(): Promise<void>;
  fork(entryId: string): Promise<AgentSession>;
}

export interface AgentSpace {
  /** 当前可用的 Agent；关掉的通用 Agent 不在其中。 */
  agents(): AgentInfo[];
  /** 省略 agent 时为通用 Agent；会话的 Agent 之后不能更换。 */
  create(options?: { agent?: string; model?: ModelRef }): Promise<AgentSession>;
  get(id: string): Promise<AgentSession>;
  list(): Promise<SessionInfo[]>;
  preview(agent?: string): Promise<{ sections: PromptSection[]; views: { id: string; text: string }[] }>;
  runAgent(task: AgentTask): Promise<AgentWork>;
  close(): Promise<void>;
}

export interface AgentSpaceOptions {
  root: string;
  sessionsDir: string;
  /** 全部插件的说明、工具和 view，组成通用 Agent。 */
  instructions(): { id: string; text: string }[];
  tools(): AgentTool[];
  views(): Promise<{ id: string; text: string }[]>;
  /** 插件声明的 Agent。 */
  agents?(): AgentDefinition[];
  /** 装配是否提供通用 Agent；默认提供。 */
  generalAgent?: boolean;
  /** 装配指定用户能直接对话的 Agent；省略时按定义的 direct，通用 Agent 默认可以。 */
  directAgents?: string[];
  overrides(): Promise<{ app: PromptOverrides; space: PromptOverrides }>;
  commandPolicy(): "ask" | "fullAccess";
  /** 带命令行的运行整次在这里执行：持空间写锁独占，前后整体快照记到这个运行。其余运行不经过它。 */
  record<T>(runId: string, action: () => Promise<T>): Promise<T>;
  /** 写入工具接入的空间写入路径；省略时直接写文件，不经过空间写锁和历史，供只测运行时的场合使用。 */
  writes?: SpaceWrites;
  onEvent(event: AgentEvent): void;
  confirm: Confirm;
  /** ask_user 的询问路由，绑定发起运行的连接；省略时 ask_user 以 ask_unavailable 交回模型。 */
  ask?: AskRoute;
}

export interface AgentRuntime {
  openSpace(options: AgentSpaceOptions): Promise<AgentSpace>;
  listModels(): Promise<{ provider: string; id: string; name: string; available: boolean }[]>;
  listProviders(): Promise<ProviderInfo[]>;
  /** 新会话不指定模型时使用的模型；没有可用模型时为 undefined。 */
  defaultModel(): ModelRef | undefined;
  setDefaultModel(model: ModelRef): Promise<void>;
  login(provider: string, type: string, confirm: Confirm, signal?: AbortSignal): Promise<void>;
  setKey(provider: string, key: string): Promise<void>;
  logout(provider: string): Promise<void>;
  complete(request: CompletionRequest): Promise<string>;
  completeStructured<S extends TSchema>(request: CompletionRequest, schema: S): Promise<Static<S>>;
  close(): Promise<void>;
}

export interface AgentRuntimeOptions {
  agentDir: string;
  /** 默认在提示段变化后的下一轮附上一次说明；关闭仅影响说明，不影响 Pi 的提示更新。 */
  promptChangeNotice?: boolean;
  /**
   * 子 Agent 最多嵌套几层，默认 3。这是 Repa 的假设：Agent 定义允许循环和重入，
   * 用层数挡住失控的递归，以后按实际使用调整。超过时启动请求作为工具错误交回父 Agent。
   */
  maxSubagentDepth?: number;
}

export { createAgentRuntime } from "./agent/runtime.js";
// Agent 写入工具（Pi 的 write、edit）使用的同一文件写入队列；装配空间时交给插件写入共用。
export { withFileMutationQueue } from "./agent/files.js";
