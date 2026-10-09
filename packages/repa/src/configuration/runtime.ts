import { Type, type Static } from "typebox";
import { ModelFallbackSchema, ModelSelectionSchema, ThinkingLevelSchema } from "../models/schema.js";
import { object } from "../schema.js";
import type { SettingsNamespaceDefinition } from "./definitions.js";
import { SummaryPromptsSchema } from "../agent/summary-settings.js";

export { ThinkingLevelSchema } from "../models/schema.js";
export const CompactionOptionsSchema = object({
  enabled: Type.Boolean(),
  reserveTokens: Type.Integer({ minimum: 1 }),
  keepRecentTokens: Type.Integer({ minimum: 0 }),
});
export const RetryOptionsSchema = object({
  enabled: Type.Boolean(),
  maxRetries: Type.Integer({ minimum: 0 }),
  baseDelayMs: Type.Number({ minimum: 0 }),
  maxAgentDelayMs: Type.Number({ minimum: 0 }),
});
export const RuntimeSettingsSchema = object({
  model: Type.Union([ModelSelectionSchema, Type.Null()]),
  fallback: Type.Union([ModelFallbackSchema, Type.Null()]),
  thinkingLevel: Type.Union([ThinkingLevelSchema, Type.Null()]),
  tools: Type.Union([Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }), Type.Null()]),
  compaction: Type.Union([CompactionOptionsSchema, Type.Null()]),
  retry: Type.Union([RetryOptionsSchema, Type.Null()]),
});
export type RuntimeSettings = Static<typeof RuntimeSettingsSchema>;
export const RUNTIME_SETTINGS_DEFINITION: SettingsNamespaceDefinition = {
  namespace: "runtime",
  settings: Object.fromEntries(Object.entries(RuntimeSettingsSchema.properties).map(([key, schema]) => [
    key, { schema, default: null, scopes: ["application", "space", "session"] },
  ])),
};

export const SUMMARY_SETTINGS_DEFINITION: SettingsNamespaceDefinition = {
  namespace: "summaryPrompts",
  settings: Object.fromEntries(Object.entries(SummaryPromptsSchema.properties).map(([key, schema]) => [
    key, { schema, default: null, scopes: ["application", "space", "session"] },
  ])),
};

export const AssembledPromptSchema = object({
  system: Type.String(),
  sources: Type.Array(object({
    id: Type.String(), enabled: Type.Boolean(),
    content: Type.Optional(Type.String()),
    dynamic: Type.Optional(Type.Boolean()),
    revision: Type.Optional(Type.String()),
    reference: Type.Optional(Type.String()),
  })),
});
export type AssembledPrompt = Static<typeof AssembledPromptSchema>;
