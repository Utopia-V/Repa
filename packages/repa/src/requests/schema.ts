import { Type, type Static } from "typebox";
import { IdSchema as id, RevisionSchema, object, literals } from "../schema.js";
import { ContentTargetSchema, ResourceRefSchema } from "../content/schema.js";
import { PromptSettingsSchema } from "../configuration/schema.js";
import { SettingScopeSchema } from "../configuration/schema.js";
import { AssembledPromptSchema, CompactionOptionsSchema, RetryOptionsSchema, ThinkingLevelSchema } from "../configuration/runtime.js";
import { BoundModelFallbackSchema, ModelAttemptSchema, ModelBindingSchema, ModelFallbackSchema, ModelSelectionSchema } from "../models/schema.js";
import { SummaryPromptsSchema } from "../agent/summary-settings.js";
import { ExecutionApprovalSchema } from "../execution/schema.js";
import { CapabilitySourceSchema } from "../capabilities/schema.js";

export const ReplySchema = Type.Union([
  Type.String(),
  Type.Boolean(),
  Type.Null(),
]);
export type Reply = Static<typeof ReplySchema>;
export const InteractionReplyReceiptSchema = object({
  id, responseId: id, value: ReplySchema, acceptedAt: Type.Number(),
});
export type InteractionReplyReceipt = Static<typeof InteractionReplyReceiptSchema>;
export const InteractionReplyResultSchema = object({
  id, responseId: id, acceptedAt: Type.Number(), status: literals(["accepted", "already_processed"]),
});
export type InteractionReplyResult = Static<typeof InteractionReplyResultSchema>;

export const LocatorSchema = object({
  format: object({ id: Type.String(), version: Type.String() }),
  value: Type.Unknown(),
});
export const RepresentationSchema = object({
  format: object({ id: Type.String(), version: Type.String() }),
  value: Type.Union([
    object({ kind: Type.Literal("inline"), data: Type.Unknown() }),
    object({ kind: Type.Literal("resource"), resource: ResourceRefSchema }),
  ]),
  sources: Type.Array(object({ target: ContentTargetSchema, revision: RevisionSchema, locator: Type.Optional(LocatorSchema) })),
  resources: Type.Array(ResourceRefSchema), summary: Type.Optional(Type.String()),
});
export const InputSchema = object({ parts: Type.Array(Type.Union([
  object({ kind: Type.Literal("text"), text: Type.String() }),
  object({
    kind: Type.Literal("selection"), text: Type.String(),
    source: object({ target: ContentTargetSchema, base: Type.Optional(RevisionSchema),
      draftId: id, draftVersion: Type.Integer({ minimum: 0 }), locator: Type.Optional(LocatorSchema) }),
  }),
  object({ kind: Type.Literal("reference"), target: ContentTargetSchema, locator: Type.Optional(LocatorSchema) }),
  object({ kind: Type.Literal("resource"), resource: ResourceRefSchema, description: Type.Optional(Type.String()) }),
  object({ kind: Type.Literal("data"), representation: RepresentationSchema }),
]), { minItems: 1 }) });
export type Input = Static<typeof InputSchema>;
export const DispatchSchema = Type.Union([
  object({ kind: Type.Literal("start") }),
  object({ kind: Type.Literal("steer"), expectedRunId: id }),
  object({ kind: Type.Literal("queue") }),
]);
export const SessionTargetSchema = object({ spaceId: id, sessionId: id });
const legacySelection = {
  model: Type.Optional(object({ provider: Type.String(), id: Type.String(), baseUrl: Type.Optional(Type.String()) })),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  tools: Type.Optional(Type.Array(Type.String())),
};
export const RunOptionsSchema = object({
  ...legacySelection,
  connection: Type.Optional(ModelBindingSchema),
  fallback: Type.Optional(BoundModelFallbackSchema),
  compaction: Type.Optional(CompactionOptionsSchema),
  retry: Type.Optional(RetryOptionsSchema),
  summaryPrompts: Type.Optional(SummaryPromptsSchema),
  sources: Type.Optional(Type.Array(object({
    namespace: Type.String(), key: Type.String(),
    source: Type.Union([SettingScopeSchema, Type.Literal("default"), Type.Literal("request")]),
  }))),
});
export type RunOptions = Static<typeof RunOptionsSchema>;
export const RunSelectionSchema = object({
  model: Type.Optional(ModelSelectionSchema),
  fallback: Type.Optional(Type.Union([ModelFallbackSchema, Type.Null()])),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  tools: Type.Optional(Type.Array(Type.String(), { uniqueItems: true })),
  compaction: Type.Optional(CompactionOptionsSchema),
  retry: Type.Optional(RetryOptionsSchema),
  summaryPrompts: Type.Optional(SummaryPromptsSchema),
  prompts: Type.Optional(PromptSettingsSchema),
});
export const SubmitSchema = object({
  target: SessionTargetSchema, requestId: id, input: InputSchema, dispatch: DispatchSchema,
  selection: Type.Optional(RunSelectionSchema),
});
export type Submit = Static<typeof SubmitSchema>;
export const ContinueSchema = object({
  target: SessionTargetSchema, requestId: id, previousRequestId: id,
  input: Type.Optional(InputSchema), selection: Type.Optional(RunSelectionSchema),
});
export type Continue = Static<typeof ContinueSchema>;
// 已受理的旧记录保留原选择；读取历史不会用当前默认连接重新解释过去的请求。
const recordedSelection = Type.Union([
  RunSelectionSchema,
  object({ ...legacySelection, prompts: Type.Optional(PromptSettingsSchema) }),
]);
const recordedSubmit = object({ ...SubmitSchema.properties, selection: Type.Optional(recordedSelection) });
const recordedContinue = object({ ...ContinueSchema.properties, selection: Type.Optional(recordedSelection) });
export const RequestSchema = object({
  requestId: id, target: SessionTargetSchema,
  submission: Type.Union([recordedSubmit, recordedContinue]),
  input: InputSchema, createdAt: Type.Number(), sequence: Type.Integer({ minimum: 0 }),
  source: CapabilitySourceSchema,
  promptSettings: PromptSettingsSchema,
  runOptions: RunOptionsSchema,
  prompt: Type.Optional(AssembledPromptSchema),
  modelAttempts: Type.Optional(Type.Array(ModelAttemptSchema)),
  fallbackRequestId: Type.Optional(id),
  continuation: Type.Optional(object({ kind: Type.Literal("model_fallback"), previousRequestId: id })),
  interactionReplies: Type.Optional(Type.Array(InteractionReplyReceiptSchema)),
  status: literals(["queued", "running", "completed", "cancelled", "failed", "interrupted", "not_entered"]),
  delivery: Type.Union([
    object({ status: Type.Literal("pending") }),
    object({ status: Type.Literal("entered"), messageIds: Type.Array(id) }),
    object({ status: Type.Literal("not_entered"), reason: Type.String() }),
  ]),
  runId: Type.Optional(id),
  error: Type.Optional(object({ code: Type.String(), message: Type.String() })),
});
export type RequestRecord = Static<typeof RequestSchema>;
export const QueueSchema = object({
  target: SessionTargetSchema, status: literals(["running", "paused"]), requests: Type.Array(RequestSchema),
});
export type QueueView = Static<typeof QueueSchema>;

const dialog = {
  id,
  kind: literals(["select", "confirm", "input", "editor"]),
  title: Type.String(),
  message: Type.Optional(Type.String()),
  options: Type.Optional(Type.Array(Type.String())),
  initialValue: Type.Optional(Type.String()),
  expiresAt: Type.Optional(Type.Number()),
  execution: Type.Optional(ExecutionApprovalSchema),
};
export const SessionInteractionSchema = object({ ...dialog, spaceId: id, sessionId: id, runId: id });
export const BackgroundInteractionSchema = object({ ...dialog, spaceId: Type.Optional(id), requestId: id });
export const InteractionSchema = Type.Union([SessionInteractionSchema, BackgroundInteractionSchema]);
export type Interaction = Static<typeof InteractionSchema>;
export const BackgroundRequestSchema = object({
  requestId: id, spaceId: Type.Optional(id), operation: Type.String(), input: InputSchema,
  options: Type.Optional(Type.Unknown()),
  configuration: Type.Optional(Type.Unknown()),
  modelAttempts: Type.Optional(Type.Array(ModelAttemptSchema)),
  createdAt: Type.Number(), finishedAt: Type.Optional(Type.Number()),
  status: literals(["accepted", "running", "cancelling", "completed", "cancelled", "failed", "interrupted"]),
  progress: Type.Optional(Type.String()),
  interactions: Type.Array(InteractionSchema),
  interactionReplies: Type.Optional(Type.Array(InteractionReplyReceiptSchema)),
  result: Type.Optional(RepresentationSchema),
  error: Type.Optional(object({ code: Type.String(), message: Type.String() })),
});
export type BackgroundRequest = Static<typeof BackgroundRequestSchema>;
export type ProcessingResult = Static<typeof RepresentationSchema>;
