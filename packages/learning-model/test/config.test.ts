import assert from "node:assert/strict";
import test from "node:test";

import {
  ASSUMPTIONS, DEFAULT_MODEL_CONFIG, applyRepetition, intervalFor, isDue, repetitionWeights, selectTasks,
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

test("完整默认配置保留 v0 常数，省略配置和显式传默认配置产生完全相同的状态与候选", () => {
  assert.deepEqual(ASSUMPTIONS, {
    dueMemory: 0.5, initialSpeed: 1, minimumSpeed: 0.5, maximumSpeed: 1.5,
    passSpeedStep: 0.1, failSpeedStep: 0.2, maximumInterval: 365,
  });
  assert.deepEqual(DEFAULT_MODEL_CONFIG, {
    ...ASSUMPTIONS,
    passScale: 1, failScale: 1, qualityExponent: 1,
    intervalScale: 1, intervalBase: 2, earlyExponent: 1,
    decaySlope: 1, decayExponent: 1, pathCombination: "max", updateSpeed: true,
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
    assert.deepEqual(repetitionWeights(graph, repetition.topicId, repetition.outcome),
      repetitionWeights(graph, repetition.topicId, repetition.outcome, DEFAULT_MODEL_CONFIG));
  }
  for (const repNum of [0, 0.5, 1, 1.25, 2, 5, 20]) {
    assert.equal(intervalFor(repNum), Math.min(365, 2 ** Math.max(0, repNum - 1)));
  }
});

test("参数化后既有 simulate 的四项默认结果与冻结的 v0 数值精确一致", () => {
  // v0 默认 compare() 的冻结回归值；精确比较计数及浮点预测。
  assert.deepEqual(compare(), [
    {
      scenario: "always-pass", policy: "independent", explicitReviews: 216, failures: 0,
      learnedTopics: 36, dueAtEnd: 0, maximumDueAtDayEnd: 0, dueTopicDays: 0,
      budgetExhaustedDays: 0, meanRecallAfterSevenDays: null,
    },
    {
      scenario: "always-pass", policy: "fire-compression", explicitReviews: 128, failures: 0,
      learnedTopics: 36, dueAtEnd: 0, maximumDueAtDayEnd: 0, dueTopicDays: 0,
      budgetExhaustedDays: 0, meanRecallAfterSevenDays: null,
    },
    {
      scenario: "forgetting", policy: "independent", explicitReviews: 308, failures: 45,
      learnedTopics: 36, dueAtEnd: 0, maximumDueAtDayEnd: 3, dueTopicDays: 15,
      budgetExhaustedDays: 9, meanRecallAfterSevenDays: 0.8322899234301621,
    },
    {
      scenario: "forgetting", policy: "fire-compression", explicitReviews: 195, failures: 36,
      learnedTopics: 36, dueAtEnd: 0, maximumDueAtDayEnd: 0, dueTopicDays: 0,
      budgetExhaustedDays: 0, meanRecallAfterSevenDays: 0.6807622933344775,
    },
  ]);
});

test("成功和失败使用各自尺度及 quality 指数，memory 保留先加信用再衰减的顺序", () => {
  const config: ModelConfig = { ...DEFAULT_MODEL_CONFIG, passScale: 0.5, failScale: 2, qualityExponent: 2 };
  const student: Student = { a: { ...learnedState } };
  const pass = state(applyRepetition(independent, student, { topicId: "a", day: 1, outcome: "pass", quality: 0.5 }, config));
  assert.equal(pass.repNum, 4.125);
  assert.equal(pass.memory, 1.125 * 0.5);
  const fail = state(applyRepetition(independent, student, { topicId: "a", day: 1, outcome: "fail", quality: 0.5 }, config));
  assert.equal(fail.repNum, 3.5);
  assert.equal(fail.memory, 0.5 * 0.5);
  assert.deepEqual(student.a, learnedState);
});

test("间隔尺度、底数和上限同时应用于初学及更新后的间隔", () => {
  const config: ModelConfig = { ...DEFAULT_MODEL_CONFIG, intervalScale: 2, intervalBase: 3, maximumInterval: 10 };
  assert.equal(intervalFor(0, config), 2);
  assert.equal(intervalFor(1.5, config), 2 * Math.sqrt(3));
  assert.equal(intervalFor(2, config), 6);
  assert.equal(intervalFor(3, config), 10);
  const first = applyRepetition(independent, {}, { topicId: "a", day: 0, outcome: "pass" }, config);
  assert.equal(state(first).interval, 2);
  const second = applyRepetition(independent, first, { topicId: "a", day: 2, outcome: "pass" }, config);
  assert.equal(state(second).interval, 6);
});

test("提前折扣应用配置指数，零折扣在指数为零时仍不产生信用", () => {
  const config: ModelConfig = { ...DEFAULT_MODEL_CONFIG, earlyExponent: 2 };
  const student: Student = { a: { ...learnedState } };
  const factor = Math.sqrt(0.5);
  const delta = (2 * (1 - factor)) ** 2;
  const pass = state(applyRepetition(independent, student, { topicId: "a", day: 0.5, outcome: "pass" }, config));
  assert.equal(pass.repNum, 4 + delta);
  assert.equal(pass.memory, (1 + delta) * factor);
  const fail = state(applyRepetition(independent, student, { topicId: "a", day: 0.5, outcome: "fail" }, config));
  assert.equal(fail.repNum, 4 - delta);
  const zeroExponent = { ...DEFAULT_MODEL_CONFIG, earlyExponent: 0 };
  for (const outcome of ["pass", "fail"] as const) {
    const next = state(applyRepetition(independent, student, { topicId: "a", day: 0, outcome }, zeroExponent));
    assert.equal(next.repNum, 4);
    assert.equal(next.memory, 1);
  }
});

test("逾期惩罚使用配置斜率和指数，只影响失败的 repNum 而不改变 memory 公式", () => {
  const config: ModelConfig = { ...DEFAULT_MODEL_CONFIG, decaySlope: 0.5, decayExponent: 2 };
  const student: Student = { a: { ...learnedState } };
  const fail = state(applyRepetition(independent, student, { topicId: "a", day: 3, outcome: "fail", quality: 0.25 }, config));
  assert.equal(fail.repNum, 3.25);
  assert.equal(fail.memory, 0.75 * 0.125);
  const pass = state(applyRepetition(independent, student, { topicId: "a", day: 3, outcome: "pass", quality: 0.25 }, config));
  assert.equal(pass.repNum, 4.25);
  assert.equal(pass.memory, 1.25 * 0.125);
});

test("speed 更新遵守配置步长和上下界，关闭更新后使用外部 speed 且初学使用配置初值", () => {
  const config: ModelConfig = {
    ...DEFAULT_MODEL_CONFIG, passSpeedStep: 0.3, failSpeedStep: 0.4, minimumSpeed: 0.8, maximumSpeed: 1.2,
  };
  const student: Student = { a: { ...learnedState } };
  const pass = state(applyRepetition(independent, student, { topicId: "a", day: 1, outcome: "pass" }, config));
  const fail = state(applyRepetition(independent, student, { topicId: "a", day: 1, outcome: "fail" }, config));
  assert.equal(pass.speed, 1.2);
  assert.equal(fail.speed, 0.8);
  const external: Student = { a: { ...learnedState, speed: 2.5 } };
  const frozen: ModelConfig = { ...config, initialSpeed: 0.7, updateSpeed: false };
  const externalPass = state(applyRepetition(independent, external, { topicId: "a", day: 1, outcome: "pass" }, frozen));
  const externalFail = state(applyRepetition(independent, external, { topicId: "a", day: 1, outcome: "fail" }, frozen));
  assert.equal(externalPass.speed, 2.5);
  assert.equal(externalPass.repNum, 6.5);
  assert.equal(externalFail.speed, 2.5);
  assert.equal(externalFail.repNum, 1.5);
  const first = state(applyRepetition(independent, {}, { topicId: "a", day: 0, outcome: "pass" }, frozen));
  assert.equal(first.speed, 0.7);
  assert.equal(first.repNum, 0.7);
});

test("capped-sum 在菱形合流节点先截断再向外传播，反向失败也按拓扑汇总", () => {
  const graph: KnowledgeGraph = {
    topics: ["d", "b", "c", "a", "z"], prerequisites: [],
    encompassings: [
      { advanced: "d", simple: "b", weight: 0.8 },
      { advanced: "d", simple: "c", weight: 0.8 },
      { advanced: "b", simple: "a", weight: 0.8 },
      { advanced: "c", simple: "a", weight: 0.8 },
      { advanced: "a", simple: "z", weight: 0.5 },
      { advanced: "d", simple: "z", weight: 0.1 },
    ],
  };
  const config: ModelConfig = { ...DEFAULT_MODEL_CONFIG, pathCombination: "capped-sum" };
  const weights = repetitionWeights(graph, "d", "pass", config);
  assert.equal(weights.get("a"), 1);
  assert.equal(weights.get("z"), 0.6);
  assert.notEqual(weights.get("z"), 2 * 0.8 * 0.8 * 0.5 + 0.1);
  assert.equal(repetitionWeights(graph, "d", "pass").get("a"), 0.8 * 0.8);
  const reverse = { ...graph, encompassings: [...graph.encompassings].reverse() };
  assert.deepEqual(repetitionWeights(reverse, "d", "pass", config), weights);
  assert.equal(repetitionWeights(graph, "z", "fail", config).get("d"), 0.1 + 2 * 0.5 * 0.8 * 0.8);
  const student: Student = Object.fromEntries(graph.topics.map((id) => [id, { ...learnedState }]));
  const next = applyRepetition(graph, student, { topicId: "d", day: 1, outcome: "pass" }, config);
  assert.equal(state(next, "a").repNum, 5);
  assert.equal(state(next, "z").repNum, 4.6);
});

test("capped-sum 的有效边循环报错，零权重不传信用也不制造循环", () => {
  const config: ModelConfig = { ...DEFAULT_MODEL_CONFIG, pathCombination: "capped-sum" };
  const graph: KnowledgeGraph = {
    topics: ["a", "b"], prerequisites: [],
    encompassings: [
      { advanced: "a", simple: "b", weight: 1 },
      { advanced: "b", simple: "a", weight: 1 },
    ],
  };
  assert.throws(() => repetitionWeights(graph, "a", "pass", config), /DAG/);
  assert.throws(() => repetitionWeights(graph, "a", "fail", config), /DAG/);
  assert.deepEqual(repetitionWeights({ ...graph, encompassings: [] }, "a", "pass", config), new Map([["a", 1]]));
  const zeroEdges = { ...graph, encompassings: graph.encompassings.map((edge) => ({ ...edge, weight: 0 })) };
  assert.deepEqual(repetitionWeights(zeroEdges, "a", "pass", config), new Map([["a", 1]]));
});

test("capped-sum 处理指数路径数的多层 DAG，不枚举完整路径", () => {
  const graph: KnowledgeGraph = { topics: ["source"], prerequisites: [], encompassings: [] };
  let previous = ["source"];
  for (let layer = 0; layer < 60; layer += 1) {
    const current = [`a-${layer}`, `b-${layer}`];
    graph.topics.push(...current);
    for (const advanced of previous) {
      for (const simple of current) graph.encompassings.push({ advanced, simple, weight: layer === 0 ? 1 : 0.5 });
    }
    previous = current;
  }
  const weights = repetitionWeights(graph, "source", "pass", { ...DEFAULT_MODEL_CONFIG, pathCombination: "capped-sum" });
  assert.equal(weights.size, 121);
  assert.equal(weights.get("a-59"), 1);
  assert.equal(weights.get("b-59"), 1);
});

test("选择器的到期判断及预演都沿用同一配置，不虚报零成功信用的覆盖", () => {
  const graph: KnowledgeGraph = {
    topics: ["a", "b"], prerequisites: [],
    encompassings: [{ advanced: "b", simple: "a", weight: 1 }],
  };
  const student: Student = { a: { ...learnedState }, b: { ...learnedState } };
  assert.equal(selectTasks(graph, student, 1, 3, false).length, 1);
  const config: ModelConfig = { ...DEFAULT_MODEL_CONFIG, passScale: 0, updateSpeed: false };
  const tasks = selectTasks(graph, student, 1, 3, false, config);
  assert.deepEqual(tasks.map((task) => task.topicId), ["a", "b"]);
  for (const task of tasks) assert.deepEqual(task.reason.clearsOnPass, []);
  const laterDue = { ...DEFAULT_MODEL_CONFIG, dueMemory: 0.25 };
  assert.equal(isDue(learnedState, 1, laterDue), false);
  assert.deepEqual(selectTasks(graph, student, 1, 3, false, laterDue), []);
  assert.equal(isDue(learnedState, 2, laterDue), true);
});
