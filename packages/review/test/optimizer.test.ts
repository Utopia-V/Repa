import test from "node:test";
import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { Value } from "typebox/value";
import { RepaFault } from "repa/protocol";
import { createCard, defaultParameters, normalizeParameters, schedule, algorithmVersion, libraryVersion } from "../src/fsrs.js";
import { optimize } from "../src/optimizer.js";
import { ReviewOptimizationResultSchema, type ReviewTrainingSnapshot } from "../src/schema.js";

const start = Date.parse("2026-06-01T23:59:00Z");
const day = 86400000;

function snapshot(itemCount = 12, reviews = 5): ReviewTrainingSnapshot {
  return {
    parameters: {
      version: 3,
      createdAt: start,
      libraryVersion,
      algorithmVersion,
      parameters: defaultParameters(),
    },
    items: Array.from({ length: itemCount }, (_, index) => ({
      id: `item_${index}`,
      reviews: Array.from({ length: reviews }, (_, reviewIndex) => ({
        rating: ((index + reviewIndex) % 4 + 1) as 1 | 2 | 3 | 4,
        review: start + reviewIndex * day * 3,
      })),
    })),
  };
}

function isFault(code: string) {
  return (error: unknown) => error instanceof RepaFault && error.code === code;
}

// 可选安装不成为普通调度测试的先决条件；装有组件时以下测试使用真实 native 和进程。
let optimizerAvailable = false;
try {
  await import("@open-spaced-repetition/binding");
  optimizerAvailable = true;
} catch {
  optimizerAvailable = false;
}
const nativeTest = { skip: !optimizerAvailable };

test("有效历史经真实优化进程产出 21 个权重，可供锁定的调度器使用但不改输入参数", nativeTest, async () => {
  const input = snapshot(80, 8);
  const original = structuredClone(input);
  const progress: string[] = [];
  const result = await optimize(input, {
    signal: new AbortController().signal,
    progress: (message) => progress.push(message),
  });
  assert.equal(Value.Check(ReviewOptimizationResultSchema, result), true);
  assert.equal(result.status, "ready");
  assert.equal(result.parameterVersion, 3);
  assert.equal(result.libraryVersion, "5.4.2");
  assert.equal(result.algorithmVersion, algorithmVersion);
  assert.equal(result.optimizerVersion, "0.5.0");
  assert.equal(result.dayBoundary, "UTC");
  assert.equal(result.feedbackCount, 640);
  assert.equal(result.trainingItems, 560);
  assert.equal(result.firstReviewAt, start);
  assert.equal(result.lastReviewAt, start + 21 * day);
  assert.deepEqual(result.trainingConfig, {
    numEpochs: 5, batchSize: 512, seed: 2023, maxSeqLen: 256, learningRate: 0.04, gamma: 1,
  });
  assert.equal(progress.some((message) => message.startsWith("开始 FSRS 参数训练")), true);
  if (result.status !== "ready") throw new Error("缺少优化权重");
  assert.equal(result.matchesDefaultWeights, false);
  assert.equal(result.w.length, 21);
  assert.equal(result.w.every(Number.isFinite), true);
  const parameters = normalizeParameters({ ...input.parameters.parameters, w: result.w });
  const first = schedule(createCard(start), 3, start, parameters);
  const later = schedule(first.card, 4, start + 3 * day, parameters);
  assert.equal(Number.isFinite(later.card.due), true);
  assert.deepEqual(input, original);
});

test("上游清洗后回退默认权重时明确标记，不冒充个人参数改善或覆盖旧设置", nativeTest, async () => {
  const input = snapshot(12, 5);
  input.parameters.parameters.request_retention = 0.85;
  input.parameters.parameters.w[0] = 0.9;
  const original = structuredClone(input);
  const result = await optimize(input, { signal: new AbortController().signal });
  assert(result.status === "ready");
  assert.equal(result.trainingItems, 48);
  assert.equal(result.matchesDefaultWeights, true);
  assert.deepEqual(result.w, defaultParameters().w.map(Math.fround));
  assert.deepEqual(input, original);
});

test("跨 UTC 午夜不足 24 小时仍产生跨日样本，不采用当地四点日界", nativeTest, async () => {
  const input = snapshot(1, 2);
  const first = input.items[0]?.reviews[0];
  const second = input.items[0]?.reviews[1];
  assert.ok(first && second);
  first.rating = 3;
  second.rating = 3;
  second.review = start + 120000;
  const result = await optimize(input, { signal: new AbortController().signal });
  assert.equal(result.status, "insufficient_data");
  assert.equal(result.trainingItems, 1);
  assert.equal(result.feedbackCount, 2);
  assert.equal("w" in result, false);
});

test("冷启动及仅同日反馈返回数据不足，不生成或修改参数", nativeTest, async () => {
  for (const input of [snapshot(0), snapshot(1, 1), snapshot(1, 4)]) {
    for (const item of input.items) {
      item.reviews.forEach((review, index) => { review.review = start - 3600000 + index * 600000; });
    }
    const original = structuredClone(input);
    const result = await optimize(input, { signal: new AbortController().signal });
    assert.equal(result.status, "insufficient_data");
    assert.equal(result.trainingItems, 0);
    assert.equal("w" in result, false);
    assert.deepEqual(input, original);
  }
});

test("计算进度到达后取消，只有真实优化子进程已退出才结束请求", nativeTest, async (t) => {
  let child: ChildProcess | undefined;
  const fork = childProcess.fork;
  // 只观察创建的真实进程，不替换 IPC、绑定库或训练行为。
  t.mock.method(childProcess, "fork", (...args: Parameters<typeof childProcess.fork>) => {
    child = fork(...args);
    return child;
  });
  const controller = new AbortController();
  let receivedComputingProgress = false;
  const running = optimize(snapshot(3000, 20), {
    signal: controller.signal,
    progress(message) {
      if (message.startsWith("FSRS 参数训练：")) {
        receivedComputingProgress = true;
        controller.abort();
      }
    },
  });
  t.after(() => { child?.kill("SIGKILL"); });
  await assert.rejects(running, isFault("cancelled"));
  assert.equal(receivedComputingProgress, true);
  assert.ok(child);
  const pid = child.pid;
  assert.ok(pid);
  assert.equal(child.signalCode, "SIGKILL");
  assert.throws(() => process.kill(pid, 0), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "ESRCH");
});

test("已取消的请求与非法超时在启动前拒绝", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(optimize(snapshot(), { signal: controller.signal }), isFault("cancelled"));
  for (const timeoutSeconds of [0, 301, 1.5, Infinity]) {
    await assert.rejects(optimize(snapshot(), {
      signal: new AbortController().signal, timeoutSeconds,
    }), isFault("invalid_input"));
  }
});

test("未安装可选组件时明确返回不可用，不阻塞普通调度", { skip: optimizerAvailable }, async () => {
  await assert.rejects(optimize(snapshot(), { signal: new AbortController().signal }), isFault("optimizer_unavailable"));
  assert.equal(schedule(createCard(start), 3, start, defaultParameters()).card.reps, 1);
});
