import { Type, type Static } from "typebox";
import { IdSchema, object, literals } from "../schema.js";
import { FileLocationSchema } from "../content/schema.js";

export const SpaceOperationSchema = object({
  operationId: IdSchema,
  kind: literals(["backup", "copy", "restore"]),
  status: literals(["prepared", "completed", "failed"]),
  spaceId: IdSchema,
  destination: Type.String(),
  externalDependencies: Type.Array(FileLocationSchema),
  participants: Type.Array(object({ id: IdSchema, version: Type.String(), directory: Type.String() })),
  error: Type.Optional(object({ code: Type.String(), message: Type.String() })),
});
export type SpaceOperation = Static<typeof SpaceOperationSchema>;
const operation = { operationId: IdSchema };
const destination = { destination: Type.String({ minLength: 1 }) };
export const spaceMethods = {
  "space.backup": { params: object({ ...operation, ...destination, spaceId: IdSchema }), result: SpaceOperationSchema },
  "space.copy": { params: object({ ...operation, ...destination, spaceId: IdSchema }), result: SpaceOperationSchema },
  "space.restore": { params: object({ ...operation, ...destination, source: Type.String({ minLength: 1 }) }), result: SpaceOperationSchema },
  "space.operation.get": { params: object(operation), result: Type.Union([SpaceOperationSchema, object({ ...operation, status: Type.Literal("unknown") })]) },
};
export type SpaceMethod = keyof typeof spaceMethods;

/** 声明该目录的实际持久 owner；实现数据库一致性及独立副本中的业务引用映射。 */
export interface SpaceSnapshotParticipant {
  id: string;
  version: string;
  directory: string;
  capture(context: {
    sourceDirectory: string;
    destinationDirectory: string;
    sourceSpaceId: string;
    targetSpaceId: string;
    mode: "backup" | "copy";
  }): Promise<void>;
}
