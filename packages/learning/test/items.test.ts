import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { Value } from "typebox/value";

import { gradeSlot, matchesText } from "../src/check/grade.js";
import { publicItem, questionVersion, referenceResponse, versionInput } from "../src/check/items.js";
import { sameDisplay } from "../src/check/literal.js";
import { sameValue } from "../src/check/values.js";
import { toContent } from "../src/format/markdown.js";
import type { SlotDef, Topic } from "../src/format/schema.js";
import { checkResponse, contentVersion, ItemSchema } from "@repa/base/protocol";
import { demoCourse } from "./demo-course.js";

function t01(): Topic {
  const topic = demoCourse().topics.t01;
  assert.ok(topic);
  return topic;
}

test("整数比较接受首尾空白，不接受小数、布尔值或夹着数字的句子", () => {
  assert.equal(matchesText("integer", [5], " 5 "), true);
  assert.equal(matchesText("integer", [5], "+5"), true);
  assert.equal(matchesText("integer", [5], "5.0"), false);
  assert.equal(matchesText("integer", [1], "True"), false);
  assert.equal(matchesText("integer", [5], "答案是 5"), false);
  // 字符串形式的标准答案按原文比较，用于“尚未定义”这类固定文字。
  assert.equal(matchesText("integer", ["尚未定义"], " 尚未定义"), true);
});

test("文字比较只去掉首尾空白，编号 001 不当作数字 1", () => {
  assert.equal(matchesText("text", ["S_B"], " S_B\n"), true);
  assert.equal(matchesText("text", ["S_B"], "s_b"), false);
  // 文字值带上一对引号也算对。
  assert.equal(matchesText("text", ["S_B"], "'S_B'"), true);
  assert.equal(matchesText("text", ["S_B"], "'S_B\""), false);
  assert.equal(matchesText("text", ["001"], "1"), false);
  assert.equal(matchesText("number", [0.5], "1/2"), true);
  assert.equal(matchesText("number", [0.5], "0.51", 0.01), true);
  assert.equal(matchesText("nonempty", [], "  "), false);
});

test("Python 显示内容按字面量比较：引号和空格不同算相同，类型不同算不同", () => {
  assert.equal(sameDisplay("'hello'", '"hello"'), true);
  assert.equal(sameDisplay("[1, 2, 3]", "[1,2,3]"), true);
  assert.equal(sameDisplay("(1,)", "(1)"), false);
  assert.equal(sameDisplay("True", "1"), false);
  assert.equal(sameDisplay("6", "6.0"), false);
  assert.equal(sameDisplay("'001'", "1"), false);
  assert.equal(sameDisplay("NOTHING", " nothing "), true);
  assert.equal(sameDisplay("ERROR", "NameError"), false);
  // 打印出来的普通文字不是固定词；字典按显示的顺序比较；-0.0 与 0.0 显示不同。
  assert.equal(sameDisplay("Error", "ERROR"), false);
  assert.equal(sameDisplay("{'a': 1, 'b': 2}", "{'b': 2, 'a': 1}"), false);
  assert.equal(sameDisplay("-0.0", "0.0"), false);
  // 不是字面量时按规整后的文字比较，表格对齐用的空格不影响结果。
  assert.equal(sameDisplay("   a  b\n0  1  2\n", "a b\n0 1 2"), true);
});

test("多选按选项逐项计分，整体一致才算完全正确", () => {
  const slot: SlotDef = {
    id: "changes", type: "choice", multiple: true, minSelected: 0, scoring: "options",
    options: [{ id: "a", content: "a" }, { id: "b", content: "b" }, { id: "c", content: "c" }, { id: "d", content: "d" }],
    key: ["a", "b", "c"],
  };
  assert.deepEqual(gradeSlot(slot, { type: "choice", selected: ["a", "b", "c"] }), { verdict: "correct", earned: 4, max: 4 });
  assert.deepEqual(gradeSlot(slot, { type: "choice", selected: ["a", "b"] }), { verdict: "partial", earned: 3, max: 4 });
  assert.deepEqual(gradeSlot(slot, { type: "choice", selected: ["a", "b", "c", "d"] }), { verdict: "partial", earned: 3, max: 4 });
});

test("排列题接受登记的其他正确顺序；缩进按块计，换了位置的块仍用自己的缩进", () => {
  const slot: SlotDef = {
    id: "lines", type: "order", partial: true, indent: 2,
    items: [{ id: "x", code: "a = 1" }, { id: "y", code: "b = 2" }, { id: "z", code: "c = 3" }],
    key: ["x", "y"], alternatives: [["y", "x"]], indents: { x: 0, y: 1 },
  };
  assert.equal(gradeSlot(slot, { type: "order", items: ["x", "y"], indents: [0, 1] }).verdict, "correct");
  assert.equal(gradeSlot(slot, { type: "order", items: ["y", "x"], indents: [1, 0] }).verdict, "correct");
  assert.equal(gradeSlot(slot, { type: "order", items: ["y", "x"], indents: [0, 1] }).verdict, "incorrect");
  assert.equal(gradeSlot(slot, { type: "order", items: ["x", "z"], indents: [0, 0] }).verdict, "incorrect");
});

test("表格逐格计分，布尔格只接受 True/False 选项", () => {
  const slot = t01().kps[1]?.example?.slots[0];
  assert.ok(slot);
  const choice = (selected: string) => ({ type: "choice" as const, selected: [selected] });
  const grade = gradeSlot(slot, { type: "table", cells: { ra: { mask: choice("False") }, rb: { mask: choice("True") }, rc: { mask: choice("False") } } });
  assert.deepEqual(grade, { verdict: "partial", earned: 2, max: 3 });
});

test("投影出的题目符合交互词汇，答案、判分、核对和测试都不带出去", async () => {
  const topic = t01();
  for (const question of [topic.kps[0]?.practice?.[2], topic.kps[1]?.practice?.[0], topic.kps[1]?.practice?.[1], topic.kps[1]?.example]) {
    assert.ok(question);
    const item = await publicItem(question, topic);
    assert.equal(Value.Check(ItemSchema, item), true);
    const text = JSON.stringify(item);
    for (const secret of ['"key"', '"verify"', '"solution"', '"tests"', '"feedback"', '"rejects"', '"accepts"', '"indents"', "return x * 2", "应当减去"]) {
      assert.equal(text.includes(secret), false, `${question.id} 的公开题面里出现了 ${secret}`);
    }
  }
  const example = await publicItem(topic.kps[1]?.example ?? assert.fail(), topic);
  // 用到的数据表显示在题面最前面。
  assert.deepEqual(example.body[0], { type: "markdown", text: "|  | value |\n| --- | ---: |\n| a | 3 |\n| b | 8 |\n| c | 5 |" });
  assert.deepEqual(example.requires, ["block.code", "block.markdown", "slot.table"]);
});

test("标准答案拼出的作答能通过题目自己的结构检查，缺答或多选会被拒", async () => {
  const topic = t01();
  const question = topic.kps[0]?.practice?.[2];
  assert.ok(question);
  const item = await publicItem(question, topic);
  const reference = referenceResponse(question, item);
  assert.deepEqual(checkResponse(item, reference), { ok: true });
  assert.equal(checkResponse(item, { ...reference, answers: {} }).ok, false);
  assert.equal(checkResponse(item, { ...reference, answers: { line: { type: "choice", selected: ["minus", "plus"] } } }).ok, false);
});

test("内容版本不受元数据和核对程序影响，题面、答案、解析和用到的数据一改就变", async () => {
  const topic = t01();
  const question = topic.kps[1]?.example;
  assert.ok(question);
  const original = await questionVersion(question, topic);
  assert.match(original, /^sha256:[0-9a-f]{64}$/);
  assert.equal(await questionVersion({ ...question, kind: ["trace"], uses: ["t01.k1"] }, topic), original);
  assert.equal(await questionVersion({ ...question, verify: "answers = {}", manual: ["mask"] }, topic), original);
  assert.notEqual(await questionVersion({ ...question, explanation: "False、True、True！" }, topic), original);
  const table = question.slots[0];
  assert.ok(table?.type === "table");
  const rows = table.rows.map((row) => (row.id === "rc" ? { ...row, cells: { ...row.cells, mask: false } } : row));
  assert.notEqual(await questionVersion({ ...question, slots: [{ ...table, rows }] }, topic), original);
  const changedData = structuredClone(topic);
  const nums = changedData.data?.nums;
  assert.ok(nums?.kind === "dataframe");
  nums.columns.value = [3, 8, 6];
  assert.notEqual(await questionVersion(question, changedData), original);
  // 输入里只有题目定义和它用到的数据。
  assert.deepEqual(Object.keys(versionInput(question, topic) as object), ["question", "data"]);
});

test("代码题的等价写法和错误写法只为检查而写，不影响版本；参考答案和测试会影响", async () => {
  const topic = t01();
  const question = topic.kps[1]?.practice?.[0];
  const slot = question?.slots[0];
  assert.ok(question && slot?.type === "code");
  const original = await questionVersion(question, topic);
  const withSlot = (changes: Partial<typeof slot>) => ({ ...question, slots: [{ ...slot, ...changes }] });
  assert.equal(await questionVersion(withSlot({ accepts: [], rejects: [] }), topic), original);
  assert.notEqual(await questionVersion(withSlot({ solution: "def double(x):\n    return 2 * x\n" }), topic), original);
  assert.notEqual(await questionVersion(withSlot({ tests: slot.tests.slice(0, 1) }), topic), original);
});

test("内容版本是 JCS 规范化后的 SHA-256，与对象成员的书写顺序无关", async () => {
  const canonical = '{"a":[true,null,"é"],"b":1,"c":{"x":1,"y":2}}';
  const expected = `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
  assert.equal(await contentVersion({ b: 1, a: [true, null, "é"], c: { y: 2, x: 1 } }), expected);
  assert.equal(await contentVersion({ a: 1 }), await contentVersion({ a: 1.0 }));
  await assert.rejects(contentVersion({ a: Number.NaN }), (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_definition");
});

test("Markdown 字符串拆成内容块：围栏代码块单独成块，可标行号", () => {
  const { content, problems } = toContent("先读代码。\n\n```python startLine=3\nx = 1\n```\n\n再回答。\n\n```\n输出\n```");
  assert.deepEqual(problems, []);
  assert.deepEqual(content, [
    { type: "markdown", text: "先读代码。" },
    { type: "code", language: "python", text: "x = 1", startLine: 3 },
    { type: "markdown", text: "再回答。" },
    { type: "code", language: "text", text: "输出" },
  ]);
  assert.deepEqual(toContent("```python\nx = 1").problems, ["从 ``` 开始的代码块没有结束围栏"]);
});

test("沙箱外的值比较：浮点按相对误差，NaN 相等，字典不看顺序", () => {
  const float = (v: string) => ({ t: "float", v });
  assert.equal(sameValue(float("0.30000000000000004"), float("0.3")), true);
  assert.equal(sameValue(float("nan"), float("nan")), true);
  assert.equal(sameValue(float("1.0"), { t: "int", v: "1" }), false);
  const dict = (entries: [string, number][]) => ({ t: "dict", v: entries.map(([key, value]) => [{ t: "str", v: key }, { t: "int", v: String(value) }]) });
  assert.equal(sameValue(dict([["a", 1], ["b", 2]]), dict([["b", 2], ["a", 1]])), true);
  assert.equal(sameValue(dict([["a", 1]]), dict([["a", 2]])), false);
  // 太大而没有序列化的值无从比较，即使两边一样也不算相同。
  const large = { t: "too_large", type: "list", size: 20_000 };
  assert.equal(sameValue(large, structuredClone(large)), false);
});
