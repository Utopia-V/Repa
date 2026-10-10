import { Type, type Static, type TSchema } from "typebox";

const object = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const identifier = Type.String({ minLength: 1 });

export const HistoryOptionsSchema = object({
  gitPath: Type.Optional(identifier),
  maxFileBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
});
export type HistoryOptions = Static<typeof HistoryOptionsSchema>;

export const ActivitySourceSchema = Type.Union([
  object({ kind: Type.Literal("agent"), runId: identifier }),
  object({ kind: Type.Literal("plugin"), pluginId: identifier }),
]);
export type ActivitySource = Static<typeof ActivitySourceSchema>;

export const SnapshotSourceSchema = Type.Union([
  ActivitySourceSchema,
  object({ kind: Type.Literal("external") }),
]);
export type SnapshotSource = Static<typeof SnapshotSourceSchema>;

export const SourceSchema = Type.Union([
  SnapshotSourceSchema,
  object({ kind: Type.Literal("undo"), revision: identifier }),
]);
export type Source = Static<typeof SourceSchema>;

export const RevisionSchema = object({
  id: identifier,
  parent: Type.Union([identifier, Type.Null()]),
  source: SourceSchema,
  timestamp: Type.String(),
});
export type Revision = Static<typeof RevisionSchema>;

export const ChangeSchema = Type.Union([
  object({
    kind: Type.Union([Type.Literal("added"), Type.Literal("modified"), Type.Literal("deleted")]),
    path: identifier,
  }),
  object({ kind: Type.Literal("renamed"), path: identifier, previousPath: identifier }),
]);
export type Change = Static<typeof ChangeSchema>;

export const ChangeFeedSchema = object({
  revision: identifier,
  revisions: Type.Array(object({ ...RevisionSchema.properties, changes: Type.Array(ChangeSchema) })),
});
export type ChangeFeed = Static<typeof ChangeFeedSchema>;

export const SnapshotSchema = object({
  revision: identifier,
  committed: Type.Boolean(),
  skipped: Type.Array(object({
    path: identifier,
    reason: Type.Union([Type.Literal("large"), Type.Literal("repository"), Type.Literal("special")]),
  })),
});
export type Snapshot = Static<typeof SnapshotSchema>;

export const UndoResultSchema = object({
  revision: identifier,
  restored: Type.Array(identifier),
  conflicts: Type.Array(identifier),
});
export type UndoResult = Static<typeof UndoResultSchema>;
