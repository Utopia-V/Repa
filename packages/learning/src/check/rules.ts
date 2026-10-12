/**
 * 不需要运行代码的检查：标识、先修图、完整性、来源许可、链接与概念引用，以及每个作答位的标准答案是否自洽。
 */

import { isScalar, isSeq } from "yaml";

import type { Content } from "@repa/base/protocol";
import type { Report, ValuePath } from "../format/diagnostics.js";
import type { LoadedCourse, LoadedTopic } from "../format/load.js";
import { markdownLinks, markdownTexts, toContent } from "../format/markdown.js";
import type { ContentInput, Kp, Question, SlotDef, Topic } from "../format/schema.js";
import { parseDoctest } from "./doctest.js";
import { acceptedValues, inputCells, slotTests, tableCell, textMatch, topicQuestions, type QuestionEntry } from "./items.js";

export interface CourseIndex {
  topics: Map<string, LoadedTopic>;
  kps: Map<string, { loaded: LoadedTopic; kp: Kp }>;
  questions: Map<string, { loaded: LoadedTopic; entry: QuestionEntry }>;
  /** 每个 topic 的全部先修祖先（不含自身）。 */
  ancestors: Map<string, Set<string>>;
}

/** 需要人工核对或由测试、评分要点负责的作答位。 */
export function slotNeedsVerification(slot: SlotDef): boolean {
  if (slot.type === "code") return false;
  if (slot.type === "order" && slot.tests) return false;
  if (slot.type === "text" && (slot.rubric || textMatch(slot) === "nonempty")) return false;
  return true;
}

/** 有标准答案、由程序判分的作答位。 */
function gradable(slot: SlotDef): boolean {
  if (slot.type !== "text") return true;
  return !slot.rubric && textMatch(slot) !== "nonempty";
}

export const MIN_KPS = 2;
export const MAX_KPS = 4;
export const MIN_PRACTICE = 3;

class TopicChecker {
  constructor(
    private readonly loaded: LoadedTopic,
    private readonly course: LoadedCourse,
    private readonly index: CourseIndex,
    private readonly report: Report,
  ) {}

  private get topic(): Topic {
    return this.loaded.topic;
  }

  private error(code: string, message: string, at: ValuePath): void {
    this.report.error(code, message, this.loaded.file, at);
  }

  run(): void {
    this.checkKps();
    this.checkPrerequisites();
    this.checkSources();
    this.checkFixtures();
    this.checkContentInput(this.topic.intro, ["intro"]);
    this.checkContentInput(this.topic.wrapup, ["wrapup"]);
    this.topic.kps.forEach((kp, kpIndex) => this.checkKp(kp, kpIndex));
    for (const entry of topicQuestions(this.topic)) this.checkQuestion(entry);
  }

  private checkKps(): void {
    const count = this.topic.kps.length;
    if (count < MIN_KPS || count > MAX_KPS) {
      this.error("kp_count", `一个 topic 应有 ${MIN_KPS}–${MAX_KPS} 个知识点，这里有 ${count} 个`, ["kps"]);
    }
    this.topic.kps.forEach((kp, kpIndex) => {
      if (!kp.id.startsWith(`${this.topic.id}.`)) {
        this.error("kp_id_prefix", `知识点 ${kp.id} 的 id 应以 ${this.topic.id}. 开头`, ["kps", kpIndex, "id"]);
      }
    });
  }

  private checkPrerequisites(): void {
    const seen = new Set<string>();
    this.topic.prerequisites.forEach((edge, index) => {
      const at = ["prerequisites", index];
      if (edge.topic === this.topic.id) {
        this.error("prerequisite_self", "topic 不能以自己为先修", [...at, "topic"]);
        return;
      }
      if (seen.has(edge.topic)) this.error("prerequisite_duplicate", `先修 ${edge.topic} 写了两次`, [...at, "topic"]);
      seen.add(edge.topic);
      if (!this.course.course.topics.includes(edge.topic)) {
        this.error("prerequisite_unknown", `先修 ${edge.topic} 不在课程清单里`, [...at, "topic"]);
        return;
      }
      const target = this.index.topics.get(edge.topic);
      if (!target) return;
      const kps = new Set(target.topic.kps.map((kp) => kp.id));
      edge.covers.forEach((kp, kpIndex) => {
        if (!kps.has(kp)) this.error("prerequisite_covers", `${kp} 不是 ${edge.topic} 的知识点`, [...at, "covers", kpIndex]);
      });
      if (new Set(edge.covers).size !== edge.covers.length) this.error("prerequisite_covers", "covers 里有重复的知识点", [...at, "covers"]);
    });
  }

  private checkSources(): void {
    this.topic.sources.forEach((use, index) => {
      const at = ["sources", index];
      const source = this.course.course.sources[use.source];
      if (!source) {
        this.error("source_unknown", `来源 ${use.source} 没有登记在课程清单的 sources 里`, [...at, "source"]);
        return;
      }
      if (!source.permits.includes(use.use)) {
        this.error(
          "source_use_not_permitted",
          `${source.title} 的许可只允许 ${source.permits.join("、")}，不能用作 ${use.use}`,
          [...at, "use"],
        );
      }
      if (use.use !== "reference" && !use.notice) {
        this.error("source_notice_missing", "改编、复用代码或引用时要写 notice：署名、许可和修改说明", at);
      }
    });
  }

  private checkFixtures(): void {
    for (const [name, fixture] of Object.entries(this.topic.data ?? {})) {
      const at = ["data", name];
      if (fixture.kind === "python") {
        this.checkContentInput(fixture.display, [...at, "display"]);
        continue;
      }
      const lengths = new Set(Object.values(fixture.columns).map((values) => values.length));
      if (fixture.index) lengths.add(fixture.index.length);
      if (Object.keys(fixture.columns).length === 0) this.error("fixture_shape", `数据 ${name} 没有列`, [...at, "columns"]);
      if (lengths.size > 1) this.error("fixture_shape", `数据 ${name} 的各列和 index 长度不一致`, at);
      if (fixture.index && new Set(fixture.index.map(String)).size !== fixture.index.length) {
        this.error("fixture_shape", `数据 ${name} 的 index 有重复标签；需要重复标签的题请用 python 夹具明确写出`, [...at, "index"]);
      }
      for (const column of Object.keys(fixture.dtypes ?? {})) {
        if (!(column in fixture.columns)) this.error("fixture_dtypes", `dtypes 里的 ${column} 不是数据 ${name} 的列`, [...at, "dtypes", column]);
      }
      this.checkWrittenNumbers([...at, "index"], false);
      for (const column of Object.keys(fixture.columns)) {
        this.checkWrittenNumbers([...at, "columns", column], fixture.dtypes?.[column] === "float");
      }
    }
  }

  /**
   * YAML 读出的数不保留写法：001 成了 1，1.0 成了和 1 一样的数，1e3 成了 1000。
   * 小表的值会原样显示给学生，也决定 pandas 推断的类型，所以按源文件里的写法检查。
   */
  private checkWrittenNumbers(at: ValuePath, float: boolean): void {
    const node = this.loaded.file.document.getIn(at, true);
    if (!isSeq(node)) return;
    node.items.forEach((item, index) => {
      if (!isScalar(item) || typeof item.value !== "number") return;
      const written = item.source ?? String(item.value);
      const where = [...at, index];
      if (/^[+-]?[0-9]+$/.test(written)) {
        if (String(item.value) !== written.replace(/^\+/, "")) {
          this.error("number_written_form", `${written} 会被读成 ${item.value}；当文字（例如编号）时加引号`, where);
        }
      } else if (/^[+-]?([0-9]+\.[0-9]*|\.[0-9]+)$/.test(written)) {
        if (!float) this.error("number_written_form", `这一列写了小数 ${written}；要当浮点数就在 dtypes 里声明这一列为 float，否则写成整数或加引号`, where);
      } else {
        this.error("number_written_form", `${written} 请用普通的十进制写法，或者加引号当文字`, where);
      }
    });
  }

  private checkKp(kp: Kp, kpIndex: number): void {
    const at: ValuePath = ["kps", kpIndex];
    this.checkContentInput(kp.lesson, [...at, "lesson"]);
    if (kp.card) {
      this.checkContentInput(kp.card.example.text, [...at, "card", "example", "text"]);
      const from = [kp.example, ...(kp.practice ?? [])].find((question) => question?.id === kp.card?.example.from);
      if (!from) {
        this.error("card_example_unknown", `卡片的例子要来自本知识点的例题或练习题，找不到 ${kp.card.example.from}`, [...at, "card", "example", "from"]);
      }
    }
    if (this.topic.status !== "complete") return;
    if (!kp.card) this.error("card_missing", `${kp.id} 缺少概念卡 card`, at);
    if (kp.lesson === undefined || toContent(kp.lesson).content.length === 0) this.error("lesson_missing", `${kp.id} 缺少讲解 lesson`, at);
    if (!kp.example) this.error("example_missing", `${kp.id} 缺少例题 example`, at);
    const practice = kp.practice?.length ?? 0;
    if (practice < MIN_PRACTICE) this.error("practice_too_few", `${kp.id} 至少要有 ${MIN_PRACTICE} 道练习，现在有 ${practice} 道`, at);
    if ((kp.review?.length ?? 0) === 0) this.error("review_missing", `${kp.id} 缺少复习题池 review`, at);
    if ((kp.quiz?.length ?? 0) === 0) this.error("quiz_missing", `${kp.id} 缺少测验题池 quiz`, at);
  }

  private checkQuestion(entry: QuestionEntry): void {
    const { question, kp, at } = entry;
    if (!question.id.startsWith(`${kp.id}.`)) this.error("question_id_prefix", `题目 ${question.id} 的 id 应以 ${kp.id}. 开头`, [...at, "id"]);
    for (const [index, name] of (question.data ?? []).entries()) {
      if (!this.topic.data?.[name]) this.error("data_unknown", `题目用到的数据 ${name} 没有在 topic 的 data 里定义`, [...at, "data", index]);
    }
    const dataframes = (question.data ?? []).flatMap((name) => {
      const fixture = this.topic.data?.[name];
      return fixture?.kind === "dataframe" ? [fixture.name] : [];
    });
    if (new Set(dataframes).size !== dataframes.length) this.error("fixture_conflict", "同一道题的两份小表用了同一个变量名", [...at, "data"]);
    this.checkContentInput(question.body, [...at, "body"]);
    this.checkContentInput(question.explanation, [...at, "explanation"]);
    if (toContent(question.explanation).content.length === 0) this.error("explanation_missing", `题目 ${question.id} 缺少解析 explanation`, [...at, "explanation"]);
    const slotIds = new Set<string>();
    question.slots.forEach((slot, slotIndex) => {
      if (slotIds.has(slot.id)) this.error("duplicate_slot", `作答位 ${slot.id} 重复`, [...at, "slots", slotIndex, "id"]);
      slotIds.add(slot.id);
      this.checkContentInput(slot.prompt, [...at, "slots", slotIndex, "prompt"]);
      this.checkSlot(question, slot, [...at, "slots", slotIndex]);
    });
    this.checkVerification(question, at);
    if ((entry.pool === "review" || entry.pool === "quiz") && question.slots.some((slot) => slot.type === "text" && slot.rubric)) {
      this.error("pool_open_question", "复习和测验题要由程序判分；含开放作答（rubric）的题只能放在例题或练习里", at);
    }
    if ((entry.pool === "review" || entry.pool === "quiz") && !question.slots.some(gradable)) {
      this.error("pool_ungraded", "复习和测验题至少要有一个有标准答案、由程序判分的作答位；只要求非空的小问总是判对", at);
    }
    this.checkKpReferences(question, at);
  }

  private checkVerification(question: Question, at: ValuePath): void {
    const slots = new Map(question.slots.map((slot) => [slot.id, slot]));
    for (const [index, id] of (question.manual ?? []).entries()) {
      const slot = slots.get(id);
      if (!slot) {
        this.error("manual_unknown", `manual 里的 ${id} 不是这道题的作答位`, [...at, "manual", index]);
      } else if (!slotNeedsVerification(slot)) {
        this.error("manual_needless", `${id} 由测试或评分要点负责，不用列进 manual`, [...at, "manual", index]);
      }
    }
    if (question.verify === undefined) {
      const manual = new Set(question.manual ?? []);
      for (const slot of question.slots) {
        if (slotNeedsVerification(slot) && !manual.has(slot.id)) {
          this.error("unverified_slot", `作答位 ${slot.id} 既没有 verify 程序核对，也没有列进 manual`, at);
        }
      }
    }
  }

  private checkKpReferences(question: Question, at: ValuePath): void {
    const ancestors = this.index.ancestors.get(this.topic.id) ?? new Set<string>();
    for (const field of ["measures", "uses"] as const) {
      (question[field] ?? []).forEach((kpId, index) => {
        const target = this.index.kps.get(kpId);
        if (!target) {
          this.error("kp_unknown", `${field} 里的 ${kpId} 不是课程里的知识点`, [...at, field, index]);
          return;
        }
        const owner = target.loaded.topic.id;
        if (field === "measures" && owner !== this.topic.id) {
          this.error("measures_other_topic", `measures 只写本 topic 的知识点；用到的先修写进 uses`, [...at, field, index]);
        }
        if (field === "uses" && owner !== this.topic.id && !ancestors.has(owner)) {
          this.error("uses_not_prerequisite", `${kpId} 所在的 ${owner} 不是本 topic 的先修（直接或间接）`, [...at, field, index]);
        }
      });
    }
  }

  private checkSlot(question: Question, slot: SlotDef, at: ValuePath): void {
    switch (slot.type) {
      case "choice": {
        const options = new Set<string>();
        slot.options.forEach((option, index) => {
          if (options.has(option.id)) this.error("duplicate_option", `选项 ${option.id} 重复`, [...at, "options", index, "id"]);
          options.add(option.id);
          this.checkContentInput(option.content, [...at, "options", index, "content"]);
          this.checkContentInput(option.feedback, [...at, "options", index, "feedback"]);
        });
        const key = Array.isArray(slot.key) ? slot.key : [slot.key];
        if (!slot.multiple && Array.isArray(slot.key)) this.error("key_shape", "单选题的 key 写一个选项 id；多选题要加 multiple: true", [...at, "key"]);
        if (slot.multiple && !Array.isArray(slot.key)) this.error("key_shape", "多选题的 key 写成选项 id 列表", [...at, "key"]);
        for (const id of key) if (!options.has(id)) this.error("key_unknown_option", `key 里的 ${id} 不是选项`, [...at, "key"]);
        if (slot.multiple && (key.length < (slot.minSelected ?? 1) || key.length > (slot.maxSelected ?? slot.options.length))) {
          this.error("key_count", "标准答案的选项个数超出了 minSelected/maxSelected 的范围", [...at, "key"]);
        }
        if (slot.scoring === "options" && !slot.multiple) this.error("scoring_single", "scoring: options 只用于多选题", [...at, "scoring"]);
        return;
      }
      case "text": {
        const match = textMatch(slot);
        if (slot.rubric && slot.key !== undefined) this.error("key_and_rubric", "开放作答用 rubric，不再写 key", at);
        if (!slot.rubric && match !== "nonempty" && slot.key === undefined) this.error("key_missing", `作答位 ${slot.id} 缺少标准答案 key`, at);
        if (match === "nonempty" && slot.key !== undefined) this.error("key_unexpected", "match: nonempty 只要求非空，不写 key", [...at, "key"]);
        if (match === "integer" && acceptedValues(slot).some((value) => typeof value === "number" && !Number.isInteger(value))) {
          this.error("key_type", "match 为 integer 时，数值答案必须是整数", [...at, "key"]);
        }
        if (slot.tolerance !== undefined && match !== "number") this.error("tolerance_unused", "tolerance 只用于 match: number", [...at, "tolerance"]);
        if ((match === "text" || match === "output") && acceptedValues(slot).some((value) => typeof value !== "string")) {
          this.error("key_type", `match 为 ${match} 时答案写成带引号的文字；YAML 会把 5.0 读成 5、把 true 读成布尔值`, [...at, "key"]);
        }
        slot.feedback?.forEach((item, index) => {
          this.checkContentInput(item.message, [...at, "feedback", index, "message"]);
          if ((match === "text" || match === "output") && typeof item.when !== "string") {
            this.error("key_type", `match 为 ${match} 时 when 写成带引号的文字`, [...at, "feedback", index, "when"]);
          }
        });
        if (slot.rubric && new Set(slot.rubric.map((criterion) => criterion.id)).size !== slot.rubric.length) {
          this.error("duplicate_criterion", "rubric 的要点 id 重复", [...at, "rubric"]);
        }
        return;
      }
      case "order":
        this.checkOrder(slot, at, question);
        this.checkTests(slot, at);
        return;
      case "table":
        this.checkTable(slot, at);
        return;
      case "code":
        this.checkTests(slot, at);
        return;
    }
  }

  private checkOrder(slot: Extract<SlotDef, { type: "order" }>, at: ValuePath, question: Question): void {
    const items = new Set<string>();
    slot.items.forEach((item, index) => {
      if (items.has(item.id)) this.error("duplicate_option", `块 ${item.id} 重复`, [...at, "items", index, "id"]);
      items.add(item.id);
      if ((item.content === undefined) === (item.code === undefined)) {
        this.error("order_item_content", "每个块写 content 或 code 其中之一", [...at, "items", index]);
      }
      this.checkContentInput(item.content, [...at, "items", index, "content"]);
      if (slot.tests && item.code === undefined) this.error("order_item_code", "按测试判的排列题，每个块都要用 code 写一行代码", [...at, "items", index]);
    });
    const sequences = [slot.key, ...(slot.alternatives ?? [])];
    sequences.forEach((sequence, index) => {
      const where = index === 0 ? [...at, "key"] : [...at, "alternatives", index - 1];
      for (const id of sequence) if (!items.has(id)) this.error("key_unknown_item", `排列里的 ${id} 不是块`, where);
      if (new Set(sequence).size !== sequence.length) this.error("key_duplicate", "排列里同一块出现了两次", where);
      if (!slot.partial && sequence.length !== slot.items.length) this.error("key_incomplete", "不是 partial 的排列题，标准排列要用上全部块", where);
    });
    if (slot.indent === undefined && slot.indents !== undefined) this.error("indents_unused", "没有设置 indent，不需要 indents", [...at, "indents"]);
    for (const [id, level] of Object.entries(slot.indents ?? {})) {
      if (!items.has(id)) this.error("indents_unknown_item", `indents 里的 ${id} 不是块`, [...at, "indents", id]);
      if (slot.indent !== undefined && level > slot.indent) this.error("indents_too_deep", `${id} 的缩进超过了 indent: ${slot.indent}`, [...at, "indents", id]);
    }
    // 程序核对只能给出块的顺序，缩进对不对要拼成代码运行才知道。
    if (slot.indent !== undefined && !slot.tests && !(question.manual ?? []).includes(slot.id)) {
      this.error("indent_needs_tests", "要排缩进的排列题按测试判：加 tests，或者把这一小问列进 manual", at);
    }
  }

  private checkTable(slot: Extract<SlotDef, { type: "table" }>, at: ValuePath): void {
    const columns = new Set<string>();
    slot.columns.forEach((column, index) => {
      if (columns.has(column.id)) this.error("duplicate_column", `列 ${column.id} 重复`, [...at, "columns", index, "id"]);
      columns.add(column.id);
    });
    const rows = new Set<string>();
    slot.rows.forEach((row, index) => {
      if (rows.has(row.id)) this.error("duplicate_row", `行 ${row.id} 重复`, [...at, "rows", index, "id"]);
      rows.add(row.id);
      for (const column of Object.keys(row.cells)) {
        if (!columns.has(column)) this.error("cell_unknown_column", `行 ${row.id} 的 ${column} 不是表格的列`, [...at, "rows", index, "cells", column]);
      }
      for (const column of columns) {
        if (!(column in row.cells)) this.error("cell_missing", `行 ${row.id} 缺少 ${column} 列的单元格`, [...at, "rows", index, "cells"]);
      }
    });
    slot.rows.forEach((row, index) => {
      for (const column of slot.columns) {
        const cell = tableCell(slot, row, column.id);
        const raw = row.cells[column.id];
        if (cell?.kind === "fixed" && typeof raw !== "string" && typeof raw !== "object") {
          this.error("cell_value_type", `行 ${row.id} 的 ${column.id} 是固定显示的文字，写成带引号的字符串，免得 YAML 改掉写法`, [...at, "rows", index, "cells", column.id]);
        }
      }
    });
    const cells = inputCells(slot);
    if (cells.length === 0) this.error("table_without_input", "表格里没有需要作答的格；给作答列加 input", at);
    for (const { row, column, cell } of cells) {
      const where = [...at, "rows", slot.rows.findIndex((candidate) => candidate.id === row), "cells", column];
      if (cell.match === "choice") {
        const options = cell.input.type === "choice" ? cell.input.options.map((option) => option.id) : [];
        const key = typeof cell.key === "boolean" ? (cell.key ? "True" : "False") : String(cell.key);
        if (!options.includes(key)) this.error("key_unknown_option", `单元格答案 ${key} 不是可选项（${options.join("、")}）`, where);
      } else if (cell.match === "integer" && typeof cell.key === "number" && !Number.isInteger(cell.key)) {
        this.error("key_type", "整数格的数值答案必须是整数", where);
      } else if ((cell.match === "text" || cell.match === "output") && typeof cell.key !== "string") {
        this.error("key_type", `match 为 ${cell.match} 的格，答案写成带引号的文字`, where);
      }
    }
  }

  private checkTests(slot: SlotDef, at: ValuePath): void {
    const tests = slotTests(slot);
    const names = new Set<string>();
    tests.forEach((test, index) => {
      const where = [...at, "tests", index];
      if (names.has(test.name)) this.error("duplicate_test", `测试名 ${test.name} 重复`, [...where, "name"]);
      names.add(test.name);
      if (test.expect === undefined && test.doctest === undefined && test.stdout === undefined) {
        this.error("test_without_check", "测试至少要写 expect、doctest、stdout 之一", where);
      }
      if (test.doctest !== undefined) {
        const parsed = parseDoctest(test.doctest);
        for (const problem of parsed.problems) this.error("doctest_parse", problem, [...where, "doctest"]);
        if (parsed.examples.length === 0 && parsed.problems.length === 0) this.error("doctest_parse", "doctest 里没有找到 >>> 开头的例子", [...where, "doctest"]);
      }
      for (const [dataIndex, name] of (test.data ?? []).entries()) {
        if (!this.topic.data?.[name]) this.error("data_unknown", `测试用到的数据 ${name} 没有在 topic 的 data 里定义`, [...where, "data", dataIndex]);
      }
    });
    if (slot.type === "code" && tests.every((test) => test.hidden)) {
      this.error("tests_all_hidden", "至少留一个公开测试，学生才知道作答要满足什么", [...at, "tests"]);
    }
  }

  /** 内容块里的围栏、链接协议、插图和概念引用。 */
  checkContentInput(input: ContentInput | undefined, at: ValuePath): void {
    if (input === undefined) return;
    const { content, problems } = toContent(input);
    for (const problem of problems) this.error("markdown_fence", problem, at);
    this.checkLinks(content, at);
  }

  private checkLinks(content: Content, at: ValuePath): void {
    for (const text of markdownTexts(content)) {
      for (const link of markdownLinks(text)) {
        if (link.image) {
          this.error("markdown_image", "题面和讲解不用 ![]() 插图；插图用 image 内容块", at);
          continue;
        }
        if (link.url.startsWith("https:")) continue;
        if (!link.url.startsWith("repa:")) {
          this.error("link_scheme", `链接只能用 https: 或 repa:，这里是 ${link.url}`, at);
          continue;
        }
        const reference = /^repa:([a-z]+)\/(.+)$/.exec(link.url);
        if (!reference || reference[1] !== "concept") {
          this.error("repa_link_kind", `学习插件目前只提供 repa:concept/<知识点 id> 引用，这里是 ${link.url}`, at);
        } else if (!this.index.kps.has(reference[2] ?? "")) {
          this.error("concept_unknown", `概念引用 ${link.url} 指向的知识点不存在`, at);
        }
      }
    }
  }
}

/** 返回每个 topic 的全部祖先，并报告先修图里的环。 */
function prerequisiteGraph(course: LoadedCourse, report: Report): Map<string, Set<string>> {
  const edges = new Map(course.topics.map(({ topic }) => [topic.id, topic.prerequisites.map((edge) => edge.topic).filter((id) => id !== topic.id)]));
  const files = new Map(course.topics.map((loaded) => [loaded.topic.id, loaded]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const reported = new Set<string>();
  const visit = (id: string): void => {
    state.set(id, "visiting");
    stack.push(id);
    for (const next of edges.get(id) ?? []) {
      if (!edges.has(next)) continue;
      if (state.get(next) === "visiting") {
        const cycle = [...stack.slice(stack.indexOf(next)), next];
        const signature = [...new Set(cycle)].sort().join(",");
        if (!reported.has(signature)) {
          reported.add(signature);
          const owner = files.get(id);
          const edgeIndex = owner?.topic.prerequisites.findIndex((edge) => edge.topic === next) ?? -1;
          report.error("prerequisite_cycle", `先修关系成环：${cycle.join(" → ")}`, owner?.file, ["prerequisites", edgeIndex]);
        }
      } else if (!state.has(next)) {
        visit(next);
      }
    }
    stack.pop();
    state.set(id, "done");
  };
  for (const id of edges.keys()) if (!state.has(id)) visit(id);

  const ancestors = new Map<string, Set<string>>();
  const collect = (id: string, seen: Set<string>): void => {
    for (const next of edges.get(id) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      collect(next, seen);
    }
  };
  for (const id of edges.keys()) {
    const seen = new Set<string>();
    collect(id, seen);
    seen.delete(id);
    ancestors.set(id, seen);
  }
  return ancestors;
}

export function checkRules(course: LoadedCourse, report: Report): CourseIndex {
  const index: CourseIndex = { topics: new Map(), kps: new Map(), questions: new Map(), ancestors: new Map() };
  for (const loaded of course.topics) {
    index.topics.set(loaded.topic.id, loaded);
    loaded.topic.kps.forEach((kp, kpIndex) => {
      const previous = index.kps.get(kp.id);
      if (previous) {
        report.error("duplicate_id", `知识点 id ${kp.id} 与 ${previous.loaded.topic.id} 里的重复`, loaded.file, ["kps", kpIndex, "id"]);
        return;
      }
      index.kps.set(kp.id, { loaded, kp });
    });
    for (const entry of topicQuestions(loaded.topic)) {
      const previous = index.questions.get(entry.question.id);
      if (previous) {
        report.error("duplicate_id", `题目 id ${entry.question.id} 重复（另一处在 ${previous.loaded.topic.id}）`, loaded.file, [...entry.at, "id"]);
        continue;
      }
      index.questions.set(entry.question.id, { loaded, entry });
    }
  }
  index.ancestors = prerequisiteGraph(course, report);
  for (const loaded of course.topics) new TopicChecker(loaded, course, index, report).run();
  return index;
}
