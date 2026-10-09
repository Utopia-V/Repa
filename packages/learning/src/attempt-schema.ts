import { Type, type Static, type TSchema } from "typebox";
import {
  CapabilitySourceSchema, ContentRefSchema, IdSchema, ResourceRefSchema,
  RevisionSchema, literals, object,
} from "repa/protocol";

const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const nonempty = Type.String({ minLength: 1 });
export const LocalResourceSchema = object({ id: hash, mediaType: Type.String() });
export type LocalResource = Static<typeof LocalResourceSchema>;

function snapshot<R extends TSchema>(resource: R) {
  return object({
    resource,
    resources: Type.Optional(Type.Array(resource)),
    selector: Type.Optional(Type.String()),
    // 历史来源说明，不解释为当前空间的 live reference。
    source: Type.Optional(Type.String()),
  });
}

function report<R extends TSchema>(resource: R) {
  return Type.Union([
    object({ kind: Type.Literal("unknown") }),
    object({
      kind: Type.Literal("reported"),
      text: Type.String(),
      sources: Type.Optional(Type.Array(snapshot(resource))),
    }),
  ]);
}

function factShape<R extends TSchema>(resource: R) {
  return {
    actor: object({
      kind: literals(["learner", "assistant", "synthetic", "unknown"]),
      label: Type.Optional(Type.String()),
    }),
    response: Type.Union([
      object({ kind: Type.Literal("text"), text: Type.String() }),
      object({ kind: Type.Literal("resource"), resource }),
    ]),
    materials: Type.Array(snapshot(resource), { minItems: 1 }),
    presentation: Type.Optional(snapshot(resource)),
    initialConditions: report(resource),
    assistance: report(resource),
    occurredAt: Type.Optional(Type.Number()),
    provenance: Type.Optional(Type.String()),
  };
}

function judgmentShape<R extends TSchema>(resource: R) {
  return {
    factId: hash,
    method: object({
      kind: literals(["program", "model", "human"]),
      name: nonempty,
      version: Type.Union([Type.String(), Type.Null()]),
      execution: Type.Optional(snapshot(resource)),
    }),
    basis: Type.Array(snapshot(resource), { minItems: 1 }),
    conclusions: Type.Array(object({
      criterion: nonempty,
      verdict: literals(["met", "not-met", "undetermined"]),
      explanation: Type.String(),
    }), { minItems: 1 }),
    report: Type.Optional(snapshot(resource)),
    supersedes: Type.Optional(object({ id: IdSchema, reason: nonempty })),
  };
}

const recorded = { recordedAt: Type.Number(), recordedBy: CapabilitySourceSchema };
export const AttemptFactInputSchema = object(factShape(ResourceRefSchema));
export type AttemptFactInput = Static<typeof AttemptFactInputSchema>;
export const AttemptFactSchema = object({
  format: Type.Literal("repa.learning-attempt-fact"),
  version: Type.Literal(1),
  ...factShape(LocalResourceSchema),
  ...recorded,
});
export type AttemptFact = Static<typeof AttemptFactSchema>;
export const JudgmentInputSchema = object(judgmentShape(ResourceRefSchema));
export type JudgmentInput = Static<typeof JudgmentInputSchema>;
export const AttemptJudgmentSchema = object({
  format: Type.Literal("repa.learning-judgment"),
  version: Type.Literal(1),
  id: IdSchema,
  ...judgmentShape(LocalResourceSchema),
  ...recorded,
});
export type AttemptJudgment = Static<typeof AttemptJudgmentSchema>;
export const AttemptSelectionSchema = object({
  id: IdSchema,
  from: Type.Union([IdSchema, Type.Null()]),
  to: Type.Union([IdSchema, Type.Null()]),
  reason: nonempty,
  ...recorded,
});
export type AttemptSelection = Static<typeof AttemptSelectionSchema>;
export const AttemptRecordSchema = object({
  format: Type.Literal("repa.learning-attempt"),
  version: Type.Literal(1),
  fact: LocalResourceSchema,
  judgments: Type.Array(object({ id: IdSchema, resource: LocalResourceSchema })),
  selections: Type.Array(AttemptSelectionSchema),
});
export type AttemptRecord = Static<typeof AttemptRecordSchema>;
export const AttemptViewSchema = object({
  ref: ContentRefSchema,
  base: RevisionSchema,
  factId: hash,
  fact: AttemptFactSchema,
  judgments: Type.Array(AttemptJudgmentSchema),
  selections: Type.Array(AttemptSelectionSchema),
  current: Type.Union([IdSchema, Type.Null()]),
  resources: Type.Array(ResourceRefSchema),
});
export type AttemptView = Static<typeof AttemptViewSchema>;
export const RecordAttemptInputSchema = object({ operationId: IdSchema, fact: AttemptFactInputSchema });
export type RecordAttemptInput = Static<typeof RecordAttemptInputSchema>;
export const SaveJudgmentInputSchema = object({
  operationId: IdSchema,
  ref: ContentRefSchema,
  base: RevisionSchema,
  judgment: JudgmentInputSchema,
  adopt: Type.Optional(object({ reason: nonempty })),
});
export type SaveJudgmentInput = Static<typeof SaveJudgmentInputSchema>;
export const SelectJudgmentInputSchema = object({
  operationId: IdSchema,
  ref: ContentRefSchema,
  base: RevisionSchema,
  judgmentId: Type.Union([IdSchema, Type.Null()]),
  reason: nonempty,
});
export type SelectJudgmentInput = Static<typeof SelectJudgmentInputSchema>;
