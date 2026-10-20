/**
 * 课程文件格式：一份课程清单 course.yaml，加每个 topic 一个 topics/<id>.yaml。
 *
 * 写法尽量贴近交互词汇（@repa/base/protocol）的 Item：题面、作答位、选项和单元格的字段名一致，
 * 再在作答位上加只留在插件里的部分（key、match、tests 等）。投影成学生可见的 Item 时按白名单取字段，
 * 这些私有字段不会带出去。凡是 Content 的位置，都可以直接写一段 Markdown 字符串，加载时拆成内容块。
 */

import { Type, type Static, type TSchema } from "typebox";

import { BlockSchema } from "@repa/base/protocol";

const object = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });

/** 题内的作答位、选项、块、行列标识，与交互词汇的 id 相同。 */
export const IdSchema = Type.String({ minLength: 1, maxLength: 120, pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$" });

export const TopicIdSchema = Type.String({
  pattern: "^[a-z][a-z0-9]*$", maxLength: 32,
  description: "topic id 只用小写字母和数字，以字母开头，例如 py17",
});
export const KpIdSchema = Type.String({
  pattern: "^[a-z][a-z0-9]*\\.k[0-9]+$", maxLength: 40,
  description: "知识点 id 写成 <topic id>.k<数字>，例如 py17.k1",
});
export const QuestionIdSchema = Type.String({
  pattern: "^[a-z][a-z0-9]*\\.k[0-9]+\\.[a-z][0-9]+$", maxLength: 48,
  description: "题目 id 写成 <知识点 id>.<小写字母><数字>，例如 py17.k1.q1",
});
/** 数据夹具、课程来源等课程内的名字。 */
export const NameSchema = Type.String({
  pattern: "^[A-Za-z][A-Za-z0-9_-]*$", maxLength: 40,
  description: "名字以字母开头，只用字母、数字、下划线和连字符",
});
const PythonNameSchema = Type.String({
  pattern: "^[A-Za-z_][A-Za-z0-9_]*$", maxLength: 40,
  description: "需要是合法的 Python 变量名",
});
const HttpsUrlSchema = Type.String({ pattern: "^https://", maxLength: 500, description: "链接需要以 https:// 开头" });

/** Markdown 字符串，或显式的内容块列表。 */
export const ContentInputSchema = Type.Union([Type.String({ maxLength: 20_000 }), Type.Array(BlockSchema, { maxItems: 64 })]);
export type ContentInput = Static<typeof ContentInputSchema>;

const ScalarSchema = Type.Union([Type.String({ maxLength: 500 }), Type.Number(), Type.Boolean()]);
const CellValueSchema = Type.Union([Type.String({ maxLength: 500 }), Type.Number(), Type.Boolean(), Type.Null()]);

// ---------------------------------------------------------------------------
// 课程清单
// ---------------------------------------------------------------------------

export const SourceUseKinds = ["reference", "adapt", "code", "quote"] as const;
const SourceUseKindSchema = Type.Enum(SourceUseKinds);

/** 课程用到的一份外部材料，以及它的许可允许怎样使用。 */
export const SourceSchema = object({
  title: text(200),
  author: Type.Optional(text(200)),
  url: HttpsUrlSchema,
  /** 版本、出版或访问日期，例如“第 3 版（2024-05）”“3.0.6，访问于 2026-10-11”。 */
  version: text(200),
  /** 许可原文名称；文字与代码许可不同时分别写明。 */
  license: text(300),
  /**
   * 许可允许的用法：reference 只作取材参照、内容自行编写；adapt 改编文字；code 复用代码；quote 短引用。
   * topic 里登记的用法必须在这里列出。
   */
  permits: Type.Array(SourceUseKindSchema, { minItems: 1, maxItems: 4 }),
  note: Type.Optional(text(1_000)),
});
export type Source = Static<typeof SourceSchema>;

export const RuntimeSchema = object({
  /** 判分和核对用的 Pyodide 发行版本，与学习者运行代码的版本一致。 */
  pyodide: text(32),
  python: text(32),
  /** 需要预先加载的 Pyodide 包及其版本，检查时与实际加载的版本比对。 */
  packages: Type.Record(Type.String({ pattern: "^[a-z][a-z0-9_-]*$" }), text(32)),
  /**
   * 运行前导：每次运行题目代码、测试和核对程序之前，先在同一个命名空间里运行的 Python 代码，
   * 例如 import pandas as pd。学习者在 Repa 里运行代码时也用这一份，所以写在清单里，不放在检查程序里。
   */
  prelude: Type.Optional(text(2_000)),
});
export type Runtime = Static<typeof RuntimeSchema>;

export const CourseSchema = object({
  id: NameSchema,
  version: Type.String({ pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+$", description: "课程版本写成 x.y.z" }),
  title: text(80),
  summary: Type.Optional(text(500)),
  language: text(16),
  /** 本课程自写内容的许可，用 SPDX 表达式；尚未决定时写 NOASSERTION。 */
  license: text(100),
  runtime: RuntimeSchema,
  sources: Type.Record(NameSchema, SourceSchema),
  /** topic 的稳定 id；顺序只是浏览顺序，学习安排由先修图和学习状态决定。 */
  topics: Type.Array(TopicIdSchema, { minItems: 1, maxItems: 500 }),
  /** 发布后退役的 topic、KP 和题目 id，不得再次使用。尚未发布时从空列表开始。 */
  retiredIds: Type.Optional(Type.Array(Type.Union([TopicIdSchema, KpIdSchema, QuestionIdSchema]))),
});
export type Course = Static<typeof CourseSchema>;

// ---------------------------------------------------------------------------
// topic 的元数据
// ---------------------------------------------------------------------------

/** 覆盖关系独立于先修图；缺失或零权重不传信用。权重是 Repa 的待校准假设。 */
export const EncompassingSchema = object({
  topic: TopicIdSchema,
  weight: Type.Number({ minimum: 0, maximum: 1 }),
});
export type Encompassing = Static<typeof EncompassingSchema>;

/** topic 对某份课程来源的具体使用：哪一章哪一节、怎样用。 */
export const SourceUseSchema = object({
  source: NameSchema,
  where: text(300),
  url: Type.Optional(HttpsUrlSchema),
  use: SourceUseKindSchema,
  /** 改编、复用代码或引用时必须写的署名与修改说明。 */
  notice: Type.Optional(text(1_000)),
});
export type SourceUse = Static<typeof SourceUseSchema>;

/** 小表数据：加载时生成 pandas.DataFrame，题面里显示成表格。 */
export const DataFrameFixtureSchema = object({
  kind: Type.Literal("dataframe"),
  name: PythonNameSchema,
  caption: Type.Optional(text(200)),
  index: Type.Optional(Type.Array(ScalarSchema, { minItems: 1, maxItems: 60 })),
  indexHeader: Type.Optional(Type.String({ maxLength: 40 })),
  /** 题面里是否显示行索引列，缺省显示；不讲 pandas 的题可以关掉。 */
  showIndex: Type.Optional(Type.Boolean()),
  columns: Type.Record(Type.String({ minLength: 1, maxLength: 60 }), Type.Array(CellValueSchema, { minItems: 0, maxItems: 60 })),
  /**
   * 列的类型。YAML 把 1.0 读成和 1 一样的数，写了小数的列要在这里声明 float，
   * 生成的 DataFrame 和题面里的表格才会是浮点（显示 1.0）。
   */
  dtypes: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 60 }), Type.Enum(["float"]))),
});

/** 一段准备代码，例如 limit = 10；display 是题面里要给学生看的说明，可省略。 */
export const PythonFixtureSchema = object({
  kind: Type.Literal("python"),
  code: text(10_000),
  display: Type.Optional(ContentInputSchema),
});

export const FixtureSchema = Type.Union([DataFrameFixtureSchema, PythonFixtureSchema]);
export type Fixture = Static<typeof FixtureSchema>;

// ---------------------------------------------------------------------------
// 题目
// ---------------------------------------------------------------------------

const slotBase = {
  id: IdSchema,
  prompt: Type.Optional(ContentInputSchema),
  label: Type.Optional(Type.String({ maxLength: 80 })),
  optional: Type.Optional(Type.Boolean()),
};

const OptionSchema = object({
  id: IdSchema,
  content: ContentInputSchema,
  label: Type.Optional(Type.String({ maxLength: 80 })),
  /** 选了这个错误选项时给的针对性反馈。 */
  feedback: Type.Optional(ContentInputSchema),
});

export const ChoiceSlotSchema = object({
  ...slotBase,
  type: Type.Literal("choice"),
  options: Type.Array(OptionSchema, { minItems: 2, maxItems: 26 }),
  multiple: Type.Optional(Type.Boolean()),
  minSelected: Type.Optional(Type.Integer({ minimum: 0 })),
  maxSelected: Type.Optional(Type.Integer({ minimum: 1 })),
  layout: Type.Optional(Type.Enum(["list", "row", "menu"])),
  /** 单选写一个选项 id，多选写选项 id 列表（可以为空列表）。 */
  key: Type.Union([IdSchema, Type.Array(IdSchema, { maxItems: 26 })]),
  /** 多选的计分：all 整体一致才得分（缺省）；options 每个选项的勾选状态各 1 分。 */
  scoring: Type.Optional(Type.Enum(["all", "options"])),
});
export type ChoiceSlot = Static<typeof ChoiceSlotSchema>;

export const TextMatchKinds = ["integer", "number", "text", "output", "nonempty"] as const;
const TextMatchSchema = Type.Enum(TextMatchKinds);
export type TextMatch = (typeof TextMatchKinds)[number];

const CriterionSchema = object({
  id: IdSchema,
  label: text(200),
  guide: Type.Optional(text(2_000)),
});

export const TextSlotSchema = object({
  ...slotBase,
  type: Type.Literal("text"),
  lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 40 })),
  maxLength: Type.Optional(Type.Integer({ minimum: 1, maximum: 20_000 })),
  format: Type.Optional(Type.String({ maxLength: 32 })),
  placeholder: Type.Optional(Type.String({ maxLength: 120 })),
  suffix: Type.Optional(Type.String({ maxLength: 20 })),
  quick: Type.Optional(Type.Array(Type.String({ maxLength: 40 }), { maxItems: 8 })),
  /**
   * 怎样比较：integer、number 按数值比较（字符串形式的标准答案按原文比较，用于“尚未定义”这类固定文字）；
   * text 去掉首尾空白后逐字比较；output 按 Python 显示内容比较；nonempty 只要求非空。
   * 省略时 format 为 integer 或 number 的按同名方式，其余按 text。
   */
  match: Type.Optional(TextMatchSchema),
  /** 标准答案；可以写一个值或多个可接受的值。nonempty 不写。 */
  key: Type.Optional(Type.Union([ScalarSchema, Type.Array(ScalarSchema, { minItems: 1, maxItems: 20 })])),
  tolerance: Type.Optional(Type.Number({ minimum: 0 })),
  /** 已知的错误答案和对应反馈；检查时确认它们确实判错。 */
  feedback: Type.Optional(Type.Array(object({ when: ScalarSchema, message: ContentInputSchema }), { maxItems: 20 })),
  /** 开放作答的评分要点。有 rubric 的小问由人或模型评，不进入复习和测验题池。 */
  rubric: Type.Optional(Type.Array(CriterionSchema, { minItems: 1, maxItems: 10 })),
});
export type TextSlot = Static<typeof TextSlotSchema>;

/** 代码测试：data 与 setup 准备输入，运行作答代码，再逐项比较 expect、stdout 或 doctest。 */
export const TestSchema = object({
  name: text(200),
  /** 用到的数据夹具；省略时沿用题目的 data。 */
  data: Type.Optional(Type.Array(NameSchema, { maxItems: 8 })),
  setup: Type.Optional(text(10_000)),
  /**
   * 键是作答代码运行后求值的 Python 表达式，值是期望结果的 Python 表达式。
   * 期望表达式在只有 data 和 setup 的全新命名空间里求值（可用 pd、np），两边结果序列化后在沙箱外比较。
   */
  expect: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 500 }), text(10_000))),
  /** doctest 写法：>>> 后是在作答命名空间里执行的语句，下面是交互解释器应显示的内容。 */
  doctest: Type.Optional(text(10_000)),
  /** 作答代码运行时打印的全部内容。 */
  stdout: Type.Optional(Type.String({ maxLength: 10_000 })),
  hidden: Type.Optional(Type.Boolean()),
});
export type CodeTest = Static<typeof TestSchema>;

const OrderItemSchema = object({
  id: IdSchema,
  content: Type.Optional(ContentInputSchema),
  /** 一行 Python 代码的简写，等同于 content 为一个 python 代码块。 */
  code: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
  label: Type.Optional(Type.String({ maxLength: 80 })),
});

export const OrderSlotSchema = object({
  ...slotBase,
  type: Type.Literal("order"),
  items: Type.Array(OrderItemSchema, { minItems: 2, maxItems: 40 }),
  partial: Type.Optional(Type.Boolean()),
  indent: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
  /** 标准排列（partial 时只含用到的块）。 */
  key: Type.Array(IdSchema, { maxItems: 40 }),
  /** 其他同样正确的排列。 */
  alternatives: Type.Optional(Type.Array(Type.Array(IdSchema, { maxItems: 40 }), { maxItems: 10 })),
  /** 有 indent 时，每块的缩进层级 {块 id: 层级}；标准排列和其他正确排列共用。 */
  indents: Type.Optional(Type.Record(IdSchema, Type.Integer({ minimum: 0, maximum: 8 }))),
  /** Parsons 题按测试判：把排好的块按缩进拼成程序后运行这些测试，接受等价的顺序。 */
  tests: Type.Optional(Type.Array(TestSchema, { minItems: 1, maxItems: 20 })),
});
export type OrderSlot = Static<typeof OrderSlotSchema>;

/** 表格输入格：bool（True/False 选择）、integer、text 三种简写，或完整写法。 */
export const CellInputPresets = ["bool", "integer", "text"] as const;
export const CellInputDefSchema = Type.Union([
  Type.Enum(CellInputPresets),
  object({
    type: Type.Literal("text"),
    format: Type.Optional(Type.String({ maxLength: 32 })),
    maxLength: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
    lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    quick: Type.Optional(Type.Array(Type.String({ maxLength: 40 }), { maxItems: 8 })),
    match: Type.Optional(TextMatchSchema),
  }),
  object({
    type: Type.Literal("choice"),
    options: Type.Array(object({ id: IdSchema, label: Type.String({ maxLength: 80 }) }), { minItems: 2, maxItems: 12 }),
  }),
]);
export type CellInputDef = Static<typeof CellInputDefSchema>;

/**
 * 单元格：在有 input 的列里，直接写的值就是这一格的标准答案；在没有 input 的列里，直接写的值是固定显示的文字。
 * 需要例外时用 { value } 固定显示，或 { input, key } 单独设一个输入格。
 */
export const CellSchema = Type.Union([
  ScalarSchema,
  object({ value: Type.String({ maxLength: 500 }) }),
  object({ input: CellInputDefSchema, key: ScalarSchema }),
]);
export type Cell = Static<typeof CellSchema>;

export const TableSlotSchema = object({
  ...slotBase,
  type: Type.Literal("table"),
  columns: Type.Array(object({
    id: IdSchema,
    header: Type.String({ maxLength: 200 }),
    input: Type.Optional(CellInputDefSchema),
  }), { minItems: 1, maxItems: 12 }),
  rows: Type.Array(object({
    id: IdSchema,
    header: Type.Optional(Type.String({ maxLength: 500 })),
    cells: Type.Record(Type.String(), CellSchema),
  }), { minItems: 1, maxItems: 60 }),
});
export type TableSlot = Static<typeof TableSlotSchema>;

export const CodeSlotSchema = object({
  ...slotBase,
  type: Type.Literal("code"),
  language: Type.Literal("python"),
  starter: Type.String({ maxLength: 50_000 }),
  maxLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
  /** 参考答案，必须通过全部测试。 */
  solution: text(50_000),
  /** 其他应当通过全部测试的等价写法。 */
  accepts: Type.Optional(Type.Array(text(50_000), { maxItems: 10 })),
  /** 常见错误写法，每一份都必须至少在一个测试上失败。 */
  rejects: Type.Optional(Type.Array(object({ code: text(50_000), why: text(300) }), { maxItems: 10 })),
  tests: Type.Array(TestSchema, { minItems: 1, maxItems: 20 }),
});
export type CodeSlot = Static<typeof CodeSlotSchema>;

export const SlotDefSchema = Type.Union([ChoiceSlotSchema, TextSlotSchema, OrderSlotSchema, TableSlotSchema, CodeSlotSchema]);
export type SlotDef = Static<typeof SlotDefSchema>;

export const QuestionKinds = ["predict", "trace", "debug", "explain", "modify", "specify"] as const;

export const QuestionSchema = object({
  id: QuestionIdSchema,
  title: Type.Optional(text(200)),
  /** 题目用到的数据夹具；按顺序显示在题面最前面，核对和测试时预先准备好。 */
  data: Type.Optional(Type.Array(NameSchema, { maxItems: 8 })),
  body: ContentInputSchema,
  slots: Type.Array(SlotDefSchema, { minItems: 1, maxItems: 24 }),
  /** 解析：交卷后给学生看的完整解答。 */
  explanation: ContentInputSchema,
  /**
   * 程序核对：在沙箱里运行这段 Python，给 answers 赋值 {作答位 id: 用程序独立算出的答案}。
   * 可用 CODE（题面里 python 代码块拼成的程序）、OPTIONS（选项里的代码）、run()、trace()、repl()、pd、np，
   * 以及题目 data 里的数据。
   */
  verify: Type.Optional(text(20_000)),
  /**
   * 程序算不出答案、需要语义判断的作答位。复习和测验题里的这些作答位，要由 course:confirm
   * 用一次隔离的模型调用独立再解，一致后在 topic 的 verified 段留下记录。
   */
  manual: Type.Optional(Type.Array(IdSchema, { maxItems: 24 })),
  // kind 是解释性元数据；有效 measures/uses 参与题目版本。
  /** 题型：预测输出、追踪变量、找错、解释代码、小改代码、写清需求。 */
  kind: Type.Optional(Type.Array(Type.Enum(QuestionKinds), { minItems: 1, maxItems: 3 })),
  /** 这道题直接测量的知识点；省略时为所在知识点。 */
  measures: Type.Optional(Type.Array(KpIdSchema, { minItems: 1, maxItems: 4 })),
  /** 本题实际执行的其他子技能；可以指向非祖先 topic，缺省为空。 */
  uses: Type.Optional(Type.Array(KpIdSchema, { maxItems: 12 })),
});
export type Question = Static<typeof QuestionSchema>;

// ---------------------------------------------------------------------------
// 知识点与 topic
// ---------------------------------------------------------------------------

/** 概念卡：内容取自课程，学生不用自己做笔记。 */
export const CardSchema = object({
  /** 概念名，对话里提到时作为链接文字。 */
  name: text(24),
  aliases: Type.Optional(Type.Array(text(24), { maxItems: 8 })),
  /** 一句话定义。 */
  definition: text(200),
  /** 适用条件或常见混淆，只写会影响使用的。 */
  conditions: Type.Array(text(160), { minItems: 1, maxItems: 3 }),
  /** 一个学过的例子；from 指向本知识点里的题目，也就是原学习位置。 */
  example: object({ from: QuestionIdSchema, text: ContentInputSchema }),
});
export type Card = Static<typeof CardSchema>;

export const KpSchema = object({
  id: KpIdSchema,
  title: text(80),
  /** 定位补救的关键先修 topic，可指向跳层祖先；按本 KP 内容填写。 */
  keyPrerequisites: Type.Optional(Type.Array(TopicIdSchema, { maxItems: 12 })),
  card: Type.Optional(CardSchema),
  /** 讲解。 */
  lesson: Type.Optional(ContentInputSchema),
  /** 例题：带完整解答，展示后不计独立证据。 */
  example: Type.Optional(QuestionSchema),
  practice: Type.Optional(Type.Array(QuestionSchema, { maxItems: 20 })),
  /** 复习题池：脱离讲解独立作答，和练习题分开。 */
  review: Type.Optional(Type.Array(QuestionSchema, { maxItems: 20 })),
  /** 测验题池。 */
  quiz: Type.Optional(Type.Array(QuestionSchema, { maxItems: 20 })),
});
export type Kp = Static<typeof KpSchema>;

/**
 * 一条模型核对记录：只把题目的公开部分交给模型独立作答，按作答位自己的判分规则与标准答案比对，
 * slots 里的 manual 作答位全部一致时才记下。记录放在 topic 文件里、不在题目里，所以不进题目版本；
 * 题面、判分定义、数据或运行依赖改变后失效，信用归属单独换版不使证明失效。
 */
export const ConfirmationSchema = object({
  question: QuestionIdSchema,
  version: Type.String({ pattern: "^sha256:[0-9a-f]{64}$", description: "核对哈希写成 sha256:<64 位十六进制>" }),
  /** 缺省是旧题目哈希；新范围同时绑定题面、判分定义、数据和运行依赖。 */
  scope: Type.Optional(Type.Literal("question-runtime-v1")),
  slots: Type.Array(IdSchema, { minItems: 1, maxItems: 24 }),
  /** provider/id，例如 deepseek/deepseek-flash。 */
  model: text(100),
  date: Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", description: "日期写成 YYYY-MM-DD" }),
});
export type Confirmation = Static<typeof ConfirmationSchema>;

export const TopicSchema = object({
  id: TopicIdSchema,
  title: text(80),
  /** outline 只有名称、知识点、先修和来源；complete 的内容必须齐全。 */
  status: Type.Enum(["outline", "complete"]),
  /** 预计用时，分钟。 */
  minutes: Type.Integer({ minimum: 5, maximum: 60 }),
  summary: Type.Optional(text(300)),
  /** 直接先修，仅决定学习资格。 */
  prerequisites: Type.Array(TopicIdSchema, { maxItems: 12 }),
  encompassings: Type.Optional(Type.Array(EncompassingSchema, { maxItems: 500 })),
  sources: Type.Array(SourceUseSchema, { maxItems: 20 }),
  /** 写课备注：范围约束、题型安排等，不给学习者看，也不进内容哈希。 */
  notes: Type.Optional(text(5_000)),
  intro: Type.Optional(ContentInputSchema),
  wrapup: Type.Optional(ContentInputSchema),
  data: Type.Optional(Type.Record(NameSchema, FixtureSchema)),
  kps: Type.Array(KpSchema, { minItems: 1, maxItems: 8 }),
  /** manual 作答位的模型核对记录，由 course:confirm 写入，每道题一条。 */
  verified: Type.Optional(Type.Array(ConfirmationSchema, { maxItems: 500 })),
});
export type Topic = Static<typeof TopicSchema>;
