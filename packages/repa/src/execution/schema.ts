import { Type, type Static } from "typebox";
import { CapabilitySourceSchema } from "../capabilities/schema.js";
import { ResourceRefSchema } from "../content/schema.js";
import { IdSchema, literals, object } from "../schema.js";

const paths = Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true });
export const ExecutionPolicySchema = Type.Union([
  object({ mode: Type.Literal("restricted"), readPaths: paths, writePaths: paths, network: Type.Boolean() }),
  object({ mode: Type.Literal("full-access") }),
]);
export type ExecutionPolicy = Static<typeof ExecutionPolicySchema>;

export const ExecutionInputSchema = object({
  command: Type.String(),
  timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 2147483.647 })),
  access: Type.Optional(object({ policy: ExecutionPolicySchema, reason: Type.String({ minLength: 1 }) })),
});
export type ExecutionInput = Static<typeof ExecutionInputSchema>;

export const ExecutionApprovalSchema = object({
  executionId: IdSchema,
  command: Type.String(),
  cwd: Type.String(),
  policy: ExecutionPolicySchema,
  lifetime: Type.Literal("once"),
});

export const ExecutionViewSchema = object({
  id: IdSchema,
  spaceId: IdSchema,
  requestId: IdSchema,
  source: CapabilitySourceSchema,
  command: Type.String(),
  cwd: Type.String(),
  policy: ExecutionPolicySchema,
  protectedPaths: paths,
  status: literals(["authorizing", "running", "cancelling", "completed", "failed", "cancelled"]),
  createdAt: Type.Number(),
  startedAt: Type.Optional(Type.Number()),
  finishedAt: Type.Optional(Type.Number()),
  pid: Type.Optional(Type.Integer({ minimum: 1 })),
  exitCode: Type.Optional(Type.Integer()),
  terminationSignal: Type.Optional(Type.String()),
  output: Type.String(),
  truncated: Type.Boolean(),
  fullOutput: Type.Optional(ResourceRefSchema),
  // 旧执行结果的额外资源仍参与恢复与复制；新命令不再汇入能力资源。
  resources: Type.Optional(Type.Array(ResourceRefSchema)),
  error: Type.Optional(object({ code: Type.String(), message: Type.String() })),
});
export type ExecutionView = Static<typeof ExecutionViewSchema>;
