/** python.run 的领域载荷；底座仍负责 service.request/reply/closed 的关联与取消。 */
import { Type, type Static } from "typebox";

import { identifier, ItemResponseSchema, object, readLenient, type ReadResult } from "@repa/base/protocol";
import { FixtureSchema, NameSchema, RuntimeSchema, TestSchema } from "./format/schema.js";

/** Repa 工程参数，与课程检查器及 runner.py 一致。 */
export const PYTHON_RUN_LIMITS = {
  timeoutMs: 10_000, maxElements: 10_000, maxDepth: 30, maxReprLength: 20_000, maxOutputLength: 65_536,
} as const;
const runtime = object({ ...RuntimeSchema.properties, pyodide: Type.Literal("314.0.7") });
const error = object({ type: Type.String({ maxLength: 200 }), message: Type.String({ maxLength: 2_000 }) });
/** canon() 的带标签值作为不透明记录传递，交给现有 sameValue/showValue；不转换成 JS 数值。 */
const serialized = Type.Record(Type.String(), Type.Unknown());
const capture = Type.Union([object({ value: serialized }), object({ error })]);
const captures = Type.Record(Type.String(), capture);
const execution = {
  executionId: identifier, taskId: identifier, deliveryId: identifier, submissionId: identifier,
  gradeRevision: Type.Integer({ minimum: 0 }), item: ItemResponseSchema.properties.item, slotId: identifier,
};
export const PythonRunRequestSchema = object({
  ...execution,
  runtime,
  fixtures: Type.Record(NameSchema, FixtureSchema),
  /** 测试 data 未指定时使用这些夹具；prelude 位于 runtime，不能由前端自行补写。 */
  data: Type.Array(NameSchema, { maxItems: 8 }),
  program: object({ source: Type.Enum(["code", "parsons"]), code: Type.String({ maxLength: 50_000 }) }),
  tests: Type.Array(TestSchema, { minItems: 1, maxItems: 20 }),
  limits: object({
    timeoutMs: Type.Literal(PYTHON_RUN_LIMITS.timeoutMs), maxElements: Type.Literal(PYTHON_RUN_LIMITS.maxElements),
    maxDepth: Type.Literal(PYTHON_RUN_LIMITS.maxDepth), maxReprLength: Type.Literal(PYTHON_RUN_LIMITS.maxReprLength),
    maxOutputLength: Type.Literal(PYTHON_RUN_LIMITS.maxOutputLength),
  }),
});
export type PythonRunRequest = Static<typeof PythonRunRequestSchema>;

/** 每个测试先在独立命名空间算 expected，再在另一命名空间运行原答；不在前端比较或判分。 */
const testOutcome = Type.Union([
  object({
    status: Type.Literal("done"),
    expected: captures,
    actual: object({
      stdout: Type.String({ maxLength: PYTHON_RUN_LIMITS.maxOutputLength }),
      error: Type.Union([error, Type.Null()]), captures,
      doctest: Type.Array(object({
        out: Type.String({ maxLength: PYTHON_RUN_LIMITS.maxOutputLength }),
        exception: Type.Union([Type.String({ maxLength: 2_000 }), Type.Null()]),
      })),
    }),
  }),
  object({ status: Type.Literal("student_timeout") }),
  object({ status: Type.Literal("environment_failure"), message: Type.String({ maxLength: 2_000 }) }),
]);
export const PythonRunResultSchema = Type.Union([
  object({
    ...execution, status: Type.Literal("completed"), runtime,
    tests: Type.Array(object({ index: Type.Integer({ minimum: 0 }), outcome: testOutcome }), { minItems: 1, maxItems: 20 }),
  }),
  object({
    ...execution, status: Type.Literal("unavailable"),
    reason: Type.Enum(["runtime_mismatch", "initialization_failed", "worker_failed", "cancelled"]),
    message: Type.String({ maxLength: 2_000 }),
  }),
]);
export type PythonRunResult = Static<typeof PythonRunResultSchema>;

export function readPythonRunRequest(value: unknown): ReadResult<PythonRunRequest> {
  return readLenient<PythonRunRequest>(PythonRunRequestSchema, value);
}
export function readPythonRunResult(value: unknown): ReadResult<PythonRunResult> {
  return readLenient<PythonRunResult>(PythonRunResultSchema, value);
}
