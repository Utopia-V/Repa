import { Type, type Static } from "typebox";
import type { ChangeFeed, Revision, UndoResult } from "@repa/space-history";
import {
  AskClosedSchema,
  AskReplyParamsSchema,
  AskReplyResultSchema,
  AskRequestSchema,
  InteractionCapabilitiesSchema,
  readAskReplyResult,
  readAskRequest,
  type ReadResult,
} from "./interaction.js";
import {
  AgentEventSchema,
  AgentInfoSchema,
  BackupInfoSchema,
  BackupSettingsSchema,
  BackupSpaceSchema,
  BackupStatusSchema,
  ConfirmationSchema,
  DirectoryListingSchema,
  DirectoryRootSchema,
  ModelRefSchema,
  PromptOverrideSchema,
  PromptSectionSchema,
  ProviderInfoSchema,
  SessionEntrySchema,
  SessionInfoSchema,
  SettingsSchema,
  identifier,
  object,
} from "./schema.js";

export * from "./schema.js";
export * from "./interaction.js";
// 3：space.open/create 返回 disabledPlugins，新增 plugin.disabled。读取时忽略未知字段；只有旧版会读错的语义变化才升版本。
// 开发阶段版本不变：插件集合可在空间打开期间重组，为此新增装配序号 assembly 与 space.assembled 通知，plugin.call 必须带序号，plugin.event 带序号。
// 开发阶段版本不变：插件列表 PluginInfo 取代 disabledPlugins 与 plugin.disabled；新增 plugin.load、plugin.unload、plugin.cancel、plugin.updated，
// 确认种类 plugin，会话条目与事件 pluginResult。
/** 当前前后端协议版本；连接初始化时用于拒绝无法正确理解的协议。 */
export const PROTOCOL_VERSION = "3";

const serviceName = Type.String({ minLength: 1, maxLength: 64 });
/**
 * 连接在 initialize 里声明的能力：interaction 是能显示的作答位、内容块和特性，services 是能提供的服务，
 * 例如浏览器隔离环境里的 python.run。服务端按连接保存；ask 只发给能显示那份 Item 的连接，服务请求只发给声明了它的连接。
 */
export const ClientCapabilitiesSchema = object({
  interaction: Type.Optional(InteractionCapabilitiesSchema),
  services: Type.Optional(Type.Array(serviceName, { maxItems: 64 })),
});
/** 客户端能渲染的交互词汇与可提供的服务，用于筛选询问和路由服务请求。 */
export type ClientCapabilities = Static<typeof ClientCapabilitiesSchema>;
// 服务的输入和结果由提供方与调用方约定，底座只转交。
const serviceRequest = object({ id: identifier, service: serviceName, input: Type.Unknown() });
const serviceReply = Type.Union([
  object({ id: identifier, result: Type.Unknown() }),
  object({ id: identifier, error: object({ code: identifier, message: Type.String({ maxLength: 2_000 }) }) }),
]);
// aborted：调用方不再等待，例如运行中止；closed：空间关闭。断线时连接已经不在，不再通知。
const serviceClosed = object({ id: identifier, reason: Type.Union([Type.Literal("aborted"), Type.Literal("closed")]) });
const empty = object({});
const nothing = Type.Null();
const session = { sessionId: identifier };
const text = { ...session, text: Type.String({ minLength: 1 }) };
const scope = Type.Union([Type.Literal("app"), Type.Literal("space")]);
const preview = object({
  sections: Type.Array(PromptSectionSchema),
  views: Type.Array(object({ id: identifier, text: Type.String() })),
});
const space = object({ root: identifier });
// 省略 agent 时指通用 Agent。
const agent = object({ agent: Type.Optional(identifier) });
// 历史记录由所属模块校验；这里显式保留开放容器的内容，Value.Clean 不清除所属模块的数据。
// 类型导入不会把 Node 实现带到浏览器。
const historyList = Type.Unsafe<Revision[]>(Type.Array(Type.Unknown()));
const historyChanges = Type.Unsafe<ChangeFeed>(Type.Object({}, { additionalProperties: true }));
const historyUndo = Type.Unsafe<UndoResult>(Type.Object({}, { additionalProperties: true }));
const confirmationReply = Type.Union([Type.String(), Type.Boolean(), Type.Null()]);
// 前端内存里的最近错误，随反馈请求带给后端打包；条数和长度设上限，挡住意外的大请求。
const feedbackError = object({ time: Type.String({ maxLength: 64 }), message: Type.String({ maxLength: 4000 }), source: Type.Optional(Type.String({ maxLength: 200 })) });

const pluginId = Type.String({ pattern: "^[a-z][a-z0-9-]*$" });
const digest = Type.String({ pattern: "^[0-9a-f]{64}$" });
/** 插件不能运行、或一次装卸没有生效的原因；code 供程序判断，message 供人和模型阅读。 */
export const PluginReasonSchema = object({ code: identifier, message: Type.String() });
/**
 * 一次装卸请求里一个插件的结局，形状借 dsh 的 ChangeResult：recorded 是盘上的启用记录有没有因此改变（写入以后读回得出），
 * application 是这次请求在运行中的结果：applied 生效，failed 没有生效（附原因），denied 使用者拒绝批准，cancelled 撤回、断线或空间关闭。
 */
export const PluginOutcomeSchema = object({
  recorded: Type.Boolean(),
  application: Type.Union([Type.Literal("applied"), Type.Literal("failed"), Type.Literal("denied"), Type.Literal("cancelled")]),
  reason: Type.Optional(PluginReasonSchema),
});
/** 一次装卸请求里一个插件的结局。 */
export type PluginOutcome = Static<typeof PluginOutcomeSchema>;
/**
 * 装卸请求所处的阶段：requested 是 Agent 的运行还没结束，queued 排在前面的请求之后，preparing 复制并核对插件文件夹，
 * approving 等使用者批准，importing 发布快照并导入入口，waiting 等空间空闲，executing 正在重组。
 */
export const PluginRequestStageSchema = Type.Union([
  Type.Literal("requested"), Type.Literal("queued"), Type.Literal("preparing"), Type.Literal("approving"),
  Type.Literal("importing"), Type.Literal("waiting"), Type.Literal("executing"),
]);
/** 装卸请求所处的阶段。 */
export type PluginRequestStage = Static<typeof PluginRequestStageSchema>;
/** 一个插件当前的或最近一次的装卸请求：进行中的带阶段，结束的带结局。 */
export const PluginRequestStateSchema = Type.Union([
  object({ id: identifier, stage: PluginRequestStageSchema }),
  object({ id: identifier, outcome: PluginOutcomeSchema }),
]);
/**
 * 插件列表的一项，取随包插件、启用记录与空间里发现的插件文件夹的并集。
 * state：disabled 没有启用，running 已启用且实例已打开，pending 已启用但本机没有记下版本的完好快照，failed 已启用却打不开（附原因）。
 * folder 是空间里的插件文件夹相对记下的版本：same 内容相同，modified 有改动，missing 不在，unreadable 读不了；没有记下版本的不带。
 * digest、previous 取自启用记录；title、version、pages 取自运行或记下的版本的清单，没有记下版本时取自文件夹；methods、tools 只有运行中的插件才有。
 */
export const PluginInfoSchema = object({
  id: pluginId,
  source: Type.Union([Type.Literal("bundled"), Type.Literal("space")]),
  title: Type.Optional(Type.String()),
  version: Type.Optional(Type.String()),
  state: Type.Union([Type.Literal("disabled"), Type.Literal("running"), Type.Literal("pending"), Type.Literal("failed")]),
  reason: Type.Optional(PluginReasonSchema),
  folder: Type.Optional(Type.Union([Type.Literal("same"), Type.Literal("modified"), Type.Literal("missing"), Type.Literal("unreadable")])),
  digest: Type.Optional(digest),
  previous: Type.Optional(digest),
  pages: Type.Array(object({ id: identifier, title: Type.String() })),
  methods: Type.Array(identifier),
  tools: Type.Array(identifier),
  request: Type.Optional(PluginRequestStateSchema),
});
/** 插件列表的一项。 */
export type PluginInfo = Static<typeof PluginInfoSchema>;
const pluginIds = Type.Array(pluginId, { minItems: 1, maxItems: 32 });
const requested = object({ requestId: identifier });

/**
 * 装配序号：后端每次打开空间、每次重组插件宿主与 Agent 运行时前分配，在一个后端进程内单调递增。
 * 前端只收序号等于自己当前序号的插件事件，plugin.call 带上它，后端据此拒绝切换空间之前组成的调用。
 */
const assembly = Type.Integer({ minimum: 1 });
const openedSpace = object({ root: identifier, assembly, plugins: Type.Array(PluginInfoSchema) });

/** 重接时投影会话当前运行和排队消息的 schema，不加载盘上空闲会话。 */
export const SessionBaselineSchema = object({
  sessionId: identifier,
  agent: identifier,
  runId: Type.Optional(identifier),
  queued: Type.Array(object({
    text: Type.String(),
    mode: Type.Union([Type.Literal("send"), Type.Literal("steer"), Type.Literal("followUp")]),
  })),
});
/** 单个内存会话的重接基线，前端据此恢复运行与排队状态。 */
export type SessionBaseline = Static<typeof SessionBaselineSchema>;
/** 连接初始化时返回的空间、会话和插件列表基线，用于恢复前端状态。 */
export const BaselineSchema = object({
  space: Type.Union([object({ root: identifier, assembly }), Type.Null()]),
  sessions: Type.Array(SessionBaselineSchema),
  plugins: Type.Array(PluginInfoSchema),
});
/** 初始化连接的状态基线，与后续通知衔接以重建前端当前画面。 */
export type Baseline = Static<typeof BaselineSchema>;

/** 底座全部 JSON-RPC 方法的参数与结果 schema，服务端和客户端共用此登记。 */
export const methods = {
  initialize: {
    params: object({ token: identifier, version: Type.String(), capabilities: Type.Optional(ClientCapabilitiesSchema) }),
    result: object({ version: Type.Literal(PROTOCOL_VERSION), serverId: identifier, baseline: BaselineSchema }),
  },
  "space.list": { params: empty, result: Type.Array(identifier) },
  "space.open": { params: space, result: openedSpace },
  "space.create": { params: space, result: openedSpace },
  "space.close": { params: empty, result: nothing },
  "space.roots": { params: empty, result: Type.Array(DirectoryRootSchema) },
  "space.browse": { params: object({ path: Type.Optional(identifier) }), result: DirectoryListingSchema },
  "agent.list": { params: empty, result: Type.Array(AgentInfoSchema) },
  "session.list": { params: empty, result: Type.Array(SessionInfoSchema) },
  "session.create": { params: object({ model: Type.Optional(ModelRefSchema), agent: Type.Optional(identifier) }), result: SessionInfoSchema },
  "session.history": { params: object(session), result: Type.Array(SessionEntrySchema) },
  "session.send": { params: object(text), result: nothing },
  "session.steer": { params: object(text), result: nothing },
  "session.followUp": { params: object(text), result: nothing },
  "session.abort": { params: object(session), result: nothing },
  "session.setModel": { params: object({ ...session, model: ModelRefSchema }), result: nothing },
  "session.compact": { params: object(session), result: nothing },
  "session.fork": { params: object({ ...session, entryId: identifier }), result: SessionInfoSchema },
  "confirm.reply": { params: object({ id: identifier, value: confirmationReply }), result: nothing },
  "ask.reply": { params: AskReplyParamsSchema, result: AskReplyResultSchema },
  "service.reply": { params: serviceReply, result: nothing },
  "history.list": { params: object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) }), result: historyList },
  "history.changes": { params: object({ since: Type.Optional(identifier) }), result: historyChanges },
  "history.undo": { params: object({ revision: identifier }), result: historyUndo },
  // 撤回一个运行及其全部子孙运行；runId 来自 runStart 事件或会话里的 run 条目。
  "history.undoRun": { params: object({ runId: identifier }), result: historyUndo },
  // 插件列表；读取时重新核对各插件文件夹相对记下版本的状态。
  "plugin.list": { params: empty, result: Type.Array(PluginInfoSchema) },
  // 请求启用自写插件，或让文件夹当前的内容（from 省略或 folder）、记录里的版本（recorded）、上一次选定的版本（previous）生效。
  // 只登记一批请求，立即返回请求编号；准备、批准、等待空闲与重组随后进行，阶段与结局见插件列表。
  "plugin.load": { params: object({ ids: pluginIds, from: Type.Optional(Type.Union([Type.Literal("folder"), Type.Literal("recorded"), Type.Literal("previous")])) }), result: requested },
  "plugin.unload": { params: object({ ids: pluginIds }), result: requested },
  // 撤回一批还没开始重组的请求。
  "plugin.cancel": { params: object({ requestId: identifier }), result: nothing },
  "plugin.call": { params: object({ pluginId: identifier, method: identifier, input: Type.Unknown(), assembly }), result: Type.Unknown() },
  "prompt.list": { params: agent, result: Type.Array(PromptSectionSchema) },
  "prompt.set": { params: object({ scope, id: identifier, override: PromptOverrideSchema }), result: nothing },
  "prompt.reset": { params: object({ scope, id: identifier }), result: nothing },
  "prompt.preview": { params: agent, result: preview },
  "model.list": { params: empty, result: Type.Array(object({ provider: identifier, id: identifier, name: Type.String(), available: Type.Boolean() })) },
  "model.providers": { params: empty, result: Type.Array(ProviderInfoSchema) },
  "model.getDefault": { params: empty, result: Type.Union([ModelRefSchema, nothing]) },
  "model.setDefault": { params: object({ model: ModelRefSchema }), result: nothing },
  "auth.login": { params: object({ provider: identifier, type: identifier }), result: nothing },
  "auth.setKey": { params: object({ provider: identifier, key: identifier }), result: nothing },
  "auth.logout": { params: object({ provider: identifier }), result: nothing },
  // 生成问题反馈包：会话记录、空间历史、最近错误和运行环境，凭据脱敏后打成 zip；describe 为 true 时附上 Agent 自述。
  "feedback.create": {
    params: object({
      sessionId: identifier,
      describe: Type.Boolean(),
      note: Type.Optional(Type.String({ maxLength: 4000 })),
      clientErrors: Type.Optional(Type.Array(feedbackError, { maxItems: 100 })),
      directory: Type.Optional(identifier),
    }),
    result: object({ path: identifier, files: Type.Array(identifier) }),
  },
  "settings.get": { params: empty, result: SettingsSchema },
  "settings.set": {
    params: object({
      commandPolicy: Type.Optional(SettingsSchema.properties.commandPolicy),
      backup: Type.Optional(BackupSettingsSchema),
    }),
    result: SettingsSchema,
  },
  // 活动空间的备份状态：最近一次成功的时间与上一次失败的原因；没有打开空间时为 null。
  "backup.status": { params: empty, result: Type.Union([BackupStatusSchema, nothing]) },
  // 立即备份：与定期检查相同，没有变化时不复制，created 为 false，backup 是已有的最近一份。
  "backup.create": { params: empty, result: object({ created: Type.Boolean(), backup: BackupInfoSchema }) },
  // 全部空间的备份，包括文件夹已不存在的空间；不需要打开空间。
  "backup.list": { params: empty, result: Type.Array(BackupSpaceSchema) },
  // 恢复到原位置，空间须已关闭；返回这次自动保存的"恢复前"备份，用它可以撤回。
  "backup.restore": { params: object({ root: identifier, id: identifier }), result: BackupInfoSchema },
  // 恢复到新文件夹：target 是新空间的绝对路径，须尚不存在；返回新空间的根目录。
  "backup.restoreTo": { params: object({ root: identifier, id: identifier, target: identifier }), result: object({ root: identifier }) },
  "backup.delete": { params: object({ root: identifier, id: identifier }), result: nothing },
} as const;

/** 底座发给客户端的全部通知 schema，供两端校验通知参数。 */
export const notifications = {
  // 一个空间的备份有了变化：新建、失败、删除或恢复；前端据此刷新设置页与空间列表。
  "backup.updated": BackupStatusSchema,
  "session.event": AgentEventSchema,
  "confirm.request": object({ id: identifier, request: ConfirmationSchema }),
  "ask.request": AskRequestSchema,
  "ask.closed": AskClosedSchema,
  "service.request": serviceRequest,
  "service.closed": serviceClosed,
  "plugin.event": object({ pluginId: identifier, assembly, event: Type.Unknown() }),
  // 插件列表变了：请求的阶段或结局、源文件夹的状态。整份列表，不改装配序号。
  "plugin.updated": object({ plugins: Type.Array(PluginInfoSchema) }),
  // 重组完成：插件宿主与 Agent 运行时已按新的插件清单打开，前端换用新的序号并重新读取空间状态。
  // 整体失败时空间已经关闭，root 为 null，带上原因。
  "space.assembled": Type.Union([
    object({ root: identifier, assembly, plugins: Type.Array(PluginInfoSchema) }),
    object({ root: Type.Null(), error: object({ code: identifier, message: Type.String() }) }),
  ]),
} as const;

/**
 * 接收方读取带 Item 或内容块的消息时，不整体严格校验，也不整体清理：登记的读取函数拿到原始数据，信封去掉未知字段后校验，
 * 里面的 Item 和内容块按词汇的规则宽松读取。这样词汇加了可选字段，旧前端照常显示；加了必须理解的特性，按 requires 判为不能作答。
 * 没有登记的消息去掉未知字段后按 schema 校验。
 */
export const lenientNotifications: Partial<Record<Notification, (params: unknown) => ReadResult<unknown>>> = {
  "ask.request": readAskRequest,
};
/** 含可扩展交互词汇的方法结果读取器，供客户端保留词汇的宽松读取语义。 */
export const lenientResults: Partial<Record<Method, (result: unknown) => ReadResult<unknown>>> = {
  "ask.reply": readAskReplyResult,
};

/** 底座协议方法名，用于限定客户端调用和服务端分派。 */
export type Method = keyof typeof methods;
/** 指定协议方法的参数类型，从方法登记的 schema 推导。 */
export type Params<M extends Method> = Static<(typeof methods)[M]["params"]>;
/** 指定协议方法的结果类型，从方法登记的 schema 推导。 */
export type Result<M extends Method> = Static<(typeof methods)[M]["result"]>;
/** 底座通知名，用于限定订阅与服务端推送。 */
export type Notification = keyof typeof notifications;
/** 指定通知的参数类型，从通知登记的 schema 推导。 */
export type NotificationParams<N extends Notification> = Static<(typeof notifications)[N]>;
