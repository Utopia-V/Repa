import { Type, type Static } from "typebox";
import { object, literals, IdSchema } from "../schema.js";

const text = Type.String({ minLength: 1 });
export const BundledPluginRegistrationSchema = object({ id: IdSchema, directory: text, enabled: Type.Boolean() });
export type BundledPluginRegistration = Static<typeof BundledPluginRegistrationSchema>;
export const PluginEntrySchema = object({ entry: text, api: text });
export type PluginEntry = Static<typeof PluginEntrySchema>;
export const PluginFrontendSchema = object({ ...PluginEntrySchema.properties, environment: text });
export const PluginManifestSchema = object({
  manifestVersion: Type.Literal(1),
  backend: Type.Optional(PluginEntrySchema),
  snapshot: Type.Optional(PluginEntrySchema),
  contributions: Type.Optional(PluginEntrySchema),
  frontends: Type.Optional(Type.Array(PluginFrontendSchema)),
});
export type PluginManifest = Static<typeof PluginManifestSchema>;
export const PluginSelectionSchema = Type.Union([
  object({ kind: Type.Literal("source"), source: text, scope: literals(["user", "project", "bundled"]) }),
  object({ kind: Type.Literal("package"), name: text }),
]);
export type PluginSelection = Static<typeof PluginSelectionSchema>;
export const PluginIssueSchema = object({ code: text, message: Type.String() });
const resolvedEntry = {
  ...PluginEntrySchema.properties,
  status: literals(["ready", "missing", "invalid", "incompatible"]),
};
export const PluginPackageSchema = object({
  source: text,
  scope: literals(["user", "project", "bundled"]),
  status: literals(["ready", "missing", "invalid"]),
  installedPath: Type.Optional(text),
  registrationId: Type.Optional(text),
  name: Type.Optional(text),
  version: Type.Optional(text),
  manifestVersion: Type.Optional(Type.Integer()),
  piResources: Type.Boolean(),
  backend: Type.Optional(object(resolvedEntry)),
  snapshot: Type.Optional(object(resolvedEntry)),
  contributions: Type.Optional(object(resolvedEntry)),
  frontends: Type.Array(object({ ...resolvedEntry, environment: text })),
  issues: Type.Array(PluginIssueSchema),
});
export type PluginPackage = Static<typeof PluginPackageSchema>;
