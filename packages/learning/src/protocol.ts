import { object, IdSchema, RevisionSchema, ContentChangeResultSchema } from "repa/protocol";
import type { Static } from "typebox";
import { ContextBindingSchema, ContextStateSchema, ContextViewSchema } from "./schema.js";

export const learningMethods = {
  "context.get": { params: object({ spaceId: IdSchema }), result: ContextStateSchema },
  "context.set": { params: object({ spaceId: IdSchema, operationId: IdSchema, base: RevisionSchema, binding: ContextBindingSchema }), result: ContentChangeResultSchema },
  "context.preview": { params: object({ spaceId: IdSchema }), result: ContextViewSchema },
};
export type LearningMethod = keyof typeof learningMethods;
export type LearningParams<M extends LearningMethod> = Static<(typeof learningMethods)[M]["params"]>;
export type LearningResult<M extends LearningMethod> = Static<(typeof learningMethods)[M]["result"]>;
export * from "./schema.js";
