import { Type, type Static } from "typebox";
import { object, DisplayArtifactSchema } from "repa/protocol";
import { AttemptFactInputSchema } from "./attempt-schema.js";

const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const ExerciseSubmissionSchema = object({
  response: Type.String(),
  assistance: Type.Union([
    object({ kind: Type.Literal("unknown") }),
    object({ kind: Type.Literal("reported"), text: Type.String() }),
  ]),
  data: Type.Optional(Type.Unknown()),
});
export type ExerciseSubmission = Static<typeof ExerciseSubmissionSchema>;

const initialShape = {
  actor: AttemptFactInputSchema.properties.actor,
  materials: Type.Array(object({
    resourceId: hash,
    selector: Type.Optional(Type.String()),
    source: Type.Optional(Type.String()),
  }), { minItems: 1 }),
  data: Type.Unknown(),
};
const jsonResource = object({ id: hash, mediaType: Type.Literal("application/json") });
export const ExerciseInitialV1Schema = object({
  format: object({ id: Type.Literal("repa.learning-response"), version: Type.Literal("1") }),
  ...initialShape,
});
export type ExerciseInitialV1 = Static<typeof ExerciseInitialV1Schema>;
export const ExerciseInitialV2Schema = object({
  format: object({ id: Type.Literal("repa.learning-response"), version: Type.Literal("2") }),
  ...initialShape,
  previous: Type.Optional(object({ fact: jsonResource, presentation: jsonResource, submission: ExerciseSubmissionSchema })),
});
export type ExerciseInitialV2 = Static<typeof ExerciseInitialV2Schema>;
export const ExerciseInitialSchema = Type.Union([ExerciseInitialV1Schema, ExerciseInitialV2Schema]);
export type ExerciseInitial = Static<typeof ExerciseInitialSchema>;
export const ExerciseDisplayResultSchema = object({
  source: object({ kind: Type.Literal("artifact"), artifact: DisplayArtifactSchema, initialData: ExerciseInitialV2Schema }),
});
export type ExerciseDisplayResult = Static<typeof ExerciseDisplayResultSchema>;
