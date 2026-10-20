import { Type, type Static } from "typebox";

export const KnowledgeGraphSchema = Type.Object({
  topics: Type.Array(Type.String()),
  prerequisites: Type.Array(Type.Object({
    topic: Type.String(),
    prerequisite: Type.String(),
  }, { additionalProperties: false })),
  encompassings: Type.Array(Type.Object({
    advanced: Type.String(),
    simple: Type.String(),
    weight: Type.Number({ minimum: 0, maximum: 1 }),
  }, { additionalProperties: false })),
}, { additionalProperties: false });
export type KnowledgeGraph = Static<typeof KnowledgeGraphSchema>;

export const ModelConfigSchema = Type.Object({
  dueMemory: Type.Number({ minimum: 0 }),
  initialSpeed: Type.Number({ exclusiveMinimum: 0 }),
  minimumSpeed: Type.Number({ exclusiveMinimum: 0 }),
  maximumSpeed: Type.Number({ exclusiveMinimum: 0 }),
  passSpeedStep: Type.Number({ minimum: 0 }),
  failSpeedStep: Type.Number({ minimum: 0 }),
  maximumInterval: Type.Number({ exclusiveMinimum: 0 }),
  passScale: Type.Number({ minimum: 0 }),
  failScale: Type.Number({ minimum: 0 }),
  qualityExponent: Type.Number({ minimum: 0 }),
  intervalScale: Type.Number({ exclusiveMinimum: 0 }),
  intervalBase: Type.Number({ minimum: 1 }),
  earlyExponent: Type.Number({ minimum: 0 }),
  decaySlope: Type.Number({ minimum: 0 }),
  decayExponent: Type.Number({ minimum: 0 }),
  pathCombination: Type.Union([Type.Literal("max"), Type.Literal("capped-sum")]),
  updateSpeed: Type.Boolean(),
}, { additionalProperties: false });
export type ModelConfig = Readonly<Static<typeof ModelConfigSchema>>;

export const TopicStateSchema = Type.Object({
  repNum: Type.Number({ minimum: 0 }),
  memory: Type.Number({ minimum: 0 }),
  speed: Type.Number({ exclusiveMinimum: 0 }),
  lastRepetitionDay: Type.Number(),
  interval: Type.Number({ exclusiveMinimum: 0 }),
}, { additionalProperties: false });
export type TopicState = Static<typeof TopicStateSchema>;

// 存在条目表示已完成初次学习；遗忘和失败不抹去这段学习经历。
export const StudentSchema = Type.Record(Type.String(), TopicStateSchema);
export type Student = Static<typeof StudentSchema>;

export const RepetitionSchema = Type.Object({
  topicId: Type.String(),
  day: Type.Number(),
  outcome: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
  quality: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1 })),
}, { additionalProperties: false });
export type Repetition = Static<typeof RepetitionSchema>;

export const CandidateSchema = Type.Object({
  topicId: Type.String(),
  kind: Type.Union([Type.Literal("learn"), Type.Literal("review")]),
  reason: Type.Object({
    kind: Type.Union([
      Type.Literal("frontier"),
      Type.Literal("compression"),
      Type.Literal("due"),
    ]),
    // 都相对于调用时的真实状态；候选任务之间不假定已经完成。
    clearsOnPass: Type.Array(Type.String()),
    prerequisites: Type.Array(Type.String()),
    explicitOnly: Type.Boolean(),
  }, { additionalProperties: false }),
}, { additionalProperties: false });
export type Candidate = Static<typeof CandidateSchema>;
