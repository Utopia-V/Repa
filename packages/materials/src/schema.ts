import { Type, type Static } from "repa/plugin";
import { ContentTargetSchema, LocatorSchema, RepresentationSchema } from "repa/protocol";

const object = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(properties, { additionalProperties: false });
const index = Type.Integer({ minimum: 1 });
export const ExtractInputSchema = object({
  target: ContentTargetSchema,
  expectedBodyRevision: Type.Optional(Type.String({ minLength: 1 })),
  range: Type.Optional(Type.Union([
    object({ kind: Type.Literal("lines"), start: index, end: Type.Optional(index) }),
    object({ kind: Type.Literal("pages"), start: index, end: Type.Optional(index) }),
  ])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
});
export type ExtractInput = Static<typeof ExtractInputSchema>;
export const ExtractDataSchema = object({
  status: Type.Enum(["ready", "empty", "unsupported", "invalid", "dependency_missing", "limit_exceeded"]),
  kind: Type.Enum(["text", "html", "pdf", "image", "unknown"]),
  reader: object({ name: Type.String(), version: Type.Optional(Type.String()) }),
  segments: Type.Array(object({ text: Type.String(), locator: LocatorSchema })),
  truncated: Type.Boolean(),
  total: Type.Optional(Type.Integer({ minimum: 0 })),
  title: Type.Optional(Type.String()),
  image: Type.Optional(object({ format: Type.String(), width: index, height: index, orientation: Type.Optional(index) })),
  issues: Type.Array(object({ code: Type.String(), message: Type.String() })),
});
export type ExtractData = Static<typeof ExtractDataSchema>;
export const ExtractOutputSchema = RepresentationSchema;
export const EXTRACT_CONTRACT = { id: "repa.material.extract", version: "1" };
export const EXTRACT_FORMAT = { id: "repa.material-extraction", version: "1" };
export const MAX_BYTES = 32 * 1024 * 1024;
export const MAX_TEXT = 200000;
