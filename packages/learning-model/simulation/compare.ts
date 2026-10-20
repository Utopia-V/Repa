import { applyRepetition, isDue, selectTasks } from "../src/index.js";
import type { KnowledgeGraph, Student } from "../src/index.js";

export type Scenario = "always-pass" | "forgetting";
export type Policy = "independent" | "fire-compression";

export interface SimulationOptions {
  days: number;
  reviewBudget: number;
  seed: number;
}

export interface SimulationResult {
  scenario: Scenario;
  policy: Policy;
  explicitReviews: number;
  failures: number;
  learnedTopics: number;
  dueAtEnd: number;
  maximumDueAtDayEnd: number;
  dueTopicDays: number;
  budgetExhaustedDays: number;
  meanRecallAfterSevenDays: number | null;
}

// 这只是可重复的机制演示，不是课程或 MA 学习者数据。
export const SIMULATION_DEFAULTS: SimulationOptions = {
  days: 180,
  reviewBudget: 6,
  seed: 20261010,
};

export function demonstrationGraph(): KnowledgeGraph {
  const graph: KnowledgeGraph = { topics: [], prerequisites: [], encompassings: [] };
  for (let level = 0; level < 6; level += 1) {
    for (let lane = 0; lane < 6; lane += 1) {
      const topic = `lane-${lane}-level-${level}`;
      graph.topics.push(topic);
      if (level === 0) continue;
      const prerequisite = `lane-${lane}-level-${level - 1}`;
      graph.prerequisites.push({ topic, prerequisite });
      // 第六条链只约束先修，不提供 FIRe 信用。
      if (lane === 5) continue;
      graph.encompassings.push({
        advanced: topic,
        simple: prerequisite,
        weight: lane === 4 ? 0.6 : 1,
      });
    }
  }
  return graph;
}

interface RecallState {
  halfLife: number;
  lastPracticeDay: number;
}

// 按事件键生成固定抽样，两个策略在同一天同主题同次作答时使用同一抽样。
function draw(seed: number, key: string): number {
  let value = seed >>> 0;
  for (let index = 0; index < key.length; index += 1) {
    value = Math.imul(value ^ key.charCodeAt(index), 16777619) >>> 0;
  }
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b) >>> 0;
  value ^= value >>> 16;
  return (value >>> 0) / 4294967296;
}

function recallProbability(state: RecallState, day: number): number {
  return 0.5 ** ((day - state.lastPracticeDay) / state.halfLife);
}

// 合成真实过程与 HSRS 状态分离：真实半衰期不等于 repNum 对应的间隔。
// 通过显式作答增加 50% 半衰期；失败后讲解补救增加 10%。
// 成功实践对已学先修提供半强度的部分刷新，增益为强度的 45%。
function practice(
  graph: KnowledgeGraph,
  recall: Map<string, RecallState>,
  topicId: string,
  day: number,
  passed: boolean,
  firstLearning = false,
): void {
  const explicit = recall.get(topicId);
  if (!explicit) throw new Error(`主题 ${topicId} 尚未完成教学`);
  if (!firstLearning) {
    explicit.halfLife = Math.min(240, explicit.halfLife * (passed ? 1.5 : 1.1));
    explicit.lastPracticeDay = day;
  }
  if (!passed) return;

  // 此传播只描述合成学习者的迁移假设，与模型独立计算，且两策略完全相同。
  const strengths = new Map([[topicId, 1]]);
  const pending: Array<[string, number]> = [[topicId, 1]];
  for (const [advanced, strength] of pending) {
    for (const edge of graph.encompassings) {
      if (edge.advanced !== advanced) continue;
      const next = strength * edge.weight;
      if (next <= (strengths.get(edge.simple) ?? 0)) continue;
      strengths.set(edge.simple, next);
      pending.push([edge.simple, next]);
    }
  }
  strengths.delete(topicId);
  for (const [topic, weight] of strengths) {
    const state = recall.get(topic);
    if (!state) continue;
    const strength = weight * 0.5;
    state.halfLife = Math.min(240, state.halfLife * (1 + strength * 0.45));
    state.lastPracticeDay += (day - state.lastPracticeDay) * strength;
  }
}

function dueCount(graph: KnowledgeGraph, student: Student, day: number): number {
  return graph.topics.filter((topic) => {
    const state = student[topic];
    return state !== undefined && isDue(state, day);
  }).length;
}

export function simulate(
  scenario: Scenario,
  policy: Policy,
  options: SimulationOptions = SIMULATION_DEFAULTS,
): SimulationResult {
  if (!Number.isInteger(options.days) || options.days < 1
    || !Number.isInteger(options.reviewBudget) || options.reviewBudget < 0
    || !Number.isInteger(options.seed)) {
    throw new Error("天数须为正整数，复习预算须为非负整数，seed 须为整数");
  }
  const truthGraph = demonstrationGraph();
  const graph: KnowledgeGraph = {
    ...truthGraph,
    encompassings: policy === "independent" ? [] : truthGraph.encompassings,
  };
  const recall = new Map<string, RecallState>();
  let student: Student = {};
  let explicitReviews = 0;
  let failures = 0;
  let maximumDueAtDayEnd = 0;
  let dueTopicDays = 0;
  let budgetExhaustedDays = 0;

  for (let day = 0; day < options.days; day += 1) {
    // 固定教学发生在复习前。初次 lesson 完成记 pass；不与复习预算争用。
    const newTopic = truthGraph.topics[day];
    if (newTopic !== undefined) {
      student = applyRepetition(graph, student, { topicId: newTopic, day, outcome: "pass" });
      recall.set(newTopic, {
        halfLife: 2.5 + draw(options.seed, `ability:${newTopic}`) * 2,
        lastPracticeDay: day,
      });
      // 初学也包含对已学先修的成功实践，但不额外强化刚教的新主题。
      practice(truthGraph, recall, newTopic, day, true, true);
    }

    const attempts = new Map<string, number>();
    for (let used = 0; used < options.reviewBudget; used += 1) {
      const candidate = selectTasks(graph, student, day, 1, false)[0];
      if (!candidate) break;
      const state = recall.get(candidate.topicId);
      if (!state) throw new Error("调度了尚未教学的主题");
      const attempt = attempts.get(candidate.topicId) ?? 0;
      attempts.set(candidate.topicId, attempt + 1);
      const passed = scenario === "always-pass"
        || draw(options.seed, `answer:${day}:${candidate.topicId}:${attempt}`) < recallProbability(state, day);
      student = applyRepetition(graph, student, {
        topicId: candidate.topicId,
        day,
        outcome: passed ? "pass" : "fail",
      });
      practice(truthGraph, recall, candidate.topicId, day, passed);
      explicitReviews += 1;
      if (!passed) failures += 1;
    }
    const due = dueCount(graph, student, day);
    dueTopicDays += due;
    maximumDueAtDayEnd = Math.max(maximumDueAtDayEnd, due);
    // 有 due 剩余表示当天预算未能排清；包括零预算，不将延后藏在平均值里。
    if (due > 0) budgetExhaustedDays += 1;
  }

  const horizon = options.days - 1 + 7;
  const meanRecallAfterSevenDays = scenario === "always-pass" ? null
    : [...recall.values()].reduce((sum, state) => sum + recallProbability(state, horizon), 0) / recall.size;
  return {
    scenario,
    policy,
    explicitReviews,
    failures,
    learnedTopics: recall.size,
    dueAtEnd: dueCount(graph, student, options.days - 1),
    maximumDueAtDayEnd,
    dueTopicDays,
    budgetExhaustedDays,
    meanRecallAfterSevenDays,
  };
}

export function compare(options: SimulationOptions = SIMULATION_DEFAULTS): SimulationResult[] {
  return (["always-pass", "forgetting"] as const).flatMap((scenario) =>
    (["independent", "fire-compression"] as const).map((policy) => simulate(scenario, policy, options)));
}
