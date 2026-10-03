import {
  FSRSVersion,
  checkParameters,
  createEmptyCard,
  fsrs,
  generatorParameters,
  type Card,
  type FSRSParameters,
  type RecordLogItem,
} from "ts-fsrs";
import type {
  FsrsCard,
  FsrsGrade,
  FsrsLog,
  FsrsParameters,
  FsrsReview,
} from "./fsrs-schema.js";

export const libraryVersion = "5.4.2";
export const algorithmVersion = FSRSVersion;

function serializeParameters(parameters: FSRSParameters): FsrsParameters {
  return {
    ...parameters,
    w: [...parameters.w],
    learning_steps: [...parameters.learning_steps],
    relearning_steps: [...parameters.relearning_steps],
  };
}

export function defaultParameters(): FsrsParameters {
  return serializeParameters(generatorParameters());
}

export function normalizeParameters(parameters: FsrsParameters): FsrsParameters {
  checkParameters(parameters.w);
  const scheduler = fsrs(serializeParameters(parameters));
  scheduler.calculate_interval_modifier(parameters.request_retention);
  return serializeParameters(scheduler.parameters);
}

function serializeCard(card: Card): FsrsCard {
  const { due, last_review, ...fields } = card;
  return {
    ...fields,
    due: due.getTime(),
    ...(last_review === undefined ? {} : { last_review: last_review.getTime() }),
  };
}

function deserializeCard(card: FsrsCard): Card {
  const { due, last_review, ...fields } = card;
  return {
    ...fields,
    due: new Date(due),
    ...(last_review === undefined ? {} : { last_review: new Date(last_review) }),
  };
}

function serializeItem(item: RecordLogItem): { card: FsrsCard; log: FsrsLog } {
  // 普通反馈只产生 1—4；重建的人工调度日志不属于真实反馈，也不进入结果。
  if (item.log.rating === 0) {
    throw new Error("人工调度日志不能作为普通复习反馈保存");
  }
  return {
    card: serializeCard(item.card),
    log: {
      ...item.log,
      rating: item.log.rating,
      due: item.log.due.getTime(),
      review: item.log.review.getTime(),
    },
  };
}

export function createCard(at: number): FsrsCard {
  return serializeCard(createEmptyCard(new Date(at)));
}

export function schedule(
  card: FsrsCard,
  grade: FsrsGrade,
  at: number,
  parameters: FsrsParameters,
): { card: FsrsCard; log: FsrsLog } {
  return fsrs(serializeParameters(parameters)).next(
    deserializeCard(card),
    new Date(at),
    grade,
    serializeItem,
  );
}

export function preview(
  card: FsrsCard,
  at: number,
  parameters: FsrsParameters,
): Record<FsrsGrade, { card: FsrsCard; log: FsrsLog }> {
  const outcomes = fsrs(serializeParameters(parameters)).repeat(deserializeCard(card), new Date(at));
  return {
    1: serializeItem(outcomes[1]),
    2: serializeItem(outcomes[2]),
    3: serializeItem(outcomes[3]),
    4: serializeItem(outcomes[4]),
  };
}

export function rebuild(
  createdAt: number,
  effectiveReviews: readonly FsrsReview[],
  parameters: FsrsParameters,
): { card: FsrsCard; logs: FsrsLog[] } {
  const firstCard = createEmptyCard(new Date(createdAt));
  // 调用方已按实际复习时间和稳定次序排序；复制后交给 SDK，避免它修改事实输入。
  const reviews = effectiveReviews.map((review) => ({ ...review, review: new Date(review.review) }));
  const now = effectiveReviews.at(-1)?.review ?? createdAt;
  const result = fsrs(serializeParameters(parameters)).reschedule(firstCard, reviews, {
    first_card: firstCard,
    now: new Date(now),
  });
  const collections = result.collections.map(serializeItem);
  const last = collections.at(-1);
  return {
    card: last?.card ?? serializeCard(firstCard),
    logs: collections.map((item) => item.log),
  };
}
