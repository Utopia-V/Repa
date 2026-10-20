import { Type, type Static } from "typebox";
import { identifier, ItemSchema, object } from "@repa/base/protocol";
import { KnowledgeGraphSchema, ModelConfigSchema, StudentSchema } from "@repa/learning-model";
import { ExpectedSchema } from "./python-execution.js";
import { CourseSchema, TopicSchema } from "./format/schema.js";
import { ContentRefSchema, FeedbackSchema, LearningStateSchema, SubmissionSchema } from "./protocol.js";

const time = Type.Integer({ minimum: 0 });
const nullableId = Type.Union([identifier, Type.Null()]);
export const SnapshotSchema = object({
  course: CourseSchema, topic: TopicSchema, kpId: identifier, questionId: identifier,
  topicVersion: identifier, kpVersion: identifier, questionVersion: identifier,
  expected: Type.Optional(ExpectedSchema),
  item: ItemSchema, idMap: Type.Record(identifier, identifier), graph: KnowledgeGraphSchema,
});
export type Snapshot = Static<typeof SnapshotSchema>;
export const DecisionSchema = object({
  policyVersion: identifier, now: time, seed: Type.Integer(),
  candidates: Type.Array(identifier), selected: nullableId, scores: Type.Record(identifier, Type.Number()),
});
export type Decision = Static<typeof DecisionSchema>;
export const ProjectionSchema = object({
  state: LearningStateSchema, student: StudentSchema,
  deliveries: Type.Record(identifier, identifier),
});
export type Projection = Static<typeof ProjectionSchema>;
export const AttemptContextSchema = object({
  startedAt: time, submittedAt: time, startOffsetMs: time, submitOffsetMs: time,
  helpBefore: Type.Array(identifier),
  model: object({ before: StudentSchema, now: time, configVersion: identifier, config: ModelConfigSchema }),
});
export type AttemptContext = Static<typeof AttemptContextSchema>;
export const GradeSchema = object({
  feedback: FeedbackSchema, ruleVersion: identifier, source: Type.Unknown(),
});
export type Grade = Static<typeof GradeSchema>;
const envelope = { v: Type.Literal(1), seq: Type.Integer({ minimum: 1 }), at: time };
export const RecordSchema = Type.Union([
  object({ ...envelope, type: Type.Literal("snapshot"), digest: identifier, snapshot: SnapshotSchema }),
  object({ ...envelope, type: Type.Literal("checkpoint"), projection: ProjectionSchema, decision: DecisionSchema }),
  object({ ...envelope, type: Type.Literal("accepted"), submission: SubmissionSchema, context: AttemptContextSchema }),
  object({ ...envelope, type: Type.Literal("appeal"), submissionId: identifier, expectedGradeRevision: Type.Integer({ minimum: 1 }), reason: Type.String({ minLength: 1, maxLength: 2_000 }) }),
  object({ ...envelope, type: Type.Literal("regraded"), submission: SubmissionSchema, grade: GradeSchema, projection: ProjectionSchema }),
  object({ ...envelope, type: Type.Literal("graded"), submissionId: identifier, grade: GradeSchema, projection: ProjectionSchema }),
  object({
    ...envelope, type: Type.Literal("viewed"), taskId: identifier, deliveryId: Type.Optional(identifier),
    action: Type.Enum(["explanation", "card", "kp", "help_before", "help_after"]), ref: ContentRefSchema,
  }),
]);
export type LearningRecord = Static<typeof RecordSchema>;
export type RecordBody = LearningRecord extends infer R ? R extends LearningRecord ? Omit<R, keyof typeof envelope> : never : never;
