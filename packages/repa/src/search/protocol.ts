import { Type, type Static } from "typebox";
import { FileLocationSchema } from "../content/schema.js";
import { SessionTargetSchema } from "../requests/schema.js";
import { IdSchema, object, RevisionSchema } from "../schema.js";
import { ContentSearchInputSchema, ContentSearchMatchSchema, ContentSearchResultSchema } from "./content-schema.js";
import { HistorySearchMatchSchema } from "./schema.js";
export * from "./content-schema.js";
export * from "./schema.js";

export const HistorySearchInputSchema = object({
  sessionId: SessionTargetSchema.properties.sessionId,
  pattern: Type.String({ minLength: 1 }),
  literal: Type.Optional(Type.Boolean()),
  ignoreCase: Type.Optional(Type.Boolean()),
  revision: Type.Optional(RevisionSchema),
});
export type HistorySearchInput = Static<typeof HistorySearchInputSchema>;
export const ContentSearchSnapshotSchema = object({
  kind: Type.Literal("content"),
  query: ContentSearchInputSchema,
  ...ContentSearchResultSchema.properties,
});
export const HistorySearchSnapshotSchema = object({
  kind: Type.Literal("history"),
  spaceId: SessionTargetSchema.properties.spaceId,
  query: HistorySearchInputSchema,
  revision: RevisionSchema,
  matches: Type.Array(HistorySearchMatchSchema),
  truncated: Type.Boolean(),
});
export const SearchSnapshotSchema = Type.Union([ContentSearchSnapshotSchema, HistorySearchSnapshotSchema]);
export type SearchSnapshot = Static<typeof SearchSnapshotSchema>;
export const StoredSearchSnapshotSchema = object({
  format: Type.Literal("repa.search-snapshot"), version: Type.Literal(1), originSpaceId: IdSchema, result: SearchSnapshotSchema,
});
export type StoredSearchSnapshot = Static<typeof StoredSearchSnapshotSchema>;
export const SearchCursorSchema = object({
  snapshot: IdSchema,
  offset: Type.Integer({ minimum: 0 }),
});
export type SearchCursor = Static<typeof SearchCursorSchema>;
export const SearchPageInputSchema = object({
  cursor: SearchCursorSchema,
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export type SearchPageInput = Static<typeof SearchPageInputSchema>;

export const SearchPageNextSchema = object({
  snapshotIndex: Type.Integer({ minimum: 0 }), offset: Type.Integer({ minimum: 0 }),
});
/** 当前空间由表示的结果快照资源确定，不再重复保存一个可失效的 spaceId。 */
export const ScopedSearchTargetSchema = Type.Union([
  object({ kind: Type.Literal("content"), id: IdSchema }),
  object({ kind: Type.Literal("file"), location: FileLocationSchema }),
]);
export const ContentSearchPageMatchSchema = object({
  ...Type.Omit(ContentSearchMatchSchema, ["target", "revision", "resource"]).properties,
  sourceIndex: Type.Integer({ minimum: 0 }), resourceIndex: Type.Integer({ minimum: 0 }),
});
const page = {
  total: Type.Integer({ minimum: 0 }), next: Type.Optional(SearchPageNextSchema),
};
/** 搜索表示的实际 value.data；来源与字节引用只索引标准 sources/resources。 */
export const SearchPageDataSchema = Type.Union([
  object({
    kind: Type.Literal("content"), query: ContentSearchInputSchema,
    matches: Type.Array(ContentSearchPageMatchSchema), truncated: Type.Boolean(),
    unavailable: Type.Array(object({ target: ScopedSearchTargetSchema, code: Type.String(), message: Type.String() })),
    ...page,
  }),
  object({ ...Type.Omit(HistorySearchSnapshotSchema, ["spaceId"]).properties, ...page }),
]);
export type SearchPageData = Static<typeof SearchPageDataSchema>;
