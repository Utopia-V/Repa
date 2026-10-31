import { Type, type Static } from "typebox";

/**
 * 学生模型读的知识图：topic 列表；先修关系决定新 topic 什么时候能学；包含关系（encompassing）决定一次学习或复习的信用按多大权重
 * 传给别的 topic（FIRe）。schema 只查形状，引用的 topic 是否存在、图是否无环由调用方保证。
 */
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
/** 一张知识图；其中的 topic id 也是学生状态、结论和候选里用的 id。 */
export type KnowledgeGraph = Static<typeof KnowledgeGraphSchema>;

/** HSRS 公式里的常数，各项的含义与出处见 DEFAULT_MODEL_CONFIG。 */
export const ModelConfigSchema = Type.Object({
  dueMemory: Type.Number({ minimum: 0 }),
  fullCreditMemory: Type.Number({ minimum: 0, exclusiveMaximum: 1 }),
  initialSpeed: Type.Number({ exclusiveMinimum: 0 }),
  minimumSpeed: Type.Number({ exclusiveMinimum: 0 }),
  maximumSpeed: Type.Number({ exclusiveMinimum: 0 }),
  passSpeedStep: Type.Number({ minimum: 0 }),
  failSpeedStep: Type.Number({ minimum: 0 }),
  intervalBase: Type.Number({ minimum: 1 }),
  maximumInterval: Type.Number({ exclusiveMinimum: 0 }),
  decaySlope: Type.Number({ minimum: 0 }),
}, { additionalProperties: false });
/** 一组 HSRS 常数，只读；缺省用 DEFAULT_MODEL_CONFIG。 */
export type ModelConfig = Readonly<Static<typeof ModelConfigSchema>>;

/**
 * 一个已学 topic 的状态。repNum 决定理想间隔 interval；memory 是 lastRepetitionDay 那天的值，别的日子用 memoryAt 投影；
 * speed 是这个学习者学这个 topic 的快慢，乘在 repNum 的增减上。interval 随状态保存，所以投影 memory 不需要配置。
 */
export const TopicStateSchema = Type.Object({
  repNum: Type.Number({ minimum: 0 }),
  memory: Type.Number({ minimum: 0 }),
  speed: Type.Number({ exclusiveMinimum: 0 }),
  lastRepetitionDay: Type.Number(),
  interval: Type.Number({ exclusiveMinimum: 0 }),
}, { additionalProperties: false });
/** 一个已学 topic 的状态。 */
export type TopicState = Static<typeof TopicStateSchema>;

/** 学生状态：topic id 到它的状态。存在条目表示已完成初次学习；遗忘和失败不抹去这段学习经历。 */
export const StudentSchema = Type.Record(Type.String(), TopicStateSchema);
/** 学生状态，按 topic id 索引。 */
export type Student = Static<typeof StudentSchema>;

/**
 * 一次已确认的学习或复习结论。day 是统一时间基准上的连续天数，由调用方换算；quality 在 0 到 1 之间、缺省为 1，
 * 按比例缩放这次的信用：表现一般的通过只拿部分正信用，失败的 quality 越大扣得越多。
 */
export const RepetitionSchema = Type.Object({
  topicId: Type.String(),
  day: Type.Number(),
  outcome: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
  quality: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1 })),
}, { additionalProperties: false });
/** 一次学习或复习结论。 */
export type Repetition = Static<typeof RepetitionSchema>;

/**
 * 选择器给出的一项候选：学一个新 topic（learn）或复习一个已学的（review），附上选它的理由。reason.kind 为 frontier 表示先修都已学完的
 * 新 topic，due 表示它自己到期，compression 表示通过它还能消除别的到期复习；clearsOnPass 是通过以后不再到期的 topic；
 * explicitOnly 表示 speed 低于 1、不收隐式的正信用，只能靠显式复习解除到期。
 */
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
/** 一项任务候选。 */
export type Candidate = Static<typeof CandidateSchema>;
