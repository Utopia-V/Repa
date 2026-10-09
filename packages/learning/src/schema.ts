import { Type, type Static } from "typebox";
import { object, RevisionSchema as revision, literals, ContentRefSchema } from "repa/protocol";

export const ContextBindingSchema = Type.Union([
  Type.Null(),
  object({ kind: literals(["document", "composition"]), ref: ContentRefSchema }),
]);
export type ContextBinding = Static<typeof ContextBindingSchema>;
export const ContextStateSchema = object({ binding: ContextBindingSchema, revision });
export type ContextState = Static<typeof ContextStateSchema>;
export const ContextMemberSchema = object({
  ref: ContentRefSchema,
  mode: literals(["expand", "reference"]),
  title: Type.Optional(Type.String()),
  note: Type.Optional(Type.String()),
});
export type ContextMember = Static<typeof ContextMemberSchema>;
export const ContextCompositionSchema = object({
  items: Type.Array(Type.Union([
    ContextMemberSchema,
    object({ title: Type.String(), items: Type.Array(ContextMemberSchema) }),
  ])),
});
export type ContextComposition = Static<typeof ContextCompositionSchema>;
export const ContextViewSchema = object({
  text: Type.String(),
  revision,
  sources: Type.Array(object({ ref: ContentRefSchema, revision })),
});
export type ContextView = Static<typeof ContextViewSchema>;
export * from "./attempt-schema.js";
export * from "./exercise-schema.js";
