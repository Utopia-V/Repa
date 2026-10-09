import { object, IdSchema, RevisionSchema, ContentChangeResultSchema, ContentRefSchema } from "repa/protocol";
import type { Static } from "typebox";
import { ContextBindingSchema, ContextStateSchema, ContextViewSchema } from "./schema.js";
import { AttemptViewSchema, RecordAttemptInputSchema, SaveJudgmentInputSchema, SelectJudgmentInputSchema } from "./attempt-schema.js";

export const learningMethods = {
  "attempt.get": { params: object({ spaceId: IdSchema, ref: ContentRefSchema }), result: AttemptViewSchema },
  "attempt.record": { params: object({ spaceId: IdSchema, ...RecordAttemptInputSchema.properties }), result: ContentChangeResultSchema },
  "attempt.judgment.save": { params: object({ spaceId: IdSchema, ...SaveJudgmentInputSchema.properties }), result: ContentChangeResultSchema },
  "attempt.judgment.select": { params: object({ spaceId: IdSchema, ...SelectJudgmentInputSchema.properties }), result: ContentChangeResultSchema },
  "context.get": { params: object({ spaceId: IdSchema }), result: ContextStateSchema },
  "context.set": { params: object({ spaceId: IdSchema, operationId: IdSchema, base: RevisionSchema, binding: ContextBindingSchema }), result: ContentChangeResultSchema },
  "context.preview": { params: object({ spaceId: IdSchema }), result: ContextViewSchema },
};
export type LearningMethod = keyof typeof learningMethods;
export type LearningParams<M extends LearningMethod> = Static<(typeof learningMethods)[M]["params"]>;
export type LearningResult<M extends LearningMethod> = Static<(typeof learningMethods)[M]["result"]>;
export * from "./schema.js";
