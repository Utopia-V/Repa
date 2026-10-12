/**
 * 交互词汇的临时副本，逐段复制自 @repa/base 的 src/interaction.ts（interaction-protocol 分支，提交 040bae4f2）。
 *
 * 那个分支合进 dev 之前，学习包先用这份副本；本包其他文件只从这里导入交互词汇。合并以后，把本文件的内容换成
 *   export * from "@repa/base/protocol";
 * 并在 package.json 里加上对 @repa/base 的依赖，其余代码不用改。
 *
 * 只复制了课程检查用到的部分：内容块、作答位、Item、作答、提交结果与反馈，以及 contentVersion、
 * requiredCapabilities、canRender、checkResponse。对话询问（ask.*）和前端的宽松读取没有复制。
 * 下面除了 object 与 RepaFault 两处本地替身，其余与原文件相同，不要在这里单独修改。
 */

/**
 * 交互词汇：题面怎样写、作答长什么样、提交结果和反馈怎样回。
 *
 * 词汇只描述交卷前可以给学生看的东西和交卷后已释放的反馈；答案、评分规则、解析和学习证据都留在插件。
 * 任务区和概念卡由插件把 Item 等嵌进自己的契约，对话里的询问走底座的 ask.*。
 *
 * 版本规则：词汇只增不改。已有类型名、字段含义、默认值和作答格式不改；新增作答位、影响题意的内容块
 * 和忽略后会改变题意的特性进 Item.requires；可以忽略的呈现提示直接加。每次新增把
 * INTERACTION_VOCABULARY 加一。发送方按当前版本严格校验，多余字段直接拒绝；前端用 readItem、readFeedback
 * 宽松读取，丢掉不认识的字段，再按 requires 决定能不能作答。
 *
 * 本文件经 @repa/base/protocol 与 @repa/base/plugin 导出，保持浏览器可用。
 */
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

// 以下两项在底座里来自 ./schema.js；副本里放同样的本地替身。
const object = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

class RepaFault extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = "RepaFault";
  }
}

/** 词汇版本。判断能否渲染不比版本号，比 Item.requires。 */
export const INTERACTION_VOCABULARY = 1;

/**
 * 第一版的能力名。以后新增的必须理解的特性按 "<所属>.<特性>" 命名，例如 "table.dynamicRows"。
 * markdown.math 表示 Markdown 块里的 $…$、$$…$$ 按 TeX 排版。
 */
export const INTERACTION_CAPABILITIES = [
  "slot.choice", "slot.text", "slot.order", "slot.table", "slot.code",
  "block.markdown", "block.code", "block.image",
  "markdown.math",
] as const;
export type InteractionCapability = (typeof INTERACTION_CAPABILITIES)[number];

/** 题目、小问、选项、单元格等的标识，题内唯一即可。 */
const id = Type.String({ minLength: 1, maxLength: 120, pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$" });
const reference = object({ id, version: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }) });

/** 前端在 initialize 里声明能显示的作答位、内容块和特性。服务端按连接保存。 */
export const InteractionCapabilitiesSchema = object({
  // 只供诊断；能否渲染看 supports。
  vocabulary: Type.Integer({ minimum: 1 }),
  supports: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 200 }),
});
export type InteractionCapabilities = Static<typeof InteractionCapabilitiesSchema>;

// ---------------------------------------------------------------------------
// 内容块：题面、小问、选项和反馈共用
// ---------------------------------------------------------------------------

/**
 * Repa Markdown：CommonMark 加 GFM 表格和删除线。原始 HTML 按文本显示，不用 ![]() 插图，
 * 链接只认 https: 和 repa:。repa:<kind>/<id> 指向内容所属插件的对象，前端不认识的 kind 按普通文字显示。
 * math 为 true 时 $…$、$$…$$ 按 TeX 排版，否则 $ 就是普通字符。
 */
export const MarkdownBlockSchema = object({
  type: Type.Literal("markdown"),
  text: Type.String({ maxLength: 20_000 }),
  math: Type.Optional(Type.Boolean()),
});

/** 代码块。startLine 有值时显示行号并从该值起算，题目可以说“第 3 行”。 */
export const CodeBlockSchema = object({
  type: Type.Literal("code"),
  language: Type.String({ maxLength: 32 }),
  text: Type.String({ maxLength: 20_000 }),
  startLine: Type.Optional(Type.Integer({ minimum: 1 })),
  highlight: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 200 })),
});

/**
 * 图像。asset 是内容所属插件里的不可变资产 id，读取入口另定。
 * 默认视为影响题意；decorative 为 true 时，不能显示图像的前端可以只给 alt。
 */
export const ImageBlockSchema = object({
  type: Type.Literal("image"),
  asset: id,
  alt: Type.String({ minLength: 1, maxLength: 2_000 }),
  decorative: Type.Optional(Type.Boolean()),
});

export const BlockSchema = Type.Union([MarkdownBlockSchema, CodeBlockSchema, ImageBlockSchema]);
export type Block = Static<typeof BlockSchema>;
export const ContentSchema = Type.Array(BlockSchema, { maxItems: 64 });
export type Content = Static<typeof ContentSchema>;

// ---------------------------------------------------------------------------
// 作答位：一道题由题面和若干作答位组成，每种作答位只有一种作答形状
// ---------------------------------------------------------------------------

const slotBase = {
  id,
  /** 这一小问的题面；省略时只看 Item.body。 */
  prompt: Type.Optional(ContentSchema),
  /** 简短名称，供读屏和反馈定位。 */
  label: Type.Optional(Type.String({ maxLength: 80 })),
  /** 默认必答。可选的小问不答也能提交。 */
  optional: Type.Optional(Type.Boolean()),
};

// 选项 id 不能暗示对错；顺序由后端决定，前端不重排。
const OptionSchema = object({
  id,
  content: ContentSchema,
  label: Type.Optional(Type.String({ maxLength: 80 })),
});

/** 选择：单选、多选、判断、下拉。other 允许自填“其他”，主要给询问用；layout 只是呈现提示。 */
export const ChoiceSlotSchema = object({
  ...slotBase,
  type: Type.Literal("choice"),
  options: Type.Array(OptionSchema, { minItems: 1, maxItems: 26 }),
  multiple: Type.Optional(Type.Boolean()),
  minSelected: Type.Optional(Type.Integer({ minimum: 0 })),
  maxSelected: Type.Optional(Type.Integer({ minimum: 1 })),
  other: Type.Optional(object({ label: Type.String({ maxLength: 40 }) })),
  layout: Type.Optional(Type.Union([Type.Literal("list"), Type.Literal("row"), Type.Literal("menu")])),
});

/**
 * 文本输入：短答、数值、表达式、逐行输出、开放说明。format 只是输入提示（integer、number、math、date），
 * 不认识的 format 按普通文本框处理；quick 是一键填入的固定文字，不受 format 限制。作答永远是原样文本。
 */
export const TextSlotSchema = object({
  ...slotBase,
  type: Type.Literal("text"),
  lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 40 })),
  maxLength: Type.Optional(Type.Integer({ minimum: 1, maximum: 20_000 })),
  format: Type.Optional(Type.String({ maxLength: 32 })),
  placeholder: Type.Optional(Type.String({ maxLength: 120 })),
  suffix: Type.Optional(Type.String({ maxLength: 20 })),
  quick: Type.Optional(Type.Array(Type.String({ maxLength: 40 }), { maxItems: 8 })),
});

/**
 * 排列：排序、Parsons、从候选里挑出并排好。items 的交付顺序就是初始顺序，必须由后端整体打乱并记进尝试。
 * partial 为 true 时可以留下不用的块；indent 是允许的最大缩进层级，省略则不缩进。
 */
export const OrderSlotSchema = object({
  ...slotBase,
  type: Type.Literal("order"),
  items: Type.Array(OptionSchema, { minItems: 2, maxItems: 40 }),
  partial: Type.Optional(Type.Boolean()),
  indent: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
});

const TextCellSchema = object({
  type: Type.Literal("text"),
  format: Type.Optional(Type.String({ maxLength: 32 })),
  maxLength: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
  lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  quick: Type.Optional(Type.Array(Type.String({ maxLength: 40 }), { maxItems: 8 })),
});
const ChoiceCellSchema = object({
  type: Type.Literal("choice"),
  options: Type.Array(object({ id, label: Type.String({ maxLength: 80 }) }), { minItems: 2, maxItems: 12 }),
});

/**
 * 表格：追踪表、逐行掩码、WWPD。行列由题目给定；单元格要么是固定文字（Markdown 行内子集），
 * 要么是文本或选择输入格。第一版不能增删行列。
 */
export const TableSlotSchema = object({
  ...slotBase,
  type: Type.Literal("table"),
  columns: Type.Array(object({ id, header: Type.String({ maxLength: 200 }) }), { minItems: 1, maxItems: 12 }),
  rows: Type.Array(object({
    id,
    header: Type.Optional(Type.String({ maxLength: 500 })),
    cells: Type.Record(Type.String(), Type.Union([
      object({ value: Type.String({ maxLength: 500 }) }),
      object({ input: Type.Union([TextCellSchema, ChoiceCellSchema]) }),
    ])),
  }), { minItems: 1, maxItems: 60 }),
});

/** 代码编辑：小改代码、骨架代码加测试。运行和判分在插件的隔离环境里，前端只交代码。 */
export const CodeSlotSchema = object({
  ...slotBase,
  type: Type.Literal("code"),
  language: Type.String({ maxLength: 32 }),
  starter: Type.String({ maxLength: 50_000 }),
  maxLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
});

export const SlotSchema = Type.Union([ChoiceSlotSchema, TextSlotSchema, OrderSlotSchema, TableSlotSchema, CodeSlotSchema]);
export type Slot = Static<typeof SlotSchema>;

// ---------------------------------------------------------------------------
// 题目：只含交卷前可以给学生看的部分
// ---------------------------------------------------------------------------

/**
 * id 是插件内稳定的题目标识；Agent 临时出的题由底座生成 ask:<uuid>。
 * version 是完整题目定义（公开部分、答案、评分规则、解析、测试）经 contentVersion 得到的哈希。
 * requires 由 requiredCapabilities 从结构算出，不手写；前端缺任何一项，就不能把这道题显示成可提交的题。
 * 0 个作答位表示只读内容。
 */
export const ItemSchema = object({
  id,
  version: reference.properties.version,
  requires: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 32 }),
  title: Type.Optional(Type.String({ maxLength: 200 })),
  body: ContentSchema,
  slots: Type.Array(SlotSchema, { maxItems: 24 }),
});
export type Item = Static<typeof ItemSchema>;
/** 交给底座的题可以不带 version 和 requires，由底座补上。 */
export type ItemDraft = Omit<Item, "version" | "requires">;

// ---------------------------------------------------------------------------
// 作答：前端提交原样输入，不去空白、不改大小写、不判断对错、不带分数
// ---------------------------------------------------------------------------

export const ChoiceAnswerSchema = object({
  type: Type.Literal("choice"),
  selected: Type.Array(id, { maxItems: 26 }),
  other: Type.Optional(Type.String({ maxLength: 2_000 })),
});
export const TextAnswerSchema = object({
  type: Type.Literal("text"),
  text: Type.String({ maxLength: 20_000 }),
});
/** items 只含用到的块；indents 与 items 等长，仅在 OrderSlot.indent 存在时出现。 */
export const OrderAnswerSchema = object({
  type: Type.Literal("order"),
  items: Type.Array(id, { maxItems: 40 }),
  indents: Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: 8 }), { maxItems: 40 })),
});
/** cells[rowId][columnId]，只含输入格。 */
export const TableAnswerSchema = object({
  type: Type.Literal("table"),
  cells: Type.Record(Type.String(), Type.Record(Type.String(), Type.Union([TextAnswerSchema, ChoiceAnswerSchema]))),
});
export const CodeAnswerSchema = object({
  type: Type.Literal("code"),
  code: Type.String({ maxLength: 50_000 }),
});
export const AnswerSchema = Type.Union([ChoiceAnswerSchema, TextAnswerSchema, OrderAnswerSchema, TableAnswerSchema, CodeAnswerSchema]);
export type Answer = Static<typeof AnswerSchema>;

/**
 * 一道题的作答。answers 以作答位 id 为键，缺键表示这一小问没答。
 * dontKnow 表示学习者明确说“不会”：此时可以不填任何作答位，checkResponse 不再要求必答位。
 */
export const ItemResponseSchema = object({
  item: reference,
  answers: Type.Record(Type.String(), AnswerSchema),
  dontKnow: Type.Optional(Type.Literal(true)),
});
export type ItemResponse = Static<typeof ItemResponseSchema>;

// ---------------------------------------------------------------------------
// 提交结果与反馈
// ---------------------------------------------------------------------------

// ungraded：本来就不判；pending：已保存，判分还没完成。
const VerdictSchema = Type.Union([
  Type.Literal("correct"), Type.Literal("partial"), Type.Literal("incorrect"),
  Type.Literal("ungraded"), Type.Literal("pending"),
]);
const ScoreSchema = object({ earned: Type.Number({ minimum: 0 }), max: Type.Number({ minimum: 0 }) });

export const SlotFeedbackSchema = object({
  verdict: VerdictSchema,
  score: Type.Optional(ScoreSchema),
  message: Type.Optional(ContentSchema),
  /** 参考答案，用作答格式表示；只在插件决定释放时出现。 */
  expected: Type.Optional(AnswerSchema),
  /** 选项、单元格（"rowId/columnId"）或排列位置级的标记。 */
  marks: Type.Optional(Type.Record(Type.String(), Type.Union([Type.Literal("correct"), Type.Literal("incorrect"), Type.Literal("missed")]))),
  /** 代码题的用例结果；hidden 的用例只报告结果，不给输入和期望。 */
  tests: Type.Optional(Type.Array(object({
    name: Type.String({ maxLength: 200 }),
    result: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("error"), Type.Literal("timeout")]),
    hidden: Type.Optional(Type.Boolean()),
    detail: Type.Optional(ContentSchema),
  }), { maxItems: 100 })),
  /** 按评分要点给的反馈。unsure 表示判分方没有把握，不等于学生错。 */
  criteria: Type.Optional(Type.Array(object({
    label: Type.String({ maxLength: 200 }),
    met: Type.Union([Type.Literal("yes"), Type.Literal("no"), Type.Literal("unsure")]),
    comment: Type.Optional(Type.String({ maxLength: 2_000 })),
  }), { maxItems: 20 })),
});

/** judge 为 model 时，界面标明模型反馈仅供参考；它不更新学习状态，由插件保证。 */
export const FeedbackSchema = object({
  item: reference,
  verdict: VerdictSchema,
  judge: Type.Optional(Type.Union([Type.Literal("rule"), Type.Literal("tests"), Type.Literal("model"), Type.Literal("person")])),
  score: Type.Optional(ScoreSchema),
  message: Type.Optional(ContentSchema),
  slots: Type.Optional(Type.Record(Type.String(), SlotFeedbackSchema)),
});
export type Feedback = Static<typeof FeedbackSchema>;

/** 结构或格式问题；slot 指向出问题的小问。 */
const ProblemSchema = object({ slot: Type.Optional(id), message: Type.String({ maxLength: 500 }) });
export type Problem = Static<typeof ProblemSchema>;

/**
 * rejected：格式不合要求，没有记为作答，改好可以再交；只返回问题列表，不透露其他小问的对错。
 * recorded：已经记为一次作答。练习时通常带 feedback，测验交卷前不带。
 */
export const SubmitResultSchema = Type.Union([
  object({
    status: Type.Literal("rejected"),
    problems: Type.Array(ProblemSchema, { minItems: 1, maxItems: 24 }),
  }),
  object({
    status: Type.Literal("recorded"),
    feedback: Type.Optional(FeedbackSchema),
  }),
]);
export type SubmitResult = Static<typeof SubmitResultSchema>;

// 纯函数：浏览器与 Node 都可用
// ---------------------------------------------------------------------------

const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

function notCanonical(path: string): RepaFault {
  return new RepaFault("invalid_definition", "题目定义里有不能规范化的值，只能使用 JSON 数据", { path });
}

/**
 * RFC 8785（JCS）规范化：对象成员按名称的 UTF-16 码元排序，数字按 ECMAScript 的方式输出，
 * 字符串只转义引号、反斜杠和控制字符。值为 undefined 的对象成员视为不存在，与 JSON.stringify 一致。
 */
function canonical(value: unknown, path: string): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw notCanonical(path);
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    // I-JSON 不允许孤立的代理码元，JCS 以 I-JSON 为前提。
    if (LONE_SURROGATE.test(value)) throw notCanonical(path);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index) || value[index] === undefined) throw notCanonical(`${path}/${index}`);
      items.push(canonical(value[index], `${path}/${index}`));
    }
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw notCanonical(path);
    const members: string[] = [];
    // 默认排序按 UTF-16 码元比较，正是 JCS 规定的顺序。
    for (const key of Object.keys(value).sort()) {
      const member: unknown = (value as Record<string, unknown>)[key];
      if (member === undefined) continue;
      if (LONE_SURROGATE.test(key)) throw notCanonical(`${path}/${key}`);
      members.push(`${JSON.stringify(key)}:${canonical(member, `${path}/${key}`)}`);
    }
    return `{${members.join(",")}}`;
  }
  throw notCanonical(path);
}

/**
 * 完整题目定义经 RFC 8785 规范化后取 SHA-256，返回 "sha256:<hex>"。所有插件用同一个实现，版本才可比。
 * 进哈希的是学生看到什么、怎样判：公开部分、答案、评分规则、解析和测试；知识点归属、难度、标签和交付时的打乱顺序
 * 不放进 definition。只看得到公开内容的场合（Agent 的临时题）对公开内容计算。
 */
export async function contentVersion(definition: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(definition, ""));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function contentNeeds(content: Content | undefined, needs: Set<string>): void {
  for (const block of content ?? []) {
    // 装饰图不影响题意：不能显示图像的前端只给 alt 也能作答。
    if (block.type === "image" && block.decorative === true) continue;
    needs.add(`block.${block.type}`);
    if (block.type === "markdown" && block.math === true) needs.add("markdown.math");
  }
}

/**
 * 从题目结构推出渲染这道题必须理解的能力：用到的作答位、内容块，以及 markdown.math。
 * format、layout、placeholder、quick、other 这些可以忽略的提示不进 requires。结果排序去重。
 */
export function requiredCapabilities(item: ItemDraft): string[] {
  const needs = new Set<string>();
  contentNeeds(item.body, needs);
  for (const slot of item.slots) {
    needs.add(`slot.${slot.type}`);
    contentNeeds(slot.prompt, needs);
    if (slot.type === "choice") for (const option of slot.options) contentNeeds(option.content, needs);
    if (slot.type === "order") for (const block of slot.items) contentNeeds(block.content, needs);
  }
  return [...needs].sort();
}

/** item.requires 是否全在前端声明的 supports 里。没有声明时只能渲染不需要任何能力的内容。 */
export function canRender(capabilities: InteractionCapabilities | undefined, item: Pick<Item, "requires">): boolean {
  const supports = new Set(capabilities?.supports ?? []);
  return item.requires.every((name) => supports.has(name));
}

export type CheckResult = { ok: true } | { ok: false; problems: Problem[] };

// SubmitResult 最多带 24 条问题。
const MAX_PROBLEMS = 24;

function characters(text: string): number {
  return [...text].length;
}

/** 代码行数；末尾的换行不算新的一行。 */
function lineCount(code: string): number {
  const trimmed = code.replace(/[\r\n]+$/u, "");
  return trimmed === "" ? 0 : trimmed.split(/\r\n|\r|\n/u).length;
}

function short(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

// 作答和单元格的键来自外部 JSON，只读自有成员，不经原型链。
function own<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * 结构检查，与判分无关：作答对应的题目和版本一致，作答类型与作答位一致；选项、块、行列 id 存在且不重复；
 * 选择个数、排列是否完整、缩进长度和范围、文本长度和代码行数都在声明的范围内；必答位不缺。
 * dontKnow 为 true 时不查必答和完整性，其余照查。format 的含义由插件判断，这里不查。
 * 失败时返回 problems，插件可以原样作为 rejected 结果交回前端。
 */
export function checkResponse(item: Item, response: ItemResponse): CheckResult {
  if (!Value.Check(ItemResponseSchema, response)) {
    return { ok: false, problems: [{ message: "作答不符合接口要求" }] };
  }
  if (response.item.id !== item.id || response.item.version !== item.version) {
    return { ok: false, problems: [{ message: "作答对应的题目已经变化，请重新读取题目后作答" }] };
  }
  const problems: Problem[] = [];
  const complete = response.dontKnow !== true;
  const slots = new Map(item.slots.map((slot) => [slot.id, slot]));
  for (const key of Object.keys(response.answers)) {
    if (!slots.has(key)) problems.push({ message: "作答里有题目中不存在的小问" });
  }
  for (const slot of item.slots) {
    const report = (message: string) => problems.push({ slot: slot.id, message });
    const answer = own(response.answers, slot.id);
    if (answer === undefined) {
      if (complete && slot.optional !== true) report("这一小问还没有作答");
      continue;
    }
    if (answer.type !== slot.type) {
      report("作答类型与小问不一致");
      continue;
    }
    if (slot.type === "choice" && answer.type === "choice") {
      const known = new Set(slot.options.map((option) => option.id));
      if (answer.selected.some((selected) => !known.has(selected))) report("选择了不存在的选项");
      if (new Set(answer.selected).size !== answer.selected.length) report("同一个选项选了不止一次");
      if (answer.other !== undefined && slot.other === undefined) report("这一小问不能自填");
      if (answer.other !== undefined && answer.other === "") report("自填内容是空的");
      // 不允许自填时上面已经报告，不再算进个数。
      const count = answer.selected.length + (answer.other === undefined || slot.other === undefined ? 0 : 1);
      const multiple = slot.multiple === true;
      const min = multiple ? slot.minSelected ?? 1 : 1;
      const max = multiple ? slot.maxSelected ?? slot.options.length + (slot.other === undefined ? 0 : 1) : 1;
      if (complete && count < min) report(multiple ? `至少选择 ${min} 项` : "请选择一项");
      if (count > max) report(multiple ? `最多选择 ${max} 项` : "只能选择一项");
    } else if (slot.type === "text" && answer.type === "text") {
      if (answer.text === "") {
        if (complete && slot.optional !== true) report("这一小问还没有作答");
      } else if (slot.maxLength !== undefined && characters(answer.text) > slot.maxLength) {
        report(`不能超过 ${slot.maxLength} 个字`);
      }
    } else if (slot.type === "order" && answer.type === "order") {
      const known = new Set(slot.items.map((block) => block.id));
      if (answer.items.some((block) => !known.has(block))) report("排列里有不存在的块");
      if (new Set(answer.items).size !== answer.items.length) report("同一个块排了不止一次");
      if (complete && slot.partial !== true && answer.items.length < slot.items.length) report("还有块没有排进去");
      if (complete && slot.partial === true && answer.items.length === 0 && slot.optional !== true) report("这一小问还没有作答");
      if (slot.indent === undefined) {
        if (answer.indents !== undefined) report("这一小问不需要缩进");
      } else if (answer.indents === undefined || answer.indents.length !== answer.items.length) {
        report("缩进与排列的块数不一致");
      } else if (answer.indents.some((indent) => indent > (slot.indent ?? 0))) {
        report(`缩进不能超过 ${slot.indent} 层`);
      }
    } else if (slot.type === "table" && answer.type === "table") {
      const columns = new Map(slot.columns.map((column) => [column.id, column]));
      const rows = new Map(slot.rows.map((row) => [row.id, row]));
      let missing = 0;
      for (const [rowId, cells] of Object.entries(answer.cells)) {
        const row = rows.get(rowId);
        if (row === undefined) {
          report("表格里没有作答中的某一行");
          continue;
        }
        for (const [columnId, value] of Object.entries(cells)) {
          const cell = own(row.cells, columnId);
          const where = `${short(row.header ?? row.id)} 行「${short(columns.get(columnId)?.header ?? columnId)}」`;
          if (cell === undefined || !("input" in cell)) {
            report(`${where}不需要填写`);
            continue;
          }
          const input = cell.input;
          if (value.type !== input.type) {
            report(`${where}的作答类型不对`);
          } else if (input.type === "choice" && value.type === "choice") {
            const known = new Set(input.options.map((option) => option.id));
            if (value.other !== undefined) report(`${where}不能自填`);
            if (value.selected.some((selected) => !known.has(selected))) report(`${where}选择了不存在的选项`);
            if (value.selected.length > 1) report(`${where}只能选择一项`);
          } else if (input.type === "text" && value.type === "text") {
            if (input.maxLength !== undefined && characters(value.text) > input.maxLength) report(`${where}不能超过 ${input.maxLength} 个字`);
          }
        }
      }
      for (const row of slot.rows) {
        for (const [columnId, cell] of Object.entries(row.cells)) {
          if (!("input" in cell)) continue;
          const filled = own(own(answer.cells, row.id), columnId);
          if (filled === undefined || (filled.type === "text" && filled.text === "") || (filled.type === "choice" && filled.selected.length === 0)) missing++;
        }
      }
      if (complete && missing > 0) report(`表格还有 ${missing} 格没有填写`);
    } else if (slot.type === "code" && answer.type === "code") {
      if (answer.code === "") {
        if (complete && slot.optional !== true) report("这一小问还没有作答");
      } else if (slot.maxLines !== undefined && lineCount(answer.code) > slot.maxLines) {
        report(`代码不能超过 ${slot.maxLines} 行`);
      }
    }
  }
  if (problems.length === 0) return { ok: true };
  return { ok: false, problems: problems.slice(0, MAX_PROBLEMS) };
}
