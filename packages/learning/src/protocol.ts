/**
 * 学习插件的公开约定：任务画面、判分、提交恢复、内容读取与“不会”。
 *
 * 底座的交互词汇只管向用户要结构化的输入：内容块、作答位、Item、作答、只查结构的 checkResponse 和
 * contentVersion。这里在它上面加学习要用的部分；通用的部分直接用底座的，不另行定义。
 * 判分与原答形状延续 2026-10-12 从底座移走的词汇；任务契约供后续插件实现与前端共用。
 *
 * 本文件经 @repa/learning/protocol 导出，只依赖 typebox 和 @repa/base/protocol，浏览器里也能用。
 * 规则与底座的词汇相同：只增不改，发送方按当前版本严格校验，多余字段直接拒绝；前端通过
 * readLearningResult 等入口宽松读取，插件比前端新时也能显示。
 */
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

import {
  AnswerSchema,
  AskSubmitResultSchema,
  canRender,
  checkResponse,
  ContentSchema,
  identifier,
  ItemSchema,
  ItemResponseSchema,
  object,
  readItem,
  readLenient,
  type CheckResult,
  type ClientCapabilities,
  type Item,
  type ReadFallback,
  type ReadResult,
} from "@repa/base/protocol";

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
 * 来源与证据资格分开：确定的隔离模型判分可以参与课内推进，资格由后端给出。
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
  evidence: Type.Optional(object({
    status: Type.Enum(["eligible", "ineligible", "unresolved"]),
    reason: Type.Optional(Type.String({ maxLength: 500 })),
  })),
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
// 代码题的测试
// ---------------------------------------------------------------------------

/**
 * 一个测试的 doctest 最多几个例子、每个例子最长多少字符，课程核对按这个上限检查。
 * 前端在隔离环境里运行代码的 python.run 输入输出见 @repa/python-runner/protocol。
 */
export const DOCTEST_LIMITS = { examples: 50, source: 2_000 } as const;

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

// ---------------------------------------------------------------------------
// 当前任务、提交恢复与内容读取；传输信封沿用 plugin.call / plugin.event。
// ---------------------------------------------------------------------------

const count = Type.Integer({ minimum: 0 });
/** 时间为服务端 Unix 毫秒；revision 是空间内学习状态的单调序号。 */
const timestamp = Type.Integer({ minimum: 0 });
const nullableTime = Type.Union([timestamp, Type.Null()]);
const kind = Type.Enum(["lesson", "review", "quiz", "retake"]);
export const TaskStageSchema = Type.Enum([
  "preparing", "explanation", "example", "awaiting_answer", "judging", "recovery", "feedback", "completed", "aborted",
]);
export type TaskStage = Static<typeof TaskStageSchema>;

/** id 是公开内容身份，version 是该内容的摘要，不是内部题号映射。 */
export const ContentRefSchema = object({
  courseId: identifier, topicId: identifier, kpId: Type.Optional(identifier),
  id: identifier, version: reference.properties.version,
  kind: Type.Enum(["topic", "kp", "lesson", "example", "card", "explanation"]),
});
export type ContentRef = Static<typeof ContentRefSchema>;
const origin = object({ taskId: identifier, deliveryId: Type.Optional(identifier), content: ContentRefSchema });
const range = { offset: count, limit: Type.Integer({ minimum: 1, maximum: 64 }) };
export const ContentPageSchema = object({
  ref: ContentRefSchema, origin, offset: count, total: count, blocks: ContentSchema,
});
export type ContentPage = Static<typeof ContentPageSchema>;

/** submissionId 在交付时预留；一次交付只收一份原答，重试沿用它。 */
export const DeliverySchema = object({
  deliveryId: identifier, submissionId: identifier, item: ItemSchema,
  topicId: identifier, kpId: identifier,
  mode: Type.Enum(["practice", "review", "quiz"]), repeated: Type.Boolean(),
  requiresServices: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 64 }),
});
export type Delivery = Static<typeof DeliverySchema>;
export const ProcessingSchema = Type.Union([
  object({ status: Type.Literal("accepted") }),
  object({ status: Type.Literal("pending") }),
  object({ status: Type.Literal("interrupted"), reason: Type.Enum(["restart", "service_failure", "uncertain_grade", "cancelled"]) }),
  object({ status: Type.Literal("completed") }),
]);
export type Processing = Static<typeof ProcessingSchema>;
export const SubmissionSchema = object({
  taskId: identifier, deliveryId: identifier, submissionId: identifier,
  response: LearnerResponseSchema, acceptedAt: timestamp, processing: ProcessingSchema,
  gradeRevision: count,
  /** practice 判分后、review 结束后、quiz/retake 交卷或超时后才释放；受限任务中历史结果同样隐藏。 */
  feedback: Type.Optional(FeedbackSchema), explanation: Type.Optional(ContentSchema),
});
export type Submission = Static<typeof SubmissionSchema>;
export const SubmissionReceiptSchema = Type.Union([
  object({
    ...SubmitResultSchema.anyOf[0].properties, submissionId: identifier,
    processing: object({ status: Type.Literal("not_accepted") }),
  }),
  object({ status: Type.Literal("recorded"), submission: SubmissionSchema }),
]);
export type SubmissionReceipt = Static<typeof SubmissionReceiptSchema>;

const phase = Type.Union([
  object({ stage: Type.Literal("preparing") }),
  object({ stage: Type.Literal("explanation"), page: ContentPageSchema }),
  object({ stage: Type.Literal("example"), page: ContentPageSchema }),
  object({ stage: Type.Literal("awaiting_answer"), deliveryId: identifier }),
  object({ stage: Type.Literal("judging"), submissionId: identifier }),
  object({ stage: Type.Literal("recovery"), submissionId: identifier }),
  object({ stage: Type.Literal("feedback"), submissionId: identifier }),
  // unresolved：任务已经结束，但还有作答没判出结果，判出来可能改变结论；判出以后改为其他三种之一。
  object({ stage: Type.Literal("completed"), outcome: Type.Enum(["passed", "failed", "timeout", "unresolved"]) }),
  object({ stage: Type.Literal("aborted"), reason: Type.String({ maxLength: 500 }) }),
]);
export const LearningTaskSchema = object({
  taskId: identifier, kind, topicIds: Type.Array(identifier), phase,
  startedAt: nullableTime, deadlineAt: nullableTime,
  kps: Type.Array(object({ kpId: identifier, attempts: count, consecutiveCorrect: count, completed: Type.Boolean() })),
  deliveries: Type.Array(DeliverySchema), submissions: Type.Array(SubmissionSchema),
});
export type LearningTask = Static<typeof LearningTaskSchema>;
export const LearningMenuSchema = object({
  menuId: identifier,
  candidates: Type.Array(object({
    id: identifier, kind, title: Type.String({ maxLength: 200 }), topicIds: Type.Array(identifier),
    originalTaskId: Type.Optional(identifier),
  }), { maxItems: 3 }),
  unavailableReason: Type.Optional(Type.String({ maxLength: 500 })), availableAt: Type.Optional(timestamp),
});
export type LearningMenu = Static<typeof LearningMenuSchema>;
const localDate = Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" });
export const LearningProgressSchema = object({
  day: localDate, timeZone: identifier,
  dailyGoalXp: Type.Integer({ minimum: 1 }), todayXp: count, totalXp: count,
  completedTopics: count, totalTopics: count,
  completionRate: Type.Number({ minimum: 0, maximum: 1 }),
  /** 估计完课的本地日期（与 day 同一时区）；最近学得太少、没有依据时为 null。 */
  etaDate: Type.Union([localDate, Type.Null()]),
});
export type LearningProgress = Static<typeof LearningProgressSchema>;
export const LearningStateSchema = object({
  revision: count, serverNow: timestamp,
  course: Type.Union([object({ id: identifier, title: Type.String({ maxLength: 200 }), version: Type.String() }), Type.Null()]),
  task: Type.Union([LearningTaskSchema, Type.Null()]), menu: Type.Union([LearningMenuSchema, Type.Null()]),
  restrictions: object({
    kind: Type.Enum(["none", "review", "quiz"]), tutorAllowed: Type.Boolean(), referenceContentAllowed: Type.Boolean(),
  }),
  progress: LearningProgressSchema,
});
export type LearningState = Static<typeof LearningStateSchema>;

/** 事件只使缓存失效，不交付题面、原答或反馈。 */
export const LearningEventSchema = object({
  type: Type.Literal("learning.changed"), revision: count,
  taskId: Type.Union([identifier, Type.Null()]), menuId: Type.Union([identifier, Type.Null()]),
  submissionId: Type.Optional(identifier),
});
export type LearningEvent = Static<typeof LearningEventSchema>;
export const LearningErrorDetailsSchema = Type.Union([
  object({ reason: Type.Literal("invalid_structure"), problems }),
  object({ reason: Type.Literal("stale"), state: LearningStateSchema }),
  object({ reason: Type.Literal("payload_conflict"), submissionId: identifier }),
  object({ reason: Type.Literal("missing_capability"), missing: Type.Array(identifier), taskId: identifier }),
  object({ reason: Type.Literal("restricted"), taskId: identifier, stage: TaskStageSchema }),
  object({ reason: Type.Literal("service_failure"), service: identifier, retryable: Type.Boolean() }),
]);
export type LearningErrorDetails = Static<typeof LearningErrorDetailsSchema>;

const guard = { taskId: identifier, expectedStage: TaskStageSchema, expectedRevision: count };
const selection = object({ menuId: identifier, candidateId: identifier });
const submission = object({ submissionId: identifier });
/** 本表是 learning 插件方法的 input/result；不另造 RPC 信封。 */
export const learningMethods = {
  "state.get": { input: object({}), result: LearningStateSchema },
  "menu.select": { input: selection, result: LearningStateSchema },
  "task.advance": { input: object(guard), result: LearningStateSchema },
  "task.resume": { input: object(guard), result: LearningStateSchema },
  "task.abort": { input: object(guard), result: LearningStateSchema },
  "submission.get": {
    input: submission,
    result: Type.Union([
      object({ status: Type.Literal("absent"), submissionId: identifier, revision: count }),
      object({ status: Type.Literal("found"), submission: SubmissionSchema, revision: count }),
    ]),
  },
  "submission.submit": {
    input: object({ taskId: identifier, deliveryId: identifier, submissionId: identifier, response: LearnerResponseSchema }),
    result: SubmissionReceiptSchema,
  },
  "submission.resume": { input: submission, result: SubmissionReceiptSchema },
  "submission.appeal": { input: object({ submissionId: identifier, expectedGradeRevision: count, reason: Type.String({ minLength: 1, maxLength: 2_000 }) }), result: SubmissionReceiptSchema },
  "content.search": {
    input: object({ query: Type.String({ maxLength: 200 }), offset: count, limit: Type.Integer({ minimum: 1, maximum: 20 }) }),
    result: object({ hits: Type.Array(object({ ref: ContentRefSchema, title: Type.String(), snippet: Type.String(), origin })), nextOffset: Type.Union([count, Type.Null()]) }),
  },
  "content.read": { input: object({ refs: Type.Array(ContentRefSchema, { minItems: 1, maxItems: 8 }), ...range }), result: Type.Array(ContentPageSchema) },
  "content.open": { input: object({ ref: ContentRefSchema }), result: object({ openedAt: timestamp }) },
  "quiz.start": { input: selection, result: LearningStateSchema },
  "quiz.finish": { input: object(guard), result: LearningStateSchema },
  "quiz.retake": { input: object({ ...selection.properties, originalTaskId: identifier }), result: LearningStateSchema },
  "progress.get": { input: object({}), result: object({ serverNow: timestamp, progress: LearningProgressSchema }) },
  "progress.setGoal": { input: object({ dailyGoalXp: Type.Integer({ minimum: 1 }) }), result: LearningStateSchema },
} as const;
export type LearningMethod = keyof typeof learningMethods;
export type LearningInput<M extends LearningMethod> = Static<(typeof learningMethods)[M]["input"]>;
export type LearningResult<M extends LearningMethod> = Static<(typeof learningMethods)[M]["result"]>;

/** 保留原任务；缺少运行服务与缺少渲染能力都返回具体缺项。 */
export function missingDeliveryCapabilities(capabilities: ClientCapabilities | undefined, delivery: Delivery): string[] {
  const missing = canRender(capabilities?.interaction, delivery.item)
    ? [] : delivery.item.requires.filter((name) => !capabilities?.interaction?.supports.includes(name));
  const services = new Set(delivery.requiresServices);
  if (delivery.item.slots.some((slot) => slot.type === "code")) services.add("python.run");
  return [...new Set([...missing, ...[...services].filter((name) => !capabilities?.services?.includes(name))])].sort();
}

/** 宽松读取时仍用 readItem 补齐未知作答位的 requires，不能把它读成可提交的残缺题目。 */
function readLearning<T>(schema: TSchema, value: unknown): ReadResult<T> {
  const result = readLenient<T>(schema, value, fallback);
  if (!result.ok) return result;
  function restore(raw: unknown, clean: unknown, path: string): string | undefined {
    if (raw === null || clean === null || typeof raw !== "object" || typeof clean !== "object") return;
    if (Array.isArray(raw) && Array.isArray(clean)) {
      for (const [index, member] of clean.entries()) {
        // 新增 mode 可能让整份交付被丢掉，不能把其后的题面错配给前一份交付。
        const source = member !== null && typeof member === "object" && "deliveryId" in member
          ? raw.find((entry: unknown) => entry !== null && typeof entry === "object" && "deliveryId" in entry && entry.deliveryId === member.deliveryId)
          : raw[index];
        const error = restore(source, member, `${path}/${index}`);
        if (error !== undefined) return error;
      }
      return;
    }
    const source = raw as Record<string, unknown>;
    for (const [key, member] of Object.entries(clean)) {
      if (key === "item" && typeof member === "object" && member !== null && "slots" in member) {
        const item = readItem(source[key]);
        if (!item.ok) return `${path}/${key}${item.path}`;
        Object.assign(member, item.value);
      } else {
        const error = restore(source[key], member, `${path}/${key}`);
        if (error !== undefined) return error;
      }
    }
    return;
  }
  const error = restore(value, result.value, "");
  return error === undefined ? result : { ok: false, path: error };
}

export function readLearningResult<M extends LearningMethod>(method: M, value: unknown): ReadResult<LearningResult<M>> {
  return readLearning<LearningResult<M>>(learningMethods[method].result, value);
}
export function readLearningEvent(value: unknown): ReadResult<LearningEvent> {
  return readLearning<LearningEvent>(LearningEventSchema, value);
}
export function readLearningError(value: unknown): ReadResult<LearningErrorDetails> {
  return readLearning<LearningErrorDetails>(LearningErrorDetailsSchema, value);
}

