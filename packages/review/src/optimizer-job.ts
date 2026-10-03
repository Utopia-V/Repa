import { Value } from "typebox/value";
import { algorithmVersion, libraryVersion, defaultParameters } from "./fsrs.js";
import {
  OptimizationJobInputSchema,
  type OptimizationJobInput,
  type OptimizationJobMessage,
} from "./optimizer.js";
import type { ReviewOptimizationResult } from "./schema.js";

const trainingConfig = {
  numEpochs: 5,
  batchSize: 512,
  seed: 2023,
  maxSeqLen: 256,
  learningRate: 0.04,
  gamma: 1,
};

function send(message: OptimizationJobMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) {
      reject(new Error("缺少优化进程 IPC 通道"));
      return;
    }
    process.send(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function run({ snapshot }: OptimizationJobInput): Promise<ReviewOptimizationResult> {
  let binding: typeof import("@open-spaced-repetition/binding");
  try {
    // 包负责原生／WASI 的选择；缺失或不能加载时不补造另一种实现。
    binding = await import("@open-spaced-repetition/binding");
  } catch {
    await send({ type: "error", code: "optimizer_unavailable", message: "可选 FSRS 参数优化组件未安装或不能加载。" });
    process.exit(1);
  }
  const rows = ["card_id,review_time,review_rating,review_state,review_duration"];
  let feedbackCount = 0;
  let firstReviewAt: number | undefined;
  let lastReviewAt: number | undefined;
  snapshot.items.forEach((item, itemIndex) => {
    item.reviews.forEach((review, reviewIndex) => {
      // 上游 CSV 状态仅用于识别历史起点；首条为 new，其余不声明另一轮首次学习。
      // 序号替代领域 id，避免 CSV 转义并使优化进程只接触评分与时间。
      rows.push(`${itemIndex},${review.review},${review.rating},${reviewIndex === 0 ? 0 : 2},0`);
      feedbackCount++;
      firstReviewAt = firstReviewAt === undefined ? review.review : Math.min(firstReviewAt, review.review);
      lastReviewAt = lastReviewAt === undefined ? review.review : Math.max(lastReviewAt, review.review);
    });
  });
  const items = binding.convertCsvToFsrsItems(Buffer.from(rows.join("\n")), 0, "UTC", () => 0)
    .filter((item) => item.reviews.length > 0 && item.includeLongTermReviews());
  const metadata = {
    parameterVersion: snapshot.parameters.version,
    libraryVersion,
    algorithmVersion,
    optimizerVersion: "0.5.0",
    dayBoundary: "UTC" as const,
    feedbackCount,
    trainingItems: items.length,
    ...(firstReviewAt === undefined ? {} : { firstReviewAt }),
    ...(lastReviewAt === undefined ? {} : { lastReviewAt }),
    trainingConfig,
  };
  // 锁定的 fsrs-rs 6.5.0 对清洗后少于 8 项的输入直接返回默认值，不生成个人候选。
  if (items.length < 8) {
    return { ...metadata, status: "insufficient_data" };
  }
  await send({ type: "progress", message: `开始 FSRS 参数训练：${items.length} 个跨日历史样本。` });
  const w = await binding.computeParameters(items, {
    enableShortTerm: snapshot.parameters.parameters.enable_short_term,
    numRelearningSteps: snapshot.parameters.parameters.relearning_steps.length,
    trainingConfig,
    // 上游 timeout 是进度轮询间隔（毫秒）；硬截止时间由父进程持有。
    timeout: 100,
    progress(current, total) {
      process.send?.({ type: "progress", message: `FSRS 参数训练：${current}/${total}。` });
    },
  });
  // 上游还会清洗样本；明确返回值是否仍是默认权重，不把它包装成个性化改善。
  const defaults = defaultParameters().w.map(Math.fround);
  const matchesDefaultWeights = w.length === defaults.length && w.every((value, index) => value === defaults[index]);
  return { ...metadata, status: "ready", w, matchesDefaultWeights };
}

process.once("message", (input: unknown) => {
  const execute = async () => {
    if (!Value.Check(OptimizationJobInputSchema, input)) {
      throw new Error("优化历史快照无效");
    }
    await send({ type: "result", result: await run(input) });
  };
  execute().then(() => {
    // 已确认 IPC 消息写出；显式退出也收回上游可能保留的原生／WASI 工作线程。
    process.exit(0);
  }, async () => {
    try {
      await send({ type: "error", code: "review_optimization_failed", message: "FSRS 参数优化失败。" });
    } finally {
      process.exit(1);
    }
  });
});
// 宿主退出后不能留下仍在训练的孤儿进程。
process.once("disconnect", () => process.exit(1));
