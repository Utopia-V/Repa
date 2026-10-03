import { Type, type Static } from "typebox";
import { IdSchema, object } from "../schema.js";
import { PluginSelectionSchema } from "../plugins/schema.js";
import type { SettingsNamespaceDefinition } from "./definitions.js";

export const PluginSettingsSchema = object({
  backends: Type.Array(object({ id: IdSchema, package: PluginSelectionSchema })),
  disabled: Type.Array(IdSchema, { uniqueItems: true }),
  trusted: Type.Array(PluginSelectionSchema),
  implementations: Type.Record(Type.String({ minLength: 1 }), Type.String({ minLength: 1 })),
});
export type PluginSettings = Static<typeof PluginSettingsSchema>;
export const PLUGIN_SETTINGS_DEFINITION: SettingsNamespaceDefinition = {
  namespace: "plugins",
  settings: {
    backends: { schema: PluginSettingsSchema.properties.backends, default: [], scopes: ["application", "space"] },
    disabled: { schema: PluginSettingsSchema.properties.disabled, default: [], scopes: ["application", "space"] },
    trusted: { schema: PluginSettingsSchema.properties.trusted, default: [], scopes: ["application"] },
    implementations: { schema: PluginSettingsSchema.properties.implementations, default: {}, scopes: ["application", "space"] },
  },
};
