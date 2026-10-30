// space-format 首次入库的 schema；保持固定以检验 baseline，而不随当前源码变化。
export const FormatSchema = {
  type: "object",
  required: ["version"],
  properties: {
    version: { type: "integer", minimum: 1, maximum: 9007199254740991 },
  },
};
