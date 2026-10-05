import { Type, type Static } from "typebox";
import { IdSchema, object, literals } from "../schema.js";
import { FileLocationSchema } from "../content/schema.js";

const text = Type.String({ minLength: 1 });
export const SpaceSchema = object({ id: IdSchema, path: Type.String(), contentRevision: Type.Optional(Type.String()) });
export type Space = Static<typeof SpaceSchema>;

export const DirectoryEntrySchema = object({
  name: text,
  path: text,
  kind: literals(["directory", "file", "symlink", "other"]),
  size: Type.Optional(Type.Integer({ minimum: 0 })),
  targetKind: Type.Optional(literals(["directory", "file", "other"])),
});
export type DirectoryEntry = Static<typeof DirectoryEntrySchema>;
export const BrowseDirectoryInputSchema = object({
  path: Type.Optional(text),
  cursor: Type.Optional(text),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  includeHidden: Type.Optional(Type.Boolean()),
});
export type BrowseDirectoryInput = Static<typeof BrowseDirectoryInputSchema>;
export const DirectoryListingSchema = object({
  path: text,
  parent: Type.Union([text, Type.Null()]),
  entries: Type.Array(DirectoryEntrySchema),
  nextCursor: Type.Optional(text),
});
export type DirectoryListing = Static<typeof DirectoryListingSchema>;

export const RecentSpaceRecordSchema = object({
  path: text,
  lastOpenedAt: Type.Integer({ minimum: 0 }),
});
export type RecentSpaceRecord = Static<typeof RecentSpaceRecordSchema>;
export const RecentSpaceSchema = object({ ...RecentSpaceRecordSchema.properties, available: Type.Boolean() });
export type RecentSpace = Static<typeof RecentSpaceSchema>;

export const SpaceOperationSchema = object({
  operationId: IdSchema,
  kind: literals(["backup", "copy", "restore"]),
  status: literals(["prepared", "completed", "failed"]),
  spaceId: IdSchema,
  destination: Type.String(),
  externalDependencies: Type.Array(FileLocationSchema),
  participants: Type.Array(object({ id: IdSchema, version: Type.String(), directory: Type.String() })),
  error: Type.Optional(object({ code: Type.String(), message: Type.String() })),
});
export type SpaceOperation = Static<typeof SpaceOperationSchema>;
const operation = { operationId: IdSchema };
const destination = { destination: Type.String({ minLength: 1 }) };
export const spaceMethods = {
  "space.open": { params: object({ path: text }), result: SpaceSchema },
  "space.list": { params: object({}), result: Type.Array(SpaceSchema) },
  "space.browse": { params: BrowseDirectoryInputSchema, result: DirectoryListingSchema },
  "space.create": { params: object({ hint: text }), result: SpaceSchema },
  "space.recent": {
    params: object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
    result: Type.Array(RecentSpaceSchema),
  },
  "space.backup": { params: object({ ...operation, ...destination, spaceId: IdSchema }), result: SpaceOperationSchema },
  "space.copy": { params: object({ ...operation, ...destination, spaceId: IdSchema }), result: SpaceOperationSchema },
  "space.restore": { params: object({ ...operation, ...destination, source: Type.String({ minLength: 1 }) }), result: SpaceOperationSchema },
  "space.operation.get": { params: object(operation), result: Type.Union([SpaceOperationSchema, object({ ...operation, status: Type.Literal("unknown") })]) },
};
export type SpaceMethod = keyof typeof spaceMethods;

/** 声明该目录的实际持久 owner；实现数据库一致性及独立副本中的业务引用映射。 */
export interface SpaceSnapshotParticipant {
  id: string;
  version: string;
  directory: string;
  capture(context: {
    sourceDirectory: string;
    destinationDirectory: string;
    sourceSpaceId: string;
    targetSpaceId: string;
    mode: "backup" | "copy";
  }): Promise<void>;
}
