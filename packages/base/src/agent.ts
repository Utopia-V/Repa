import type { Static, TSchema } from "typebox";
import type { AgentTask, AgentWork, CompletionRequest, Tool } from "./plugin.js";
import type { AgentEvent, Confirm, ModelRef, PromptOverrides, PromptSection, SessionEntry, SessionInfo } from "./schema.js";

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
  create(model?: ModelRef): Promise<AgentSession>;
  get(id: string): Promise<AgentSession>;
  list(): Promise<SessionInfo[]>;
  preview(): Promise<{ sections: PromptSection[]; views: { id: string; text: string }[] }>;
  runAgent(task: AgentTask): Promise<AgentWork>;
  close(): Promise<void>;
}

export interface AgentSpaceOptions {
  root: string;
  sessionsDir: string;
  instructions(): { id: string; text: string }[];
  tools(): Tool[];
  views(): Promise<{ id: string; text: string }[]>;
  overrides(): Promise<{ app: PromptOverrides; space: PromptOverrides }>;
  commandPolicy(): "ask" | "fullAccess";
  record<T>(runId: string, action: () => Promise<T>): Promise<T>;
  onEvent(event: AgentEvent): void;
  confirm: Confirm;
}

export interface AgentRuntime {
  openSpace(options: AgentSpaceOptions): Promise<AgentSpace>;
  listModels(): Promise<{ provider: string; id: string; name: string; available: boolean }[]>;
  login(provider: string, type: string, confirm: Confirm, signal?: AbortSignal): Promise<void>;
  setKey(provider: string, key: string): Promise<void>;
  logout(provider: string): Promise<void>;
  complete(request: CompletionRequest): Promise<string>;
  completeStructured<S extends TSchema>(request: CompletionRequest, schema: S): Promise<Static<S>>;
  close(): Promise<void>;
}

export interface AgentRuntimeOptions {
  agentDir: string;
}

export { createAgentRuntime } from "./agent/runtime.js";
