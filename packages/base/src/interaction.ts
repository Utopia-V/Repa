/**
 * 交互词汇：向用户要结构化输入时，说明怎样写、作答长什么样。
 *
 * 底座只管这一件事：把内容块和作答位交给前端，收回原样的作答，查结构。作答怎样解释、算不算数、
 * 要不要记下来，都由调用方决定，例如健康插件记下当天的打卡，写作插件按用户挑的方案继续，Agent 拿到澄清问题的回答。
 * 插件自己的界面把 Item 等嵌进自己的契约，对话里的询问走底座的 ask.*。
 *
 * 版本规则：词汇只增不改。已有类型名、字段含义、默认值和作答格式不改；新增作答位、影响含义的内容块
 * 和忽略后会改变含义的特性进 Item.requires；可以忽略的呈现提示直接加。每次新增把
 * INTERACTION_VOCABULARY 加一。发送方按当前版本严格校验，多余字段直接拒绝；前端用 readItem
 * 宽松读取，丢掉不认识的字段，再按 requires 决定能不能作答。
 *
 * 本文件经 @repa/base/protocol 与 @repa/base/plugin 导出，保持浏览器可用。
 */
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { object, RepaFault } from "./schema.js";

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

/** Item、小问、选项、单元格等的标识，在所属的 Item 内唯一即可。 */
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
// 内容块：说明、小问和选项共用
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

/** 代码块。startLine 有值时显示行号并从该值起算，说明里可以说“第 3 行”。 */
export const CodeBlockSchema = object({
  type: Type.Literal("code"),
  language: Type.String({ maxLength: 32 }),
  text: Type.String({ maxLength: 20_000 }),
  startLine: Type.Optional(Type.Integer({ minimum: 1 })),
  highlight: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 200 })),
});

/**
 * 图像。asset 是内容所属插件里的不可变资产 id，读取入口另定。
 * 默认视为影响内容的含义；decorative 为 true 时，不能显示图像的前端可以只给 alt。
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
// 作答位：一次询问由说明和若干作答位组成，每种作答位只有一种作答形状
// ---------------------------------------------------------------------------

const slotBase = {
  id,
  /** 这一小问的说明；省略时只看 Item.body。 */
  prompt: Type.Optional(ContentSchema),
  /** 简短名称，供读屏和定位问题。 */
  label: Type.Optional(Type.String({ maxLength: 80 })),
  /** 默认必答。可选的小问不答也能提交。 */
  optional: Type.Optional(Type.Boolean()),
};

// 选项按给出的顺序显示，前端不重排。
const OptionSchema = object({
  id,
  content: ContentSchema,
  label: Type.Optional(Type.String({ maxLength: 80 })),
});

/** 选择：单选、多选、是否、下拉，例如写作时让用户挑一个方案。other 允许用户自填“其他”；layout 只是呈现提示。 */
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
 * 文本输入：短文本、数值、日期、表达式、多行说明。format 只是输入提示（integer、number、math、date），
 * 不认识的 format 按普通文本框处理；quick 是一键填入的固定文字，例如“不适用”，不受 format 限制。作答永远是原样文本。
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
 * 排列：给候选排序，或从候选里挑出一部分再排好，例如写作时排定章节顺序。items 按给出的顺序作为初始顺序，前端不重排。
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
 * 表格：逐行填写的记录，例如一周里每天的睡眠时长和是否服药。行列由调用方给定；单元格要么是固定文字
 * （Markdown 行内子集），要么是文本或选择输入格。第一版不能增删行列。
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

/** 代码编辑：在给出的起始内容上修改一段代码或配置，前端只交编辑后的文本。 */
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
// Item：一次询问交给前端的内容
// ---------------------------------------------------------------------------

/**
 * Item 只含可以给用户看的部分；调用方自己保留的数据，例如解释作答用的规则，不放进来。
 * id 是调用方内稳定的标识；Agent 临时提的问题由底座生成 ask:<uuid>。
 * version 是调用方对完整定义（包括它自己保留的部分）经 contentVersion 得到的哈希；没有私有部分时对公开内容计算。
 * requires 由 requiredCapabilities 从结构算出，不手写；前端缺任何一项，就不能把它显示成可以提交的表单。
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
/** 交给底座的 Item 可以不带 version 和 requires，由底座补上。 */
export type ItemDraft = Omit<Item, "version" | "requires">;

// ---------------------------------------------------------------------------
// 作答：前端提交原样输入，不去空白、不改大小写，也不做别的处理
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

/** 一次作答。answers 以作答位 id 为键，缺键表示这一小问没答。 */
export const ItemResponseSchema = object({
  item: reference,
  answers: Type.Record(Type.String(), AnswerSchema),
});
export type ItemResponse = Static<typeof ItemResponseSchema>;

/** 作答的结构或格式问题；slot 指向出问题的小问。 */
const ProblemSchema = object({ slot: Type.Optional(id), message: Type.String({ maxLength: 500 }) });
export type Problem = Static<typeof ProblemSchema>;

// ---------------------------------------------------------------------------
// 对话里的询问：ask.request、ask.reply、ask.closed
// ---------------------------------------------------------------------------

// 来源里的会话、工具调用 id 由运行时和模型服务生成，格式不归词汇管，只要求非空。
const originId = Type.String({ minLength: 1, maxLength: 200 });

/**
 * 通知 ask.request：只发给发起这次 Agent 运行的连接。origin.callId 让前端把卡片放在对应工具调用的位置。
 */
export const AskRequestSchema = object({
  id,
  origin: object({
    kind: Type.Union([Type.Literal("agent"), Type.Literal("plugin")]),
    pluginId: Type.Optional(originId),
    sessionId: Type.Optional(originId),
    callId: Type.Optional(originId),
  }),
  item: ItemSchema,
});
export type AskRequest = Static<typeof AskRequestSchema>;
// ask.request 的信封：除 Item 外都严格校验，Item 交给 readItem。
const AskEnvelopeSchema = object({ ...AskRequestSchema.properties, item: Type.Unknown() });

/**
 * 通知 ask.closed：询问已经结束，前端收起卡片。answered 为提交或拒绝作答，cancelled 为前端关闭或无法显示，
 * aborted 为运行中止，closed 为空间关闭。断线时连接已经不在，不再通知。默认不设超时。
 */
export const AskClosedSchema = object({
  id,
  reason: Type.Union([Type.Literal("answered"), Type.Literal("cancelled"), Type.Literal("aborted"), Type.Literal("closed")]),
});
export type AskClosed = Static<typeof AskClosedSchema>;

/**
 * 方法 ask.reply：submit 交作答；decline 不按卡片作答，可以附一句话交回模型；cancel 直接关掉；
 * unsupported 表示前端无法渲染（正常情况下底座已按能力拦住）。response 只随 submit，message 只随 decline。
 * 结果：submit 为 AskSubmitResult，其他动作为 null。
 */
export const AskReplyParamsSchema = object({
  id,
  action: Type.Union([Type.Literal("submit"), Type.Literal("decline"), Type.Literal("cancel"), Type.Literal("unsupported")]),
  response: Type.Optional(ItemResponseSchema),
  message: Type.Optional(Type.String({ maxLength: 4_000 })),
});
export type AskReplyParams = Static<typeof AskReplyParamsSchema>;

/**
 * 一次提交的结果，调用方只能二选一：invalid 是格式不对，交回问题列表，卡片保持打开，用户改好可以再交；
 * accepted 是接受了这次作答，可以附一段内容显示在卡片上，例如“已记下今天的打卡”，然后卡片关闭。
 * 怎样解释作答、要不要记下来，都由调用方自己决定，不在协议里。
 */
export const AskSubmitResultSchema = Type.Union([
  object({
    status: Type.Literal("invalid"),
    problems: Type.Array(ProblemSchema, { minItems: 1, maxItems: 24 }),
  }),
  object({
    status: Type.Literal("accepted"),
    message: Type.Optional(ContentSchema),
  }),
]);
export type AskSubmitResult = Static<typeof AskSubmitResultSchema>;
export const AskReplyResultSchema = Type.Union([AskSubmitResultSchema, Type.Null()]);
export type AskReplyResult = Static<typeof AskReplyResultSchema>;

// ---------------------------------------------------------------------------
// 纯函数：浏览器与 Node 都可用
// ---------------------------------------------------------------------------

const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

function notCanonical(path: string): RepaFault {
  return new RepaFault("invalid_definition", "定义里有不能规范化的值，只能使用 JSON 数据", { path });
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
 * 完整定义经 RFC 8785 规范化后取 SHA-256，返回 "sha256:<hex>"。所有插件用同一个实现，版本才可比。
 * 调用方决定 definition 里放什么：通常是用户看到的内容加上它自己保留、会影响含义的部分；
 * 只看得到公开内容的场合（Agent 临时提的问题）对公开内容计算。
 */
export async function contentVersion(definition: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(definition, ""));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function contentNeeds(content: Content | undefined, needs: Set<string>): void {
  for (const block of content ?? []) {
    // 装饰图不影响含义：不能显示图像的前端只给 alt 也能作答。
    if (block.type === "image" && block.decorative === true) continue;
    needs.add(`block.${block.type}`);
    if (block.type === "markdown" && block.math === true) needs.add("markdown.math");
  }
}

/**
 * 从 Item 的结构推出渲染它必须理解的能力：用到的作答位、内容块，以及 markdown.math。
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

// ask.reply 的 invalid 结果最多带 24 条问题。
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
 * 结构检查，不解释作答的含义：作答对应的 Item 和版本一致，作答类型与作答位一致；选项、块、行列 id 存在且不重复；
 * 选择个数、排列是否完整、缩进长度和范围、文本长度和代码行数都在声明的范围内；必答位不缺。
 * format 的含义由调用方判断，这里不查。失败时返回 problems，调用方可以原样作为 invalid 交回前端。
 */
export function checkResponse(item: Item, response: ItemResponse): CheckResult {
  if (!Value.Check(ItemResponseSchema, response)) {
    return { ok: false, problems: [{ message: "作答不符合接口要求" }] };
  }
  if (response.item.id !== item.id || response.item.version !== item.version) {
    return { ok: false, problems: [{ message: "作答对应的内容已经变化，请重新读取后作答" }] };
  }
  const problems: Problem[] = [];
  const slots = new Map(item.slots.map((slot) => [slot.id, slot]));
  for (const key of Object.keys(response.answers)) {
    if (!slots.has(key)) problems.push({ message: "作答里有不存在的小问" });
  }
  for (const slot of item.slots) {
    const report = (message: string) => problems.push({ slot: slot.id, message });
    const answer = own(response.answers, slot.id);
    if (answer === undefined) {
      if (slot.optional !== true) report("这一小问还没有作答");
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
      if (count < min) report(multiple ? `至少选择 ${min} 项` : "请选择一项");
      if (count > max) report(multiple ? `最多选择 ${max} 项` : "只能选择一项");
    } else if (slot.type === "text" && answer.type === "text") {
      if (answer.text === "") {
        if (slot.optional !== true) report("这一小问还没有作答");
      } else if (slot.maxLength !== undefined && characters(answer.text) > slot.maxLength) {
        report(`不能超过 ${slot.maxLength} 个字`);
      }
    } else if (slot.type === "order" && answer.type === "order") {
      const known = new Set(slot.items.map((block) => block.id));
      if (answer.items.some((block) => !known.has(block))) report("排列里有不存在的块");
      if (new Set(answer.items).size !== answer.items.length) report("同一个块排了不止一次");
      if (slot.partial !== true && answer.items.length < slot.items.length) report("还有块没有排进去");
      if (slot.partial === true && answer.items.length === 0 && slot.optional !== true) report("这一小问还没有作答");
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
      if (missing > 0) report(`表格还有 ${missing} 格没有填写`);
    } else if (slot.type === "code" && answer.type === "code") {
      if (answer.code === "") {
        if (slot.optional !== true) report("这一小问还没有作答");
      } else if (slot.maxLines !== undefined && lineCount(answer.code) > slot.maxLines) {
        report(`代码不能超过 ${slot.maxLines} 行`);
      }
    }
  }
  if (problems.length === 0) return { ok: true };
  return { ok: false, problems: problems.slice(0, MAX_PROBLEMS) };
}

// ---------------------------------------------------------------------------
// 前端的宽松读取
// ---------------------------------------------------------------------------
// 词汇只增不改：新版本可以给 Item 加可选字段，也可以加作答位、内容块这类必须理解的特性，
// 后者一定进 requires。旧前端如果严格校验，词汇每加一个字段就读不了；所以前端读的时候认识的字段照常查类型，
// 不认识的字段丢掉，读不懂的部分连同它所在的那一项丢掉，再按 requires 决定能不能作答。
// 长度、个数这类上限读取时不查：放宽上限也属于必须理解的变化，同样经 requires 拦下。

/** 读取结果。失败时 path 指向第一个读不了的位置，例如 /slots/0/options。 */
export type ReadResult<T> = { ok: true; value: T } | { ok: false; path: string };

// TypeBox 1.x 的 schema 就是普通的 JSON Schema；读取只用到下面这些关键字。
interface JsonSchema {
  type?: string;
  const?: unknown;
  anyOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  patternProperties?: Record<string, JsonSchema>;
  items?: JsonSchema;
}

// TSchema 的类型不暴露这些关键字；只在读取的入口转换一次。
const json = (schema: unknown) => schema as JsonSchema;

/** 读不懂、要丢掉的值。它向上传到能丢掉它的那一层：可选字段、数组元素或映射里的一项。 */
const DROP = Symbol("drop");

class Unreadable extends Error {
  constructor(readonly path: string) {
    super(`读不了 ${path || "/"}`);
  }
}

interface ReadContext {
  /** 读 Item 时收集读不懂的作答位和内容块对应的能力名；读别的内容时没有。 */
  needs?: Set<string>;
}

/** 联合各分支的判别值。Type.Optional 会复制 schema，所以按判别值认出联合，不比对象身份。 */
function discriminants(union: JsonSchema): string {
  return (union.anyOf ?? []).map((variant) => String(variant.const ?? variant.properties?.type?.const)).join("|");
}

const BLOCK_TYPES = discriminants(json(BlockSchema));
const SLOT_TYPES = discriminants(json(SlotSchema));

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function matches(type: string | undefined, value: unknown): boolean {
  switch (type) {
    case undefined: return true;
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    case "array": return Array.isArray(value);
    case "object": return plain(value);
    default: return false;
  }
}

/** 某个分支是否认领这个值：有判别字段时看判别值，没有时看必需字段是否都在。 */
function claims(variant: JsonSchema, value: Record<string, unknown>): boolean {
  const required = variant.required ?? [];
  const keys = required.filter((key) => variant.properties?.[key]?.const !== undefined);
  if (keys.length > 0) return keys.every((key) => value[key] === variant.properties?.[key]?.const);
  return required.every((key) => Object.hasOwn(value, key));
}

function readUnion(schema: JsonSchema, value: unknown, path: string, context: ReadContext): unknown {
  const variants = schema.anyOf ?? [];
  if (variants.every((variant) => variant.const !== undefined)) {
    if (variants.some((variant) => variant.const === value)) return value;
    if (!variants.some((variant) => matches(variant.type, value))) throw new Unreadable(path);
    // 不认识的取值连同所在的一项丢掉，例如不认识的 layout 用默认布局。
    return DROP;
  }
  if (!plain(value)) throw new Unreadable(path);
  const claimed = variants.find((variant) => claims(variant, value));
  if (claimed !== undefined) return readValue(claimed, value, path, context);
  const type = value.type;
  const discriminated = variants.every((variant) => variant.properties?.type?.const !== undefined);
  // 有判别字段的联合，判别值不是字符串就是类型不对；是字符串而读不懂，才是新版本加的分支。
  if (discriminated && typeof type !== "string") throw new Unreadable(`${path}/type`);
  const signature = discriminants(schema);
  if (typeof type === "string" && signature === SLOT_TYPES && variants[0]?.properties?.id !== undefined) context.needs?.add(`slot.${type}`);
  if (typeof type === "string" && signature === BLOCK_TYPES) context.needs?.add(`block.${type}`);
  return DROP;
}

function readObject(schema: JsonSchema, value: unknown, path: string, context: ReadContext): unknown {
  if (!plain(value)) throw new Unreadable(path);
  const required = new Set(schema.required ?? []);
  const result: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    const member = Object.hasOwn(value, key) ? value[key] : undefined;
    if (member === undefined) {
      if (required.has(key)) throw new Unreadable(`${path}/${key}`);
      continue;
    }
    const read = readValue(property, member, `${path}/${key}`, context);
    if (read === DROP) {
      // 必需的部分读不懂，这一项整个读不懂。
      if (required.has(key)) return DROP;
      continue;
    }
    result[key] = read;
  }
  return result;
}

function readRecord(schema: JsonSchema, value: unknown, path: string, context: ReadContext): unknown {
  if (!plain(value)) throw new Unreadable(path);
  const [entrySchema] = Object.values(schema.patternProperties ?? {});
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const read = entrySchema === undefined ? entry : readValue(entrySchema, entry, `${path}/${key}`, context);
    if (read === DROP) continue;
    // 键来自外部 JSON，可能是 __proto__；按普通成员写入，不改原型。
    Object.defineProperty(result, key, { value: read, enumerable: true, writable: true, configurable: true });
  }
  return result;
}

function readValue(schema: JsonSchema, value: unknown, path: string, context: ReadContext): unknown {
  if (schema.anyOf !== undefined) return readUnion(schema, value, path, context);
  if (schema.const !== undefined) {
    if (value !== schema.const) throw new Unreadable(path);
    return value;
  }
  if (schema.type === "object") {
    return schema.patternProperties === undefined ? readObject(schema, value, path, context) : readRecord(schema, value, path, context);
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Unreadable(path);
    const result: unknown[] = [];
    value.forEach((entry: unknown, index) => {
      const read = schema.items === undefined ? entry : readValue(schema.items, entry, `${path}/${index}`, context);
      if (read !== DROP) result.push(read);
    });
    return result;
  }
  if (!matches(schema.type, value)) throw new Unreadable(path);
  return value;
}

function read<T>(schema: unknown, value: unknown, context: ReadContext = {}): ReadResult<T> {
  try {
    const result = readValue(json(schema), value, "", context);
    return result === DROP ? { ok: false, path: "" } : { ok: true, value: result as T };
  } catch (error) {
    if (error instanceof Unreadable) return { ok: false, path: error.path };
    throw error;
  }
}

/**
 * 前端读取 Item，例如插件方法返回的内容。认识的字段照常查类型，类型不对时读取失败；不认识的字段丢掉。
 * 读不懂的作答位和内容块也丢掉，并把 slot.<type>、block.<type> 补进 requires；requires 还并上从结构算出的能力。
 * 所以词汇加了可以忽略的字段，旧前端照常显示；加了必须理解的特性，canRender 判为不能作答。
 */
export function readItem(value: unknown): ReadResult<Item> {
  const needs = new Set<string>();
  const result = read<Item>(ItemSchema, value, { needs });
  if (!result.ok) return result;
  const requires = [...new Set([...result.value.requires, ...requiredCapabilities(result.value), ...needs])].sort();
  return { ok: true, value: { ...result.value, requires } };
}

/** 读取 ask.reply 的结果：invalid 的问题列表和 accepted 附的内容块同样宽松读取。 */
export function readAskReplyResult(value: unknown): ReadResult<AskReplyResult> {
  if (value === null) return { ok: true, value: null };
  return read<AskSubmitResult>(AskSubmitResultSchema, value);
}

/** 读取 ask.request：信封仍严格校验，里面的 Item 按 readItem 读取。 */
export function readAskRequest(value: unknown): ReadResult<AskRequest> {
  if (!Value.Check(AskEnvelopeSchema, value)) return { ok: false, path: "" };
  const item = readItem(value.item);
  if (!item.ok) return { ok: false, path: `/item${item.path}` };
  return { ok: true, value: { ...value, item: item.value } };
}
