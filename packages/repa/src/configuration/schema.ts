import { Type, type Static } from "typebox";
import { IdSchema, object, RevisionSchema, literals } from "../schema.js";

export const SettingScopeSchema = Type.Union([
  object({ kind: Type.Literal("application") }),
  object({ kind: Type.Literal("space"), spaceId: IdSchema }),
  object({
    kind: Type.Literal("session"),
    spaceId: IdSchema,
    sessionId: IdSchema,
  }),
]);
export type SettingScope = Static<typeof SettingScopeSchema>;

export const PromptSettingsSchema = object({
  base: Type.String(),
  append: Type.Array(Type.String()),
  projectInstructions: Type.Boolean(),
  skillCatalog: Type.Boolean(),
  environment: Type.Boolean(),
  /** 旧学习来源的兼容默认；显式 backgrounds.learningContext 优先。 */
  learningContext: Type.Boolean(),
  backgrounds: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.Boolean())),
  fileChanges: literals(["on-demand", "notice", "diff"]),
});
export type PromptSettings = Static<typeof PromptSettingsSchema>;

export const SettingsEntrySchema = object({
  key: Type.String({ minLength: 1 }),
  override: Type.Optional(Type.Unknown()),
  effective: Type.Unknown(),
  source: Type.Union([SettingScopeSchema, Type.Literal("default")]),
  revision: RevisionSchema,
});
export type SettingsEntry = Static<typeof SettingsEntrySchema>;
export const SettingsDefinitionSchema = object({
  key: Type.String({ minLength: 1 }),
  schema: Type.Record(Type.String(), Type.Unknown()),
  default: Type.Unknown(),
  scopes: Type.Array(literals(["application", "space", "session"]), { minItems: 1, uniqueItems: true }),
});
export type SettingsDefinition = Static<typeof SettingsDefinitionSchema>;
export const SettingsViewSchema = object({
  namespace: Type.String({ minLength: 1 }),
  scope: SettingScopeSchema,
  entries: Type.Array(SettingsEntrySchema),
  definitions: Type.Array(SettingsDefinitionSchema),
});
export type SettingsView = Static<typeof SettingsViewSchema>;

const query = {
  scope: SettingScopeSchema,
  namespace: Type.String({ minLength: 1 }),
};
export const SettingsGetParamsSchema = object(query);
export type SettingsGetParams = Static<typeof SettingsGetParamsSchema>;
export const SettingsSetParamsSchema = object({
  ...query,
  key: Type.String({ minLength: 1 }),
  value: Type.Unknown(),
  base: RevisionSchema,
});
export type SettingsSetParams = Static<typeof SettingsSetParamsSchema>;
export const SettingsResetParamsSchema = object({
  ...query,
  key: Type.String({ minLength: 1 }),
  base: RevisionSchema,
});
export type SettingsResetParams = Static<typeof SettingsResetParamsSchema>;
