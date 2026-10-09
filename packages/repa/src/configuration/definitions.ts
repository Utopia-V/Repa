import type { TSchema } from "typebox";
import { PromptSettingsSchema, type PromptSettings, type SettingScope } from "./schema.js";

export type SettingsNamespaceDefinition = {
  namespace: string;
  settings: Record<string, {
    schema: TSchema;
    default: unknown;
    scopes: SettingScope["kind"][];
  }>;
};

const promptDefaults: PromptSettings = {
  base: "",
  append: [],
  projectInstructions: false,
  skillCatalog: true,
  environment: true,
  learningContext: true,
  backgrounds: {},
  fileChanges: "on-demand",
};

export const PROMPT_SETTINGS_DEFINITION: SettingsNamespaceDefinition = {
  namespace: "prompts",
  settings: Object.fromEntries(Object.entries(PromptSettingsSchema.properties).map(([key, schema]) => [
    key,
    {
      schema,
      default: promptDefaults[key as keyof PromptSettings],
      scopes: ["application", "space", "session"],
    },
  ])),
};
