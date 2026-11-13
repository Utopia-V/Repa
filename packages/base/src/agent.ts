import type { Static, TSchema } from "typebox";
import type { SessionBaseline } from "./protocol.js";
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

/** 一个固定归属 Agent 的会话；用于发送消息、排队、切换模型及读取公开历史。 */
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

/** 一个空间中的 Agent 会话集合；用于创建、恢复、运行及关闭会话。 */
export interface AgentSpace {
  /** 当前可用的 Agent；关掉的通用 Agent 不在其中。 */
  agents(): AgentInfo[];
  /** 省略 agent 时为通用 Agent；会话的 Agent 之后不能更换。 */
  create(options?: { agent?: string; model?: ModelRef }): Promise<AgentSession>;
  get(id: string): Promise<AgentSession>;
  list(): Promise<SessionInfo[]>;
  /** 只投影内存中正在运行或排队的会话，不加载磁盘会话。 */
  baseline(): SessionBaseline[];
  /** 会话记录文件的路径，只读取文件、不打开会话；没有这个会话时为 undefined。 */
  sessionFile(id: string): Promise<string | undefined>;
  /** 只中止内存中属于该 Agent 的会话，不发现或加载磁盘上的旧会话。 */
  abortAgent(agent: string): Promise<void>;
  preview(agent?: string): Promise<{ sections: PromptSection[]; views: { id: string; text: string }[] }>;
  runAgent(task: AgentTask): Promise<AgentWork>;
  /** 是否有工作：任一已载入或正在载入的会话有运行、排队、取消或入队中的消息，或 Pi 仍在运行、队列里还有消息。 */
  busy(): boolean;
  /** 同步地拒绝新的会话与运行，再中止已有运行、释放会话。 */
  close(): Promise<void>;
  /** 关闭以后可读：还没有第一条消息、因而没有会话文件的会话，重组时交给新的 Agent 空间。 */
  unsavedSessions(): UnsavedSession[];
}

/** 没有会话文件的会话的最小描述；新的 Agent 空间凭它以同一编号重建会话。 */
export interface UnsavedSession {
  id: string;
  agent: string;
  model?: ModelRef;
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
  /**
   * 文件工具在任何模式下都不写的目录，例如应用配置目录里保管已批准插件快照的 plugins/。
   * 按字面路径和解析符号链接后的路径判断，空间内外一样。
   */
  controlDirs?: string[];
  onEvent(event: AgentEvent): void;
  confirm: Confirm;
  /** ask_user 的询问路由，绑定发起运行的连接；省略时 ask_user 以 ask_unavailable 交回模型。 */
  ask?: AskRoute;
  /** 一项工作结束时调用；调用方据此重新判断 busy()。 */
  onIdle?(): void;
  /** 上一次装配里还没有会话文件的会话；按编号打开时找不到文件就照描述重建，前端手里的会话编号仍然有效。 */
  unsavedSessions?: UnsavedSession[];
}

/** 插件在空间内发起模型调用时的持久归属；不传时会话仅存在内存中。 */
export interface ModelCallScope {
  pluginId: string;
  root: string;
  sessionsDir: string;
}

/** 应用持有的 Agent 运行时，统一管理模型、凭据、空间会话和插件模型调用。 */
export interface AgentRuntime {
  /** 底座与插件共用的当前时间，Unix 毫秒。 */
  now(): number;
  openSpace(options: AgentSpaceOptions): Promise<AgentSpace>;
  listModels(): Promise<{ provider: string; id: string; name: string; available: boolean }[]>;
  listProviders(): Promise<ProviderInfo[]>;
  /** 新会话不指定模型时使用的模型；没有可用模型时为 undefined。 */
  defaultModel(): ModelRef | undefined;
  setDefaultModel(model: ModelRef): Promise<void>;
  login(provider: string, type: string, confirm: Confirm, signal?: AbortSignal): Promise<void>;
  setKey(provider: string, key: string): Promise<void>;
  logout(provider: string): Promise<void>;
  /** 保存的凭据里的全部字符串值，供反馈包脱敏；没有凭据文件时为空，文件读不了或损坏时抛错。 */
  credentials(): Promise<string[]>;
  complete(request: CompletionRequest, scope?: ModelCallScope): Promise<string>;
  completeStructured<S extends TSchema>(request: CompletionRequest, schema: S, scope?: ModelCallScope): Promise<Static<S>>;
  close(): Promise<void>;
}

export interface AgentRuntimeOptions {
  /** 当前时间，Unix 毫秒；省略时使用系统时钟。测试可通过闭包设定和拨动时间。 */
  now?: () => number;
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
