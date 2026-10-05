import { Type, type Static } from "typebox";
import { CapabilitySourceSchema, LocatorSchema } from "repa/protocol";
import { FsrsCardSchema, FsrsGradeSchema, FsrsLogSchema, FsrsParametersSchema, FsrsReviewSchema } from "./fsrs-schema.js";
export * from "./fsrs-schema.js";

const object = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(properties, { additionalProperties: false });
const id = Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9_-]+$" });
const time = FsrsCardSchema.properties.due;
const revision = Type.Integer({ minimum: 1 });
const mutation = { operationId: id };
const existing = { ...mutation, itemId: id, base: revision };

/** 归属来自能力 scope；副本沿用本空间内容身份，不重复保存旧空间标识。 */
export const ReviewSourceSchema = object({
  contentId: id,
  revision: Type.Optional(Type.String({ minLength: 1 })),
  locator: Type.Optional(LocatorSchema),
});
export type ReviewSource = Static<typeof ReviewSourceSchema>;
export const ParameterVersionSchema = object({
  version: revision, createdAt: time,
  libraryVersion: Type.String(), algorithmVersion: Type.String(), parameters: FsrsParametersSchema,
});
export type ParameterVersion = Static<typeof ParameterVersionSchema>;
export const ReviewItemSchema = object({
  id, revision, prompt: Type.String({ minLength: 1 }), answer: Type.Optional(Type.String()),
  sources: Type.Array(ReviewSourceSchema), createdAt: time, updatedAt: time, paused: Type.Boolean(),
  card: FsrsCardSchema, parameterVersion: revision,
  dueAt: time, manualDueAt: Type.Optional(time),
});
export type ReviewItem = Static<typeof ReviewItemSchema>;
const event = { id, itemId: id, sequence: Type.Integer({ minimum: 1 }), recordedAt: time, recordedBy: CapabilitySourceSchema };
export const FeedbackEventSchema = object({
  ...event, kind: Type.Literal("feedback"), reviewedAt: time, rating: FsrsGradeSchema,
  response: Type.Optional(Type.String()), sources: Type.Array(ReviewSourceSchema), parameterVersion: revision,
  result: object({ card: FsrsCardSchema, log: FsrsLogSchema }),
});
export const FeedbackCorrectionSchema = Type.Union([
  object({ kind: Type.Literal("replace"), rating: FsrsGradeSchema, reviewedAt: time }),
  object({ kind: Type.Literal("void") }),
]);
export const CorrectionEventSchema = object({
  ...event, kind: Type.Literal("correction"), feedbackId: id,
  correction: FeedbackCorrectionSchema, reason: Type.String({ minLength: 1 }),
  parameterVersion: revision,
});
export const ReviewEventSchema = Type.Union([FeedbackEventSchema, CorrectionEventSchema]);
export type ReviewEvent = Static<typeof ReviewEventSchema>;
export type FeedbackEvent = Static<typeof FeedbackEventSchema>;
export type CorrectionEvent = Static<typeof CorrectionEventSchema>;
export const ReviewMutationResultSchema = object({
  item: ReviewItemSchema,
  event: Type.Optional(ReviewEventSchema),
  recomputedReviews: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type ReviewMutationResult = Static<typeof ReviewMutationResultSchema>;

export const CreateReviewInputSchema = object({
  ...mutation, prompt: Type.String({ minLength: 1 }), answer: Type.Optional(Type.String()),
  sources: Type.Optional(Type.Array(ReviewSourceSchema)),
});
export const UpdateReviewInputSchema = object({
  ...existing,
  patch: object({
    prompt: Type.Optional(Type.String({ minLength: 1 })),
    answer: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sources: Type.Optional(Type.Array(ReviewSourceSchema)),
  }),
});
export const ListReviewsInputSchema = object({
  dueBefore: Type.Optional(time), paused: Type.Optional(Type.Boolean()),
  after: Type.Optional(object({ dueAt: time, id })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});
export const ListReviewsResultSchema = object({ items: Type.Array(ReviewItemSchema), next: Type.Optional(object({ dueAt: time, id })) });
export const GetReviewInputSchema = object({ itemId: id });
export const SubmitFeedbackInputSchema = object({
  ...existing, rating: FsrsGradeSchema, reviewedAt: Type.Optional(time),
  response: Type.Optional(Type.String()), sources: Type.Optional(Type.Array(ReviewSourceSchema)),
});
export const CorrectFeedbackInputSchema = object({
  ...existing, feedbackId: id, correction: FeedbackCorrectionSchema, reason: Type.String({ minLength: 1 }),
});
export const SetReviewStatusInputSchema = object({ ...existing, paused: Type.Boolean() });
export const SetReviewScheduleInputSchema = object({ ...existing, dueAt: Type.Union([time, Type.Null()]) });
export const ReviewHistoryInputSchema = object({
  itemId: id, after: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});
export const ReviewHistoryResultSchema = object({ events: Type.Array(ReviewEventSchema), next: Type.Optional(Type.Integer({ minimum: 1 })) });
export const SetReviewParametersInputSchema = object({ ...mutation, base: revision, patch: Type.Partial(FsrsParametersSchema) });
export const GetReviewParametersInputSchema = object({ version: Type.Optional(revision) });
export const SetReviewParametersResultSchema = object({ parameters: ParameterVersionSchema, recomputedItems: Type.Integer({ minimum: 0 }) });

export type CreateReviewInput = Static<typeof CreateReviewInputSchema>;
export type UpdateReviewInput = Static<typeof UpdateReviewInputSchema>;
export type ListReviewsInput = Static<typeof ListReviewsInputSchema>;
export type ListReviewsResult = Static<typeof ListReviewsResultSchema>;
export type SubmitFeedbackInput = Static<typeof SubmitFeedbackInputSchema>;
export type CorrectFeedbackInput = Static<typeof CorrectFeedbackInputSchema>;
export type SetReviewStatusInput = Static<typeof SetReviewStatusInputSchema>;
export type SetReviewScheduleInput = Static<typeof SetReviewScheduleInputSchema>;
export type ReviewHistoryInput = Static<typeof ReviewHistoryInputSchema>;
export type ReviewHistoryResult = Static<typeof ReviewHistoryResultSchema>;
export type SetReviewParametersInput = Static<typeof SetReviewParametersInputSchema>;
export type SetReviewParametersResult = Static<typeof SetReviewParametersResultSchema>;

export const ReviewTrainingSnapshotSchema = object({
  parameters: ParameterVersionSchema, items: Type.Array(object({ id, reviews: Type.Array(FsrsReviewSchema) })),
});
export type ReviewTrainingSnapshot = Static<typeof ReviewTrainingSnapshotSchema>;

export const OptimizeReviewInputSchema = object({
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })),
});
export type OptimizeReviewInput = Static<typeof OptimizeReviewInputSchema>;
const optimization = {
  parameterVersion: revision, libraryVersion: Type.String(), algorithmVersion: Type.String(), optimizerVersion: Type.String(),
  dayBoundary: Type.Literal("UTC"), feedbackCount: Type.Integer({ minimum: 0 }), trainingItems: Type.Integer({ minimum: 0 }),
  firstReviewAt: Type.Optional(time), lastReviewAt: Type.Optional(time),
  trainingConfig: object({
    numEpochs: Type.Integer(), batchSize: Type.Integer(), seed: Type.Integer(), maxSeqLen: Type.Integer(),
    learningRate: Type.Number(), gamma: Type.Number(),
  }),
};
export const ReviewOptimizationResultSchema = Type.Union([
  object({ ...optimization, status: Type.Literal("ready"), w: Type.Array(Type.Number()), matchesDefaultWeights: Type.Boolean() }),
  object({ ...optimization, status: Type.Literal("insufficient_data") }),
]);
export type ReviewOptimizationResult = Static<typeof ReviewOptimizationResultSchema>;
