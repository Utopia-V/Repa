import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MODEL_CONFIG, applyRepetition, intervalFor, isDue, repetitionWeights, selectTasks,
  type KnowledgeGraph, type ModelConfig, type Repetition, type Student, type TopicState,
} from "../src/index.js";
import { compare } from "../simulation/compare.js";

const independent: KnowledgeGraph = { topics: ["a"], prerequisites: [], encompassings: [] };
const learnedState: TopicState = { repNum: 4, memory: 1, speed: 1, lastRepetitionDay: 0, interval: 1 };

function state(student: Student, id = "a"): TopicState {
  const value = student[id];
  assert.ok(value);
  return value;
}

test("默认参数逐项命名，常数保留 v0 的取值；省略参数和显式传默认参数产生完全相同的状态与候选", () => {
  assert.deepEqual(DEFAULT_MODEL_CONFIG, {
    dueMemory: 0.5, fullCreditMemory: 0.5, initialSpeed: 1, minimumSpeed: 0.5, maximumSpeed: 1.5,
    passSpeedStep: 0.1, failSpeedStep: 0.2, intervalBase: 2, maximumInterval: 365, decaySlope: 1,
  });
  const graph: KnowledgeGraph = {
    topics: ["a", "b"], prerequisites: [{ topic: "b", prerequisite: "a" }],
    encompassings: [{ advanced: "b", simple: "a", weight: 0.5 }],
  };
  const repetitions: Repetition[] = [
    { topicId: "a", day: 0, outcome: "pass" },
    { topicId: "b", day: 0.5, outcome: "pass", quality: 0.75 },
    { topicId: "a", day: 2, outcome: "fail", quality: 0.25 },
    { topicId: "b", day: 4, outcome: "pass" },
  ];
  let implicit: Student = {};
  let explicit: Student = {};
  for (const repetition of repetitions) {
    implicit = applyRepetition(graph, implicit, repetition);
    explicit = applyRepetition(graph, explicit, repetition, DEFAULT_MODEL_CONFIG);
    assert.deepEqual(implicit, explicit);
    assert.deepEqual(selectTasks(graph, implicit, repetition.day),
      selectTasks(graph, explicit, repetition.day, 3, true, DEFAULT_MODEL_CONFIG));
  }
  for (const repNum of [0, 0.5, 1, 1.25, 2, 5, 20]) {
    assert.equal(intervalFor(repNum), Math.min(365, 2 ** Math.max(0, repNum - 1)));
  }
});

test("差额更新的基线：simulate 的四项默认结果与冻结的数值一致", () => {
  // memory 改为差额更新以后，默认 compare() 的冻结基线；v0 的数值（memory 先加信用再整体衰减）见 git 历史。
  // 计数精确比较。回忆率是一长串浮点运算的结果，不同 Node 版本的数学函数在最后一位上可能相差，按 1e-12 比较。
  const recall = (value: number | null) => (value === null ? null : Math.round(value * 1e12) / 1e12);
  assert.deepEqual(compare().map((row) => ({ ...row, meanRecallAfterSevenDays: recall(row.meanRecallAfterSevenDays) })), [
    {
      scenario: "always-pass", policy: "independent", explicitReviews: 216, failures: 0,
      learnedTopics: 36, dueAtEnd: 0, maximumDueAtDayEnd: 0, dueTopicDays: 0,
      budgetExhaustedDays: 0, meanRecallAfterSevenDays: null,
    },
    {
      scenario: "always-pass", policy: "fire-compression", explicitReviews: 122, failures: 0,
      learnedTopics: 36, dueAtEnd: 0, maximumDueAtDayEnd: 0, dueTopicDays: 0,
      budgetExhaustedDays: 0, meanRecallAfterSevenDays: null,
    },
    {
      scenario: "forgetting", policy: "independent", explicitReviews: 289, failures: 35,
      learnedTopics: 36, dueAtEnd: 0, maximumDueAtDayEnd: 2, dueTopicDays: 6,
      budgetExhaustedDays: 5, meanRecallAfterSevenDays: 0.782285946459,
    },
    {
      scenario: "forgetting", policy: "fire-compression", explicitReviews: 183, failures: 31,
      learnedTopics: 36, dueAtEnd: 0, maximumDueAtDayEnd: 1, dueTopicDays: 1,
      budgetExhaustedDays: 1, meanRecallAfterSevenDays: 0.604200452789,
    },
  ]);
});

test("间隔的底数和上限同时应用于初学及更新后的间隔", () => {
  const config: ModelConfig = { ...DEFAULT_MODEL_CONFIG, intervalBase: 3, maximumInterval: 10 };
  assert.equal(intervalFor(0, config), 1);
  assert.equal(intervalFor(1.5, config), Math.sqrt(3));
  assert.equal(intervalFor(2, config), 3);
  assert.equal(intervalFor(4, config), 10);
  const first = applyRepetition(independent, {}, { topicId: "a", day: 0, outcome: "pass" }, config);
  assert.equal(state(first).interval, 1);
  const second = applyRepetition(independent, first, { topicId: "a", day: 1, outcome: "pass" }, config);
  assert.equal(state(second).repNum, 2);
  assert.equal(state(second).interval, 3);
});

test("提前复习的折扣在 memory 降到满额线时拿满额，之前线性打折，刚复习过时没有信用", () => {
  const config: ModelConfig = { ...DEFAULT_MODEL_CONFIG, fullCreditMemory: 0.25 };
  const student: Student = { a: { ...learnedState } };
  // 半天以后 memory 为 √0.5：默认满额线下折扣是 2(1 − √0.5)，满额线降到 0.25 时是 (1 − √0.5)／0.75；
  // memory 再补上与 1 之间差额的这么多倍。
  const factor = Math.sqrt(0.5);
  const pass = state(applyRepetition(independent, student, { topicId: "a", day: 0.5, outcome: "pass" }));
  assert.equal(pass.repNum, 4 + 2 * (1 - factor));
  const later = state(applyRepetition(independent, student, { topicId: "a", day: 0.5, outcome: "pass" }, config));
  assert.equal(later.repNum, 4 + (1 - factor) / 0.75);
  assert.equal(later.memory, factor + (1 - factor) * ((1 - factor) / 0.75));
  for (const outcome of ["pass", "fail"] as const) {
    const fresh = state(applyRepetition(independent, student, { topicId: "a", day: 0, outcome }, config));
    assert.equal(fresh.repNum, 4);
    assert.equal(fresh.memory, 1);
  }
});

test("逾期倒退的斜率只放大失败的 repNum，不改变 memory 公式", () => {
  const config: ModelConfig = { ...DEFAULT_MODEL_CONFIG, decaySlope: 0.5 };
  const student: Student = { a: { ...learnedState } };
  // 逾期两个理想间隔：decay 为 1 + 0.5 × 2。memory 衰减到 0.125，失败扣掉差额 0.875 的四分之一以后低于零，取零。
  const fail = state(applyRepetition(independent, student, { topicId: "a", day: 3, outcome: "fail", quality: 0.25 }, config));
  assert.equal(fail.repNum, 3.5);
  assert.equal(fail.memory, 0);
  const pass = state(applyRepetition(independent, student, { topicId: "a", day: 3, outcome: "pass", quality: 0.25 }, config));
  assert.equal(pass.repNum, 4.25);
  assert.equal(pass.memory, 0.125 + 0.875 * 0.25);
});

test("speed 按参数的步长和上下界调整，初学使用参数里的初值，只有显式复习调整", () => {
  const config: ModelConfig = {
    ...DEFAULT_MODEL_CONFIG, passSpeedStep: 0.3, failSpeedStep: 0.4, minimumSpeed: 0.8, maximumSpeed: 1.2, initialSpeed: 1.1,
  };
  const student: Student = { a: { ...learnedState } };
  const pass = state(applyRepetition(independent, student, { topicId: "a", day: 1, outcome: "pass" }, config));
  const fail = state(applyRepetition(independent, student, { topicId: "a", day: 1, outcome: "fail" }, config));
  assert.equal(pass.speed, 1.2);
  assert.equal(fail.speed, 0.8);
  const first = state(applyRepetition(independent, {}, { topicId: "a", day: 0, outcome: "pass" }, config));
  assert.equal(first.speed, 1.1);
  assert.equal(first.repNum, 1.1);
  const graph: KnowledgeGraph = { topics: ["a", "b"], prerequisites: [], encompassings: [{ advanced: "b", simple: "a", weight: 1 }] };
  const both: Student = { a: { ...learnedState }, b: { ...learnedState } };
  const implicit = applyRepetition(graph, both, { topicId: "b", day: 1, outcome: "pass" }, config);
  assert.equal(state(implicit, "a").speed, 1);
  assert.equal(state(implicit, "b").speed, 1.2);
});

test("选择器的到期判断及预演都沿用同一组参数", () => {
  const graph: KnowledgeGraph = {
    topics: ["a", "b"], prerequisites: [],
    encompassings: [{ advanced: "b", simple: "a", weight: 1 }],
  };
  const student: Student = { a: { ...learnedState }, b: { ...learnedState } };
  assert.equal(selectTasks(graph, student, 1, 3, false).length, 1);
  const laterDue = { ...DEFAULT_MODEL_CONFIG, dueMemory: 0.25 };
  assert.equal(isDue(learnedState, 1, laterDue), false);
  assert.deepEqual(selectTasks(graph, student, 1, 3, false, laterDue), []);
  assert.equal(isDue(learnedState, 2, laterDue), true);
  assert.deepEqual(repetitionWeights(graph, "b", "pass"), new Map([["b", 1], ["a", 1]]));
});

test("换一组参数重放同一串复习，得出不同的到期预测", () => {
  const repetitions: Repetition[] = [
    { topicId: "a", day: 0, outcome: "pass" },
    { topicId: "a", day: 1, outcome: "pass" },
    { topicId: "a", day: 3, outcome: "pass", quality: 0.5 },
  ];
  const replay = (config: ModelConfig) =>
    repetitions.reduce<Student>((student, repetition) => applyRepetition(independent, student, repetition, config), {});
  const slower: ModelConfig = { ...DEFAULT_MODEL_CONFIG, intervalBase: 3 };
  const base = state(replay(DEFAULT_MODEL_CONFIG));
  const other = state(replay(slower));
  assert.notEqual(base.interval, other.interval);
  // 第 5 天：默认参数下已经到期，间隔长的一组还没有。
  assert.equal(isDue(base, 5), true);
  assert.equal(isDue(other, 5, slower), false);
});
