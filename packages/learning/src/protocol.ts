/**
 * 学习插件的公开约定：判对错、提交结果和“不会”。插件方法照着它返回，前端的学习组件照着它渲染。
 *
 * 底座的交互词汇只管向用户要结构化的输入：内容块、作答位、Item、作答、只查结构的 checkResponse 和
 * contentVersion。这里在它上面加学习要用的部分；通用的部分直接用底座的，不另行定义。
 * 定义照 2026-10-12 从底座移走的原文（dev 50d458b6c 的 interaction.ts），只留学习用得上的。
 *
 * 本文件经 @repa/learning/protocol 导出，只依赖 typebox 和 @repa/base/protocol，浏览器里也能用。
 * 规则与底座的词汇相同：只增不改，发送方按当前版本严格校验，多余字段直接拒绝；前端用 readFeedback、
 * readSubmitResult 宽松读取，插件比前端新时也能显示。
 */
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

import {
  AnswerSchema,
  AskSubmitResultSchema,
  checkResponse,
  ContentSchema,
  ItemResponseSchema,
  object,
  readLenient,
  type CheckResult,
  type Item,
  type ReadFallback,
  type ReadResult,
} from "@repa/base/protocol";

import { DataFrameFixtureSchema, PythonFixtureSchema } from "./format/schema.js";

/** 指向一道题的某个版本：{ id, version }，与作答里的 item 相同。 */
const reference = ItemResponseSchema.properties.item;
/** 结构问题的列表，与底座 ask 的 invalid 结果是同一份 schema。 */
const problems = AskSubmitResultSchema.anyOf[0].properties.problems;

// ---------------------------------------------------------------------------
// 判分结果
// ---------------------------------------------------------------------------

/** correct、partial、incorrect 是判过的结果；ungraded 是本来就不判；pending 是作答已保存、判分还没完成。 */
export const VerdictSchema = Type.Union([
  Type.Literal("correct"), Type.Literal("partial"), Type.Literal("incorrect"),
  Type.Literal("ungraded"), Type.Literal("pending"),
]);
export type Verdict = Static<typeof VerdictSchema>;

export const ScoreSchema = object({ earned: Type.Number({ minimum: 0 }), max: Type.Number({ minimum: 0 }) });
export type Score = Static<typeof ScoreSchema>;

/**
 * 判分方式：rule 按标准答案和比较规则，tests 运行测试，model 由模型评，person 由人评。
 * model 判的反馈，界面标明仅供参考；它不更新学习状态，由插件保证。
 */
export const JudgeSchema = Type.Union([Type.Literal("rule"), Type.Literal("tests"), Type.Literal("model"), Type.Literal("person")]);
export type Judge = Static<typeof JudgeSchema>;

/** 选项、单元格或排列位置上的标记；missed 是该选而没选。 */
export const MarkSchema = Type.Union([Type.Literal("correct"), Type.Literal("incorrect"), Type.Literal("missed")]);
export type Mark = Static<typeof MarkSchema>;

/** 代码题的一个测试用例的结果；hidden 的用例只报告结果，不给输入和期望。 */
export const TestResultSchema = object({
  name: Type.String({ maxLength: 200 }),
  result: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("error"), Type.Literal("timeout")]),
  hidden: Type.Optional(Type.Boolean()),
  detail: Type.Optional(ContentSchema),
});
export type TestResult = Static<typeof TestResultSchema>;

/** 按一条评分要点给的反馈。unsure 表示判分方没有把握，不等于学习者错。 */
export const CriterionResultSchema = object({
  label: Type.String({ maxLength: 200 }),
  met: Type.Union([Type.Literal("yes"), Type.Literal("no"), Type.Literal("unsure")]),
  comment: Type.Optional(Type.String({ maxLength: 2_000 })),
});
export type CriterionResult = Static<typeof CriterionResultSchema>;

/** 一个作答位的反馈。 */
export const SlotFeedbackSchema = object({
  verdict: VerdictSchema,
  score: Type.Optional(ScoreSchema),
  message: Type.Optional(ContentSchema),
  /** 参考答案，用作答的格式表示；只在插件决定释放时出现。 */
  expected: Type.Optional(AnswerSchema),
  /** 键是选项 id、"行 id/列 id" 或排列位置。 */
  marks: Type.Optional(Type.Record(Type.String(), MarkSchema)),
  tests: Type.Optional(Type.Array(TestResultSchema, { maxItems: 100 })),
  criteria: Type.Optional(Type.Array(CriterionResultSchema, { maxItems: 20 })),
});
export type SlotFeedback = Static<typeof SlotFeedbackSchema>;

/** 一次作答的反馈：整题一级加上各作答位，item 指向作答时的题目和版本。 */
export const FeedbackSchema = object({
  item: reference,
  verdict: VerdictSchema,
  judge: Type.Optional(JudgeSchema),
  score: Type.Optional(ScoreSchema),
  message: Type.Optional(ContentSchema),
  slots: Type.Optional(Type.Record(Type.String(), SlotFeedbackSchema)),
});
export type Feedback = Static<typeof FeedbackSchema>;

// ---------------------------------------------------------------------------
// 作答与提交
// ---------------------------------------------------------------------------

/**
 * 学习者的一次作答：底座的作答加上“不会”。dontKnow 为 true 表示学习者明确说不会，这时不带作答。
 * 把“不会”做成正式的作答，比让学习者随便填一个答案更能区分“不会”和“粗心”；是否显示这个按钮由界面决定。
 */
export const LearnerResponseSchema = object({
  ...ItemResponseSchema.properties,
  dontKnow: Type.Optional(Type.Literal(true)),
});
export type LearnerResponse = Static<typeof LearnerResponseSchema>;

/**
 * 交给判分之前的结构检查。平常的作答交给底座的 checkResponse；说“不会”时不带作答，只查题目和版本。
 * 失败时的问题列表可以原样作为 rejected 交回前端。
 */
export function checkSubmission(item: Item, response: LearnerResponse): CheckResult {
  if (!Value.Check(LearnerResponseSchema, response)) return { ok: false, problems: [{ message: "作答不符合接口要求" }] };
  const { dontKnow, ...answered } = response;
  if (dontKnow !== true) return checkResponse(item, answered);
  if (Object.keys(answered.answers).length > 0) return { ok: false, problems: [{ message: "说“不会”时不带作答" }] };
  // 没有作答位的同一道题：底座只查题目和版本是否一致。
  return checkResponse({ ...item, slots: [] }, answered);
}

/**
 * 一次提交的结果。rejected：格式不合要求，没有记为作答，改好可以再交；只返回问题列表，不透露其他小问的对错。
 * recorded：已经记为一次作答。练习时通常带 feedback，测验交卷前不带。
 */
export const SubmitResultSchema = Type.Union([
  object({ status: Type.Literal("rejected"), problems }),
  object({ status: Type.Literal("recorded"), feedback: Type.Optional(FeedbackSchema) }),
]);
export type SubmitResult = Static<typeof SubmitResultSchema>;

// ---------------------------------------------------------------------------
// python.run：在前端的隔离环境里运行学习者的代码
// ---------------------------------------------------------------------------

/**
 * 前端服务 python.run 的输入，与课程核对交给 sandbox/runner.py 的 program 任务相同（不带 op），
 * 前端用同一个 runner.py 执行，学习者看到的输出和课程核对一致。
 * 在全新的命名空间里依次运行 prelude、准备 data、运行 setup 和 program，再对 captures 逐个求值、逐条运行 doctest。
 * 这些内容都会交给前端，带答案的核对程序和隐藏测试不放进来。
 */
const label = Type.String({ minLength: 1, maxLength: 40 });
export const PythonRunInputSchema = object({
  prelude: Type.Optional(Type.String({ maxLength: 10_000 })),
  data: Type.Array(Type.Union([
    object({
      kind: Type.Literal("dataframe"),
      label,
      name: DataFrameFixtureSchema.properties.name,
      columns: DataFrameFixtureSchema.properties.columns,
      index: DataFrameFixtureSchema.properties.index,
      dtypes: DataFrameFixtureSchema.properties.dtypes,
    }),
    object({ kind: Type.Literal("python"), label, code: PythonFixtureSchema.properties.code }),
  ]), { maxItems: 20 }),
  setup: Type.Optional(Type.String({ maxLength: 10_000 })),
  program: Type.String({ maxLength: 50_000 }),
  captures: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { maxItems: 50 }),
  doctest: Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: 50 }),
});
export type PythonRunInput = Static<typeof PythonRunInputSchema>;

const pythonError = { type: Type.String(), message: Type.String() };

/**
 * python.run 的结果，即 runner.py 的 program 任务的结果。error 是 program 抛出的异常，line 是它停在 program 的第几行；
 * captures 的 value 是 runner.py 序列化后的值；doctest 按输入顺序给出每条的输出或异常。
 * prelude、data 或 setup 出错时没有结果，服务以错误回复。
 */
export const PythonRunResultSchema = object({
  stdout: Type.String(),
  error: Type.Union([object({ ...pythonError, line: Type.Union([Type.Integer(), Type.Null()]) }), Type.Null()]),
  captures: Type.Record(Type.String(), Type.Union([object({ value: Type.Unknown() }), object({ error: object(pythonError) })])),
  doctest: Type.Array(object({ out: Type.String(), exception: Type.Union([Type.String(), Type.Null()]) })),
});
export type PythonRunResult = Static<typeof PythonRunResultSchema>;

// ---------------------------------------------------------------------------
// 前端的宽松读取
// ---------------------------------------------------------------------------

const VERDICTS = new Set<unknown>(VerdictSchema.anyOf.map((member) => member.const));

/** 认出判分结果这个联合。Type.Optional 会复制 schema，所以比成员，不比对象身份。 */
function isVerdict(union: TSchema): boolean {
  const members = (union as { anyOf?: { const?: unknown }[] }).anyOf ?? [];
  return members.length === VERDICTS.size && members.every((member) => VERDICTS.has(member.const));
}

/** 不认识的 verdict 读作 ungraded，界面不标对错、只显示说明；其余认不出的值连同所在的一项丢掉。 */
const fallback: ReadFallback = ({ union }) => (isVerdict(union) ? "ungraded" : undefined);

/**
 * 前端读取反馈。规则同底座的 readLenient：不认识的字段丢掉，认识的字段类型不对时读取失败。
 * 不认识的 verdict 读作 ungraded；不认识的 judge 丢掉，不标来源；标记、测试结果和评分要点里不认识的条目逐条丢掉。
 */
export function readFeedback(value: unknown): ReadResult<Feedback> {
  return readLenient<Feedback>(FeedbackSchema, value, fallback);
}

/** 前端读取提交结果，例如插件方法返回的 SubmitResult；其中的反馈按 readFeedback 的规则读取，认不出的 status 读取失败。 */
export function readSubmitResult(value: unknown): ReadResult<SubmitResult> {
  return readLenient<SubmitResult>(SubmitResultSchema, value, fallback);
}
