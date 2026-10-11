import type { Static, TSchema } from "typebox";
import type { ActivitySource, ChangeFeed, Revision, Snapshot } from "@repa/space-history";
import type { ModelRef } from "./schema.js";

export type { ModelRef } from "./schema.js";
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
  view?(): Promise<string | undefined>;
  onChange?(revision: string): Promise<void>;
  methods?: Record<string, PluginMethod>;
  // 宿主先取消模型、等在途调用，再关闭直接加载的实例；父插件另行关闭子实例时也负责停止它的工作。
  // close 必须等待插件自有的通知与非模型后台工作完成。
  close?(): Promise<void>;
}
