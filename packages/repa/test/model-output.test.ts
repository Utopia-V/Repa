import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { RepaFault } from "../src/errors.js";
import { prepareModelOutput } from "../src/models/output.js";

const schema = Type.Object({
  correct: Type.Boolean(),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  explanation: Type.Optional(Type.String()),
}, { additionalProperties: false });
const invalidOutput = (error: unknown) => error instanceof RepaFault && error.code === "invalid_model_output";

test("结构化输出保留原值、可选字段与 schema 快照，thinking 不进入 JSON", () => {
  const original = structuredClone(schema);
  const constraint = prepareModelOutput({ kind: "json", schema: { ...original } });
  assert(constraint);
  Object.assign(original.properties.confidence, { maximum: 0 });
  const message = fauxAssistantMessage([
    { type: "thinking", thinking: "不能当成 JSON 的推理", thinkingSignature: "signature" },
    { type: "text", text: "{\"correct\":true," },
    { type: "text", text: "\"confidence\":0.75}" },
  ]);
  const before = structuredClone(message);
  assert.deepEqual(constraint.read(message), { correct: true, confidence: 0.75 });
  assert.deepEqual(message, before);
  assert.deepEqual(constraint.specification.schema, schema);
  assert(constraint.instruction.includes(JSON.stringify(schema)));
  assert.equal(prepareModelOutput(), undefined);
});

test("结构化输出不剥围栏、不截取对象、不修补 JSON，也不转换值或删除多余字段", () => {
  const constraint = prepareModelOutput({ kind: "json", schema: { ...schema } });
  assert(constraint);
  for (const text of [
    "", "```json\n{\"correct\":true,\"confidence\":1}\n```",
    "判断如下：{\"correct\":true,\"confidence\":1}", "{\"correct\":true,\"confidence\":1",
    "{\"correct\":\"true\",\"confidence\":1}", "{\"correct\":true,\"confidence\":\"1\"}",
    "{\"correct\":true}", "{\"correct\":true,\"confidence\":2}",
    "{\"correct\":true,\"confidence\":1,\"extra\":0}", "{\"correct\":true,\"confidence\":1,\"explanation\":null}",
    "{\"correct\":true,\"confidence\":1} {}",
  ]) assert.throws(() => constraint.read(fauxAssistantMessage(text)), invalidOutput, text);
});

test("看似完整的 JSON 在截断、工具调用、延后或失败终态中仍不被接收", () => {
  const constraint = prepareModelOutput({ kind: "json", schema: { ...schema } });
  assert(constraint);
  for (const stopReason of ["length", "toolUse", "pending", "deferred", "error", "aborted"] as const)
    assert.throws(() => constraint.read(fauxAssistantMessage('{"correct":true,"confidence":1}', { stopReason })), invalidOutput);
  assert.throws(() => constraint.read(fauxAssistantMessage([
    { type: "text", text: '{"correct":true,"confidence":1}' }, fauxToolCall("side_effect", {}),
  ], { stopReason: "stop" })), invalidOutput);
});

test("错误 schema、未知约束、远程引用及非 JSON 数据在生成前拒绝", () => {
  for (const invalid of [
    { type: "wrong" }, { type: "number", minimum: "zero" }, { type: "object", typo: true },
    { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
    { type: "string", format: "unknown-format" }, { type: "string", pattern: "[" },
    { $ref: "https://no-network.invalid/schema" }, { type: "object", $async: true },
    { type: "string", description: undefined }, { type: "number", maximum: Infinity },
  ]) assert.throws(() => prepareModelOutput({ kind: "json", schema: invalid }),
    error => error instanceof RepaFault && error.code === "invalid_output_schema");
});

test("自包含引用与 JSON 标量使用同一验收入口，默认值不补写，溢出数值拒绝", () => {
  const referenced = prepareModelOutput({ kind: "json", schema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object", properties: { name: { $ref: "#/definitions/name" } }, additionalProperties: false,
    definitions: { name: { type: "string", default: "不会补写" } },
  } });
  assert(referenced);
  assert.deepEqual(referenced.read(fauxAssistantMessage("{}")), {});
  for (const [value, outputSchema] of [[null, { type: "null" }], [0, { type: "number" }], [false, { type: "boolean" }],
    [[1, 2], { type: "array", items: { type: "integer" } }]] as const) {
    const constraint = prepareModelOutput({ kind: "json", schema: outputSchema });
    assert(constraint);
    assert.deepEqual(constraint.read(fauxAssistantMessage(JSON.stringify(value))), value);
  }
  const unconstrained = prepareModelOutput({ kind: "json", schema: {} });
  assert(unconstrained);
  assert.throws(() => unconstrained.read(fauxAssistantMessage('{"value":1e999}')), invalidOutput);
});
