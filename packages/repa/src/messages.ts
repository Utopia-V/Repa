import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { RepresentationSchema } from "./requests/schema.js";
import type { Block, Message } from "./protocol.js";
import type { ResourceRetention } from "./content/resources.js";
import type { ResourceRef } from "./content/schema.js";

export class Resources {
  constructor(readonly retention: ResourceRetention, readonly owner: string) {}
  add(mimeType: string, data: string): ResourceRef {
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(mimeType))
      mimeType = "application/octet-stream";
    return this.retention.pinBytes(this.owner, mimeType, Buffer.from(data, "base64"));
  }
  retainDetails(value: unknown): void {
    if (!Check(RepresentationSchema, value)) return;
    this.retention.retainAdditional(this.owner, [
      ...value.resources, ...(value.value.kind === "resource" ? [value.value.resource] : []),
    ]);
    if (value.value.kind === "inline") this.retainDetails(value.value.data);
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function blocks(content: unknown, resources: Resources): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.map((value) => {
    const part = record(value);
    if (part.type === "text" && typeof part.text === "string")
      return { type: "text", text: part.text };
    if (part.type === "thinking" && typeof part.thinking === "string")
      return { type: "thinking", text: part.thinking };
    if (
      part.type === "image" &&
      typeof part.mimeType === "string" &&
      typeof part.data === "string"
    )
      return {
        type: "resource",
        resource: resources.add(part.mimeType, part.data),
      };
    if (part.type === "toolCall")
      return {
        type: "tool_call",
        id: String(part.id),
        name: String(part.name),
        arguments: part.arguments ?? {},
      };
    return { type: "extension", data: JSON.parse(JSON.stringify(value)) };
  });
}

export function messageView(
  id: string,
  raw: unknown,
  resources: Resources,
): Message {
  const message = record(raw);
  resources.retainDetails(message.details);
  const role =
    message.role === "user" || message.role === "assistant"
      ? message.role
      : message.role === "toolResult"
        ? "tool"
        : "context";
  return {
    id,
    role,
    ...(typeof message.repaRequestId === "string" ? { requestId: message.repaRequestId } : {}),
    content: blocks(message.content, resources),
    timestamp: typeof message.timestamp === "number" ? message.timestamp : 0,
    ...(typeof message.toolCallId === "string"
      ? { toolCallId: message.toolCallId }
      : {}),
    ...(typeof message.toolName === "string" ? { name: message.toolName } : {}),
    ...(typeof message.errorMessage === "string"
      ? { error: message.errorMessage }
      : message.isError
        ? { error: "工具执行失败。" }
        : {}),
    ...(message.details !== undefined
      ? { details: JSON.parse(JSON.stringify(message.details)) }
      : {}),
  };
}

export function historyView(
  entries: SessionEntry[],
  resources: Resources,
): Message[] {
  return entries.flatMap((entry) => {
    // Pi 的 system 条目记录提示和工具配置；公开交流历史由实际消息与运行配置解释。
    if (entry.type === "message" && entry.message.role !== "system")
      return [messageView(entry.id, entry.message, resources)];
    if (entry.type === "custom_message")
      return [
        messageView(
          entry.id,
          { ...entry, role: "custom", timestamp: Date.parse(entry.timestamp) },
          resources,
        ),
      ];
    if (entry.type === "compaction" || entry.type === "branch_summary")
      return [
        {
          id: entry.id,
          role: "context" as const,
          content: [{ type: "text" as const, text: entry.summary }],
          timestamp: Date.parse(entry.timestamp),
        },
      ];
    return [];
  });
}
