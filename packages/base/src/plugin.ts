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

export interface AgentWork {
  id: string;
  result: Promise<void>;
  cancel(): Promise<void>;
}

export interface Models {
  complete(request: CompletionRequest): Promise<string>;
  completeStructured<S extends TSchema>(request: CompletionRequest, schema: S): Promise<Static<S>>;
  runAgent(task: AgentTask): Promise<AgentWork>;
}

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
  open(host: Host): Promise<PluginInstance>;
}

export interface PluginInstance {
  instructions?(): string;
  tools?(): Tool[];
  view?(): Promise<string | undefined>;
  onChange?(revision: string): Promise<void>;
  methods?: Record<string, PluginMethod>;
  close?(): Promise<void>;
}
