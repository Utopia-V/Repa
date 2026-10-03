import { Type } from "typebox";
import type { SettingsNamespaceDefinition } from "../configuration/definitions.js";
import { IdSchema } from "../schema.js";
import { ExecutionPolicySchema, type ExecutionPolicy } from "./schema.js";

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  mode: "restricted", readPaths: [], writePaths: [], network: false,
};

export const EXECUTION_SETTINGS_DEFINITION: SettingsNamespaceDefinition = {
  namespace: "execution",
  settings: {
    default: { schema: ExecutionPolicySchema, default: DEFAULT_EXECUTION_POLICY, scopes: ["application"] },
    spaces: { schema: Type.Record(IdSchema, ExecutionPolicySchema), default: {}, scopes: ["application"] },
  },
};
