import { Type, type Static } from "typebox";
import { IdSchema as id, RevisionSchema, object } from "../schema.js";
import { ContentTargetSchema, ResourceRefSchema } from "../content/schema.js";

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
