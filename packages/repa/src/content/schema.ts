import { Type, type Static } from "typebox";
import { IdSchema as id, object, RevisionSchema as revision, literals } from "../schema.js";

export const ContentRefSchema = object({ spaceId: id, id });
export type ContentRef = Static<typeof ContentRefSchema>;
export const FileLocationSchema = Type.Union([
  object({ kind: Type.Literal("relative"), path: Type.String({ minLength: 1 }) }),
  object({ kind: Type.Literal("external"), path: Type.String({ minLength: 1 }) }),
]);
export type FileLocation = Static<typeof FileLocationSchema>;
export const ContentTargetSchema = Type.Union([
  object({ kind: Type.Literal("content"), ref: ContentRefSchema }),
  object({ kind: Type.Literal("file"), spaceId: id, location: FileLocationSchema }),
]);
export type ContentTarget = Static<typeof ContentTargetSchema>;
export const ContentRoleSchema = literals(["document", "material"]);
export const ResourceRefSchema = object({ spaceId: id, id, mediaType: Type.String() });
export type ResourceRef = Static<typeof ResourceRefSchema>;
export const ContentMemberSchema = object({
  target: ContentTargetSchema,
  name: Type.Optional(Type.String()),
});
export const ContentInfoSchema = object({
  target: ContentTargetSchema,
  ref: Type.Optional(ContentRefSchema),
  location: FileLocationSchema,
  role: Type.Optional(ContentRoleSchema),
  mediaType: Type.String(),
  revision: Type.Union([revision, Type.Null()]),
  bodyRevision: Type.Optional(Type.Union([revision, Type.Null()])),
  status: literals(["available", "missing", "detached", "needs_recovery", "permission_required"]),
  fileType: Type.Optional(literals(["file", "directory"])),
  size: Type.Optional(Type.Number()),
  members: Type.Array(ContentMemberSchema),
  resources: Type.Array(ResourceRefSchema),
  origin: Type.Optional(FileLocationSchema),
});
export type ContentInfo = Static<typeof ContentInfoSchema>;
export const ContentReadSchema = object({
  content: ContentInfoSchema,
  text: Type.Optional(Type.String()),
  resource: Type.Optional(ResourceRefSchema),
  preparation: Type.Optional(object({ id, expiresAt: Type.Number() })),
  offset: Type.Optional(Type.Integer({ minimum: 1 })),
  nextOffset: Type.Optional(Type.Integer({ minimum: 1 })),
  totalLines: Type.Optional(Type.Integer({ minimum: 0 })),
  truncated: Type.Boolean(),
});
export type ContentRead = Static<typeof ContentReadSchema>;
export const ContentSnapshotSchema = object({ target: ContentTargetSchema, content: ContentInfoSchema, resource: Type.Optional(ResourceRefSchema) });
export type ContentSnapshot = Static<typeof ContentSnapshotSchema>;
export const ResourcePreparationSchema = object({ id, resource: ResourceRefSchema, expiresAt: Type.Number() });
export type ResourcePreparation = Static<typeof ResourcePreparationSchema>;
export const ResourceHoldSchema = object({ id, spaceId: id, expiresAt: Type.Number(),
  contents: Type.Array(ContentSnapshotSchema), resources: Type.Array(ResourceRefSchema) });
export type ResourceHold = Static<typeof ResourceHoldSchema>;
export const ContentValueSchema = Type.Union([
  object({ kind: Type.Literal("text"), text: Type.String() }),
  object({ kind: Type.Literal("resource"), resource: ResourceRefSchema }),
]);
export type ContentValue = Static<typeof ContentValueSchema>;
export const WriteBaseSchema = Type.Union([
  revision,
  object({ kind: Type.Literal("absent") }),
]);
export type WriteBase = Static<typeof WriteBaseSchema>;
export const ContentChangeSchema = object({
  path: Type.String(),
  before: Type.Union([revision, Type.Null()]),
  after: Type.Union([revision, Type.Null()]),
});
export const ContentChangeResultSchema = object({
  operationId: id,
  changes: Type.Array(ContentChangeSchema),
  contents: Type.Array(ContentInfoSchema),
});
export type ContentChangeResult = Static<typeof ContentChangeResultSchema>;
export const ContentOperationSchema = object({
  operationId: id,
  status: literals(["prepared", "committed", "rolled_back", "needs_recovery", "reconciled"]),
  createdAt: Type.Number(),
  result: Type.Optional(ContentChangeResultSchema),
  error: Type.Optional(Type.String()),
  conflicts: Type.Array(Type.String()),
  repairedBy: Type.Optional(id),
});
export type ContentOperation = Static<typeof ContentOperationSchema>;

export const ContentPatchInputSchema = object({
  operationId: id,
  patch: Type.String(),
  registrations: Type.Optional(Type.Array(object({
    path: Type.String({ minLength: 1 }),
    role: ContentRoleSchema,
    id: Type.Optional(id),
    members: Type.Optional(Type.Array(ContentMemberSchema)),
    resources: Type.Optional(Type.Array(ResourceRefSchema)),
  }))),
  compositions: Type.Optional(Type.Array(object({
    ref: ContentRefSchema,
    base: revision,
    members: Type.Array(ContentMemberSchema),
    resources: Type.Array(ResourceRefSchema),
  }))),
});
export type ContentPatchInput = Static<typeof ContentPatchInputSchema>;
