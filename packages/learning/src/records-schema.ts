/**
 * 学习记录的盘上格式：每行一条事实，只追加、不改写。
 *
 * 事实只记对推断学习状态有用的事情：学习者选了什么任务、看了哪一页讲解、出了哪道题、
 * 答了什么（题目原来的选项编号）、当时判成什么，以及主动结束任务和日目标。界面、学生模型、进度和 XP
 * 都从这些事实重放出来，删掉以后可以重算。任务、交付和提交的编号由事实的序号得出，不另存。
 */
import { Type, type Static } from "typebox";
import { AnswerSchema, identifier, object } from "@repa/base/protocol";
import { CourseStructureSchema } from "./course-structure.js";

const time = Type.Integer({ minimum: 0 });
/** 引用此前一条事实的序号。 */
const reference = Type.Integer({ minimum: 1 });
const version = Type.String({ pattern: "^sha256:[0-9a-f]{64}$" });
const envelope = { seq: Type.Integer({ minimum: 1 }), at: time };

/**
 * 计算任务所用规则（判定、奖励、学生模型的更新与参数）的身份。test1 是测试版 v0.1.0-test.1 起一直使用的这一套；
 * 以后改规则时另起一个身份，之前的任务仍按它记下的那一套计算。
 */
export const RulesSchema = Type.Enum(["test1"]);
/** 规则的身份。 */
export type Rules = Static<typeof RulesSchema>;

/** 任务类型：课、复习、测验和换题重考。 */
export const TaskKindSchema = Type.Enum(["lesson", "review", "quiz", "retake"]);
/** 任务类型。 */
export type TaskKind = Static<typeof TaskKindSchema>;

/** 一个作答位当时的判分：tests 与课程里的测试一一对应，reason 是模型给的理由。 */
export const GradedSlotSchema = object({
  verdict: Type.Enum(["correct", "partial", "incorrect"]),
  tests: Type.Optional(Type.Array(Type.Enum(["passed", "failed", "timeout", "error", "not_run"]), { maxItems: 100 })),
  reason: Type.Optional(Type.String({ maxLength: 2_000 })),
});
/** 一个作答位当时的判分。 */
export type GradedSlot = Static<typeof GradedSlotSchema>;

/** 一条学习事实；seq 从 1 起连续，at 是写入时的服务端毫秒时间。 */
export const FactSchema = Type.Union([
  // 学习者从菜单选了一项任务；course 是开始时加载的课程标识与版本，课程改版以后仍知道这项任务及其作答依据的是哪一版。
  // retakes 是换题重考所针对的测验任务。课还记下开始时的练习：按知识点顺序列出必做题和开放题，
  // 以及课的分钟数（XP 的基数），之后课程改动不改写这节课的结论与 XP。
  object({
    ...envelope, type: Type.Literal("task"), kind: TaskKindSchema, course: object({ id: identifier, version: identifier }),
    topics: Type.Array(identifier, { minItems: 1, maxItems: 20 }), retakes: Type.Optional(reference),
    practice: Type.Optional(Type.Array(
      object({ kp: identifier, required: Type.Array(identifier, { maxItems: 20 }), open: Type.Array(identifier, { maxItems: 20 }) }),
      { maxItems: 8 },
    )),
    minutes: Type.Optional(Type.Integer({ minimum: 0 })),
    // structure 引用此前一条带课程结构的事实（structure，或带结构的 baseline），任务的结论、奖励、学生模型与补救都按它计算；
    // rules 是计算所用规则的身份。旧日志基线之前的任务没有这两项，按基线计算。
    structure: Type.Optional(reference),
    rules: Type.Optional(RulesSchema),
  }),
  // 课内翻到某个知识点的讲解页或例题页。
  object({ ...envelope, type: Type.Literal("viewed"), task: reference, kp: identifier, page: Type.Enum(["lesson", "example"]) }),
  // 出了一道题；seed 决定这次交付的选项顺序与不透明编号。
  object({
    ...envelope, type: Type.Literal("delivered"), task: reference, question: identifier,
    seed: Type.Integer({ minimum: 0, maximum: 0xffff_ffff }),
  }),
  // 学习者的作答，选项、排列块和选择格换回课程里的编号；seen 是学习者看到的题面版本。
  object({
    ...envelope, type: Type.Literal("answered"), delivery: reference, seen: version,
    answers: Type.Record(Type.String(), AnswerSchema), dontKnow: Type.Optional(Type.Literal(true)),
  }),
  // 一次判分；version 是判分所依据的题目版本。后来的判分取代先前的，先前的照样保留。
  object({
    ...envelope, type: Type.Literal("graded"), delivery: reference, version,
    verdict: Type.Enum(["correct", "partial", "incorrect"]), slots: Type.Record(Type.String(), GradedSlotSchema),
  }),
  // 学习者对已判的作答提出申诉，要求重判。
  object({ ...envelope, type: Type.Literal("appealed"), delivery: reference, reason: Type.String({ minLength: 1, maxLength: 2_000 }) }),
  // 学习者主动结束任务：中止，或测验交卷。
  object({ ...envelope, type: Type.Literal("ended"), task: reference }),
  // 学习者设定的每日 XP 目标。
  object({ ...envelope, type: Type.Literal("goal"), xp: Type.Integer({ minimum: 1 }) }),
  // 一份课程结构，供之后的任务引用。随第一项用到它的任务一起写下，与同一门课最近一份结构相同时不再写。
  object({ ...envelope, type: Type.Literal("structure"), structure: CourseStructureSchema }),
  // 旧日志基线：首次用记录结构的版本打开测试版留下的日志时追加。此前（seq 小于它）的任务都按这里的结构和规则计算，
  // 即测试版当时用来解释整段日志的那一份；没有 structure 表示测试版当时不显示任何一门课的进度（空间里有还没换用的 course/），
  // 此前的任务不对任何一门课计数。
  object({ ...envelope, type: Type.Literal("baseline"), rules: RulesSchema, structure: Type.Optional(CourseStructureSchema) }),
]);
/** 一条学习事实。 */
export type Fact = Static<typeof FactSchema>;
/** 不含序号与时间的事实，由写入方补上。 */
export type FactBody = Fact extends infer F ? F extends Fact ? Omit<F, keyof typeof envelope> : never : never;
/** 指定类型的事实。 */
export type FactOf<T extends Fact["type"]> = Extract<Fact, { type: T }>;
