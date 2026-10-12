import { Type, type Static } from "typebox";
import type { ChangeFeed, Revision, UndoResult } from "@repa/space-history";
import {
  AskClosedSchema,
  AskReplyParamsSchema,
  AskReplyResultSchema,
  AskRequestSchema,
  InteractionCapabilitiesSchema,
} from "./interaction.js";
import {
  AgentEventSchema,
  AgentInfoSchema,
  ConfirmationSchema,
  ModelRefSchema,
  PromptOverrideSchema,
  PromptSectionSchema,
  SessionEntrySchema,
  SessionInfoSchema,
  SettingsSchema,
  identifier,
  object,
} from "./schema.js";

export * from "./schema.js";
export * from "./interaction.js";
// 2：initialize 增加 capabilities，新增 ask.*。客户端严格校验已有消息，加字段必须升版本。
export const PROTOCOL_VERSION = "2";

const serviceName = Type.String({ minLength: 1, maxLength: 64 });
/**
 * 连接在 initialize 里声明的能力：interaction 是能显示的作答位、内容块和特性，services 是能提供的服务，
 * 例如浏览器隔离环境里的 python.run。服务端按连接保存；ask 只发给能显示那道题的连接，服务请求只发给声明了它的连接。
 */
export const ClientCapabilitiesSchema = object({
  interaction: Type.Optional(InteractionCapabilitiesSchema),
  services: Type.Optional(Type.Array(serviceName, { maxItems: 64 })),
});
export type ClientCapabilities = Static<typeof ClientCapabilitiesSchema>;
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
// 历史记录由所属模块校验；这里只描述传输容器，类型导入不会把 Node 实现带到浏览器。
const historyList = Type.Unsafe<Revision[]>(Type.Array(Type.Unknown()));
const historyChanges = Type.Unsafe<ChangeFeed>(Type.Object({}));
const historyUndo = Type.Unsafe<UndoResult>(Type.Object({}));
const confirmationReply = Type.Union([Type.String(), Type.Boolean(), Type.Null()]);

export const methods = {
  initialize: {
    params: object({ token: identifier, version: Type.String(), capabilities: Type.Optional(ClientCapabilitiesSchema) }),
    result: object({ version: Type.Literal(PROTOCOL_VERSION), serverId: identifier }),
  },
  "space.list": { params: empty, result: Type.Array(identifier) },
  "space.open": { params: space, result: space },
  "space.create": { params: space, result: space },
  "space.close": { params: empty, result: nothing },
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
  "history.list": { params: object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) }), result: historyList },
  "history.changes": { params: object({ since: Type.Optional(identifier) }), result: historyChanges },
  "history.undo": { params: object({ revision: identifier }), result: historyUndo },
  // 撤回一个运行及其全部子孙运行；runId 来自 runStart 事件或会话里的 run 条目。
  "history.undoRun": { params: object({ runId: identifier }), result: historyUndo },
  "plugin.list": { params: empty, result: Type.Array(object({ id: identifier, methods: Type.Array(identifier), tools: Type.Array(identifier) })) },
  "plugin.call": { params: object({ pluginId: identifier, method: identifier, input: Type.Unknown() }), result: Type.Unknown() },
  "prompt.list": { params: agent, result: Type.Array(PromptSectionSchema) },
  "prompt.set": { params: object({ scope, id: identifier, override: PromptOverrideSchema }), result: nothing },
  "prompt.reset": { params: object({ scope, id: identifier }), result: nothing },
  "prompt.preview": { params: agent, result: preview },
  "model.list": { params: empty, result: Type.Array(object({ provider: identifier, id: identifier, name: Type.String(), available: Type.Boolean() })) },
  "auth.login": { params: object({ provider: identifier, type: identifier }), result: nothing },
  "auth.setKey": { params: object({ provider: identifier, key: identifier }), result: nothing },
  "auth.logout": { params: object({ provider: identifier }), result: nothing },
  "settings.get": { params: empty, result: SettingsSchema },
  "settings.set": {
    params: object({ commandPolicy: Type.Optional(SettingsSchema.properties.commandPolicy) }),
    result: SettingsSchema,
  },
} as const;

export const notifications = {
  "session.event": AgentEventSchema,
  "confirm.request": object({ id: identifier, request: ConfirmationSchema }),
  "ask.request": AskRequestSchema,
  "ask.closed": AskClosedSchema,
  "plugin.event": object({ pluginId: identifier, event: Type.Unknown() }),
} as const;

export type Method = keyof typeof methods;
export type Params<M extends Method> = Static<(typeof methods)[M]["params"]>;
export type Result<M extends Method> = Static<(typeof methods)[M]["result"]>;
export type Notification = keyof typeof notifications;
export type NotificationParams<N extends Notification> = Static<(typeof notifications)[N]>;
