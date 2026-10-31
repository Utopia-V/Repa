import type { KnowledgeGraph, ModelConfig, Repetition, Student, TopicState } from "./schema.js";

export type { ModelConfig } from "./schema.js";

/**
 * HSRS 公式里的常数。Justin Skycak 公开了公式的结构（HSRS／FIRe 文章与 The Math Academy Way）：repNum 与 memory 的两条更新式、
 * memory 每过一个理想间隔减半、通过的信用沿包含关系向下传而失败向上传、speed 低于 1 的 topic 不收隐式的正信用。memory 式没有标出
 * 各项属于哪个时刻，Repa 的取法见 applyRepetition。
 * 下面的常数是公开资料没有给出的部分，全部是 Repa 的假设，等真实作答校准；它们控制什么、什么证据会改变它们，
 * 见学习插件说明里的“尚待查证的假设”。调参就是换这组常数：用另一组参数重放同一份历史作答，可以比较两组参数的预测。
 */
export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  /** 到期线：memory 降到它（含）以下就到期。公开资料只说降到“足够低”时到期。 */
  dueMemory: 0.5,
  /** 提前复习的信用折扣：memory 为 1（刚复习过）时没有信用，降到这里时拿满额，中间线性。公开资料只说提前的复习要打折。 */
  fullCreditMemory: 0.5,
  /** 初学时的 speed。MA 按学习者能力与 topic 难度之比估计 speed，估计方法没有公开。 */
  initialSpeed: 1,
  /** speed 的下限与上限。 */
  minimumSpeed: 0.5,
  maximumSpeed: 1.5,
  /** 每次显式复习以后 speed 的调整幅度（乘以质量）：通过加，失败减。测验每个 topic 只有一题，答错一题就按失败的幅度降速。 */
  passSpeedStep: 0.1,
  failSpeedStep: 0.2,
  /** 理想间隔是 intervalBase 的 (repNum - 1) 次方天，最长 maximumInterval 天。公开资料只说间隔能长到一年以上。 */
  intervalBase: 2,
  maximumInterval: 365,
  /** 逾期失败的倒退倍数 decay 是 1 加上 decaySlope 乘以逾期了几个理想间隔。公开资料只说 decay 从 1 起、逾期越久越大。 */
  decaySlope: 1,
};

/** repNum 对应的理想间隔（天），memory 每过一个理想间隔减半。repNum 可以是小数，所以部分信用也让间隔连续地变化。 */
export function intervalFor(repNum: number, config: ModelConfig = DEFAULT_MODEL_CONFIG): number {
  return Math.min(config.maximumInterval, config.intervalBase ** Math.max(0, repNum - 1));
}

/**
 * 某一天的 memory：状态里存的是 lastRepetitionDay 那天的值，从那天起每过一个理想间隔减半（公开式）。
 * 只做投影、不改写状态，所以查询多少次都不会重复累计衰减。
 */
export function memoryAt(state: TopicState, day: number): number {
  return state.memory * 0.5 ** ((day - state.lastRepetitionDay) / state.interval);
}

/** 这一天是否该显式复习：memory 降到到期线（含）以下即到期。 */
export function isDue(state: TopicState, day: number, config: ModelConfig = DEFAULT_MODEL_CONFIG): boolean {
  return memoryAt(state, day) <= config.dueMemory;
}

/**
 * 一次学习或复习的信用传给哪些 topic、各按多大权重（FIRe）：通过沿包含关系向下传给被覆盖的 topic，失败向上传给覆盖它的 topic，
 * 方向是公开规则。多条路径怎样合并没有公开，Repa 假设沿路径相乘、多路径取最大值，免得菱形图重复计分。
 * 接收者的 speed 和提前折扣不改变图上的流量，也不阻断更远的 topic。
 */
export function repetitionWeights(
  graph: KnowledgeGraph,
  topicId: string,
  outcome: Repetition["outcome"],
): Map<string, number> {
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

/**
 * 把一次已确认的学习或复习结论记进学生状态，返回新状态，不修改输入；同一串结论换一组参数重放，就得到那组参数下的状态。
 * 信用按 repetitionWeights 传给相关 topic，每个 topic 再按自己此刻的 memory 打提前折扣，走同一套更新：repNum 用公开式，
 * memory 用差额更新（见函数内的说明）。
 */
export function applyRepetition(
  graph: KnowledgeGraph,
  student: Student,
  repetition: Repetition,
  config: ModelConfig = DEFAULT_MODEL_CONFIG,
): Student {
  const { topicId, day, outcome, quality = 1 } = repetition;
  const passed = outcome === "pass";
  const next = new Map(Object.entries(student));
  for (const [id, weight] of repetitionWeights(graph, topicId, outcome)) {
    const explicit = id === topicId;
    let previous = next.get(id);
    const firstLearning = previous === undefined;
    // 隐式信用只能复习已学主题，不能绕过初次学习。初学从零开始，再加上这一次的信用（Repa 假设）。
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
    const memory = memoryAt(previous, day);
    const discount = Math.max(0, Math.min(1, (1 - memory) / (1 - config.fullCreditMemory)));
    const rawDelta = (passed ? 1 : -1) * quality * weight * discount;
    // 每逾期一个理想间隔，失败多退 decaySlope 倍；成功不受此项放大。
    const decay = 1 + config.decaySlope * Math.max(0, days / previous.interval - 1);
    const repNum = Math.max(0, previous.repNum + previous.speed * (passed ? 1 : decay) * rawDelta);
    // 差额更新（Repa 假设，公开式没有标出各项属于哪个时刻）：旧 memory 先按旧间隔衰减到这一天，这次的信用再补上它与 1 之间差额的
    // rawDelta 倍，从这一天起按新间隔衰减。这一天的信用不再乘以此前的衰减，迟到的满额通过同样回到 1，不会马上又到期；
    // 失败按同样的比例往下扣。信用为零时只把锚点移到这一天，遗忘的轨迹不变。
    const updatedMemory = Math.max(0, memory + (1 - memory) * rawDelta);
    // 只有显式复习调整 speed；本次仍用旧 speed，下一次才用新值。
    let speed = previous.speed;
    if (explicit && !firstLearning) {
      const step = passed ? config.passSpeedStep : -config.failSpeedStep;
      speed = Math.max(config.minimumSpeed, Math.min(config.maximumSpeed, speed + step * quality));
    }
    next.set(id, { repNum, memory: updatedMemory, speed, lastRepetitionDay: day, interval: intervalFor(repNum, config) });
  }
  return Object.fromEntries(next);
}
