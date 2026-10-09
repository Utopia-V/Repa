import type { ExecutionInput, ExecutionView } from "../execution/schema.js";
import type { Dialog, DialogOptions } from "../pi-host.js";
import type { Message, Params, Reply, RequestRecord, Result, SettingsView } from "../protocol.js";
import type { ProcessingResult, Submit, Continue } from "../requests/schema.js";
import type { ContentInfo, ContentTarget, ResourceRef } from "../content/schema.js";
import type { ModelCompleteOptions } from "../models/schema.js";
import type { CapabilityNotification } from "./schema.js";

export interface RepaCapabilityServices {
  progress?(message: string): void;
  ask?(dialog: Dialog, options?: DialogOptions): Promise<Reply>;
  settings(namespace: string): Promise<SettingsView>;
  /** 持久修改完成后发布失效通知；插件身份、作用域与来源由本次调用绑定。 */
  events?: { publish(notification: CapabilityNotification): void };
  resources?: {
    snapshot(params: { target: ContentTarget; revision?: string; maxBytes?: number }): Promise<{
      content: ContentInfo; resource: ResourceRef; bytes: Uint8Array;
    }>;
    retain(refs: readonly ResourceRef[]): void;
    create(bytes: Uint8Array, mediaType: string): Promise<ResourceRef>;
    read(ref: ResourceRef): Promise<Uint8Array>;
  };
  execution?: {
    run(input: ExecutionInput): Promise<ExecutionView>;
  };
  models?: {
    complete(options: ModelCompleteOptions): Promise<ProcessingResult>;
  };
  sessions?: {
    snapshot(params: { sessionId: string; revision?: string }): { revision: string; messages: Message[] };
    history(params: Omit<Params<"session.history">, "spaceId">): Result<"session.history">;
    submit(params: Submit | Continue): Promise<RequestRecord>;
  };
}
