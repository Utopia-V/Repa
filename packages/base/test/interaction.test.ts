import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Value } from "typebox/value";
import {
  canRender,
  checkResponse,
  contentVersion,
  INTERACTION_CAPABILITIES,
  INTERACTION_VOCABULARY,
  ItemSchema,
  readFeedback,
  readItem,
  readSubmitResult,
  requiredCapabilities,
  SubmitResultSchema,
  type Answer,
  type Item,
  type ItemDraft,
  type ItemResponse,
} from "../src/interaction.js";
import { RepaFault } from "../src/schema.js";

const fault = (code: string) => (error: unknown): boolean => error instanceof RepaFault && error.code === code;

const BOOL = { type: "choice" as const, options: [{ id: "true", label: "True" }, { id: "false", label: "False" }] };

// 草案的 py17.k1.q1：按原行索引填 mask 的 True/False。
const maskDraft: ItemDraft = {
  id: "py17.k1.q1",
  body: [
    { type: "markdown", text: "表 T 已重置。阅读代码，按原行索引填写 `mask` 的值。" },
    { type: "code", language: "python", text: "mask = df[\"signal\"] > 10" },
  ],
  slots: [{
    id: "mask",
    type: "table",
    label: "mask 的值",
    columns: [{ id: "index", header: "原行索引" }, { id: "signal", header: "signal" }, { id: "mask", header: "mask" }],
    rows: [
      { id: "r31", cells: { index: { value: "31" }, signal: { value: "8" }, mask: { input: BOOL } } },
      { id: "r7", cells: { index: { value: "7" }, signal: { value: "10" }, mask: { input: BOOL } } },
    ],
  }],
};

// 草案的 py12.k1.q2 加一个短答和一个代码小问，覆盖其余作答位。
const mixedDraft: ItemDraft = {
  id: "demo.mixed.1",
  body: [{ type: "markdown", text: "已确认的要求为“signal 至少 10”。" }],
  slots: [
    {
      id: "changes",
      type: "choice",
      multiple: true,
      minSelected: 0,
      options: [
        { id: "threshold", content: [{ type: "markdown", text: "阈值是否含等号" }] },
        { id: "columns", content: [{ type: "markdown", text: "输出列" }] },
        { id: "order", content: [{ type: "markdown", text: "行顺序" }] },
      ],
    },
    { id: "count", type: "text", format: "integer", maxLength: 6, quick: ["ERROR"] },
    { id: "pick", type: "choice", options: [{ id: "a", content: [{ type: "markdown", text: "甲" }] }, { id: "b", content: [{ type: "markdown", text: "乙" }] }] },
    { id: "lines", type: "order", partial: true, indent: 2, items: [
      { id: "b1", content: [{ type: "code", language: "python", text: "def f(values):" }] },
      { id: "b2", content: [{ type: "code", language: "python", text: "return len(values)" }] },
      { id: "b3", content: [{ type: "code", language: "python", text: "return 0" }] },
    ] },
    { id: "fix", type: "code", language: "python", starter: "result = df\n", maxLines: 2 },
    { id: "note", type: "text", optional: true, lines: 3 },
  ],
};

// 插件交付题目时的做法：版本对定义计算，requires 从结构算出。
async function item(draft: ItemDraft): Promise<Item> {
  return { ...draft, version: await contentVersion(draft), requires: requiredCapabilities(draft) };
}

function respond(target: Item, answers: Record<string, Answer>, extra: Partial<ItemResponse> = {}): ItemResponse {
  return { item: { id: target.id, version: target.version }, answers, ...extra };
}

const mixedAnswers = (): Record<string, Answer> => ({
  changes: { type: "choice", selected: ["threshold"] },
  count: { type: "text", text: "3" },
  pick: { type: "choice", selected: ["b"] },
  lines: { type: "order", items: ["b1", "b2"], indents: [0, 1] },
  fix: { type: "code", code: "result = df[df.signal >= 10]\n" },
});

function problemsOf(target: Item, response: ItemResponse): { slot?: string; message: string }[] {
  const result = checkResponse(target, response);
  return result.ok ? [] : result.problems;
}

test("词汇的 schema 拒绝多余字段：题目或选项里多带一个答案字段就不合法", async () => {
  const valid = await item(maskDraft);
  assert.equal(Value.Check(ItemSchema, valid), true);
  assert.equal(Value.Check(ItemSchema, { ...valid, answer: { mask: "false" } }), false);
  const slot = valid.slots[0];
  assert(slot?.type === "table");
  assert.equal(Value.Check(ItemSchema, { ...valid, slots: [{ ...slot, correct: ["false"] }] }), false);
  const choice = await item(mixedDraft);
  const options = choice.slots[0];
  assert(options?.type === "choice");
  const leaked = { ...choice, slots: [{ ...options, options: options.options.map(option => ({ ...option, correct: true })) }, ...choice.slots.slice(1)] };
  assert.equal(Value.Check(ItemSchema, leaked), false);
  assert.equal(Value.Check(SubmitResultSchema, { status: "recorded", answer: "x" }), false);
});

test("contentVersion 按 RFC 8785 规范化：成员顺序不影响结果，改了答案就得到新版本", async () => {
  const definition = { public: maskDraft, answer: { r31: "false", r7: "false" }, rubric: "逐格精确比较" };
  const reordered = { rubric: "逐格精确比较", answer: { r7: "false", r31: "false" }, public: JSON.parse(JSON.stringify(maskDraft)) as unknown };
  const version = await contentVersion(definition);
  assert.match(version, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(await contentVersion(reordered), version);
  assert.equal(await contentVersion({ ...definition, extra: undefined }), version);
  assert.notEqual(await contentVersion({ ...definition, answer: { r31: "false", r7: "true" } }), version);
  assert.notEqual(await contentVersion({ ...definition, rubric: "逐格比较，忽略大小写" }), version);
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
  assert.deepEqual(requiredCapabilities(maskDraft), ["block.code", "block.markdown", "slot.table"]);
  assert.deepEqual(requiredCapabilities(mixedDraft), ["block.code", "block.markdown", "slot.choice", "slot.code", "slot.order", "slot.text"]);
  const pictured: ItemDraft = {
    id: "demo.image.1",
    body: [
      { type: "markdown", text: "求 $x^2$ 的导数", math: true },
      { type: "image", asset: "plot.png", alt: "装饰插图", decorative: true },
    ],
    slots: [{ id: "answer", type: "text", format: "math" }],
  };
  assert.deepEqual(requiredCapabilities(pictured), ["block.markdown", "markdown.math", "slot.text"]);
  const meaningful: ItemDraft = { ...pictured, body: [{ type: "image", asset: "plot.png", alt: "函数图像" }] };
  assert.deepEqual(requiredCapabilities(meaningful), ["block.image", "slot.text"]);
  for (const name of requiredCapabilities(mixedDraft)) assert.ok((INTERACTION_CAPABILITIES as readonly string[]).includes(name));
});

test("canRender 只在声明覆盖全部 requires 时成立", async () => {
  const mask = await item(maskDraft);
  assert.equal(canRender({ vocabulary: 1, supports: ["block.markdown", "block.code", "slot.table"] }, mask), true);
  assert.equal(canRender({ vocabulary: 1, supports: ["block.markdown", "slot.table"] }, mask), false);
  assert.equal(canRender(undefined, mask), false);
  assert.equal(canRender(undefined, { requires: [] }), true);
});

test("合格的作答通过结构检查，可选小问可以不答", async () => {
  const mixed = await item(mixedDraft);
  assert.deepEqual(checkResponse(mixed, respond(mixed, mixedAnswers())), { ok: true });
  const mask = await item(maskDraft);
  const cells = { r31: { mask: { type: "choice" as const, selected: ["false"] } }, r7: { mask: { type: "choice" as const, selected: ["false"] } } };
  assert.deepEqual(checkResponse(mask, respond(mask, { mask: { type: "table", cells } })), { ok: true });
});

test("题目版本变了、作答位不存在、类型不符或必答位空着时 rejected", async () => {
  const mixed = await item(mixedDraft);
  const stale = { ...respond(mixed, mixedAnswers()), item: { id: mixed.id, version: `sha256:${"0".repeat(64)}` } };
  assert.equal(problemsOf(mixed, stale).length, 1);
  assert.deepEqual(problemsOf(mixed, respond(mixed, { ...mixedAnswers(), ghost: { type: "text", text: "x" } })).map(problem => problem.slot), [undefined]);
  assert.deepEqual(problemsOf(mixed, respond(mixed, { ...mixedAnswers(), count: { type: "choice", selected: ["a"] } })).map(problem => problem.slot), ["count"]);
  const { pick: _pick, fix: _fix, ...withoutTwo } = mixedAnswers();
  assert.deepEqual(problemsOf(mixed, respond(mixed, withoutTwo)).map(problem => problem.slot), ["pick", "fix"]);
  assert.deepEqual(problemsOf(mixed, respond(mixed, { ...mixedAnswers(), count: { type: "text", text: "" } })).map(problem => problem.slot), ["count"]);
  assert.deepEqual(problemsOf(mixed, { ...respond(mixed, mixedAnswers()), extra: true } as ItemResponse).length, 1);
});

test("选择题：不存在或重复的选项、不允许的自填、个数超出范围都 rejected", async () => {
  const mixed = await item(mixedDraft);
  const check = (answers: Partial<Record<string, Answer>>) => problemsOf(mixed, respond(mixed, { ...mixedAnswers(), ...answers } as Record<string, Answer>)).map(problem => problem.slot);
  assert.deepEqual(check({ pick: { type: "choice", selected: ["z"] } }), ["pick"]);
  assert.deepEqual(check({ pick: { type: "choice", selected: ["a", "b"] } }), ["pick"]);
  assert.deepEqual(check({ pick: { type: "choice", selected: [] } }), ["pick"]);
  assert.deepEqual(check({ pick: { type: "choice", selected: ["a"], other: "丙" } }), ["pick"]);
  assert.deepEqual(check({ changes: { type: "choice", selected: ["order", "order"] } }), ["changes"]);
  // 多选题声明了 minSelected 为 0，一项都不选也是合格的作答。
  assert.deepEqual(check({ changes: { type: "choice", selected: [] } }), []);
  const asked = await item({ id: "ask:demo", body: [], slots: [{ id: "q1", type: "choice", options: [{ id: "o1", content: [] }, { id: "o2", content: [] }], other: { label: "其他" } }] });
  assert.deepEqual(checkResponse(asked, respond(asked, { q1: { type: "choice", selected: [], other: "都不要" } })), { ok: true });
  assert.equal(problemsOf(asked, respond(asked, { q1: { type: "choice", selected: [], other: "" } })).length, 1);
  assert.equal(problemsOf(asked, respond(asked, { q1: { type: "choice", selected: ["o1"], other: "还有别的" } })).length, 1);
});

test("文本、排列和代码：超长、重复或缺块、缩进越界、代码超行都 rejected", async () => {
  const mixed = await item(mixedDraft);
  const check = (answers: Partial<Record<string, Answer>>) => problemsOf(mixed, respond(mixed, { ...mixedAnswers(), ...answers } as Record<string, Answer>)).map(problem => problem.slot);
  assert.deepEqual(check({ count: { type: "text", text: "1234567" } }), ["count"]);
  // 原样作答：首尾空白不去掉，也算作答；quick 里的值不受 format 限制，格式由插件判断。
  assert.deepEqual(check({ count: { type: "text", text: " 3 " } }), []);
  assert.deepEqual(check({ count: { type: "text", text: "ERROR" } }), []);
  assert.deepEqual(check({ lines: { type: "order", items: ["b1", "b9"], indents: [0, 1] } }), ["lines"]);
  assert.deepEqual(check({ lines: { type: "order", items: ["b1", "b1"], indents: [0, 1] } }), ["lines"]);
  assert.deepEqual(check({ lines: { type: "order", items: ["b1", "b2"] } }), ["lines"]);
  assert.deepEqual(check({ lines: { type: "order", items: ["b1", "b2"], indents: [0] } }), ["lines"]);
  assert.deepEqual(check({ lines: { type: "order", items: ["b1", "b2"], indents: [0, 3] } }), ["lines"]);
  assert.deepEqual(check({ lines: { type: "order", items: [], indents: [] } }), ["lines"]);
  assert.deepEqual(check({ fix: { type: "code", code: "a = 1\nb = 2\nc = 3\n" } }), ["fix"]);
  // 末尾换行不算新的一行。
  assert.deepEqual(check({ fix: { type: "code", code: "a = 1\nb = 2\n" } }), []);
  const strict = await item({ id: "demo.sort", body: [], slots: [{ id: "s", type: "order", items: [{ id: "x", content: [] }, { id: "y", content: [] }] }] });
  assert.equal(problemsOf(strict, respond(strict, { s: { type: "order", items: ["x"] } })).length, 1);
  assert.equal(problemsOf(strict, respond(strict, { s: { type: "order", items: ["y", "x"], indents: [0, 0] } })).length, 1);
  assert.deepEqual(checkResponse(strict, respond(strict, { s: { type: "order", items: ["y", "x"] } })), { ok: true });
});

test("表格：不存在的行、固定文字格、错的格类型、不存在的选项和漏填的格都 rejected", async () => {
  const mask = await item(maskDraft);
  const pick = (selected: string[]) => ({ type: "choice" as const, selected });
  const check = (cells: Record<string, Record<string, Answer>>) => problemsOf(mask, respond(mask, { mask: { type: "table", cells } as Answer }));
  const full = { r31: { mask: pick(["false"]) }, r7: { mask: pick(["false"]) } };
  assert.equal(check({ ...full, r99: { mask: pick(["true"]) } }).length, 1);
  assert.equal(check({ ...full, r7: { mask: pick(["false"]), signal: { type: "text", text: "10" } } }).length, 1);
  assert.equal(check({ ...full, r7: { mask: { type: "text", text: "False" } } }).length, 1);
  assert.equal(check({ ...full, r7: { mask: pick(["0"]) } }).length, 1);
  assert.equal(check({ ...full, r7: { mask: pick(["true", "false"]) } }).length, 1);
  const missing = check({ r31: { mask: pick(["false"]) } });
  assert.equal(missing.length, 1);
  assert.equal(missing[0]?.slot, "mask");
  assert.match(missing[0]?.message ?? "", /1 格/u);
  // 作答的键来自外部 JSON：原型链上的名字只当作不存在的行。
  assert.equal(check(JSON.parse("{\"__proto__\":{\"mask\":{\"type\":\"choice\",\"selected\":[\"true\"]}},\"r31\":{\"mask\":{\"type\":\"choice\",\"selected\":[\"false\"]}},\"r7\":{\"mask\":{\"type\":\"choice\",\"selected\":[\"false\"]}}}") as Record<string, Record<string, Answer>>).length, 1);
});

test("“不会”是正式作答：可以不填任何作答位，结构问题照样 rejected", async () => {
  const mixed = await item(mixedDraft);
  assert.deepEqual(checkResponse(mixed, respond(mixed, {}, { dontKnow: true })), { ok: true });
  assert.deepEqual(checkResponse(mixed, respond(mixed, { lines: { type: "order", items: ["b1"], indents: [0] } }, { dontKnow: true })), { ok: true });
  assert.deepEqual(problemsOf(mixed, respond(mixed, { pick: { type: "choice", selected: ["z"] } }, { dontKnow: true })).map(problem => problem.slot), ["pick"]);
  const mask = await item(maskDraft);
  assert.deepEqual(checkResponse(mask, respond(mask, { mask: { type: "table", cells: { r31: { mask: { type: "choice", selected: ["true"] } } } } }, { dontKnow: true })), { ok: true });
});

// 第一版前端声明全部能力。
const V1 = { vocabulary: 1, supports: [...INTERACTION_CAPABILITIES] };

test("前端宽松读取题目：多出不认识的可选字段时丢掉，旧前端照常显示", async () => {
  const mask = await item(maskDraft);
  const table = mask.slots[0];
  assert(table?.type === "table");
  // 较新词汇在题目、内容块、作答位、行和输入格上加的可以忽略的字段。
  const newer: unknown = {
    ...mask,
    hint: "先看第 2 行",
    body: mask.body.map((block) => ({ ...block, caption: "题干" })),
    slots: [{
      ...table,
      striped: true,
      rows: table.rows.map((row) => ({ ...row, note: "说明", cells: { ...row.cells, mask: { input: { ...BOOL, style: "toggle" } } } })),
    }],
  };
  const read = readItem(newer);
  assert.deepEqual(read, { ok: true, value: mask });
  assert.ok(read.ok && canRender(V1, read.value));
  // 不认识的 layout 这类呈现提示同样丢掉，按默认布局显示。
  const mixed = await item(mixedDraft);
  const pick = mixed.slots[2];
  assert(pick?.type === "choice");
  const laidOut = readItem({ ...mixed, slots: mixed.slots.map((slot) => slot.id === "pick" ? { ...pick, layout: "grid" } : slot) });
  assert.deepEqual(laidOut, { ok: true, value: mixed });
});

test("前端宽松读取题目：多出必须理解的特性时，按 requires 判为不能作答", async () => {
  const mask = await item(maskDraft);
  const table = mask.slots[0];
  assert(table?.type === "table");
  // 草案预计的新特性：学生自己增删行。旧前端读不懂 dynamicRows，requires 里的名字也不在它的声明里。
  const dynamic = readItem({ ...mask, requires: [...mask.requires, "table.dynamicRows"], slots: [{ ...table, dynamicRows: true }] });
  assert.ok(dynamic.ok);
  assert.deepEqual(dynamic.value.slots, mask.slots);
  assert.ok(dynamic.value.requires.includes("table.dynamicRows"));
  assert.equal(canRender(V1, dynamic.value), false);
  // 新的作答位读不懂，连同它丢掉；发送方漏写 requires 时由读取补上，照样不能作答。
  for (const requires of [[...mask.requires, "slot.graph"], mask.requires]) {
    const read = readItem({ ...mask, requires, slots: [...mask.slots, { id: "plot", type: "graph", axes: 2 }] });
    assert.ok(read.ok);
    assert.deepEqual(read.value.slots.map((slot) => slot.id), ["mask"]);
    assert.ok(read.value.requires.includes("slot.graph"));
    assert.equal(canRender(V1, read.value), false);
  }
  // 新的内容块同理。
  const video = readItem({ ...mask, body: [...mask.body, { type: "video", asset: "clip" }] });
  assert.ok(video.ok);
  assert.deepEqual(video.value.body, mask.body);
  assert.ok(video.value.requires.includes("block.video"));
  assert.equal(canRender(V1, video.value), false);
});

test("前端宽松读取时，认识的字段类型不对照样失败", async () => {
  const mask = await item(maskDraft);
  const table = mask.slots[0];
  assert(table?.type === "table");
  assert.deepEqual(readItem({ ...mask, id: 5 }), { ok: false, path: "/id" });
  assert.deepEqual(readItem({ ...mask, body: undefined }), { ok: false, path: "/body" });
  assert.deepEqual(readItem({ ...mask, slots: [{ ...table, rows: "r31" }] }), { ok: false, path: "/slots/0/rows" });
  assert.deepEqual(readItem({ ...mask, slots: [{ ...table, type: 5 }] }), { ok: false, path: "/slots/0/type" });
  assert.deepEqual(readItem({ ...mask, slots: [{ ...table, optional: "否" }] }), { ok: false, path: "/slots/0/optional" });
  assert.deepEqual(readItem("不是题目"), { ok: false, path: "" });
  assert.deepEqual(readFeedback({ item: { id: mask.id, version: mask.version }, verdict: 3 }), { ok: false, path: "/verdict" });
});

test("前端宽松读取反馈和提交结果：不认识的字段与取值丢掉，verdict 按中性读成 ungraded", async () => {
  const mixed = await item(mixedDraft);
  const reference = { id: mixed.id, version: mixed.version };
  const newer: unknown = {
    item: reference,
    verdict: "almost",
    judge: "peer",
    tone: "warm",
    message: [{ type: "markdown", text: "差一点" }, { type: "video", asset: "explain" }],
    slots: {
      changes: {
        verdict: "partial",
        marks: { threshold: "correct", order: "half" },
        tests: [{ name: "公开用例", result: "passed" }, { name: "新用例", result: "skipped" }],
        criteria: [{ label: "阈值", met: "yes" }, { label: "顺序", met: "mostly" }],
        expected: { type: "graph", points: [] },
        highlight: true,
      },
    },
  };
  const expected = {
    item: reference,
    verdict: "ungraded",
    message: [{ type: "markdown", text: "差一点" }],
    slots: {
      changes: {
        verdict: "partial",
        marks: { threshold: "correct" },
        tests: [{ name: "公开用例", result: "passed" }],
        criteria: [{ label: "阈值", met: "yes" }],
      },
    },
  };
  assert.deepEqual(readFeedback(newer), { ok: true, value: expected });
  assert.deepEqual(readSubmitResult({ status: "recorded", feedback: newer, attempt: 2 }), { ok: true, value: { status: "recorded", feedback: expected } });
  assert.deepEqual(readSubmitResult({ status: "rejected", problems: [{ slot: "count", message: "太长", code: "too_long" }] }), { ok: true, value: { status: "rejected", problems: [{ slot: "count", message: "太长" }] } });
  assert.equal(readSubmitResult({ status: "queued" }).ok, false);
});
