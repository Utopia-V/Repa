import { Type, type Static } from "typebox";
import { IdSchema, literals, object } from "../schema.js";

const name = Type.String({ minLength: 1, maxLength: 256 });

export const CapabilityContractSchema = object({ id: name, version: name });
export type CapabilityContract = Static<typeof CapabilityContractSchema>;

export const CapabilityScopeSchema = Type.Union([
  object({ kind: Type.Literal("application") }),
  object({ kind: Type.Literal("space"), spaceId: IdSchema }),
]);
export type CapabilityScope = Static<typeof CapabilityScopeSchema>;

export const DisplaySourceSchema = object({ kind: Type.Literal("display"), hostId: IdSchema, spaceId: IdSchema, instanceId: IdSchema });
export const CapabilitySourceSchema = Type.Union([
  object({ kind: Type.Literal("client"), hostId: IdSchema }),
  DisplaySourceSchema,
  object({
    kind: Type.Literal("agent"),
    spaceId: IdSchema,
    sessionId: IdSchema,
    runId: IdSchema,
    requestId: IdSchema,
  }),
]);
export type CapabilitySource = Static<typeof CapabilitySourceSchema>;

export const CapabilityNotificationSchema = object({ format: CapabilityContractSchema, data: Type.Unknown() });
export type CapabilityNotification = Static<typeof CapabilityNotificationSchema>;
export const CapabilityEventSchema = object({
  scope: CapabilityScopeSchema, pluginId: IdSchema, requestId: IdSchema,
  source: CapabilitySourceSchema, ...CapabilityNotificationSchema.properties,
});
export type CapabilityEvent = Static<typeof CapabilityEventSchema>;

export const CapabilitySelectionSchema = object({
  contract: CapabilityContractSchema,
  implementationId: Type.Optional(name),
});
export type CapabilitySelection = Static<typeof CapabilitySelectionSchema>;

export const CapabilityDescriptorSchema = object({
  pluginId: IdSchema,
  contract: CapabilityContractSchema,
  implementationId: name,
  inputSchema: Type.Record(Type.String(), Type.Unknown()),
  outputSchema: Type.Record(Type.String(), Type.Unknown()),
  scopes: Type.Array(literals(["application", "space"]), { minItems: 1, uniqueItems: true }),
  execution: literals(["query", "inline", "background"]),
  tool: Type.Optional(object({
    name: IdSchema, description: Type.String({ minLength: 1 }),
    inputSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  })),
});
export type CapabilityDescriptor = Static<typeof CapabilityDescriptorSchema>;
