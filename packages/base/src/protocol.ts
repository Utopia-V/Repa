import { Type, type Static } from "typebox";
import type { ChangeFeed, Revision, UndoResult } from "@repa/space-history";
import {
  AgentEventSchema,
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
export const PROTOCOL_VERSION = "1";
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
// 历史记录由所属模块校验；这里只描述传输容器，类型导入不会把 Node 实现带到浏览器。
const historyList = Type.Unsafe<Revision[]>(Type.Array(Type.Unknown()));
const historyChanges = Type.Unsafe<ChangeFeed>(Type.Object({}));
const historyUndo = Type.Unsafe<UndoResult>(Type.Object({}));
const confirmationReply = Type.Union([Type.String(), Type.Boolean(), Type.Null()]);

export const methods = {
  initialize: {
    params: object({ token: identifier, version: Type.String() }),
    result: object({ version: Type.Literal(PROTOCOL_VERSION), serverId: identifier }),
  },
  "space.list": { params: empty, result: Type.Array(identifier) },
  "space.open": { params: space, result: space },
  "space.create": { params: space, result: space },
  "space.close": { params: empty, result: nothing },
  "session.list": { params: empty, result: Type.Array(SessionInfoSchema) },
  "session.create": { params: object({ model: Type.Optional(ModelRefSchema) }), result: SessionInfoSchema },
  "session.history": { params: object(session), result: Type.Array(SessionEntrySchema) },
  "session.send": { params: object(text), result: nothing },
  "session.steer": { params: object(text), result: nothing },
  "session.followUp": { params: object(text), result: nothing },
  "session.abort": { params: object(session), result: nothing },
  "session.setModel": { params: object({ ...session, model: ModelRefSchema }), result: nothing },
  "session.compact": { params: object(session), result: nothing },
  "session.fork": { params: object({ ...session, entryId: identifier }), result: SessionInfoSchema },
  "confirm.reply": { params: object({ id: identifier, value: confirmationReply }), result: nothing },
  "history.list": { params: object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) }), result: historyList },
  "history.changes": { params: object({ since: Type.Optional(identifier) }), result: historyChanges },
  "history.undo": { params: object({ revision: identifier }), result: historyUndo },
  "plugin.list": { params: empty, result: Type.Array(object({ id: identifier, methods: Type.Array(identifier), tools: Type.Array(identifier) })) },
  "plugin.call": { params: object({ pluginId: identifier, method: identifier, input: Type.Unknown() }), result: Type.Unknown() },
  "prompt.list": { params: empty, result: Type.Array(PromptSectionSchema) },
  "prompt.set": { params: object({ scope, id: identifier, override: PromptOverrideSchema }), result: nothing },
  "prompt.reset": { params: object({ scope, id: identifier }), result: nothing },
  "prompt.preview": { params: empty, result: preview },
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
  "plugin.event": object({ pluginId: identifier, event: Type.Unknown() }),
} as const;

export type Method = keyof typeof methods;
export type Params<M extends Method> = Static<(typeof methods)[M]["params"]>;
export type Result<M extends Method> = Static<(typeof methods)[M]["result"]>;
export type Notification = keyof typeof notifications;
export type NotificationParams<N extends Notification> = Static<(typeof notifications)[N]>;
