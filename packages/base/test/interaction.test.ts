import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  canRender,
  checkResponse,
  ContentSchema,
  contentVersion,
  INTERACTION_CAPABILITIES,
  INTERACTION_VOCABULARY,
  ItemSchema,
  readAskReplyResult,
  readItem,
  readLenient,
  type ReadFallback,
  requiredCapabilities,
  type Answer,
  type Item,
  type ItemDraft,
  type ItemResponse,
} from "../src/interaction.js";
import { object, RepaFault } from "../src/schema.js";

const fault = (code: string) => (error: unknown): boolean => error instanceof RepaFault && error.code === code;

const YES_NO = { type: "choice" as const, options: [{ id: "yes", label: "是" }, { id: "no", label: "否" }] };

// 健康插件的一周打卡：每天一行，睡眠时长填数字，是否服药二选一。
const checkinDraft: ItemDraft = {
  id: "health.checkin.week",
  body: [
    { type: "markdown", text: "按天填写这周的情况。睡眠时长按小时填，例如 `7.5`。" },
    { type: "code", language: "text", text: "医嘱：每天早饭后服药一次" },
  ],
  slots: [{
    id: "week",
    type: "table",
    label: "本周打卡",
    columns: [{ id: "day", header: "日期" }, { id: "sleep", header: "睡眠（小时）" }, { id: "medicine", header: "服药" }],
    rows: [
      { id: "mon", cells: { day: { value: "周一" }, sleep: { input: { type: "text", format: "number", maxLength: 4 } }, medicine: { input: YES_NO } } },
      { id: "tue", cells: { day: { value: "周二" }, sleep: { input: { type: "text", format: "number", maxLength: 4 } }, medicine: { input: YES_NO } } },
    ],
  }],
};

// 写作插件让用户定下一章的写法：选主题、给字数、挑语气、排大纲、改一段排版配置，另可附一句备注。
const planDraft: ItemDraft = {
  id: "writing.plan.ch3",
  body: [{ type: "markdown", text: "第三章动笔前，先定下这几件事。" }],
  slots: [
    {
      id: "themes",
      type: "choice",
      multiple: true,
      minSelected: 0,
      options: [
        { id: "family", content: [{ type: "markdown", text: "家庭" }] },
        { id: "travel", content: [{ type: "markdown", text: "旅行" }] },
        { id: "work", content: [{ type: "markdown", text: "工作" }] },
      ],
    },
    { id: "words", type: "text", format: "integer", maxLength: 6, quick: ["不限"] },
    { id: "tone", type: "choice", options: [{ id: "warm", content: [{ type: "markdown", text: "温和" }] }, { id: "sharp", content: [{ type: "markdown", text: "犀利" }] }] },
    { id: "outline", type: "order", partial: true, indent: 2, items: [
      { id: "s1", content: [{ type: "markdown", text: "回到老家" }] },
      { id: "s2", content: [{ type: "markdown", text: "在车站遇到旧友" }] },
      { id: "s3", content: [{ type: "markdown", text: "删掉的支线" }] },
    ] },
    { id: "style", type: "code", language: "yaml", starter: "font: serif\n", maxLines: 2 },
    { id: "note", type: "text", optional: true, lines: 3 },
  ],
};

// 调用方交付 Item 的做法：版本对定义计算，requires 从结构算出。
async function item(draft: ItemDraft): Promise<Item> {
  return { ...draft, version: await contentVersion(draft), requires: requiredCapabilities(draft) };
}

function respond(target: Item, answers: Record<string, Answer>): ItemResponse {
  return { item: { id: target.id, version: target.version }, answers };
}

const planAnswers = (): Record<string, Answer> => ({
  themes: { type: "choice", selected: ["family"] },
  words: { type: "text", text: "3000" },
  tone: { type: "choice", selected: ["warm"] },
  outline: { type: "order", items: ["s1", "s2"], indents: [0, 1] },
  style: { type: "code", code: "font: sans\n" },
});

const pick = (selected: string[]) => ({ type: "choice" as const, selected });
const hours = (text: string) => ({ type: "text" as const, text });
const fullWeek = () => ({ mon: { sleep: hours("7.5"), medicine: pick(["yes"]) }, tue: { sleep: hours("6"), medicine: pick(["no"]) } });

function problemsOf(target: Item, response: ItemResponse): { slot?: string; message: string }[] {
  const result = checkResponse(target, response);
  return result.ok ? [] : result.problems;
}

test("词汇的 schema 拒绝多余字段：Item 或选项里多带调用方私有的字段就不合法", async () => {
  const checkin = await item(checkinDraft);
  assert.equal(Value.Check(ItemSchema, checkin), true);
  assert.equal(Value.Check(ItemSchema, { ...checkin, internalNote: "只给插件看的备注" }), false);
  const slot = checkin.slots[0];
  assert(slot?.type === "table");
  assert.equal(Value.Check(ItemSchema, { ...checkin, slots: [{ ...slot, threshold: 6 }] }), false);
  const plan = await item(planDraft);
  const themes = plan.slots[0];
  assert(themes?.type === "choice");
  const leaked = { ...plan, slots: [{ ...themes, options: themes.options.map(option => ({ ...option, weight: 1 })) }, ...plan.slots.slice(1)] };
  assert.equal(Value.Check(ItemSchema, leaked), false);
});

test("contentVersion 按 RFC 8785 规范化：成员顺序不影响结果，调用方私有的部分变了就得到新版本", async () => {
  const definition = { public: checkinDraft, rule: { sleepBelow: 6 }, note: "睡眠少于 6 小时时提醒" };
  const reordered = { note: "睡眠少于 6 小时时提醒", rule: { sleepBelow: 6 }, public: JSON.parse(JSON.stringify(checkinDraft)) as unknown };
  const version = await contentVersion(definition);
  assert.match(version, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(await contentVersion(reordered), version);
  assert.equal(await contentVersion({ ...definition, extra: undefined }), version);
  assert.notEqual(await contentVersion({ ...definition, rule: { sleepBelow: 7 } }), version);
  assert.notEqual(await contentVersion({ ...definition, note: "睡眠少于 7 小时时提醒" }), version);
});

test("contentVersion 与 RFC 8785 第 3.2.3 节的例子逐字一致，拒绝不是 JSON 的值", async () => {
  // 输入与期望输出照抄 RFC 8785；期望值在这里独立取哈希，不经过被测实现。
  const input: unknown = JSON.parse("{\n  \"numbers\": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],\n  \"string\": \"\\u20ac$\\u000F\\u000aA'\\u0042\\u0022\\u005c\\\\\\\"\\/\",\n  \"literals\": [null, true, false]\n}");
  const expected = "{\"literals\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\\\\\"/\"}";
  assert.equal(await contentVersion(input), `sha256:${createHash("sha256").update(expected, "utf8").digest("hex")}`);
  // 成员名按 UTF-16 码元排序，同样取自 RFC 8785 的排序例子。
  const sorting = { "\u20ac": 1, "\r": 2, "\ufb33": 3, "1": 4, "\ud83d\ude00": 5, "\u0080": 6, "\u00f6": 7 };
  const sorted = "{\"\\r\":2,\"1\":4,\"\u0080\":6,\"\u00f6\":7,\"\u20ac\":1,\"\ud83d\ude00\":5,\"\ufb33\":3}";
  assert.equal(await contentVersion(sorting), `sha256:${createHash("sha256").update(sorted, "utf8").digest("hex")}`);
  for (const value of [{ score: Number.NaN }, { items: [1, undefined] }, { at: new Date(0) }, { text: "\ud800" }]) {
    await assert.rejects(contentVersion(value), fault("invalid_definition"));
  }
});

test("requiredCapabilities 列出用到的作答位、内容块和公式，装饰图与可以忽略的提示不进 requires", async () => {
  assert.equal(INTERACTION_VOCABULARY, 1);
  assert.deepEqual(requiredCapabilities(checkinDraft), ["block.code", "block.markdown", "slot.table"]);
  assert.deepEqual(requiredCapabilities(planDraft), ["block.markdown", "slot.choice", "slot.code", "slot.order", "slot.text"]);
  const pictured: ItemDraft = {
    id: "health.bmi",
    body: [
      { type: "markdown", text: "按 $\\text{BMI} = w / h^2$ 填写", math: true },
      { type: "image", asset: "banner.png", alt: "装饰横幅", decorative: true },
    ],
    slots: [{ id: "bmi", type: "text", format: "number" }],
  };
  assert.deepEqual(requiredCapabilities(pictured), ["block.markdown", "markdown.math", "slot.text"]);
  const meaningful: ItemDraft = { ...pictured, body: [{ type: "image", asset: "chart.png", alt: "这周的体重曲线" }] };
  assert.deepEqual(requiredCapabilities(meaningful), ["block.image", "slot.text"]);
  for (const name of requiredCapabilities(planDraft)) assert.ok((INTERACTION_CAPABILITIES as readonly string[]).includes(name));
});

test("canRender 只在声明覆盖全部 requires 时成立", async () => {
  const checkin = await item(checkinDraft);
  assert.equal(canRender({ vocabulary: 1, supports: ["block.markdown", "block.code", "slot.table"] }, checkin), true);
  assert.equal(canRender({ vocabulary: 1, supports: ["block.markdown", "slot.table"] }, checkin), false);
  assert.equal(canRender(undefined, checkin), false);
  assert.equal(canRender(undefined, { requires: [] }), true);
});

test("合格的作答通过结构检查，可选小问可以不答", async () => {
  const plan = await item(planDraft);
  assert.deepEqual(checkResponse(plan, respond(plan, planAnswers())), { ok: true });
  const checkin = await item(checkinDraft);
  assert.deepEqual(checkResponse(checkin, respond(checkin, { week: { type: "table", cells: fullWeek() } })), { ok: true });
});

test("版本变了、作答位不存在、类型不符或必答位空着时，结构检查给出问题", async () => {
  const plan = await item(planDraft);
  const stale = { ...respond(plan, planAnswers()), item: { id: plan.id, version: `sha256:${"0".repeat(64)}` } };
  assert.equal(problemsOf(plan, stale).length, 1);
  assert.deepEqual(problemsOf(plan, respond(plan, { ...planAnswers(), ghost: { type: "text", text: "x" } })).map(problem => problem.slot), [undefined]);
  assert.deepEqual(problemsOf(plan, respond(plan, { ...planAnswers(), words: { type: "choice", selected: ["a"] } })).map(problem => problem.slot), ["words"]);
  const { tone: _tone, style: _style, ...withoutTwo } = planAnswers();
  assert.deepEqual(problemsOf(plan, respond(plan, withoutTwo)).map(problem => problem.slot), ["tone", "style"]);
  assert.deepEqual(problemsOf(plan, respond(plan, { ...planAnswers(), words: { type: "text", text: "" } })).map(problem => problem.slot), ["words"]);
  assert.deepEqual(problemsOf(plan, { ...respond(plan, planAnswers()), extra: true } as ItemResponse).length, 1);
});

test("选择：不存在或重复的选项、不允许的自填、个数超出范围都给出问题", async () => {
  const plan = await item(planDraft);
  const check = (answers: Partial<Record<string, Answer>>) => problemsOf(plan, respond(plan, { ...planAnswers(), ...answers } as Record<string, Answer>)).map(problem => problem.slot);
  assert.deepEqual(check({ tone: pick(["calm"]) }), ["tone"]);
  assert.deepEqual(check({ tone: pick(["warm", "sharp"]) }), ["tone"]);
  assert.deepEqual(check({ tone: pick([]) }), ["tone"]);
  assert.deepEqual(check({ tone: { type: "choice", selected: ["warm"], other: "幽默" } }), ["tone"]);
  assert.deepEqual(check({ themes: pick(["work", "work"]) }), ["themes"]);
  // 多选声明了 minSelected 为 0，一项都不选也是合格的作答。
  assert.deepEqual(check({ themes: pick([]) }), []);
  // Agent 的澄清问题允许自填“其他”。
  const asked = await item({ id: "ask:export", body: [], slots: [{ id: "q1", type: "choice", options: [{ id: "o1", content: [] }, { id: "o2", content: [] }], other: { label: "其他" } }] });
  assert.deepEqual(checkResponse(asked, respond(asked, { q1: { type: "choice", selected: [], other: "都不要" } })), { ok: true });
  assert.equal(problemsOf(asked, respond(asked, { q1: { type: "choice", selected: [], other: "" } })).length, 1);
  assert.equal(problemsOf(asked, respond(asked, { q1: { type: "choice", selected: ["o1"], other: "还有别的" } })).length, 1);
});

test("文本、排列和代码：超长、重复或缺块、缩进越界、超过行数都给出问题", async () => {
  const plan = await item(planDraft);
  const check = (answers: Partial<Record<string, Answer>>) => problemsOf(plan, respond(plan, { ...planAnswers(), ...answers } as Record<string, Answer>)).map(problem => problem.slot);
  assert.deepEqual(check({ words: hours("1234567") }), ["words"]);
  // 原样作答：首尾空白不去掉，也算作答；quick 里的值不受 format 限制，格式的含义由调用方判断。
  assert.deepEqual(check({ words: hours(" 3000 ") }), []);
  assert.deepEqual(check({ words: hours("不限") }), []);
  assert.deepEqual(check({ outline: { type: "order", items: ["s1", "s9"], indents: [0, 1] } }), ["outline"]);
  assert.deepEqual(check({ outline: { type: "order", items: ["s1", "s1"], indents: [0, 1] } }), ["outline"]);
  assert.deepEqual(check({ outline: { type: "order", items: ["s1", "s2"] } }), ["outline"]);
  assert.deepEqual(check({ outline: { type: "order", items: ["s1", "s2"], indents: [0] } }), ["outline"]);
  assert.deepEqual(check({ outline: { type: "order", items: ["s1", "s2"], indents: [0, 3] } }), ["outline"]);
  assert.deepEqual(check({ outline: { type: "order", items: [], indents: [] } }), ["outline"]);
  assert.deepEqual(check({ style: { type: "code", code: "font: sans\nsize: 12\nmargin: 2\n" } }), ["style"]);
  // 末尾换行不算新的一行。
  assert.deepEqual(check({ style: { type: "code", code: "font: sans\nsize: 12\n" } }), []);
  const ranking = await item({ id: "writing.rank", body: [], slots: [{ id: "s", type: "order", items: [{ id: "x", content: [] }, { id: "y", content: [] }] }] });
  assert.equal(problemsOf(ranking, respond(ranking, { s: { type: "order", items: ["x"] } })).length, 1);
  assert.equal(problemsOf(ranking, respond(ranking, { s: { type: "order", items: ["y", "x"], indents: [0, 0] } })).length, 1);
  assert.deepEqual(checkResponse(ranking, respond(ranking, { s: { type: "order", items: ["y", "x"] } })), { ok: true });
});

test("表格：不存在的行、固定文字格、错的格类型、不存在的选项和漏填的格都给出问题", async () => {
  const checkin = await item(checkinDraft);
  const check = (cells: Record<string, Record<string, Answer>>) => problemsOf(checkin, respond(checkin, { week: { type: "table", cells } as Answer }));
  assert.equal(check({ ...fullWeek(), sun: { sleep: hours("8") } }).length, 1);
  assert.equal(check({ ...fullWeek(), tue: { ...fullWeek().tue, day: hours("周三") } }).length, 1);
  assert.equal(check({ ...fullWeek(), tue: { sleep: hours("6"), medicine: hours("否") } }).length, 1);
  assert.equal(check({ ...fullWeek(), tue: { sleep: hours("6"), medicine: pick(["maybe"]) } }).length, 1);
  assert.equal(check({ ...fullWeek(), tue: { sleep: hours("6"), medicine: pick(["yes", "no"]) } }).length, 1);
  assert.equal(check({ ...fullWeek(), tue: { sleep: hours("12345"), medicine: pick(["no"]) } }).length, 1);
  const missing = check({ mon: fullWeek().mon });
  assert.equal(missing.length, 1);
  assert.equal(missing[0]?.slot, "week");
  assert.match(missing[0]?.message ?? "", /2 格/u);
  // 作答的键来自外部 JSON：原型链上的名字只当作不存在的行。
  const proto = JSON.parse(`{"__proto__":{"sleep":{"type":"text","text":"8"}},${JSON.stringify(fullWeek()).slice(1)}`) as Record<string, Record<string, Answer>>;
  assert.equal(check(proto).length, 1);
});

// 第一版前端声明全部能力。
const V1 = { vocabulary: 1, supports: [...INTERACTION_CAPABILITIES] };

test("前端宽松读取 Item：多出不认识的可选字段时丢掉，旧前端照常显示", async () => {
  const checkin = await item(checkinDraft);
  const table = checkin.slots[0];
  assert(table?.type === "table");
  // 较新词汇在 Item、内容块、作答位、行和输入格上加的可以忽略的字段。
  const newer: unknown = {
    ...checkin,
    hint: "先填今天",
    body: checkin.body.map((block) => ({ ...block, caption: "说明" })),
    slots: [{
      ...table,
      striped: true,
      rows: table.rows.map((row) => ({ ...row, note: "备注", cells: { ...row.cells, medicine: { input: { ...YES_NO, style: "toggle" } } } })),
    }],
  };
  const read = readItem(newer);
  assert.deepEqual(read, { ok: true, value: checkin });
  assert.ok(read.ok && canRender(V1, read.value));
  // 不认识的 layout 这类呈现提示同样丢掉，按默认布局显示。
  const plan = await item(planDraft);
  const tone = plan.slots[2];
  assert(tone?.type === "choice");
  const laidOut = readItem({ ...plan, slots: plan.slots.map((slot) => slot.id === "tone" ? { ...tone, layout: "grid" } : slot) });
  assert.deepEqual(laidOut, { ok: true, value: plan });
});

test("前端宽松读取 Item：多出必须理解的特性时，按 requires 判为不能作答", async () => {
  const checkin = await item(checkinDraft);
  const table = checkin.slots[0];
  assert(table?.type === "table");
  // 预计的新特性：用户自己增删行。旧前端读不懂 dynamicRows，requires 里的名字也不在它的声明里。
  const dynamic = readItem({ ...checkin, requires: [...checkin.requires, "table.dynamicRows"], slots: [{ ...table, dynamicRows: true }] });
  assert.ok(dynamic.ok);
  assert.deepEqual(dynamic.value.slots, checkin.slots);
  assert.ok(dynamic.value.requires.includes("table.dynamicRows"));
  assert.equal(canRender(V1, dynamic.value), false);
  // 新的作答位读不懂，连同它丢掉；发送方漏写 requires 时由读取补上，照样不能作答。
  for (const requires of [[...checkin.requires, "slot.scale"], checkin.requires]) {
    const read = readItem({ ...checkin, requires, slots: [...checkin.slots, { id: "pain", type: "scale", steps: 10 }] });
    assert.ok(read.ok);
    assert.deepEqual(read.value.slots.map((slot) => slot.id), ["week"]);
    assert.ok(read.value.requires.includes("slot.scale"));
    assert.equal(canRender(V1, read.value), false);
  }
  // 新的内容块同理。
  const video = readItem({ ...checkin, body: [...checkin.body, { type: "video", asset: "stretch" }] });
  assert.ok(video.ok);
  assert.deepEqual(video.value.body, checkin.body);
  assert.ok(video.value.requires.includes("block.video"));
  assert.equal(canRender(V1, video.value), false);
});

test("前端宽松读取时，认识的字段类型不对照样失败", async () => {
  const checkin = await item(checkinDraft);
  const table = checkin.slots[0];
  assert(table?.type === "table");
  assert.deepEqual(readItem({ ...checkin, id: 5 }), { ok: false, path: "/id" });
  assert.deepEqual(readItem({ ...checkin, body: undefined }), { ok: false, path: "/body" });
  assert.deepEqual(readItem({ ...checkin, slots: [{ ...table, rows: "mon" }] }), { ok: false, path: "/slots/0/rows" });
  assert.deepEqual(readItem({ ...checkin, slots: [{ ...table, type: 5 }] }), { ok: false, path: "/slots/0/type" });
  assert.deepEqual(readItem({ ...checkin, slots: [{ ...table, optional: "否" }] }), { ok: false, path: "/slots/0/optional" });
  assert.deepEqual(readItem("不是 Item"), { ok: false, path: "" });
});

test("前端宽松读取 ask.reply 的结果：问题列表和附带内容里不认识的部分丢掉，认不出的结果读取失败", () => {
  const newer: unknown = {
    status: "accepted",
    attempt: 2,
    message: [{ type: "markdown", text: "已记下今天的打卡", tone: "warm" }, { type: "video", asset: "tip" }],
  };
  assert.deepEqual(readAskReplyResult(newer), { ok: true, value: { status: "accepted", message: [{ type: "markdown", text: "已记下今天的打卡" }] } });
  assert.deepEqual(readAskReplyResult({ status: "invalid", problems: [{ slot: "sleep", message: "请填数字", code: "not_number" }] }), {
    ok: true,
    value: { status: "invalid", problems: [{ slot: "sleep", message: "请填数字" }] },
  });
  assert.deepEqual(readAskReplyResult(null), { ok: true, value: null });
  assert.equal(readAskReplyResult({ status: "queued" }).ok, false);
  assert.equal(readAskReplyResult({ status: "accepted", message: "不是内容块" }).ok, false);
});

test("插件的公开约定也能宽松读取：不认识的字段丢掉，联合里认不出的值交给退路，认识的字段类型不对时指出位置", () => {
  // 一个健康插件的打卡记录：心情多了“未记录”，提醒方式以后可能增加。
  const Mood = Type.Union([Type.Literal("good"), Type.Literal("low"), Type.Literal("unrecorded")]);
  const CheckinSchema = object({
    day: Type.String(),
    mood: Mood,
    note: Type.Optional(ContentSchema),
    reminders: Type.Array(object({ at: Type.String(), via: Type.Union([Type.Literal("push"), Type.Literal("email")]) })),
    moods: Type.Optional(Type.Record(Type.String(), Mood)),
  });
  const newer: unknown = {
    day: "2026-10-12",
    mood: "great",
    weather: "晴",
    note: [{ type: "markdown", text: "睡得不错", tone: "warm" }, { type: "video", asset: "walk" }],
    reminders: [{ at: "08:00", via: "push", sound: "bell" }, { at: "21:00", via: "sms" }],
    moods: { morning: "good", evening: "calm" },
  };
  const seen: string[] = [];
  const fallback: ReadFallback = ({ value, path }) => {
    seen.push(`${path}=${JSON.stringify(value).slice(0, 20)}`);
    return path === "/mood" ? "unrecorded" : undefined;
  };
  assert.deepEqual(readLenient(CheckinSchema, newer, fallback), {
    ok: true,
    value: {
      day: "2026-10-12",
      mood: "unrecorded",
      note: [{ type: "markdown", text: "睡得不错" }],
      reminders: [{ at: "08:00", via: "push" }],
      moods: { morning: "good" },
    },
  });
  assert.deepEqual(seen.sort(), ['/mood="great"', '/moods/evening="calm"', '/note/1={"type":"video","ass', '/reminders/1/via="sms"']);

  // 没有退路时，必需字段里认不出的值让整条记录读不了；认识的字段类型不对时指出位置。
  assert.deepEqual(readLenient(CheckinSchema, newer), { ok: false, path: "" });
  assert.deepEqual(readLenient(CheckinSchema, { ...(newer as object), reminders: [{ at: 8, via: "push" }] }, fallback), { ok: false, path: "/reminders/0/at" });
  assert.deepEqual(readLenient(CheckinSchema, { ...(newer as object), mood: 3 }, fallback), { ok: false, path: "/mood" });
  // 退路给的值也要是这个联合的成员。
  assert.throws(() => readLenient(CheckinSchema, newer, () => "excellent"), TypeError);
});

test("宽松读取可空对象与原始类型联合，保留 null 且拒绝已知字段的错误类型", () => {
  const schema = object({
    task: Type.Union([object({ id: Type.String() }), Type.Null()]),
    eta: Type.Union([Type.Number(), Type.Null()]),
  });
  for (const value of [{ task: null, eta: null }, { task: { id: "one" }, eta: 3 }]) {
    assert.deepEqual(readLenient(schema, value), { ok: true, value });
  }
  assert.deepEqual(readLenient(schema, { task: null, eta: "3" }), { ok: false, path: "/eta" });
  assert.deepEqual(readLenient(schema, { task: { id: 1 }, eta: null }), { ok: false, path: "/task/id" });
});

test("TypeBox 枚举沿用联合的读取规则，未知值丢掉所在项，错误类型读取失败", () => {
  const schema = object({ entries: Type.Array(object({ mode: Type.Enum(["practice", "quiz"]) })) });
  assert.deepEqual(readLenient(schema, { entries: [{ mode: "future" }, { mode: "quiz" }] }), {
    ok: true, value: { entries: [{ mode: "quiz" }] },
  });
  assert.deepEqual(readLenient(schema, { entries: [{ mode: 1 }] }), { ok: false, path: "/entries/0/mode" });
});
