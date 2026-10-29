import { Type, type Static, type TSchema } from "typebox";

const object = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const identifier = Type.String({ minLength: 1 });

/** 历史库打开选项的 schema，供调用方指定独占访问、Git 路径和文件大小限制。 */
export const HistoryOptionsSchema = object({
  // 调用方已持有空间锁，允许打开前清理上次进程退出后遗留的 Git 锁。
  exclusive: Type.Optional(Type.Boolean()),
  gitPath: Type.Optional(identifier),
  maxFileBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
});
/** 打开历史库的选项，供持锁调用方指定 Git 与文件大小限制。 */
export type HistoryOptions = Static<typeof HistoryOptionsSchema>;

// 同一 runId 可以有多次提交。ancestorRunIds 由近到远列出发起这个运行的各级运行，根运行不写；旧历史没有这个字段。
/** 主动写入来源的 schema，用于区分 Agent 运行与插件操作。 */
export const ActivitySourceSchema = Type.Union([
  object({ kind: Type.Literal("agent"), runId: identifier, ancestorRunIds: Type.Optional(Type.Array(identifier)) }),
  object({ kind: Type.Literal("plugin"), pluginId: identifier }),
]);
/** 一次主动写入的来源，用于区分 Agent 运行与插件操作。 */
export type ActivitySource = Static<typeof ActivitySourceSchema>;

/** 普通快照来源的 schema，接受主动写入来源或外部文件变化。 */
export const SnapshotSourceSchema = Type.Union([
  ActivitySourceSchema,
  object({ kind: Type.Literal("external") }),
]);
/** 一次普通快照的来源，含主动写入和外部文件变化。 */
export type SnapshotSource = Static<typeof SnapshotSourceSchema>;

/** 历史提交来源的 schema，覆盖普通快照与按修订或运行撤回的记录。 */
export const SourceSchema = Type.Union([
  SnapshotSourceSchema,
  object({ kind: Type.Literal("undo"), revision: identifier }),
  object({ kind: Type.Literal("undo"), runId: identifier }),
]);
/** 历史提交的完整来源，含普通快照与按修订或运行撤回的记录。 */
export type Source = Static<typeof SourceSchema>;

/** 历史修订的 schema，供列表传输修订 id、父修订、时间和操作来源。 */
export const RevisionSchema = object({
  id: identifier,
  parent: Type.Union([identifier, Type.Null()]),
  source: SourceSchema,
  timestamp: Type.String(),
});
/** 历史中的一条修订，供列表显示父修订、时间和操作来源。 */
export type Revision = Static<typeof RevisionSchema>;

/** 文件变化的 schema，供变更列表区分新增、修改、删除与重命名。 */
export const ChangeSchema = Type.Union([
  object({
    kind: Type.Union([Type.Literal("added"), Type.Literal("modified"), Type.Literal("deleted")]),
    path: identifier,
  }),
  object({ kind: Type.Literal("renamed"), path: identifier, previousPath: identifier }),
]);
/** 一条文件变化，供变更列表区分新增、修改、删除与重命名。 */
export type Change = Static<typeof ChangeSchema>;

/** 历史变化集合的 schema，供插件从指定修订继续追赶并更新领域视图。 */
export const ChangeFeedSchema = object({
  revision: identifier,
  revisions: Type.Array(object({ ...RevisionSchema.properties, changes: Type.Array(ChangeSchema) })),
});
/** 从指定修订之后的变化集合，用于插件追赶历史与更新领域视图。 */
export type ChangeFeed = Static<typeof ChangeFeedSchema>;

/** 快照结果的 schema，说明是否产生提交以及哪些文件被跳过。 */
export const SnapshotSchema = object({
  revision: identifier,
  committed: Type.Boolean(),
  skipped: Type.Array(object({
    path: identifier,
    reason: Type.Union([Type.Literal("large"), Type.Literal("repository"), Type.Literal("special")]),
  })),
});
/** 一次快照的结果，含是否产生提交以及被跳过的文件。 */
export type Snapshot = Static<typeof SnapshotSchema>;

/** 撤回结果的 schema，供调用方查看新修订和未能撤回的冲突。 */
export const UndoResultSchema = object({
  revision: identifier,
  restored: Type.Array(identifier),
  conflicts: Type.Array(identifier),
});
/** 选择性撤回的结果，供调用方查看新修订和未能撤回的冲突。 */
export type UndoResult = Static<typeof UndoResultSchema>;
