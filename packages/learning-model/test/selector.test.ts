import assert from "node:assert/strict";
import test from "node:test";

import { applyRepetition, DEFAULT_MODEL_CONFIG, selectTasks, type KnowledgeGraph, type Student } from "../src/index.js";

const graph: KnowledgeGraph = {
  topics: ["a", "b", "c", "d", "e"],
  prerequisites: [
    { topic: "c", prerequisite: "a" }, { topic: "c", prerequisite: "b" },
    { topic: "d", prerequisite: "c" },
  ],
  encompassings: [{ advanced: "c", simple: "a", weight: 1 }],
};
const learnedState = { repNum: 1, memory: 1, speed: 1, lastRepetitionDay: 0, interval: 1 };

test("先修图控制新主题前沿，默认最多三项，全部先修完成后才提供主题", () => {
  assert.deepEqual(selectTasks(graph, {}, 0).map((task) => task.topicId), ["a", "b", "e"]);
  const student: Student = { a: { ...learnedState }, b: { ...learnedState } };
  const tasks = selectTasks(graph, student, 0);
  assert.deepEqual(tasks.map((task) => task.topicId), ["c", "e"]);
  assert.deepEqual(tasks[0]?.reason.prerequisites, ["a", "b"]);
  assert.equal(tasks[0]?.reason.kind, "frontier");
  assert.equal(selectTasks(graph, student, 0, 1).length, 1);
  assert.deepEqual(selectTasks(graph, student, 0, 0), []);
  assert.deepEqual(selectTasks(graph, student, 0, 3, false), []);
});

test("先修关系不自动传信用，新学习可以压缩已有复习，每个候选都相对真实状态解释", () => {
  const student: Student = { a: { ...learnedState }, b: { ...learnedState } };
  const original = structuredClone(student);
  const tasks = selectTasks(graph, student, 1);
  const lesson = tasks.find((task) => task.topicId === "c");
  assert.deepEqual(lesson?.reason.clearsOnPass, ["a"]);
  assert.ok(tasks.some((task) => task.topicId === "b" && task.kind === "review"));
  const next = applyRepetition(graph, student, { topicId: "c", day: 1, outcome: "pass" });
  assert.deepEqual(next.b, student.b);
  assert.deepEqual(student, original);
});

test("低速到期主题仍需显式复习，不会被图上的覆盖关系藏掉", () => {
  const student: Student = {
    a: { ...learnedState, speed: 0.5 }, b: { ...learnedState }, c: { ...learnedState },
  };
  const tasks = selectTasks(graph, student, 1, 3, false);
  assert.ok(tasks.some((task) => task.topicId === "a" && task.reason.explicitOnly));
  for (const task of tasks.filter((candidate) => candidate.topicId !== "a")) {
    assert.equal(task.reason.clearsOnPass.includes("a"), false);
  }
});

test("部分包含不足以清除到期时，选择器保留显式复习且不虚报覆盖", () => {
  const partial: KnowledgeGraph = {
    topics: ["a", "b"], prerequisites: [],
    encompassings: [{ advanced: "b", simple: "a", weight: 0.25 }],
  };
  const student: Student = { a: { ...learnedState, memory: 0 }, b: { ...learnedState } };
  const tasks = selectTasks(partial, student, 1);
  assert.ok(tasks.some((task) => task.topicId === "a"));
  assert.deepEqual(tasks.find((task) => task.topicId === "b")?.reason.clearsOnPass, ["b"]);
});

test("不能等待尚不可学的覆盖主题，严重逾期一次通过仍到期也会提供显式复习", () => {
  const student: Student = { a: { ...learnedState } };
  const tasks = selectTasks(graph, student, 30);
  assert.equal(tasks[0]?.topicId, "a");
  assert.deepEqual(tasks[0]?.reason.clearsOnPass, []);
  assert.equal(tasks[0]?.reason.kind, "due");
  assert.equal(tasks.some((task) => task.topicId === "c"), false);
});

test("菜单截断不修改到期集合，完成一项后重新选择会给出其余独立复习", () => {
  const independent = { ...graph, prerequisites: [], encompassings: [] };
  let student: Student = Object.fromEntries(graph.topics.map((id) => [id, { ...learnedState }]));
  const first = selectTasks(independent, student, 1);
  assert.equal(first.length, 3);
  assert.deepEqual(first.map((task) => task.topicId), ["a", "b", "c"]);
  student = applyRepetition(independent, student, { topicId: "a", day: 1, outcome: "pass" });
  assert.deepEqual(selectTasks(independent, student, 1).map((task) => task.topicId), ["b", "c", "d"]);
});

test("调用方不接受的候选不参加覆盖，被它覆盖的到期复习照样选出", () => {
  const covering: KnowledgeGraph = {
    topics: ["a", "b", "c"], prerequisites: [],
    encompassings: [{ advanced: "c", simple: "a", weight: 0.5 }, { advanced: "c", simple: "b", weight: 0.5 }],
  };
  // 第 1 天 a、b 到期；c 刚复习过、没到期，但通过 c 能以一半的权重把 a、b 都带出到期线。
  const student: Student = { a: { ...learnedState }, b: { ...learnedState }, c: { ...learnedState, lastRepetitionDay: 0.9 } };
  assert.deepEqual(selectTasks(covering, student, 1).map((task) => task.topicId), ["c"]);
  // 调用方不提供 c 的复习时，c 不能压掉 a、b。
  const accepted = selectTasks(covering, student, 1, 3, true, DEFAULT_MODEL_CONFIG, (candidate) => candidate.topicId !== "c");
  assert.deepEqual(accepted.map((task) => task.topicId), ["a", "b"]);
});
