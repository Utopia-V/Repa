import { Type, type TSchema } from "typebox";

export const object = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
export const IdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[a-zA-Z0-9_-]+$",
});
export const RevisionSchema = Type.String({ minLength: 1 });
export const literals = <const T extends string[]>(values: readonly [...T]) =>
  Type.Enum(values);
