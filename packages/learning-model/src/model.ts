import type { KnowledgeGraph, ModelConfig, Repetition, Student, TopicState } from "./schema.js";

export type { ModelConfig } from "./schema.js";

// 以下常数及函数形状都是 Repa v0 假设，不是 Skycak 公开的参数。
export const ASSUMPTIONS = {
  dueMemory: 0.5,
  initialSpeed: 1,
  minimumSpeed: 0.5,
  maximumSpeed: 1.5,
  passSpeedStep: 0.1,
  failSpeedStep: 0.2,
  maximumInterval: 365,
} as const;

// 调用方通过展开默认配置覆盖所需参数；配置不改变持久状态格式。
export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  ...ASSUMPTIONS,
  passScale: 1,
  failScale: 1,
  qualityExponent: 1,
  intervalScale: 1,
  intervalBase: 2,
  earlyExponent: 1,
  decaySlope: 1,
  decayExponent: 1,
  pathCombination: "max",
  updateSpeed: true,
};

export function intervalFor(repNum: number, config: ModelConfig = DEFAULT_MODEL_CONFIG): number {
  return Math.min(config.maximumInterval, config.intervalScale * config.intervalBase ** Math.max(0, repNum - 1));
}

// memory 存在 lastRepetitionDay；只投影，不改写状态或重复累计衰减。
export function memoryAt(state: TopicState, day: number): number {
  return state.memory * 0.5 ** ((day - state.lastRepetitionDay) / state.interval);
}

export function isDue(state: TopicState, day: number, config: ModelConfig = DEFAULT_MODEL_CONFIG): boolean {
  return memoryAt(state, day) <= config.dueMemory;
}

// Repa 默认假设：沿路径相乘，多路径取最大值，避免菱形图重复计分。
// 接收者的 speed 和提前折扣不改变图上的流量，也不阻断后续节点。
export function repetitionWeights(
  graph: KnowledgeGraph,
  topicId: string,
  outcome: Repetition["outcome"],
  config: ModelConfig = DEFAULT_MODEL_CONFIG,
): Map<string, number> {
  if (config.pathCombination === "capped-sum") return cappedSumWeights(graph, topicId, outcome);
  const weights = new Map([[topicId, 1]]);
  const pending: Array<[string, number]> = [[topicId, 1]];
  for (const [current, weight] of pending) {
    for (const edge of graph.encompassings) {
      const from = outcome === "pass" ? edge.advanced : edge.simple;
      const to = outcome === "pass" ? edge.simple : edge.advanced;
      if (from !== current) continue;
      const next = weight * edge.weight;
      if (next > (weights.get(to) ?? 0)) {
        weights.set(to, next);
        pending.push([to, next]);
      }
    }
  }
  return weights;
}

// capped-sum 在 DAG 的拓扑顺序中汇总所有入边贡献，再将节点权重截到 1。
// 下游接收的是截断后的权重乘边权；不是枚举所有完整路径后才统一截断。
// 零权重边不传信用；此分支只要求有效边组成 DAG，计算量为 O(V + E)。
function cappedSumWeights(
  graph: KnowledgeGraph,
  topicId: string,
  outcome: Repetition["outcome"],
): Map<string, number> {
  const outgoing = new Map<string, Array<{ topicId: string; weight: number }>>();
  const incoming = new Map<string, number>();
  for (const edge of graph.encompassings) {
    if (edge.weight <= 0) continue;
    const from = outcome === "pass" ? edge.advanced : edge.simple;
    const to = outcome === "pass" ? edge.simple : edge.advanced;
    const edges = outgoing.get(from) ?? [];
    edges.push({ topicId: to, weight: edge.weight });
    outgoing.set(from, edges);
    if (!incoming.has(from)) incoming.set(from, 0);
    incoming.set(to, (incoming.get(to) ?? 0) + 1);
  }
  const weights = new Map([[topicId, 1]]);
  if (incoming.size === 0) return weights;
  const pending = [...incoming].filter(([, count]) => count === 0).map(([id]) => id);
  const contributions = new Map([[topicId, 1]]);
  for (const current of pending) {
    const weight = Math.min(1, contributions.get(current) ?? 0);
    if (weight > 0) weights.set(current, weight);
    for (const edge of outgoing.get(current) ?? []) {
      contributions.set(edge.topicId, (contributions.get(edge.topicId) ?? 0) + weight * edge.weight);
      const remaining = (incoming.get(edge.topicId) ?? 0) - 1;
      incoming.set(edge.topicId, remaining);
      if (remaining === 0) pending.push(edge.topicId);
    }
  }
  if (pending.length !== incoming.size) throw new Error("capped-sum 的有效包含关系必须组成 DAG");
  return weights;
}

export function applyRepetition(
  graph: KnowledgeGraph,
  student: Student,
  repetition: Repetition,
  config: ModelConfig = DEFAULT_MODEL_CONFIG,
): Student {
  const { topicId, day, outcome, quality = 1 } = repetition;
  const passed = outcome === "pass";
  const next = new Map(Object.entries(student));
  for (const [id, weight] of repetitionWeights(graph, topicId, outcome, config)) {
    const explicit = id === topicId;
    let previous = next.get(id);
    const firstLearning = previous === undefined;
    // 隐式信用只能复习已学主题，不能绕过初次学习。
    if (!previous) {
      if (!explicit || !passed) continue;
      previous = {
        repNum: 0,
        memory: 0,
        speed: config.initialSpeed,
        lastRepetitionDay: day,
        interval: intervalFor(0, config),
      };
    }
    // 公开规则只拒收正向隐式信用；向上的失败惩罚仍然生效。
    if (!explicit && passed && previous.speed < 1) continue;
    const days = day - previous.lastRepetitionDay;
    const factor = 0.5 ** (days / previous.interval);
    const memory = memoryAt(previous, day);
    // 默认 memory 从 1 降到 0.5 时，信用从 0 线性升到 1；零折扣始终不计信用。
    const earlyCredit = Math.max(0, Math.min(1, 2 * (1 - memory)));
    const discount = earlyCredit === 0 ? 0 : earlyCredit ** config.earlyExponent;
    const scale = passed ? config.passScale : config.failScale;
    const rawDelta = (passed ? 1 : -1) * scale * quality ** config.qualityExponent * weight * discount;
    // 默认每逾期一个理想间隔，多退一个倍数；成功不受此项放大。
    const decay = 1 + config.decaySlope * Math.max(0, days / previous.interval - 1) ** config.decayExponent;
    const repNum = Math.max(0, previous.repNum + previous.speed * (passed ? 1 : decay) * rawDelta);
    // 沿用公开公式的加法结构；以更新前 interval 对整体衰减是 Repa 的时间协议假设。
    const updatedMemory = Math.max(0, previous.memory + rawDelta) * factor;
    // 默认仅显式复习估计 speed；本次仍用旧 speed，下一次才用新值。
    // 关闭估计时保留外部 speed，不按占位模型的上下界重新截断。
    let speed = previous.speed;
    if (config.updateSpeed && explicit && !firstLearning) {
      const step = passed ? config.passSpeedStep : -config.failSpeedStep;
      speed = Math.max(config.minimumSpeed, Math.min(config.maximumSpeed, speed + step * quality));
    }
    next.set(id, { repNum, memory: updatedMemory, speed, lastRepetitionDay: day, interval: intervalFor(repNum, config) });
  }
  return Object.fromEntries(next);
}
