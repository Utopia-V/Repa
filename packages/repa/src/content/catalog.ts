import path from "node:path";
import { Type, type Static } from "typebox";
import { IdSchema, object, literals } from "../schema.js";
import { FileLocationSchema, ContentRoleSchema, ContentMemberSchema, ResourceRefSchema } from "./schema.js";

export const RecordSchema = object({
  id: IdSchema, location: FileLocationSchema, role: ContentRoleSchema,
  mediaType: Type.String(), state: literals(["active", "deleted", "detached"]),
  members: Type.Array(ContentMemberSchema), resources: Type.Array(ResourceRefSchema),
  origin: Type.Optional(FileLocationSchema),
});
export type ContentRecord = Static<typeof RecordSchema>;
// 共同字段保持严格，能力字段由已安装格式校验；未知格式数据随普通保存保留。
export const CatalogSchema = Type.Intersect([
  Type.Record(Type.String(), Type.Unknown()),
  Type.Object({
    version: Type.Literal(1),
    items: Type.Record(Type.String(), RecordSchema),
  }, { additionalProperties: true }),
]);
export type Catalog = Static<typeof CatalogSchema>;
export const catalogPath = path.join(".repa", "content", "catalog.json");
export const emptyCatalog = (fields: Record<string, unknown> = {}): Catalog => ({ ...fields, version: 1, items: {} });
