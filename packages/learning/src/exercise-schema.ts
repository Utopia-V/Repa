import { Type, type Static } from "typebox";
import { object } from "repa/protocol";
import { AttemptFactInputSchema } from "./attempt-schema.js";

const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const ExerciseInitialSchema = object({
  format: object({ id: Type.Literal("repa.learning-response"), version: Type.Literal("1") }),
  actor: AttemptFactInputSchema.properties.actor,
  materials: Type.Array(object({
    resourceId: hash,
    selector: Type.Optional(Type.String()),
    source: Type.Optional(Type.String()),
  }), { minItems: 1 }),
  data: Type.Unknown(),
});
export type ExerciseInitial = Static<typeof ExerciseInitialSchema>;
export const ExerciseSubmissionSchema = object({
  response: Type.String(),
  assistance: Type.Union([
    object({ kind: Type.Literal("unknown") }),
    object({ kind: Type.Literal("reported"), text: Type.String() }),
  ]),
  data: Type.Optional(Type.Unknown()),
});
export type ExerciseSubmission = Static<typeof ExerciseSubmissionSchema>;
