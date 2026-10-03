import { Check } from "typebox/value";
import type { ResourceRef } from "../content/schema.js";
import { RepresentationSchema, type ProcessingResult } from "../requests/schema.js";
import type { CapabilityContract } from "./schema.js";

/** 保留调用原值，只识别通用表示；嵌套业务格式的资源由所属能力明确声明。 */
export function capabilityRepresentation(contract: CapabilityContract, raw: unknown, declaredResources: readonly ResourceRef[] = []): ProcessingResult {
  const representation = Check(RepresentationSchema, raw) ? raw : undefined;
  return {
    format: { ...contract },
    value: { kind: "inline", data: raw },
    sources: [...(representation?.sources ?? [])],
    resources: [
      ...(representation?.resources ?? []),
      ...(representation?.value.kind === "resource" ? [representation.value.resource] : []),
      ...declaredResources,
    ],
    ...(representation?.summary !== undefined ? { summary: representation.summary } : {}),
  };
}
