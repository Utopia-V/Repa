import { Type, type Static } from "typebox";
import { ContentTargetSchema, ResourceRefSchema } from "../content/schema.js";
import { object, RevisionSchema } from "../schema.js";
import { RangeSchema, TextSnippetSchema } from "./schema.js";

export const ContentSearchInputSchema = object({
  pattern: Type.String(), path: Type.Optional(Type.String()), glob: Type.Optional(Type.String()),
  ignoreCase: Type.Optional(Type.Boolean()), literal: Type.Optional(Type.Boolean()),
});
export type ContentSearchInput = Static<typeof ContentSearchInputSchema>;
export const ContentSearchMatchSchema = object({
  target: ContentTargetSchema, revision: RevisionSchema, resource: ResourceRefSchema,
  line: Type.Integer({ minimum: 1 }), range: RangeSchema, byteRange: RangeSchema, snippet: TextSnippetSchema,
});
export type ContentSearchMatch = Static<typeof ContentSearchMatchSchema>;
export const ContentSearchResultSchema = object({
  matches: Type.Array(ContentSearchMatchSchema),
  unavailable: Type.Array(object({ target: ContentTargetSchema, code: Type.String(), message: Type.String() })),
  truncated: Type.Boolean(), resources: Type.Array(ResourceRefSchema),
});
export type ContentSearchResult = Static<typeof ContentSearchResultSchema>;
