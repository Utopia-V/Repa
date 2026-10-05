import { Type } from "typebox";
import type { SettingsNamespaceDefinition } from "../configuration/definitions.js";

export const SPACES_SETTINGS_DEFINITION: SettingsNamespaceDefinition = {
  namespace: "spaces",
  settings: {
    parentDirectory: {
      schema: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      default: null,
      scopes: ["application"],
    },
  },
};
