import { Check } from "typebox/value";
import { mapReference, type ContentFormat, type ReferenceMapping } from "repa/plugin";
import { RepaFault } from "repa/protocol";
import { ContextBindingSchema, ContextCompositionSchema, type ContextBinding } from "./schema.js";

export function contextBinding(value: unknown): ContextBinding {
  if (!Check(ContextBindingSchema, value)) throw new RepaFault("invalid_storage", "学习语境绑定格式无效。");
  return value;
}

function remapComposition(bytes: Buffer, mapping: ReferenceMapping): Buffer {
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString("utf8")); } catch { return bytes; }
  if (!Check(ContextCompositionSchema, raw)) return bytes;
  const before = JSON.stringify(raw);
  for (const item of raw.items) {
    if ("items" in item) {
      for (const child of item.items) child.ref = mapReference(child.ref, mapping);
    } else item.ref = mapReference(item.ref, mapping);
  }
  return JSON.stringify(raw) === before ? bytes : Buffer.from(`${JSON.stringify(raw, null, 2)}\n`);
}

export const learningContentFormat: ContentFormat = {
  id: "learning-context",
  field: "context",
  default: null,
  schema: ContextBindingSchema,
  references: (value) => {
    const binding = contextBinding(value);
    return binding ? [binding.ref] : [];
  },
  files: (value) => {
    const binding = contextBinding(value);
    return binding?.kind === "composition" ? [binding.ref] : [];
  },
  remapMetadata: (value, mapping) => {
    const binding = contextBinding(value);
    return binding ? { ...binding, ref: mapReference(binding.ref, mapping) } : null;
  },
  remapFile: remapComposition,
};
