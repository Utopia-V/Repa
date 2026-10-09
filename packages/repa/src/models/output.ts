import { isDeepStrictEqual } from "node:util";
import { Ajv } from "ajv";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { RepaFault } from "../errors.js";
import type { ModelOutput } from "./schema.js";

export interface ModelOutputConstraint {
  specification: ModelOutput;
  instruction: string;
  read(message: AssistantMessage): unknown;
}

/** 只验收完整的原始回复，不修补 JSON、不转换字段，也不发起额外模型调用。 */
export function prepareModelOutput(output?: ModelOutput): ModelOutputConstraint | undefined {
  if (!output) return undefined;
  const ajv = new Ajv({ strict: true, allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
  let schemaText: string;
  let specification: ModelOutput;
  let validate: ReturnType<Ajv["compile"]>;
  try {
    specification = structuredClone(output);
    schemaText = JSON.stringify(specification.schema);
    const schema: unknown = JSON.parse(schemaText);
    if (!isDeepStrictEqual(specification.schema, schema)) throw new Error("schema 必须只包含 JSON 数据。");
    validate = ajv.compile(specification.schema);
    if ("$async" in validate) throw new Error("输出 schema 不支持异步校验。");
  } catch (error) {
    throw new RepaFault("invalid_output_schema", `独立模型输出 schema 无效：${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    specification,
    instruction: `仅返回一个符合下列 JSON Schema 的完整 JSON 值，不附加 Markdown 围栏、说明或工具调用。\n${schemaText}`,
    read(message) {
      if (message.stopReason !== "stop")
        throw new RepaFault("invalid_model_output", "模型没有完整结束 JSON 回复。");
      if (message.content.some(part => part.type !== "text" && part.type !== "thinking"))
        throw new RepaFault("invalid_model_output", "模型输出包含 JSON 文本以外的内容。");
      const text = message.content.filter(part => part.type === "text").map(part => part.text).join("");
      let value: unknown;
      try {
        value = JSON.parse(text, (_key, item: unknown) => {
          if (typeof item === "number" && !Number.isFinite(item)) throw new Error("JSON 数值超出有限数范围。");
          return item;
        });
      } catch {
        throw new RepaFault("invalid_model_output", "模型回复不是完整 JSON。");
      }
      let valid: boolean;
      try { valid = validate(value) === true; } catch {
        throw new RepaFault("output_validation_failed", "输出 schema 无法完成本次 JSON 校验。");
      }
      if (!valid)
        throw new RepaFault("invalid_model_output", `模型 JSON 不符合输出 schema：${ajv.errorsText(validate.errors)}`);
      return value;
    },
  };
}
