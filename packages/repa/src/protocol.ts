import { Type, type Static, type TSchema } from "typebox";
import { object, IdSchema as id, literals } from "./schema.js";
import { contentMethods } from "./content/protocol.js";
import { spaceMethods } from "./spaces/schema.js";
export * from "./spaces/schema.js";
import { ContentChangeResultSchema, ResourceRefSchema } from "./content/schema.js";
import { PromptSettingsSchema, SettingsGetParamsSchema, SettingsSetParamsSchema, SettingsResetParamsSchema, SettingsViewSchema, SettingScopeSchema } from "./configuration/schema.js";
export * from "./content/schema.js";
export * from "./configuration/schema.js";
export { RepaFault } from "./errors.js";

export const PROTOCOL_VERSION = 1;
const text = Type.String();
const key = { spaceId: id, sessionId: id };
export const SessionKeySchema = object(key);
export type SessionKey = Static<typeof SessionKeySchema>;

export const ResourceSchema = ResourceRefSchema;
export const BlockSchema = Type.Union([
  object({ type: Type.Literal("text"), text }),
  object({ type: Type.Literal("thinking"), text }),
  object({
    type: Type.Literal("tool_call"),
    id: text,
    name: text,
    arguments: Type.Unknown(),
  }),
  object({ type: Type.Literal("resource"), resource: ResourceSchema }),
  object({ type: Type.Literal("extension"), data: Type.Unknown() }),
]);
export const MessageSchema = object({
  id: text,
  role: Type.Union([
    Type.Literal("user"),
    Type.Literal("assistant"),
    Type.Literal("tool"),
    Type.Literal("context"),
  ]),
  content: Type.Array(BlockSchema),
  timestamp: Type.Number(),
  toolCallId: Type.Optional(text),
  name: Type.Optional(text),
  error: Type.Optional(text),
  details: Type.Optional(Type.Unknown()),
  streaming: Type.Optional(Type.Boolean()),
});
export type Message = Static<typeof MessageSchema>;
export type Block = Static<typeof BlockSchema>;

export const ErrorSchema = object({ code: text, message: text });
export type RepaError = Static<typeof ErrorSchema>;
export const RunSchema = object({
  ...key,
  id,
  text,
  status: literals([
    "accepted",
    "running",
    "waiting",
    "cancelling",
    "completed",
    "cancelled",
    "failed",
    "interrupted",
  ]),
  phase: literals([
    "preparing",
    "model",
    "tool",
    "retry",
    "compaction",
    "idle",
  ]),
  createdAt: Type.Number(),
  promptSettings: Type.Optional(PromptSettingsSchema),
  finishedAt: Type.Optional(Type.Number()),
  error: Type.Optional(ErrorSchema),
});
export type Run = Static<typeof RunSchema>;
export const isTerminal = (run: Run): boolean =>
  ["completed", "cancelled", "failed", "interrupted"].includes(run.status);

export const InteractionSchema = object({
  id,
  ...key,
  runId: id,
  kind: literals(["select", "confirm", "input", "editor"]),
  title: text,
  message: Type.Optional(text),
  options: Type.Optional(Type.Array(text)),
  initialValue: Type.Optional(text),
  expiresAt: Type.Optional(Type.Number()),
});
export type Interaction = Static<typeof InteractionSchema>;
export const ReplySchema = Type.Union([
  Type.String(),
  Type.Boolean(),
  Type.Null(),
]);
export type Reply = Static<typeof ReplySchema>;
export const NoticeSchema = object({
  id: text,
  code: text,
  message: text,
  level: literals(["info", "warning", "error"]),
});
export type Notice = Static<typeof NoticeSchema>;

export const SpaceSchema = object({ id, path: text, contentRevision: Type.Optional(text) });
export type Space = Static<typeof SpaceSchema>;
export const SessionSchema = object({
  ...key,
  title: text,
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  runtime: literals(["unloaded", "loading", "ready"]),
  messages: Type.Array(MessageSchema),
  runs: Type.Array(RunSchema),
  interactions: Type.Array(InteractionSchema),
  notices: Type.Array(NoticeSchema),
});
/** 会话当前状态的查询结果，与前端组件和布局独立。 */
export type SessionView = Static<typeof SessionSchema>;
export const SessionSummarySchema = object({
  ...key,
  title: text,
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  runtime: SessionSchema.properties.runtime,
  activeRun: Type.Optional(RunSchema),
});
export type SessionSummary = Static<typeof SessionSummarySchema>;
export const LifecycleSchema = literals([
  "running",
  "draining",
  "stopping",
  "stopped",
]);
export const SnapshotSchema = object({
  lifecycle: LifecycleSchema,
  spaces: Type.Array(SpaceSchema),
  sessions: Type.Array(SessionSchema),
});
export type Snapshot = Static<typeof SnapshotSchema>;
export const ScopeSchema = Type.Union([
  object({}),
  object({ spaceId: id }),
  object(key),
]);
export type Scope = Static<typeof ScopeSchema>;
export const ChangeSchema = Type.Union([
  object({ type: Type.Literal("session_removed"), ...key }),
  object({ type: Type.Literal("content"), spaceId: id, revision: text,
    paths: Type.Array(text), result: Type.Optional(ContentChangeResultSchema) }),
  object({ type: Type.Literal("settings"), scope: SettingScopeSchema, namespace: text }),
  object({ type: Type.Literal("lifecycle"), lifecycle: LifecycleSchema }),
  object({ type: Type.Literal("space"), space: SpaceSchema }),
  object({ type: Type.Literal("session"), session: SessionSchema }),
  object({
    type: Type.Literal("message"),
    ...key,
    message: MessageSchema,
    replaces: Type.Optional(text),
  }),
  object({
    type: Type.Literal("delta"),
    ...key,
    messageId: text,
    index: Type.Integer({ minimum: 0 }),
    kind: literals(["text", "thinking"]),
    text,
  }),
  object({ type: Type.Literal("run"), run: RunSchema }),
  object({
    type: Type.Literal("interaction"),
    ...key,
    id,
    interaction: Type.Union([InteractionSchema, Type.Null()]),
  }),
  object({ type: Type.Literal("notice"), ...key, notice: NoticeSchema }),
  object({
    type: Type.Literal("tool"),
    ...key,
    runId: id,
    callId: text,
    name: text,
    status: literals(["running", "completed", "failed"]),
  }),
]);
export type Change = Static<typeof ChangeSchema>;
export const DeliverySchema = Type.Union([
  object({
    type: Type.Literal("snapshot"),
    cursor: text,
    snapshot: SnapshotSchema,
  }),
  object({
    type: Type.Literal("changes"),
    cursor: text,
    changes: Type.Array(ChangeSchema),
  }),
]);
export type Delivery = Static<typeof DeliverySchema>;

const method = <P extends TSchema, R extends TSchema>(
  params: P,
  result: R,
) => ({ params, result });
export const methods = {
  ...contentMethods,
  ...spaceMethods,
  "settings.get": method(SettingsGetParamsSchema, SettingsViewSchema),
  "settings.set": method(SettingsSetParamsSchema, SettingsViewSchema),
  "settings.reset": method(SettingsResetParamsSchema, SettingsViewSchema),
  initialize: method(
    object({ versions: Type.Array(Type.Integer()), token: text, hostKey: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })) }),
    object({
      version: Type.Integer(),
      serverId: id,
      capabilities: Type.Array(text),
      hostKey: Type.String(),
    }),
  ),
  "space.open": method(
    object({ path: Type.String({ minLength: 1 }) }),
    SpaceSchema,
  ),
  "space.list": method(object({}), Type.Array(SpaceSchema)),
  "session.create": method(object({ spaceId: id }), SessionSchema),
  "session.list": method(
    object({ spaceId: id }),
    Type.Array(SessionSummarySchema),
  ),
  "session.get": method(SessionKeySchema, SessionSchema),
  "session.branch": method(object({ ...key, messageId: text }), SessionSchema),
  "session.close": method(SessionKeySchema, Type.Null()),
  "session.remove": method(SessionKeySchema, Type.Null()),
  "run.submit": method(
    object({ ...key, requestId: id, text: Type.String({ minLength: 1 }) }),
    RunSchema,
  ),
  "run.get": method(
    object({ spaceId: id, requestId: id }),
    Type.Union([RunSchema, object({ id, status: Type.Literal("unknown") })]),
  ),
  "run.cancel": method(object({ spaceId: id, requestId: id }), RunSchema),
  "interaction.reply": method(
    object({ ...key, id, value: ReplySchema }),
    Type.Null(),
  ),
  "state.get": method(object({ scope: ScopeSchema }), SnapshotSchema),
  "subscription.start": method(
    object({ id, scope: ScopeSchema, cursor: Type.Optional(text) }),
    Type.Null(),
  ),
  "subscription.stop": method(object({ id }), Type.Null()),
  "client.detach": method(object({}), Type.Null()),
  shutdown: method(
    object({ mode: literals(["drain", "cancel"]) }),
    Type.Null(),
  ),
};
export type Method = keyof typeof methods;
export type Params<M extends Method> = Static<(typeof methods)[M]["params"]>;
export type Result<M extends Method> = Static<(typeof methods)[M]["result"]>;
export const protocolSchema = {
  version: PROTOCOL_VERSION,
  methods,
  delivery: DeliverySchema,
};
