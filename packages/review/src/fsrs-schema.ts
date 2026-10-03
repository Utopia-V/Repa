import { Type, type Static, type TSchema } from "typebox";

const object = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const timestamp = Type.Integer({ minimum: -8640000000000000, maximum: 8640000000000000 });
const count = Type.Integer({ minimum: 0 });
const state = Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3)]);
const step = Type.TemplateLiteral([Type.Number(), Type.Union([
  Type.Literal("m"), Type.Literal("h"), Type.Literal("d"),
])]);

export const FsrsGradeSchema = Type.Union([
  Type.Literal(1), Type.Literal(2), Type.Literal(3), Type.Literal(4),
]);
export type FsrsGrade = Static<typeof FsrsGradeSchema>;

export const FsrsCardSchema = object({
  due: timestamp,
  stability: Type.Number({ minimum: 0 }),
  difficulty: Type.Number({ minimum: 0 }),
  elapsed_days: count,
  scheduled_days: count,
  learning_steps: count,
  reps: count,
  lapses: count,
  state,
  last_review: Type.Optional(timestamp),
});
export type FsrsCard = Static<typeof FsrsCardSchema>;

export const FsrsParametersSchema = object({
  request_retention: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
  maximum_interval: Type.Integer({ minimum: 1 }),
  w: Type.Array(Type.Number()),
  enable_fuzz: Type.Boolean(),
  enable_short_term: Type.Boolean(),
  learning_steps: Type.Array(step),
  relearning_steps: Type.Array(step),
});
export type FsrsParameters = Static<typeof FsrsParametersSchema>;

export const FsrsLogSchema = object({
  rating: FsrsGradeSchema,
  state,
  due: timestamp,
  stability: Type.Number({ minimum: 0 }),
  difficulty: Type.Number({ minimum: 0 }),
  elapsed_days: count,
  last_elapsed_days: count,
  scheduled_days: count,
  learning_steps: count,
  review: timestamp,
});
export type FsrsLog = Static<typeof FsrsLogSchema>;

export const FsrsReviewSchema = object({
  rating: FsrsGradeSchema,
  review: timestamp,
});
export type FsrsReview = Static<typeof FsrsReviewSchema>;
