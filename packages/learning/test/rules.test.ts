import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkCourse } from "../src/check/course.js";
import type { Diagnostic } from "../src/format/diagnostics.js";
import type { ChoiceSlot, TableSlot } from "../src/format/schema.js";
import { demoCourse, writeCourse, type DemoCourse } from "./demo-course.js";

const PYTHON_COURSE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "courses", "python");

function codes(diagnostics: Diagnostic[]): string[] {
  return diagnostics.filter((diagnostic) => diagnostic.severity === "error").map((diagnostic) => diagnostic.code).sort();
}

async function structuralCheck(t: Parameters<typeof writeCourse>[0], demo: DemoCourse) {
  const root = await writeCourse(t, demo);
  return checkCourse(root, { run: false, base: root });
}

function topic(demo: DemoCourse, id: string) {
  const found = demo.topics[id];
  assert.ok(found, `没有 ${id}`);
  return found;
}

function kp(demo: DemoCourse, index: number) {
  const found = topic(demo, "t01").kps[index];
  assert.ok(found);
  return found;
}

test("示例课程的结构检查没有问题", async (t) => {
  const result = await structuralCheck(t, demoCourse());
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.summary.topics, { complete: 1, outline: 1 });
  assert.equal(result.summary.questions, 12);
  assert.equal(result.summary.ran, false);
});

test("随包的 Python 课程通过结构检查，48 个 topic 都在清单里", async () => {
  const result = await checkCourse(PYTHON_COURSE, { run: false });
  assert.deepEqual(codes(result.diagnostics), []);
  assert.equal(result.summary.topics.complete + result.summary.topics.outline, 48);
});

test("先修成环时报出环上的 topic", async (t) => {
  const demo = demoCourse();
  topic(demo, "t01").prerequisites.push("t02");
  const result = await structuralCheck(t, demo);
  // t02 是轮廓，展开了的 t01 以它为先修，另报 prerequisite_outline。
  assert.deepEqual(codes(result.diagnostics), ["prerequisite_outline", "prerequisites_cycle"]);
  assert.match(result.diagnostics.find((diagnostic) => diagnostic.code === "prerequisites_cycle")?.message ?? "", /t01 → t02 → t01|t02 → t01 → t02/);
});

test("先修与覆盖分别检查清单外的 topic", async (t) => {
  const demo = demoCourse();
  topic(demo, "t02").prerequisites = ["t09"];
  topic(demo, "t02").encompassings = [{ topic: "t08", weight: 0.5 }];
  const result = await structuralCheck(t, demo);
  assert.deepEqual(codes(result.diagnostics), ["encompassings_unknown", "prerequisites_unknown"]);
});

test("完整 topic 缺例题、练习不足三道、缺复习或测验题池时逐项报出", async (t) => {
  const demo = demoCourse();
  const first = kp(demo, 0);
  delete first.example;
  first.practice = first.practice?.slice(0, 2) ?? [];
  delete first.review;
  first.quiz = [];
  // 卡片的例子原本来自例题，例题删掉后也要换成仍然存在的练习题。
  if (first.card) first.card.example.from = "t01.k1.q1";
  const result = await structuralCheck(t, demo);
  assert.deepEqual(codes(result.diagnostics), ["example_missing", "practice_too_few", "quiz_missing", "review_missing"]);
});

test("练习都要模型判分的知识点报出：课要做完不靠模型判分的必做题，一道都没有就无从取证", async (t) => {
  const demo = demoCourse();
  const first = kp(demo, 0);
  first.practice = (first.practice ?? []).map((question) => ({
    ...question,
    slots: [{ id: "answer", type: "text" as const, rubric: [{ id: "meaning", label: "说明含义" }] }],
  }));
  delete first.card;
  const result = await structuralCheck(t, demo);
  assert.ok(codes(result.diagnostics).includes("practice_required_missing"), JSON.stringify(codes(result.diagnostics)));
});

test("骨架 topic 不要求讲解和题目，完整 topic 缺概念卡和讲解时报出", async (t) => {
  const demo = demoCourse();
  const first = kp(demo, 0);
  delete first.card;
  first.lesson = "   ";
  const result = await structuralCheck(t, demo);
  assert.deepEqual(codes(result.diagnostics), ["card_missing", "lesson_missing"]);
});

test("同一个题目 id 用了两次时报出", async (t) => {
  const demo = demoCourse();
  const review = kp(demo, 0).review?.[0];
  assert.ok(review);
  review.id = "t01.k1.q1";
  const result = await structuralCheck(t, demo);
  assert.deepEqual(codes(result.diagnostics), ["duplicate_id"]);
});

test("来源许可不允许的用法和缺少署名说明都会报出", async (t) => {
  const demo = demoCourse();
  topic(demo, "t02").sources = [
    { source: "closed", where: "第 2 章", use: "adapt", notice: "改编自第 2 章" },
    { source: "open", where: "第 3 章", use: "code" },
    { source: "missing", where: "第 1 章", use: "reference" },
  ];
  const result = await structuralCheck(t, demo);
  assert.deepEqual(codes(result.diagnostics), ["source_notice_missing", "source_unknown", "source_use_not_permitted"]);
});

test("链接只能用 https 和 repa:concept，概念引用要指向存在的知识点", async (t) => {
  const demo = demoCourse();
  kp(demo, 0).lesson = "见[旧课](http://example.org)、[笔记](repa:note/1)、[不存在](repa:concept/t01.k9)和![图](https://example.org/a.png)。";
  const result = await structuralCheck(t, demo);
  assert.deepEqual(codes(result.diagnostics), ["concept_unknown", "link_scheme", "markdown_image", "repa_link_kind"]);
});

test("既没有程序核对也没列进 manual 的作答位会报出", async (t) => {
  const demo = demoCourse();
  const question = kp(demo, 0).practice?.[0];
  assert.ok(question);
  delete question.verify;
  const result = await structuralCheck(t, demo);
  assert.deepEqual(codes(result.diagnostics), ["unverified_slot"]);
});

test("复习和测验题池不收要由人或模型评的开放作答", async (t) => {
  const demo = demoCourse();
  const quiz = kp(demo, 0).quiz?.[0];
  assert.ok(quiz);
  quiz.slots.push({ id: "why", type: "text", lines: 3, rubric: [{ id: "reason", label: "说出原因" }] });
  const result = await structuralCheck(t, demo);
  assert.deepEqual(codes(result.diagnostics), ["pool_open_question"]);
});

test("一道题有两个按测试判的作答位时报出：多步代码题还不支持", async (t) => {
  const demo = demoCourse();
  const [code, parsons] = kp(demo, 1).practice ?? [];
  assert.ok(code && parsons);
  const second = parsons.slots[0];
  assert.ok(second);
  code.slots.push(structuredClone(second));
  const result = await structuralCheck(t, demo);
  assert.deepEqual(codes(result.diagnostics), ["multiple_code_slots"]);
});

test("标准答案不在选项里、单元格答案不是可选项时报出", async (t) => {
  const demo = demoCourse();
  const choice = kp(demo, 0).practice?.[2]?.slots[0] as ChoiceSlot;
  choice.key = "times";
  const table = kp(demo, 1).example?.slots[0] as TableSlot;
  const row = table.rows[0];
  assert.ok(row);
  row.cells.mask = "Maybe";
  const result = await structuralCheck(t, demo);
  // 标准答案自身拼出的作答也通不过结构检查，所以同时报 reference_rejected。
  assert.deepEqual(codes(result.diagnostics), ["key_unknown_option", "key_unknown_option", "reference_rejected", "reference_rejected"]);
});

test("登记的错误答案按判分规则其实判对时报出", async (t) => {
  const demo = demoCourse();
  const slot = kp(demo, 0).practice?.[0]?.slots[0];
  assert.ok(slot?.type === "text");
  slot.feedback = [{ when: " 3 ", message: "这是对的，不该当作错误答案。" }];
  const result = await structuralCheck(t, demo);
  assert.deepEqual(codes(result.diagnostics), ["feedback_not_wrong"]);
});

test("清单之外的 topic 文件、清单里缺文件、文件名与 id 不符都会报出", async (t) => {
  const demo = demoCourse();
  demo.course.topics.push("t03", "t06");
  const root = await writeCourse(t, demo);
  await writeFile(path.join(root, "topics", "t04.yaml"), "id: t04\n");
  await writeFile(path.join(root, "topics", "t03.yaml"), (await import("yaml")).stringify({ ...demo.topics.t02, id: "t05" }));
  const result = await checkCourse(root, { run: false, base: root });
  assert.deepEqual(codes(result.diagnostics), ["topic_id_mismatch", "topic_missing"]);
  // 清单之外的文件只提醒：去掉一部分时从清单删掉 id 就够了，不读那个文件。
  assert.deepEqual(result.diagnostics.filter((diagnostic) => diagnostic.severity === "warning").map((diagnostic) => diagnostic.code), ["topic_unlisted"]);
});

test("YAML 把 001 读成数字时，报出所在行并提示加引号", async (t) => {
  const demo = demoCourse();
  const root = await writeCourse(t, demo);
  await writeFile(path.join(root, "topics", "t02.yaml"), [
    "id: t02", "title: 001", "status: outline", "minutes: 20", "prerequisites: []", "sources: []",
    "kps:", "  - id: t02.k1", "    title: 第一个", "  - id: t02.k2", "    title: 第二个", "",
  ].join("\n"));
  const result = await checkCourse(root, { run: false, base: root });
  assert.deepEqual(codes(result.diagnostics), ["schema"]);
  const [problem] = result.diagnostics;
  assert.equal(problem?.file, "topics/t02.yaml");
  assert.equal(problem?.line, 2);
  assert.match(problem?.message ?? "", /引号/);
});

test("几种写法任选其一的位置，只报作者想写的那一种写法的问题", async (t) => {
  const demo = demoCourse();
  const root = await writeCourse(t, demo);
  const yaml = await import("yaml");
  const broken = structuredClone(demo.topics.t01) as unknown as { kps: { practice: { slots: Record<string, unknown>[] }[] }[] };
  const slot = broken.kps[0]?.practice[2]?.slots[0];
  assert.ok(slot);
  delete slot.key;
  await writeFile(path.join(root, "topics", "t01.yaml"), yaml.stringify(broken));
  const result = await checkCourse(root, { run: false, base: root });
  assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.message), ["kps[0].practice[2].slots[0]：缺少字段 key"]);
});

test("YAML 锚点和别名被拒绝", async (t) => {
  const demo = demoCourse();
  const root = await writeCourse(t, demo);
  await writeFile(path.join(root, "topics", "t02.yaml"), [
    "id: t02", "title: &name 骨架", "status: outline", "minutes: 20", "prerequisites: []", "sources: []",
    "kps:", "  - id: t02.k1", "    title: *name", "  - id: t02.k2", "    title: 第二个", "",
  ].join("\n"));
  const result = await checkCourse(root, { run: false, base: root });
  assert.deepEqual(codes(result.diagnostics), ["yaml_alias"]);
});

test("小表里写成 001、1e3 或没有声明 float 的小数时报出", async (t) => {
  const demo = demoCourse();
  const root = await writeCourse(t, demo);
  await writeFile(path.join(root, "topics", "t02.yaml"), [
    "id: t02", "title: 骨架", "status: outline", "minutes: 20", "prerequisites: []", "sources: []",
    "data:",
    "  table:",
    "    kind: dataframe",
    "    name: df",
    "    dtypes: { ratio: float }",
    "    columns:",
    "      code: [001, \"002\"]",
    "      size: [1e3, 2000]",
    "      weight: [1.5, 2.0]",
    "      ratio: [0.5, 1.0]",
    "kps:", "  - id: t02.k1", "    title: 第一个", "  - id: t02.k2", "    title: 第二个", "",
  ].join("\n"));
  const result = await checkCourse(root, { run: false, base: root });
  assert.deepEqual(codes(result.diagnostics), ["number_written_form", "number_written_form", "number_written_form", "number_written_form"]);
  assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.line), [13, 14, 15, 15]);
});

test("固定显示的格写成数字、按文字或显示内容比较的答案没加引号时报出", async (t) => {
  const demo = demoCourse();
  const table = kp(demo, 1).example?.slots[0] as TableSlot;
  const row = table.rows[0];
  assert.ok(row);
  row.cells.label = 5;
  const slot = kp(demo, 0).practice?.[0]?.slots[0];
  assert.ok(slot?.type === "text");
  slot.match = "output";
  slot.key = 3;
  const result = await structuralCheck(t, demo);
  assert.deepEqual(codes(result.diagnostics), ["cell_value_type", "key_type"]);
});

test("复习和测验题只有“非空即可”的小问时报出", async (t) => {
  const demo = demoCourse();
  const quiz = kp(demo, 0).quiz?.[0];
  assert.ok(quiz);
  quiz.slots = [{ id: "name", type: "text", match: "nonempty" }];
  delete quiz.verify;
  const result = await structuralCheck(t, demo);
  assert.deepEqual(codes(result.diagnostics), ["pool_ungraded"]);
});

test("要排缩进的排列题没有测试、doctest 的 >>> 后缺空格时报出", async (t) => {
  const demo = demoCourse();
  const practice = kp(demo, 1).practice ?? [];
  const parsons = practice[1]?.slots[0];
  assert.ok(parsons?.type === "order");
  delete parsons.tests;
  const code = practice[0]?.slots[0];
  assert.ok(code?.type === "code");
  const doctest = code.tests[0];
  assert.ok(doctest);
  doctest.doctest = ">>>double(2)\n4";
  const result = await structuralCheck(t, demo);
  assert.deepEqual(codes(result.diagnostics), ["doctest_parse", "indent_needs_tests", "unverified_slot"]);
});

test("doctest 超过 python.run 的上限时报出：例子太多或单个例子太长", async (t) => {
  const demo = demoCourse();
  const code = kp(demo, 1).practice?.[0]?.slots[0];
  assert.ok(code?.type === "code");
  const doctest = code.tests[0];
  assert.ok(doctest);
  doctest.doctest = Array.from({ length: 51 }, () => ">>> 1\n1").join("\n");
  assert.deepEqual(codes((await structuralCheck(t, demo)).diagnostics), ["doctest_too_large"]);
  doctest.doctest = `>>> ${"x".repeat(2_001)}\n1`;
  assert.deepEqual(codes((await structuralCheck(t, demo)).diagnostics), ["doctest_too_large"]);
});

test("单元格 input 写错字段名时只报那一处，并列出这里能写的字段", async (t) => {
  const demo = demoCourse();
  const root = await writeCourse(t, demo);
  const yaml = await import("yaml");
  const broken = structuredClone(demo.topics.t01) as unknown as { kps: { practice: { slots: { columns: Record<string, unknown>[] }[] }[] }[] };
  const column = broken.kps[1]?.practice[2]?.slots[0]?.columns[1];
  assert.ok(column);
  column.input = { type: "text", mtch: "output" };
  await writeFile(path.join(root, "topics", "t01.yaml"), yaml.stringify(broken));
  const result = await checkCourse(root, { run: false, base: root });
  assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.message), [
    "kps[1].practice[2].slots[0].columns[1].input：不认识的字段 mtch；这里能写的字段是 type、format、maxLength、lines、quick、match",
  ]);
});

test("有 verify 或代码题的课没写 runtime 时报出；题型标签可以是课程自定的词", async (t) => {
  const demo = demoCourse();
  const bare: Partial<typeof demo.course> = structuredClone(demo.course);
  delete bare.runtime;
  const result = await structuralCheck(t, { ...demo, course: bare as typeof demo.course });
  assert.deepEqual(codes(result.diagnostics), ["runtime_missing"]);
  assert.match(result.diagnostics[0]?.message ?? "", /课程清单要写 runtime/u);
  const labelled = demoCourse();
  const question = topic(labelled, "t01").kps[0]?.practice?.[0];
  assert.ok(question);
  question.kind = ["recall"];
  assert.deepEqual(codes((await structuralCheck(t, labelled)).diagnostics), []);
});

test("数值作答位只列进 manual 时检查不过，报错写明改用 verify；match 写成 text、不写 format 或答案等于题面里的数都不例外", async (t) => {
  const demo = demoCourse();
  const question = kp(demo, 0).practice?.[0];
  assert.ok(question && question.slots[0]?.type === "text");
  delete question.verify;
  question.manual = ["output"];
  const result = await structuralCheck(t, demo);
  assert.deepEqual(codes(result.diagnostics), ["numeric_manual"]);
  assert.match(result.diagnostics[0]?.message ?? "", /写一段 verify 程序把它算出来（最后写 answers = \{"output": 算出的数\}），再把 output 从 manual 里去掉/u);

  // 先来先服务里 P2 的等待时间恰好等于题面写着的 P1 运行时间，答案仍是算出来的。
  question.body = "P1 运行 5 毫秒、P2 运行 7 毫秒，同时到达。按先来先服务，P2 的等待时间是多少毫秒？";
  question.slots = [{ id: "output", type: "text", format: "integer", key: 5 }];
  assert.deepEqual(codes((await structuralCheck(t, demo)).diagnostics), ["numeric_manual"]);
  // 按文字比较而答案是数：format 写了 number 而 match 写成 text，或者干脆不写 format。
  question.slots = [{ id: "output", type: "text", format: "number", match: "text", key: "8.5" }];
  assert.deepEqual(codes((await structuralCheck(t, demo)).diagnostics), ["numeric_manual"]);
  question.slots = [{ id: "output", type: "text", key: ["8.5", "8.50"] }];
  assert.deepEqual(codes((await structuralCheck(t, demo)).diagnostics), ["numeric_manual"]);
  // 文字答案照常可以列进 manual。
  question.slots = [{ id: "output", type: "text", match: "text", key: ["就绪", "就绪态"] }];
  assert.deepEqual(codes((await structuralCheck(t, demo)).diagnostics), []);
});

test("展开了的 topic 的先修还是轮廓时报出：学习者学不到它", async (t) => {
  const demo = demoCourse();
  topic(demo, "t02").prerequisites = [];
  topic(demo, "t01").prerequisites = ["t02"];
  const result = await structuralCheck(t, demo);
  assert.deepEqual(codes(result.diagnostics), ["prerequisite_outline"]);
});

test("来源写 url 或 materials/ 里的课件，二者写一个；topic 与题目都能指到具体的页或张", async (t) => {
  const demo = demoCourse();
  demo.course.sources.slides = { title: "第一章课件", file: "materials/第一章.pptx", version: "学习者提供", license: "学习者自用", permits: ["reference"] };
  topic(demo, "t01").sources.push({ source: "slides", where: "第 3–8 张", use: "reference" });
  const question = kp(demo, 0).practice?.[0];
  assert.ok(question);
  question.sources = [{ source: "slides", where: "第 9 张的习题", use: "reference" }];
  assert.deepEqual(codes((await structuralCheck(t, demo)).diagnostics), []);

  question.sources = [{ source: "slides", where: "第 9 张的习题", use: "adapt" }];
  delete demo.course.sources.open?.url;
  demo.course.sources.closed = { ...demo.course.sources.closed!, file: "materials/书.pdf" };
  assert.deepEqual(codes((await structuralCheck(t, demo)).diagnostics), ["source_location", "source_location", "source_notice_missing", "source_use_not_permitted"]);

  demo.course.sources.slides.file = "materials/../.repa/x.pdf";
  assert.ok(codes((await structuralCheck(t, demo)).diagnostics).includes("schema"));
});
