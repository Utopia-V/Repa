import test from "node:test";
import assert from "node:assert/strict";
import { createEmptyCard, fsrs, FSRSVersion, generatorParameters } from "ts-fsrs";
import { Value } from "typebox/value";
import {
  algorithmVersion,
  libraryVersion,
  createCard,
  defaultParameters,
  normalizeParameters,
  preview,
  rebuild,
  schedule,
} from "../src/fsrs.js";
import {
  FsrsCardSchema,
  FsrsLogSchema,
  FsrsParametersSchema,
  type FsrsCard,
  type FsrsGrade,
  type FsrsParameters,
  type FsrsReview,
} from "../src/fsrs-schema.js";

const createdAt = Date.parse("2026-06-01T08:00:00Z");
const day = 86400000;

function replay(reviews: readonly FsrsReview[], parameters: FsrsParameters) {
  let card = createCard(createdAt);
  const logs = [];
  for (const review of reviews) {
    const result = schedule(card, review.rating, review.review, parameters);
    card = result.card;
    logs.push(result.log);
  }
  return { card, logs };
}

function deserialize(card: FsrsCard) {
  return {
    ...card,
    due: new Date(card.due),
    last_review: card.last_review === undefined ? undefined : new Date(card.last_review),
  };
}

function serializeSdk<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, function (key, item: unknown) {
    const source: unknown = key === "" ? value : Reflect.get(this, key);
    return source instanceof Date ? source.getTime() : item;
  }));
}

test("默认参数完整保留 SDK 快照，算法版本与库版本分别标识", () => {
  assert.equal(libraryVersion, "5.4.2");
  assert.equal(algorithmVersion, FSRSVersion);
  assert.match(algorithmVersion, /FSRS-6\.0/);
  assert.deepEqual(defaultParameters(), generatorParameters());
  assert.equal(Value.Check(FsrsParametersSchema, defaultParameters()), true);
  assert.deepEqual(normalizeParameters(defaultParameters()), defaultParameters());
  const changed = defaultParameters();
  changed.w[0] = 10;
  changed.learning_steps.push("20m");
  assert.deepEqual(defaultParameters(), generatorParameters());
});

test("新卡和四种反馈通过真实 SDK 调度，日期以毫秒持久化", () => {
  const parameters = defaultParameters();
  const card = createCard(createdAt);
  const initial = structuredClone(card);
  assert.deepEqual(card, serializeSdk(createEmptyCard(new Date(createdAt))));
  assert.equal(createCard(0).due, 0);
  assert.equal(Value.Check(FsrsCardSchema, card), true);
  const outcomes = preview(card, createdAt, parameters);
  for (const grade of [1, 2, 3, 4] as const) {
    const result = schedule(card, grade, createdAt, parameters);
    const expected = fsrs(parameters).next(deserialize(card), new Date(createdAt), grade);
    assert.deepEqual(result, serializeSdk(expected));
    assert.deepEqual(outcomes[grade], result);
    assert.equal(result.card.last_review, createdAt);
    assert.equal(result.log.review, createdAt);
    assert.equal(Value.Check(FsrsCardSchema, result.card), true);
    assert.equal(Value.Check(FsrsLogSchema, result.log), true);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  }
  assert.deepEqual(card, initial);
});

test("跨天复习与同一时间的稳定次序可确定性重建，启用 fuzz 也不改变结果", () => {
  const reviews: FsrsReview[] = [
    { rating: 3, review: createdAt },
    { rating: 3, review: createdAt + 600000 },
    { rating: 4, review: createdAt + 3 * day },
    { rating: 1, review: createdAt + 20 * day },
    { rating: 2, review: createdAt + 20 * day },
    { rating: 3, review: createdAt + 21 * day },
    { rating: 4, review: createdAt + 30 * day },
  ];
  for (const enable_fuzz of [false, true]) {
    const parameters = { ...defaultParameters(), enable_fuzz };
    const originalReviews = structuredClone(reviews);
    const originalParameters = structuredClone(parameters);
    const expected = replay(reviews, parameters);
    assert.deepEqual(rebuild(createdAt, reviews, parameters), expected);
    assert.deepEqual(rebuild(createdAt, reviews, parameters), expected);
    assert.equal(expected.logs.length, reviews.length);
    assert.deepEqual(expected.logs.map((log) => log.rating), reviews.map((review) => review.rating));
    assert.deepEqual(reviews, originalReviews);
    assert.deepEqual(parameters, originalParameters);
  }
  assert.deepEqual(rebuild(createdAt, [], defaultParameters()), { card: createCard(createdAt), logs: [] });
});

test("更正实际反馈后从创建时刻重建，替代旧评分而不额外增加一次复习", () => {
  const parameters = defaultParameters();
  const reviews: FsrsReview[] = [
    { rating: 4, review: createdAt },
    { rating: 3, review: createdAt + 8 * day },
    { rating: 3, review: createdAt + 20 * day },
  ];
  const original = rebuild(createdAt, reviews, parameters);
  const corrected = reviews.map((review, index) => ({
    ...review,
    rating: index === 1 ? 1 as FsrsGrade : review.rating,
  }));
  const result = rebuild(createdAt, corrected, parameters);
  assert.deepEqual(result, replay(corrected, parameters));
  assert.equal(result.card.reps, original.card.reps);
  assert.equal(result.card.lapses, 1);
  assert.notEqual(result.card.stability, original.card.stability);
  assert.deepEqual(result.logs.map((log) => log.review), reviews.map((review) => review.review));
  assert.equal(reviews[1]?.rating, 3);
});

test("参数变化只更新调度估计，不修改实际复习时间、评分和输入对象", () => {
  const reviews: FsrsReview[] = [
    { rating: 4, review: createdAt },
    { rating: 3, review: createdAt + 8 * day },
    { rating: 4, review: createdAt + 20 * day },
  ];
  const parameters = defaultParameters();
  const changed = normalizeParameters({ ...parameters, request_retention: 0.97 });
  const originalReviews = structuredClone(reviews);
  const originalParameters = structuredClone(parameters);
  const before = rebuild(createdAt, reviews, parameters);
  const after = rebuild(createdAt, reviews, changed);
  assert.deepEqual(after, replay(reviews, changed));
  assert.notEqual(after.card.due, before.card.due);
  assert.equal(after.card.stability, before.card.stability);
  assert.deepEqual(after.logs.map((log) => ({ rating: log.rating, review: log.review })), reviews);
  assert.deepEqual(reviews, originalReviews);
  assert.deepEqual(parameters, originalParameters);
});

test("参数边界沿用官方权重验证和 retention 验证", () => {
  const parameters = defaultParameters();
  assert.throws(() => normalizeParameters({ ...parameters, w: [1] }));
  assert.throws(() => normalizeParameters({ ...parameters, request_retention: 1.1 }));
  assert.throws(() => normalizeParameters({ ...parameters, request_retention: 0 }));
});
