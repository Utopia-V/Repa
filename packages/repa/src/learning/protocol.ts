import { object, IdSchema, RevisionSchema } from "../schema.js";
import { ContentChangeResultSchema } from "../content/schema.js";
import { ContextBindingSchema, ContextStateSchema, ContextViewSchema } from "./schema.js";

export const learningMethods = {
  "context.get": { params: object({ spaceId: IdSchema }), result: ContextStateSchema },
  "context.set": { params: object({ spaceId: IdSchema, operationId: IdSchema, base: RevisionSchema, binding: ContextBindingSchema }), result: ContentChangeResultSchema },
  "context.preview": { params: object({ spaceId: IdSchema }), result: ContextViewSchema },
};
export type LearningMethod = keyof typeof learningMethods;
