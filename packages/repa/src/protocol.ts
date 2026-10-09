import { Type, type Static, type TSchema } from "typebox";
import { object, IdSchema as id, RevisionSchema, literals } from "./schema.js";
import { displayMethods } from "./display/schema.js";
export * from "./display/schema.js";
import { contentMethods } from "./content/protocol.js";
import { spaceMethods, SpaceSchema } from "./spaces/schema.js";
import { modelMethods, ModelCompleteOptionsSchema } from "./models/schema.js";
import { learningMethods } from "./learning/protocol.js";
import { CapabilityScopeSchema, CapabilitySelectionSchema, CapabilityDescriptorSchema, CapabilitySourceSchema, CapabilityEventSchema } from "./capabilities/schema.js";
import { PluginPackageSchema } from "./plugins/schema.js";
import { executionMethods } from "./execution/protocol.js";
import { ExecutionViewSchema } from "./execution/schema.js";
export * from "./execution/schema.js";
import { packageMethods } from "./plugins/protocol.js";
export * from "./capabilities/schema.js";
export * from "./search/protocol.js";
export * from "./learning/schema.js";
export * from "./models/schema.js";
export * from "./configuration/runtime.js";
import { AssembledPromptSchema } from "./configuration/runtime.js";
export * from "./spaces/schema.js";
import { ContentChangeResultSchema, ResourceRefSchema } from "./content/schema.js";
import { PromptSettingsSchema, SettingsGetParamsSchema, SettingsSetParamsSchema, SettingsResetParamsSchema, SettingsViewSchema, SettingScopeSchema } from "./configuration/schema.js";
export * from "./content/schema.js";
export * from "./configuration/schema.js";
export { RepaFault } from "./errors.js";

import { SubmitSchema, ContinueSchema, RequestSchema, QueueSchema, BackgroundRequestSchema, RunOptionsSchema, InteractionSchema, ReplySchema, InteractionReplyResultSchema } from "./requests/schema.js";
export * from "./requests/schema.js";

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
  requestId: Type.Optional(id),
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
  prompt: Type.Optional(AssembledPromptSchema),
  requestIds: Type.Optional(Type.Array(id)),
  options: Type.Optional(RunOptionsSchema),
  finishedAt: Type.Optional(Type.Number()),
  error: Type.Optional(ErrorSchema),
});
export type Run = Static<typeof RunSchema>;
export const isTerminal = (run: Run): run is Run & { status: "completed" | "cancelled" | "failed" | "interrupted" } =>
  ["completed", "cancelled", "failed", "interrupted"].includes(run.status);

export const NoticeSchema = object({
  id: text,
  code: text,
  message: text,
  level: literals(["info", "warning", "error"]),
});
export type Notice = Static<typeof NoticeSchema>;

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
  processing: Type.Optional(Type.Array(BackgroundRequestSchema)),
  execution: Type.Optional(Type.Array(ExecutionViewSchema)),
});
export type Snapshot = Static<typeof SnapshotSchema>;
export const ScopeSchema = Type.Union([
  object({}),
  object({ spaceId: id }),
  object(key),
]);
export type Scope = Static<typeof ScopeSchema>;
export const ChangeSchema = Type.Union([
  object({ type: Type.Literal("capability"), event: CapabilityEventSchema }),
  object({ type: Type.Literal("connection"), connectionId: id }),
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
  object({ type: Type.Literal("request"), request: RequestSchema }),
  object({ type: Type.Literal("processing"), request: BackgroundRequestSchema }),
  object({ type: Type.Literal("execution"), execution: ExecutionViewSchema }),
  object({
    type: Type.Literal("execution_output"), spaceId: id, requestId: id,
    source: CapabilitySourceSchema, execId: id, stream: literals(["stdout", "stderr"]), text,
  }),
  object({ type: Type.Literal("queue"), queue: QueueSchema }),
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
    previousCursor: text,
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
  ...displayMethods,
  ...spaceMethods,
  ...modelMethods,
  ...learningMethods,
  ...packageMethods,
  ...executionMethods,
  "capability.describe": method(object({ scope: CapabilityScopeSchema }), object({
    capabilities: Type.Array(CapabilityDescriptorSchema),
    packages: Type.Array(PluginPackageSchema),
    issues: Type.Array(object({ pluginId: id, message: text })),
  })),
  "capability.invoke": method(object({ scope: CapabilityScopeSchema, requestId: id, ...CapabilitySelectionSchema.properties, input: Type.Unknown() }), Type.Union([
    object({ kind: Type.Literal("inline"), requestId: id, result: Type.Unknown() }),
    object({ kind: Type.Literal("background"), request: BackgroundRequestSchema }),
  ])),
  "prompts.preview": method(object({ ...key }), object({
    prompt: AssembledPromptSchema,
    settings: Type.Array(SettingsViewSchema),
  })),
  "model.complete": method(object({
    spaceId: id, requestId: id, ...ModelCompleteOptionsSchema.properties,
  }), BackgroundRequestSchema),
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
  "session.create": method(object({ spaceId: id }), SessionSchema),
  "session.list": method(
    object({ spaceId: id }),
    Type.Array(SessionSummarySchema),
  ),
  "session.get": method(SessionKeySchema, SessionSchema),
  "session.branch": method(object({ ...key, messageId: text }), SessionSchema),
  "session.close": method(SessionKeySchema, Type.Null()),
  "session.remove": method(SessionKeySchema, Type.Null()),
  "session.submit": method(SubmitSchema, RequestSchema),
  "session.continue": method(ContinueSchema, RequestSchema),
  "request.get": method(object({ spaceId: Type.Optional(id), requestId: id }),
    Type.Union([RequestSchema, BackgroundRequestSchema, object({ requestId: id, status: Type.Literal("unknown") })])),
  "request.cancel": method(object({ spaceId: Type.Optional(id), requestId: id }), BackgroundRequestSchema),
  "queue.list": method(SessionKeySchema, QueueSchema),
  "queue.resume": method(SessionKeySchema, QueueSchema),
  "queue.cancel": method(object({ ...key, requestId: id }), RequestSchema),
  "session.history": method({ ...object({ ...key, before: Type.Optional(id), around: Type.Optional(id),
    revision: Type.Optional(RevisionSchema), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }),
    not: { required: ["before", "around"] },
  }, object({ revision: RevisionSchema, messages: Type.Array(MessageSchema), before: Type.Optional(id) })),
  "run.get": method(object({ spaceId: id, runId: id }),
    Type.Union([RunSchema, object({ id, status: Type.Literal("unknown") })])),
  "run.cancel": method(object({ spaceId: id, runId: id }), RunSchema),
  "interaction.reply": method(
    object({ spaceId: Type.Optional(id), sessionId: Type.Optional(id), id, responseId: id, value: ReplySchema }),
    InteractionReplyResultSchema,
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
