import path from "node:path";
import { Type, type Static } from "typebox";
import { IdSchema, object, literals } from "../schema.js";
import { FileLocationSchema, ContentRoleSchema, ContentMemberSchema, ResourceRefSchema, ContextBindingSchema } from "./schema.js";

export const RecordSchema = object({
  id: IdSchema, location: FileLocationSchema, role: ContentRoleSchema,
  mediaType: Type.String(), state: literals(["active", "deleted", "detached"]),
  members: Type.Array(ContentMemberSchema), resources: Type.Array(ResourceRefSchema),
  origin: Type.Optional(FileLocationSchema),
});
export type ContentRecord = Static<typeof RecordSchema>;
export const CatalogSchema = object({
  version: Type.Literal(1),
  items: Type.Record(Type.String(), RecordSchema),
  context: ContextBindingSchema,
});
export type Catalog = Static<typeof CatalogSchema>;
export const catalogPath = path.join(".repa", "content", "catalog.json");
export const emptyCatalog = (): Catalog => ({ version: 1, items: {}, context: null });
