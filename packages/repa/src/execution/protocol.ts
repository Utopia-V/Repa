import { Type } from "typebox";
import { IdSchema, object } from "../schema.js";
import { BackgroundRequestSchema } from "../requests/schema.js";
import { ExecutionInputSchema, ExecutionPolicySchema, ExecutionViewSchema } from "./schema.js";

export const executionMethods = {
  "execution.run": {
    params: object({ spaceId: IdSchema, requestId: IdSchema, ...ExecutionInputSchema.properties }),
    result: BackgroundRequestSchema,
  },
  "execution.inspect": {
    params: object({ spaceId: IdSchema }),
    result: object({
      cwd: Type.String(), policy: ExecutionPolicySchema,
      protectedPaths: Type.Array(Type.String()), active: Type.Array(ExecutionViewSchema),
    }),
  },
};
