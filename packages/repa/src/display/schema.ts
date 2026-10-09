import { Type, type Static } from "typebox";
import { IdSchema, object } from "../schema.js";
import { ContentTargetSchema, ResourceHoldSchema, ResourceRefSchema } from "../content/schema.js";
import { CapabilitySelectionSchema, DisplaySourceSchema } from "../capabilities/schema.js";
import { BackgroundRequestSchema, RepresentationSchema, RequestSchema } from "../requests/schema.js";

export const SAVE_NEW_RESULT = "save-new-result-document";
export const SUBMIT_RESULT = "submit-result-to-agent";
export const PROCESS_RESULT = "process-display-result";
export const DisplayArtifactSchema = object({
  format: object({ id: Type.Literal("repa.display-html"), version: Type.Literal("1") }),
  value: object({ kind: Type.Literal("resource"), resource: ResourceRefSchema }),
  sources: RepresentationSchema.properties.sources,
  resources: RepresentationSchema.properties.resources,
});
export type DisplayArtifact = Static<typeof DisplayArtifactSchema>;
export const DisplayResultSchema = object({
  format: object({ id: Type.Literal("repa.display-result"), version: Type.Literal("1") }),
  value: object({ kind: Type.Literal("inline"), data: object({
    source: DisplaySourceSchema, artifact: DisplayArtifactSchema, input: Type.Unknown(),
    initialData: Type.Optional(Type.Unknown()),
  }) }),
  sources: RepresentationSchema.properties.sources,
  resources: RepresentationSchema.properties.resources,
});
export type DisplayResult = Static<typeof DisplayResultSchema>;
export const ProcessDisplayResultInputSchema = object({ operationId: IdSchema, result: DisplayResultSchema });
export type ProcessDisplayResultInput = Static<typeof ProcessDisplayResultInputSchema>;
export const SaveNewResultSchema = object({
  path: Type.String({ minLength: 1, pattern: "^[^\\r\\n]+$" }),
  inputSchema: Type.Record(Type.String(), Type.Unknown()),
});
export type SaveNewResult = Static<typeof SaveNewResultSchema>;
export const SubmitResultSchema = object({
  sessionId: IdSchema,
  instruction: Type.String({ minLength: 1 }),
  inputSchema: Type.Record(Type.String(), Type.Unknown()),
});
export const DisplayOpenSchema = object({
  spaceId: IdSchema,
  instanceId: IdSchema,
  source: Type.Union([
    object({ kind: Type.Literal("content"), target: ContentTargetSchema }),
    object({ kind: Type.Literal("artifact"), artifact: DisplayArtifactSchema, initialData: Type.Optional(Type.Unknown()) }),
  ]),
  saveNewResult: Type.Optional(SaveNewResultSchema),
  submitResult: Type.Optional(SubmitResultSchema),
  processResult: Type.Optional(object({
    selection: CapabilitySelectionSchema,
    inputSchema: Type.Record(Type.String(), Type.Unknown()),
  })),
});
export type DisplayOpen = Static<typeof DisplayOpenSchema>;
export const DisplayInstanceSchema = object({
  spaceId: IdSchema,
  instanceId: IdSchema,
  artifact: DisplayArtifactSchema,
  initialData: Type.Optional(Type.Unknown()),
  hold: ResourceHoldSchema,
  actions: Type.Array(object({
    name: Type.Union([Type.Literal(SAVE_NEW_RESULT), Type.Literal(SUBMIT_RESULT), Type.Literal(PROCESS_RESULT)]),
    inputSchema: Type.Record(Type.String(), Type.Unknown()),
  })),
});
export type DisplayInstance = Static<typeof DisplayInstanceSchema>;
const key = { spaceId: IdSchema, instanceId: IdSchema };
export const displayMethods = {
  "display.open": { params: DisplayOpenSchema, result: DisplayInstanceSchema },
  "display.get": { params: object(key), result: DisplayInstanceSchema },
  "display.close": { params: object(key), result: Type.Null() },
  "display.readResource": {
    params: object({ ...key, resourceId: Type.String({ pattern: "^[a-f0-9]{64}$" }) }),
    result: object({ resource: ResourceRefSchema, base64: Type.String() }),
  },
  "display.invoke": {
    params: object({ ...key, requestId: IdSchema,
      action: Type.Union([Type.Literal(SAVE_NEW_RESULT), Type.Literal(SUBMIT_RESULT), Type.Literal(PROCESS_RESULT)]), input: Type.Unknown() }),
    result: Type.Union([BackgroundRequestSchema, RequestSchema]),
  },
};
export type DisplayMethod = keyof typeof displayMethods;
export type DisplayParams<M extends DisplayMethod> = Static<(typeof displayMethods)[M]["params"]>;
