import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

export const object = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
export const identifier = Type.String({ minLength: 1 });
export const ModelRefSchema = object({ provider: identifier, id: identifier });
export type ModelRef = Static<typeof ModelRefSchema>;
export const PromptOverrideSchema = object({
  text: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean()),
});
export type PromptOverride = Static<typeof PromptOverrideSchema>;
export const PromptOverridesSchema = Type.Record(Type.String(), PromptOverrideSchema);
export type PromptOverrides = Static<typeof PromptOverridesSchema>;
export const PromptSectionSchema = object({
  id: identifier,
  defaultText: Type.String(),
  text: Type.String(),
  enabled: Type.Boolean(),
});
export type PromptSection = Static<typeof PromptSectionSchema>;
export const SettingsSchema = object({
  commandPolicy: Type.Union([Type.Literal("ask"), Type.Literal("fullAccess")]),
  recentSpaces: Type.Array(identifier, { maxItems: 20 }),
  prompts: PromptOverridesSchema,
});
export type Settings = Static<typeof SettingsSchema>;
export const UsageSchema = object({
  input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number(),
});
export type Usage = Static<typeof UsageSchema>;
export const SessionInfoSchema = object({
  id: identifier, createdAt: Type.String(), name: Type.Optional(Type.String()),
  model: Type.Optional(ModelRefSchema),
});
export type SessionInfo = Static<typeof SessionInfoSchema>;
export const SessionEntrySchema = object({
  id: identifier,
  type: Type.Union([
    Type.Literal("user"), Type.Literal("assistant"), Type.Literal("tool"),
    Type.Literal("view"), Type.Literal("prompt"), Type.Literal("contextEdit"),
    Type.Literal("compaction"), Type.Literal("usage"), Type.Literal("run"),
  ]),
  timestamp: Type.String(),
  text: Type.Optional(Type.String()),
  data: Type.Optional(Type.Unknown()),
  usage: Type.Optional(UsageSchema),
});
export type SessionEntry = Static<typeof SessionEntrySchema>;
export const AgentEventSchema = object({
  sessionId: identifier,
  type: Type.Union([
    Type.Literal("runStart"), Type.Literal("runEnd"), Type.Literal("textDelta"),
    Type.Literal("toolStart"), Type.Literal("toolEnd"), Type.Literal("message"),
    Type.Literal("usage"), Type.Literal("error"), Type.Literal("compaction"),
  ]),
  runId: Type.Optional(identifier), text: Type.Optional(Type.String()),
  tool: Type.Optional(Type.String()), data: Type.Optional(Type.Unknown()),
  usage: Type.Optional(UsageSchema),
});
export type AgentEvent = Static<typeof AgentEventSchema>;
export const ConfirmationSchema = object({
  kind: Type.Union([Type.Literal("command"), Type.Literal("input"), Type.Literal("select"), Type.Literal("display")]),
  title: Type.String(), message: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()), options: Type.Optional(Type.Array(Type.String())),
  secret: Type.Optional(Type.Boolean()),
});
export type Confirmation = Static<typeof ConfirmationSchema>;
export type Confirm = (request: Confirmation, signal?: AbortSignal) => Promise<string | boolean | null>;

export class RepaFault extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = "RepaFault";
  }
}

export function parse<S extends TSchema>(schema: S, input: unknown): Static<S> {
  if (!Value.Check(schema, input)) throw new RepaFault("invalid_input", "输入不符合接口要求");
  return input as Static<S>;
}
