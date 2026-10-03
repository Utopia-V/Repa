import { Type, type Static } from "typebox";
import { IdSchema, RevisionSchema, object, literals } from "../schema.js";

const text = Type.String({ minLength: 1 });
export const ModelCompatibilitySchema = object({
  supportsStore: Type.Optional(Type.Boolean()),
  supportsDeveloperRole: Type.Optional(Type.Boolean()),
  supportsReasoningEffort: Type.Optional(Type.Boolean()),
  supportsUsageInStreaming: Type.Optional(Type.Boolean()),
  supportsFinishReason: Type.Optional(Type.Boolean()),
  maxTokensField: Type.Optional(literals(["max_completion_tokens", "max_tokens"])),
  requiresToolResultName: Type.Optional(Type.Boolean()),
  requiresAssistantAfterToolResult: Type.Optional(Type.Boolean()),
  requiresThinkingAsText: Type.Optional(Type.Boolean()),
  requiresReasoningContentOnAssistantMessages: Type.Optional(Type.Boolean()),
  thinkingFormat: Type.Optional(literals(["openai", "openrouter", "deepseek", "together", "baseten", "zai", "qwen", "chat-template", "qwen-chat-template", "string-thinking", "ant-ling"])),
  supportsStrictMode: Type.Optional(Type.Boolean()),
  supportsMaxOutputTokens: Type.Optional(Type.Boolean()),
});
export const ConnectionModelSchema = object({
  id: text,
  name: text,
  api: text,
  reasoning: Type.Boolean(),
  input: Type.Array(literals(["text", "image"]), { minItems: 1, uniqueItems: true }),
  contextWindow: Type.Integer({ minimum: 1 }),
  maxTokens: Type.Integer({ minimum: 1 }),
  cost: object({ input: Type.Number({ minimum: 0 }), output: Type.Number({ minimum: 0 }), cacheRead: Type.Number({ minimum: 0 }), cacheWrite: Type.Number({ minimum: 0 }) }),
  compat: Type.Optional(ModelCompatibilitySchema),
});
export type ConnectionModel = Static<typeof ConnectionModelSchema>;
export const ConnectionInputSchema = object({
  name: Type.String({ minLength: 1, maxLength: 256 }),
  provider: text,
  baseUrl: Type.Optional(text),
  authMode: literals(["credentials", "none"]),
  models: Type.Optional(Type.Array(ConnectionModelSchema, { minItems: 1 })),
});
export type ConnectionInput = Static<typeof ConnectionInputSchema>;
export const ConnectionSchema = object({
  ...ConnectionInputSchema.properties,
  id: IdSchema,
  revision: RevisionSchema,
  authId: IdSchema,
  authentication: object({ configured: Type.Boolean(), type: Type.Optional(literals(["api_key", "oauth"])) }),
});
export type ModelConnection = Static<typeof ConnectionSchema>;
export const ModelSelectionSchema = object({ connectionId: IdSchema, id: text });
export type ModelSelection = Static<typeof ModelSelectionSchema>;
export const ModelBindingSchema = object({ connection: ConnectionSchema, modelId: text });
export type ModelBinding = Static<typeof ModelBindingSchema>;
export const ModelFallbackSchema = object({
  on: Type.Literal("transient_error"),
  models: Type.Array(ModelSelectionSchema, { minItems: 1, uniqueItems: true }),
});
export type ModelFallback = Static<typeof ModelFallbackSchema>;
export const BoundModelFallbackSchema = object({
  on: ModelFallbackSchema.properties.on,
  models: Type.Array(ModelBindingSchema, { minItems: 1 }),
});
export type BoundModelFallback = Static<typeof BoundModelFallbackSchema>;
export const ModelAttemptSchema = object({
  callId: IdSchema,
  index: Type.Integer({ minimum: 0 }),
  binding: ModelBindingSchema,
  startedAt: Type.Number(),
  finishedAt: Type.Optional(Type.Number()),
  status: literals(["running", "completed", "failed", "cancelled", "interrupted"]),
  usage: Type.Optional(object({
    input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(),
    cacheWrite: Type.Number(), totalTokens: Type.Number(),
  })),
  error: Type.Optional(object({ code: Type.String(), message: Type.String() })),
});
export type ModelAttempt = Static<typeof ModelAttemptSchema>;
export function interruptModelAttempts(attempts: readonly ModelAttempt[]): ModelAttempt[] {
  return attempts.map(attempt => attempt.status === "running" ? { ...attempt, status: "interrupted" } : attempt);
}
export function updateModelAttempts(attempts: readonly ModelAttempt[], attempt: ModelAttempt): ModelAttempt[] {
  const index = attempts.findIndex(value => value.callId === attempt.callId && value.index === attempt.index);
  const result = structuredClone([...attempts]);
  if (index < 0) result.push(structuredClone(attempt));
  else result[index] = structuredClone(attempt);
  return result;
}
export const CatalogModelSchema = object({
  ...ConnectionModelSchema.properties,
  thinkingLevels: Type.Array(literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"])),
});
export const ModelCatalogSchema = object({ connection: ConnectionSchema, models: Type.Array(CatalogModelSchema) });
export type ModelCatalog = Static<typeof ModelCatalogSchema>;
const challenge = { id: IdSchema, message: Type.String() };
const prompt = { ...challenge, placeholder: Type.Optional(Type.String()) };
export const AuthChallengeSchema = Type.Union([
  object({ ...prompt, type: Type.Literal("text") }),
  object({ ...prompt, type: Type.Literal("secret") }),
  object({ ...prompt, type: Type.Literal("manual_code") }),
  object({
    ...challenge,
    type: Type.Literal("select"),
    options: Type.Array(object({ id: Type.String(), label: Type.String(), description: Type.Optional(Type.String()) })),
  }),
]);
export type AuthChallenge = Static<typeof AuthChallengeSchema>;
export const AuthNotificationSchema = Type.Union([
  object({ type: Type.Literal("info"), message: Type.String(), links: Type.Optional(Type.Array(object({ url: Type.String(), label: Type.Optional(Type.String()) }))) }),
  object({ type: Type.Literal("auth_url"), url: Type.String(), instructions: Type.Optional(Type.String()) }),
  object({ type: Type.Literal("device_code"), userCode: Type.String(), verificationUri: Type.String(), intervalSeconds: Type.Optional(Type.Number()), expiresInSeconds: Type.Optional(Type.Number()) }),
  object({ type: Type.Literal("progress"), message: Type.String() }),
]);
export type AuthNotification = Static<typeof AuthNotificationSchema>;
export const AuthQuerySchema = object({
  loginId: IdSchema,
  connectionId: IdSchema,
  status: literals(["pending", "completed", "cancelled", "failed"]),
  challenge: Type.Optional(AuthChallengeSchema),
  notifications: Type.Array(AuthNotificationSchema),
  error: Type.Optional(object({ code: text, message: Type.String() })),
  synchronizationRequired: Type.Optional(Type.Boolean()),
});
export type AuthQuery = Static<typeof AuthQuerySchema>;
const connection = { connectionId: IdSchema };
const login = { loginId: IdSchema };
export const modelMethods = {
  "connection.list": { params: object({}), result: Type.Array(ConnectionSchema) },
  "connection.get": { params: object(connection), result: ConnectionSchema },
  "connection.create": { params: ConnectionInputSchema, result: ConnectionSchema },
  "connection.update": { params: object({ ...connection, base: RevisionSchema, input: ConnectionInputSchema }), result: ConnectionSchema },
  "connection.remove": { params: object({ ...connection, base: RevisionSchema }), result: object({ removed: Type.Boolean() }) },
  "model.list": { params: object(connection), result: ModelCatalogSchema },
  "auth.start": { params: object({ ...connection, type: literals(["api_key", "oauth"]) }), result: AuthQuerySchema },
  "auth.get": { params: object(login), result: AuthQuerySchema },
  "auth.reply": { params: object({ ...login, challengeId: IdSchema, value: Type.String() }), result: AuthQuerySchema },
  "auth.cancel": { params: object(login), result: AuthQuerySchema },
  "auth.logout": { params: object(connection), result: ConnectionSchema },
};
export type ModelMethod = keyof typeof modelMethods;
export type ModelParams<M extends ModelMethod> = Static<(typeof modelMethods)[M]["params"]>;
