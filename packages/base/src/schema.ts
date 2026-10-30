import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

/** 构造拒绝未知字段的对象 schema，供底座公开数据与协议定义复用。 */
export const object = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
/** 非空字符串 schema，用于标识符和必须填写的字符串字段。 */
export const identifier = Type.String({ minLength: 1 });
/** 模型引用的 schema，记录提供方与模型 id，用于选择会话模型或单次调用。 */
export const ModelRefSchema = object({ provider: identifier, id: identifier });
/** 提供方与模型 id 的引用，用于选择会话模型或单次模型调用。 */
export type ModelRef = Static<typeof ModelRefSchema>;
/** 认证方式的 schema，限定 API key 或 OAuth，供登录与凭据状态使用。 */
export const AuthTypeSchema = Type.Union([Type.Literal("api_key"), Type.Literal("oauth")]);
/** 模型提供方的认证方式，用于登录、凭据状态与前端选项。 */
export type AuthType = Static<typeof AuthTypeSchema>;
// login 为 false 的方式只能在 Repa 之外配置（例如环境变量）；stored 表示有可由 auth.logout 删除的保存凭据。
/** 提供方认证信息的 schema，描述可用登录方式与配置状态，供前端认证设置使用。 */
export const ProviderInfoSchema = object({
  id: identifier,
  name: Type.String(),
  methods: Type.Array(object({ type: AuthTypeSchema, name: Type.String(), login: Type.Boolean() })),
  configured: Type.Optional(AuthTypeSchema),
  stored: Type.Boolean(),
});
/** 模型提供方的认证选项与配置状态，供前端显示登录和退出入口。 */
export type ProviderInfo = Static<typeof ProviderInfoSchema>;
/** 单个提示段覆盖的 schema，允许修改文本或启用状态，供应用和空间设置使用。 */
export const PromptOverrideSchema = object({
  text: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean()),
});
/** 对一个命名提示段的文本或启用状态覆盖，供应用和空间设置使用。 */
export type PromptOverride = Static<typeof PromptOverrideSchema>;
/** 提示段覆盖集合的 schema，以段 id 为键，供应用与空间合并设置。 */
export const PromptOverridesSchema = Type.Record(Type.String(), PromptOverrideSchema);
/** 以提示段 id 为键的覆盖集合，用于合并应用与空间提示设置。 */
export type PromptOverrides = Static<typeof PromptOverridesSchema>;
/** 提示段的公开 schema，保留默认文本、实际文本与启用状态，供预览和设置界面使用。 */
export const PromptSectionSchema = object({
  id: identifier,
  defaultText: Type.String(),
  text: Type.String(),
  enabled: Type.Boolean(),
});
/** 一个提示段的默认内容、实际文本与启用状态，供预览和设置界面使用。 */
export type PromptSection = Static<typeof PromptSectionSchema>;
/** 备份设置的 schema：检查间隔（分钟）与每个空间保留的定期备份份数，学习者在设置页调整。 */
export const BackupSettingsSchema = object({
  // 下限 5 分钟是 Repa 的假设：间隔太短时，保留的几份只覆盖最近几分钟，较早的状态很快被挤掉。上限一天，定时器不会溢出。
  intervalMinutes: Type.Integer({ minimum: 5, maximum: 1440 }),
  keep: Type.Integer({ minimum: 1, maximum: 100 }),
});
/** 备份的检查间隔与保留份数，默认 30 分钟、5 份。 */
export type BackupSettings = Static<typeof BackupSettingsSchema>;
/** 应用设置的 schema，限定命令策略、最近空间、提示覆盖与备份设置，供持久化和协议校验使用。 */
export const SettingsSchema = object({
  commandPolicy: Type.Union([Type.Literal("ask"), Type.Literal("fullAccess")]),
  recentSpaces: Type.Array(identifier, { maxItems: 20 }),
  prompts: PromptOverridesSchema,
  backup: BackupSettingsSchema,
});
/** 应用保存的命令策略、最近空间、提示覆盖和备份设置，供设置存取与协议交互使用。 */
export type Settings = Static<typeof SettingsSchema>;
/**
 * 一份备份的 schema：id 在所属空间的备份中唯一，bytes 是所收文件的大小之和。
 * kind 为 beforeRestore 的是恢复到原位置之前自动保存的备份，不参与轮换，学习者删除前一直保留。
 */
export const BackupInfoSchema = object({
  id: identifier,
  createdAt: Type.String(),
  bytes: Type.Integer({ minimum: 0 }),
  kind: Type.Union([Type.Literal("regular"), Type.Literal("beforeRestore")]),
});
/** 一份备份的时间、大小与种类，供空间列表显示和选择恢复。 */
export type BackupInfo = Static<typeof BackupInfoSchema>;
/** 一个空间全部备份的 schema：root 是备份时空间根目录的真实路径；exists 为假时这个文件夹已不存在，只能恢复到新文件夹。 */
export const BackupSpaceSchema = object({
  root: identifier,
  exists: Type.Boolean(),
  backups: Type.Array(BackupInfoSchema),
});
/** 一个空间的备份，从新到旧排列，供空间列表显示。 */
export type BackupSpace = Static<typeof BackupSpaceSchema>;
/** 备份状态的 schema：最近一次成功的时间，以及上一次检查失败的原因；之后成功或确认没有变化时 failure 清空。 */
export const BackupStatusSchema = object({
  root: identifier,
  lastSuccess: Type.Union([Type.String(), Type.Null()]),
  failure: Type.Union([object({ code: identifier, message: Type.String(), at: Type.String() }), Type.Null()]),
});
/** 一个空间的备份状态，供设置页显示最近一次成功的时间与失败原因。 */
export type BackupStatus = Static<typeof BackupStatusSchema>;
/**
 * 备份清单的 schema，存为每份备份目录中的 manifest.json。files 列出所收的文件，路径相对于 .repa/、用 / 分隔，
 * 大小与修改时间取复制时的来源文件；下一次检查与它比较，没有变化就不复制。
 */
export const BackupManifestSchema = object({
  root: identifier,
  createdAt: Type.String(),
  kind: BackupInfoSchema.properties.kind,
  files: Type.Array(object({ path: identifier, size: Type.Integer({ minimum: 0 }), mtimeMs: Type.Number() })),
});
/** 一份备份的清单：所属空间、时间、种类与所收文件。 */
export type BackupManifest = Static<typeof BackupManifestSchema>;
/** 恢复标记的 schema：恢复到原位置期间存为 .repa/restore.json，记下选中的备份；标记存在时空间不打开，等待重新恢复。 */
export const RestoreMarkerSchema = object({ backup: identifier });
/**
 * 导出包中一个文件的 schema：包内路径、字节数、替换掉的凭据与密钥处数；.jsonl 另有记录条数，即行数。
 * 插件导出前把这份清单交给界面，学习者据此确认发出什么。
 */
export const ExportedFileSchema = object({
  name: identifier,
  bytes: Type.Integer({ minimum: 0 }),
  records: Type.Optional(Type.Integer({ minimum: 0 })),
  redactions: Type.Integer({ minimum: 0 }),
});
/** 导出包中一个文件的路径、字节数、记录条数与替换处数，供导出前的清单显示。 */
export type ExportedFile = Static<typeof ExportedFileSchema>;
/** 目录浏览起点的 schema，保存路径与显示名称，供空间选择界面使用。 */
export const DirectoryRootSchema = object({ path: identifier, label: identifier });
/** 目录浏览的起点路径与显示名称，供空间选择界面使用。 */
export type DirectoryRoot = Static<typeof DirectoryRootSchema>;
/** 目录浏览结果的 schema，含父目录、子目录及空间标记，供空间选择界面使用。 */
export const DirectoryListingSchema = object({
  path: identifier,
  parent: Type.Union([identifier, Type.Null()]),
  /** 文件夹内含有效 `.repa/format.json` 时为已有空间。 */
  space: Type.Boolean(),
  entries: Type.Array(object({ name: identifier, path: identifier, space: Type.Boolean() })),
  truncated: Type.Boolean(),
});
/** 目录浏览结果，含父目录、子目录及空间标记，供空间选择界面使用。 */
export type DirectoryListing = Static<typeof DirectoryListingSchema>;
/** 模型用量的 schema，记录输入、输出与缓存 token，供会话历史和运行事件使用。 */
export const UsageSchema = object({
  input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number(),
});
/** 一次模型请求的输入、输出与缓存 token 用量，供会话历史和事件展示。 */
export type Usage = Static<typeof UsageSchema>;
/** 子 Agent 父关联的 schema，记录父会话、父运行和工具调用，供恢复身份与展示来源。 */
export const SessionParentSchema = object({ sessionId: identifier, runId: identifier, callId: identifier });
/** 子 Agent 会话的父会话、父运行和工具调用关联，供恢复身份与展示来源。 */
export type SessionParent = Static<typeof SessionParentSchema>;
// updatedAt 是最后一条消息的时间，还没有消息时等于 createdAt；preview 是第一条用户消息的开头，供列表显示。
/** 会话元数据的 schema，供前端显示会话摘要、Agent 归属与父关联。 */
export const SessionInfoSchema = object({
  id: identifier, createdAt: Type.String(), updatedAt: Type.String(), name: Type.Optional(Type.String()),
  preview: Type.Optional(Type.String()), model: Type.Optional(ModelRefSchema),
  parent: Type.Optional(SessionParentSchema),
  // 会话所属的 Agent 在创建时确定，之后不变；改动前的会话属于通用 Agent。
  agent: identifier,
});
/** 会话列表中的元数据，供前端显示摘要、Agent 归属与父关联。 */
export type SessionInfo = Static<typeof SessionInfoSchema>;
/** 可用 Agent 的 schema，声明标识、用途与直接对话权限，供前端选择会话角色。 */
export const AgentInfoSchema = object({
  id: identifier,
  description: Type.Optional(Type.String()),
  // 用户能否直接与它建会话和发消息；其余 Agent 只供后台任务与子 Agent 使用。
  direct: Type.Boolean(),
});
/** 空间中可用 Agent 的标识、用途与直接对话权限，供前端选择会话角色。 */
export type AgentInfo = Static<typeof AgentInfoSchema>;
// 插件对一条用户消息的判断。拒收时 reason 供前端分支处理，message 向用户说明原因。
/** 消息接收判断的 schema，插件据此允许消息或向前端说明拒收原因。 */
export const MessageDecisionSchema = Type.Union([
  object({ status: Type.Literal("accepted") }),
  object({
    status: Type.Literal("rejected"),
    reason: identifier,
    message: Type.String({ minLength: 1 }),
    data: Type.Optional(Type.Unknown()),
  }),
]);
/** 插件接收消息前的判断结果，用于拒绝不合当前状态的用户消息。 */
export type MessageDecision = Static<typeof MessageDecisionSchema>;
/** 公开会话条目的 schema，供协议传输和前端显示消息、工具及上下文变化。 */
export const SessionEntrySchema = object({
  id: identifier,
  type: Type.Union([
    Type.Literal("user"), Type.Literal("assistant"), Type.Literal("tool"),
    Type.Literal("view"), Type.Literal("prompt"), Type.Literal("promptChange"), Type.Literal("contextEdit"),
    Type.Literal("compaction"), Type.Literal("usage"), Type.Literal("run"),
  ]),
  timestamp: Type.String(),
  text: Type.Optional(Type.String()),
  data: Type.Optional(Type.Unknown()),
  usage: Type.Optional(UsageSchema),
});
/** 对 Pi 历史投影出的公开会话条目，供前端显示消息、工具和上下文变化。 */
export type SessionEntry = Static<typeof SessionEntrySchema>;
/** 运行事件的 schema，供前端追踪文本、工具、用量和运行终态。 */
export const AgentEventSchema = object({
  sessionId: identifier,
  type: Type.Union([
    Type.Literal("runStart"), Type.Literal("runEnd"), Type.Literal("textDelta"),
    Type.Literal("toolStart"), Type.Literal("toolEnd"), Type.Literal("message"),
    Type.Literal("usage"), Type.Literal("error"), Type.Literal("compaction"),
  ]),
  parent: Type.Optional(SessionParentSchema),
  runId: Type.Optional(identifier), text: Type.Optional(Type.String()),
  tool: Type.Optional(Type.String()), data: Type.Optional(Type.Unknown()),
  usage: Type.Optional(UsageSchema),
});
/** Agent 运行中的公开事件，供前端追踪文本、工具、用量及运行终态。 */
export type AgentEvent = Static<typeof AgentEventSchema>;
/** 用户确认请求的 schema，供命令策略和认证流程声明需要确认或填写的内容。 */
export const ConfirmationSchema = object({
  kind: Type.Union([Type.Literal("command"), Type.Literal("input"), Type.Literal("select"), Type.Literal("display")]),
  title: Type.String(), message: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()), options: Type.Optional(Type.Array(Type.String())),
  secret: Type.Optional(Type.Boolean()),
});
/** 需要用户确认或填写的请求，供命令策略和认证流程使用。 */
export type Confirmation = Static<typeof ConfirmationSchema>;
/** 等待用户处理确认请求的函数，运行中止时可通过 signal 取消等待。 */
export type Confirm = (request: Confirmation, signal?: AbortSignal) => Promise<string | boolean | null>;

/** 底座可公开的业务错误，协议层将 code 和 details 交给调用方处理。 */
export class RepaFault extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = "RepaFault";
  }
}

/** 按给定 schema 校验输入，失败时抛出 invalid_input，供协议与插件边界复用。 */
export function parse<S extends TSchema>(schema: S, input: unknown): Static<S> {
  if (!Value.Check(schema, input)) throw new RepaFault("invalid_input", "输入不符合接口要求");
  return input as Static<S>;
}
