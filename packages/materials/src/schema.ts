import { Type, type Static } from "repa/plugin";
import { ContentTargetSchema, LocatorSchema, RepresentationSchema, ResourceRefSchema, UrlOriginSchema } from "repa/protocol";

const object = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(properties, { additionalProperties: false });
const index = Type.Integer({ minimum: 1 });
export const ExtractInputSchema = object({
  target: Type.Union([
    ContentTargetSchema,
    object({ kind: Type.Literal("resource"), resource: ResourceRefSchema }),
  ]),
  expectedBodyRevision: Type.Optional(Type.String({ minLength: 1 })),
  encoding: Type.Optional(Type.String({ minLength: 1, description: "文本或 HTML 的明确字符编码；省略时使用媒体类型中的 charset，否则按 UTF-8。" })),
  range: Type.Optional(Type.Union([
    object({ kind: Type.Literal("lines"), start: index, end: Type.Optional(index) }),
    object({ kind: Type.Literal("pages"), start: index, end: Type.Optional(index) }),
  ])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
});
export type ExtractInput = Static<typeof ExtractInputSchema>;
export type ExtractOptions = Pick<ExtractInput, "range" | "limit">;
export const ExtractDataSchema = object({
  status: Type.Enum(["ready", "empty", "unsupported", "invalid", "dependency_missing", "limit_exceeded"]),
  kind: Type.Enum(["text", "html", "pdf", "image", "unknown"]),
  reader: object({ name: Type.String(), version: Type.Optional(Type.String()), encoding: Type.Optional(Type.String()) }),
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
export const FetchInputSchema = object({
  url: Type.String({ minLength: 1 }),
  range: ExtractInputSchema.properties.range,
  limit: ExtractInputSchema.properties.limit,
});
export type FetchInput = Static<typeof FetchInputSchema>;
export const FetchSourceSchema = object({
  kind: Type.Literal("url"),
  requestedUrl: Type.String(),
  finalUrl: Type.String(),
  fetchedAt: Type.Number(),
  status: Type.Integer({ minimum: 200, maximum: 299 }),
  mediaType: Type.String(),
  contentType: Type.Optional(Type.String()),
  etag: Type.Optional(Type.String()),
  lastModified: Type.Optional(Type.String()),
  bodyRevision: Type.String(),
});
export type FetchSource = Static<typeof FetchSourceSchema>;
export const FetchDataSchema = object({
  source: FetchSourceSchema,
  origin: UrlOriginSchema,
  extraction: ExtractDataSchema,
  originalResourceIndex: Type.Integer({ minimum: 0 }),
});
export type FetchData = Static<typeof FetchDataSchema>;
export const FETCH_CONTRACT = { id: "repa.material.fetch", version: "1" };
export const FETCH_FORMAT = { id: "repa.material-fetch", version: "1" };
export const SearchInputSchema = object({
  query: Type.String({ minLength: 1, maxLength: 512 }),
  language: Type.Optional(Type.String({ pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$", maxLength: 20,
    description: "Wikipedia 语言版，例如 zh、en、ja；默认 zh。" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "本页最多结果数，默认 10。" })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
});
export type SearchInput = Static<typeof SearchInputSchema>;
export const SearchDataSchema = object({
  provider: object({ id: Type.Literal("wikipedia"), name: Type.Literal("Wikipedia"), scope: Type.Literal("encyclopedia") }),
  query: Type.String(), language: Type.String(), fetchedAt: Type.Number(),
  offset: Type.Integer({ minimum: 0 }), limit: Type.Integer({ minimum: 1 }),
  total: Type.Optional(Type.Integer({ minimum: 0 })),
  results: Type.Array(object({
    pageId: Type.Integer({ minimum: 1 }), title: Type.String(), url: Type.String(), snippet: Type.String(),
    pageUpdatedAt: Type.Optional(Type.Number()),
  })),
  next: Type.Optional(SearchInputSchema),
});
export type SearchData = Static<typeof SearchDataSchema>;
export const SEARCH_CONTRACT = { id: "repa.material.search", version: "1" };
export const SEARCH_FORMAT = { id: "repa.material-search", version: "1" };
export const MAX_BYTES = 32 * 1024 * 1024;
export const MAX_TEXT = 200000;
