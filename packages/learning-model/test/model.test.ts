import assert from "node:assert/strict";
import test from "node:test";

import {
  applyRepetition, intervalFor, isDue, memoryAt, repetitionWeights, selectTasks,
  type KnowledgeGraph, type Student, type TopicState,
} from "../src/index.js";

const multiplication: KnowledgeGraph = {
  topics: ["one-digit-multiplication", "two-digit-plus-one-digit", "two-digit-times-one-digit"],
  prerequisites: [
    { topic: "two-digit-times-one-digit", prerequisite: "one-digit-multiplication" },
    { topic: "two-digit-times-one-digit", prerequisite: "two-digit-plus-one-digit" },
  ],
  encompassings: [
    { advanced: "two-digit-times-one-digit", simple: "one-digit-multiplication", weight: 1 },
    { advanced: "two-digit-times-one-digit", simple: "two-digit-plus-one-digit", weight: 1 },
  ],
};

function learned(graph: KnowledgeGraph): Student {
  return Object.fromEntries(graph.topics.map((id) => [id, {
    repNum: 1, memory: 1, speed: 1, lastRepetitionDay: 0, interval: intervalFor(1),
  }]));
}

function state(student: Student, id: string): TopicState {
  const value = student[id];
  assert.ok(value);
  return value;
}

function close(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
}

test("文章的乘法例子：一次两位数乘一位数复习消除三项到期复习", () => {
  const student = learned(multiplication);
  assert.ok(multiplication.topics.every((id) => isDue(state(student, id), 1)));
  const tasks = selectTasks(multiplication, student, 1);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.topicId, "two-digit-times-one-digit");
  assert.deepEqual(tasks[0]?.reason.clearsOnPass, multiplication.topics);
  const next = applyRepetition(multiplication, student, {
    topicId: "two-digit-times-one-digit", day: 1, outcome: "pass",
  });
  for (const id of multiplication.topics) {
    assert.equal(state(next, id).repNum, 2);
    assert.equal(state(next, id).memory, 1);
    assert.equal(isDue(state(next, id), 1), false);
  }
  assert.equal(state(student, "two-digit-times-one-digit").repNum, 1);
});

test("文章的反向例子：简单加法失败惩罚高级乘法，不惩罚旁支乘法", () => {
  const student = learned(multiplication);
  const next = applyRepetition(multiplication, student, {
    topicId: "two-digit-plus-one-digit", day: 1, outcome: "fail",
  });
  assert.equal(state(next, "two-digit-times-one-digit").repNum, 0);
  assert.equal(state(next, "two-digit-times-one-digit").memory, 0);
  assert.equal(state(next, "two-digit-times-one-digit").speed, 1);
  assert.equal(state(next, "two-digit-plus-one-digit").speed, 0.8);
  assert.deepEqual(next["one-digit-multiplication"], student["one-digit-multiplication"]);
});

test("文章的完全包含链：每次学新主题时，到期的下层主题都得到完整隐式 repetition", () => {
  const graph: KnowledgeGraph = {
    topics: ["a", "b", "c", "d"],
    prerequisites: [
      { topic: "b", prerequisite: "a" }, { topic: "c", prerequisite: "b" }, { topic: "d", prerequisite: "c" },
    ],
    encompassings: [
      { advanced: "b", simple: "a", weight: 1 },
      { advanced: "c", simple: "b", weight: 1 },
      { advanced: "d", simple: "c", weight: 1 },
    ],
  };
  let student: Student = {};
  let day = 0;
  for (const topicId of graph.topics) {
    const previous = student;
    student = applyRepetition(graph, student, { topicId, day, outcome: "pass" });
    for (const [id, old] of Object.entries(previous)) {
      assert.equal(repetitionWeights(graph, topicId, "pass").get(id), 1);
      assert.equal(state(student, id).repNum, old.repNum + 1);
    }
    day = 2 * day + 1;
  }
  assert.deepEqual(graph.topics.map((id) => state(student, id).repNum), [4, 3, 2, 1]);
});

test("部分包含链沿路径相乘，成功下传和失败上传都逐层衰减", () => {
  const graph: KnowledgeGraph = {
    topics: ["a", "b", "c"], prerequisites: [],
    encompassings: [
      { advanced: "c", simple: "b", weight: 0.5 },
      { advanced: "b", simple: "a", weight: 0.5 },
    ],
  };
  const student = learned(graph);
  const pass = applyRepetition(graph, student, { topicId: "c", day: 1, outcome: "pass" });
  assert.equal(state(pass, "b").repNum, 1.5);
  assert.equal(state(pass, "a").repNum, 1.25);
  const fail = applyRepetition(graph, student, { topicId: "a", day: 1, outcome: "fail" });
  assert.equal(state(fail, "b").repNum, 0.5);
  assert.equal(state(fail, "c").repNum, 0.75);
});

test("菱形和冗余边取最大路径，不因遍历顺序或路径数量重复计分", () => {
  const graph: KnowledgeGraph = {
    topics: ["a", "b", "c", "d"], prerequisites: [],
    encompassings: [
      { advanced: "d", simple: "b", weight: 0.5 },
      { advanced: "d", simple: "c", weight: 0.5 },
      { advanced: "b", simple: "a", weight: 0.5 },
      { advanced: "c", simple: "a", weight: 0.5 },
      { advanced: "d", simple: "a", weight: 0.25 },
    ],
  };
  assert.equal(repetitionWeights(graph, "d", "pass").get("a"), 0.25);
  const reverse = { ...graph, encompassings: [...graph.encompassings].reverse() };
  const student = learned(graph);
  const repetition = { topicId: "d", day: 1, outcome: "pass" } as const;
  assert.deepEqual(applyRepetition(graph, student, repetition), applyRepetition(reverse, student, repetition));
});

test("低速主题拒收正隐式信用，但不阻断更下层、不拒绝显式复习或负隐式惩罚", () => {
  const graph: KnowledgeGraph = {
    topics: ["a", "b", "c"], prerequisites: [],
    encompassings: [
      { advanced: "c", simple: "b", weight: 1 }, { advanced: "b", simple: "a", weight: 1 },
    ],
  };
  const student = learned(graph);
  state(student, "b").speed = 0.5;
  state(student, "c").speed = 0.5;
  const next = applyRepetition(graph, student, { topicId: "c", day: 1, outcome: "pass" });
  assert.deepEqual(next.b, student.b);
  assert.equal(state(next, "a").repNum, 2);
  assert.equal(state(next, "c").repNum, 1.5);
  const failed = applyRepetition(graph, student, { topicId: "a", day: 1, outcome: "fail" });
  assert.equal(state(failed, "b").repNum, 0.5);
  assert.equal(state(failed, "c").repNum, 0.5);
});

test("提前复习在接收主题按自身 memory 折扣，失败也折扣，间隔随小数 repNum 更新", () => {
  const graph = { ...multiplication, encompassings: [] };
  const student = learned(graph);
  const topicId = "one-digit-multiplication";
  const pass = applyRepetition(graph, student, { topicId, day: 0.5, outcome: "pass", quality: 0.5 });
  const rawDelta = (1 - Math.sqrt(0.5));
  close(state(pass, topicId).repNum, 1 + rawDelta);
  close(state(pass, topicId).interval, 2 ** rawDelta);
  close(state(pass, topicId).memory, (1 + rawDelta) * Math.sqrt(0.5));
  const fail = applyRepetition(graph, student, { topicId, day: 0.5, outcome: "fail", quality: 0.5 });
  close(state(fail, topicId).repNum, 1 - rawDelta);
});

test("逾期倍数只放大失败的 repNum 回退，memory 保留公开公式的加法顺序", () => {
  const graph: KnowledgeGraph = { topics: ["a"], prerequisites: [], encompassings: [] };
  const student: Student = { a: { repNum: 1, memory: 1, speed: 1, lastRepetitionDay: 0, interval: 1 } };
  const fail = applyRepetition(graph, student, { topicId: "a", day: 3, outcome: "fail", quality: 0.25 });
  assert.equal(state(fail, "a").repNum, 0.25);
  assert.equal(state(fail, "a").memory, 0.75 * 0.125);
  const pass = applyRepetition(graph, student, { topicId: "a", day: 3, outcome: "pass", quality: 0.25 });
  assert.equal(state(pass, "a").repNum, 1.25);
  assert.equal(state(pass, "a").memory, 1.25 * 0.125);
  assert.equal(isDue(state(pass, "a"), 3), true);
});

test("查询只读投影，重复查询不改变后续更新，repNum 和 memory 的失败结果不小于零", () => {
  const student = learned(multiplication);
  const original = structuredClone(student);
  const topicId = "two-digit-times-one-digit";
  memoryAt(state(student, topicId), 0.5);
  memoryAt(state(student, topicId), 1);
  assert.deepEqual(student, original);
  const repetition = { topicId, day: 20, outcome: "fail" } as const;
  const next = applyRepetition(multiplication, student, repetition);
  assert.deepEqual(next, applyRepetition(multiplication, original, repetition));
  assert.equal(state(next, topicId).repNum, 0);
  assert.equal(state(next, topicId).memory, 0);
});

test("未学主题不能通过隐式信用或失败变成已学，只有通过初次学习才创建状态", () => {
  const advancedOnly: Student = { "two-digit-times-one-digit": state(learned(multiplication), "two-digit-times-one-digit") };
  const next = applyRepetition(multiplication, advancedOnly, { topicId: "two-digit-times-one-digit", day: 1, outcome: "pass" });
  assert.equal(Object.keys(next).length, 1);
  assert.deepEqual(applyRepetition(multiplication, {}, { topicId: "one-digit-multiplication", day: 0, outcome: "fail" }), {});
  const learnedFirst = applyRepetition(multiplication, {}, { topicId: "one-digit-multiplication", day: 0, outcome: "pass" });
  assert.equal(state(learnedFirst, "one-digit-multiplication").speed, 1);
});

test("主题 ID 与对象原型同名时，仍作为普通未学主题选择并安全保存", () => {
  const graph: KnowledgeGraph = {
    topics: ["constructor", "__proto__", "toString"], prerequisites: [], encompassings: [],
  };
  let student: Student = {};
  assert.deepEqual(selectTasks(graph, student, 0).map((task) => task.topicId), graph.topics);
  for (const topicId of graph.topics) {
    student = applyRepetition(graph, student, { topicId, day: 0, outcome: "pass" });
    assert.equal(Object.hasOwn(student, topicId), true);
    assert.equal(state(student, topicId).repNum, 1);
  }
  assert.equal(Object.getPrototypeOf(student), Object.prototype);
  assert.equal(selectTasks(graph, student, 1).length, 3);
});
