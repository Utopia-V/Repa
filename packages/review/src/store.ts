import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { Static, TSchema } from "typebox";
import { Compile, type Validator } from "typebox/compile";
import type { CapabilitySource } from "repa/plugin";
import { CapabilitySourceSchema, RepaFault } from "repa/protocol";
import * as fsrs from "./fsrs.js";
import {
  CreateReviewInputSchema, UpdateReviewInputSchema, SubmitFeedbackInputSchema, CorrectFeedbackInputSchema,
  SetReviewStatusInputSchema, SetReviewScheduleInputSchema, SetReviewParametersInputSchema,
  ReviewItemSchema, ReviewEventSchema, ParameterVersionSchema, ReviewMutationResultSchema,
  SetReviewParametersResultSchema,
  type CreateReviewInput, type UpdateReviewInput, type SubmitFeedbackInput, type CorrectFeedbackInput,
  type SetReviewStatusInput, type SetReviewScheduleInput, type SetReviewParametersInput,
  type ListReviewsInput, type ListReviewsResult, type ReviewHistoryInput, type ReviewHistoryResult,
  type ReviewItem, type ReviewEvent, type FeedbackEvent, type ParameterVersion,
  type ReviewMutationResult, type SetReviewParametersResult, type FsrsReview, type FsrsParameters,
  type ReviewTrainingSnapshot,
} from "./schema.js";

const validators = new WeakMap<TSchema, Validator>();

function check<T extends TSchema>(schema: T, value: unknown): value is Static<T> {
  let validator = validators.get(schema);
  if (!validator) {
    // 持久格式固定，编译一次后复用，避免批量重算反复解释每条事件的 schema。
    validator = Compile(schema);
    validators.set(schema, validator);
  }
  return validator.Check(value);
}

function encode<T extends TSchema>(schema: T, value: Static<T>): string {
  if (!check(schema, value)) throw new RepaFault("review_data_invalid", "复习数据不符合持久格式。");
  return JSON.stringify(value);
}

function decode<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  let value: unknown;
  try {
    if (typeof raw !== "string") throw new Error("非文本数据");
    value = JSON.parse(raw);
  } catch {
    throw new RepaFault("review_data_invalid", "复习数据库中的 JSON 数据损坏。");
  }
  if (!check(schema, value)) throw new RepaFault("review_data_invalid", "复习数据库中的数据不符合持久格式。");
  return value;
}

interface EffectiveReview extends FsrsReview {
  feedbackId: string;
  sequence: number;
}

/** 同步 SQLite 事务保证能力结果、实际事件和当前调度一起持久后才返回。 */
export class ReviewStore {
  private readonly database: DatabaseSync;

  constructor(file: string, private readonly now: () => number = Date.now) {
    this.database = new DatabaseSync(file, { timeout: 5000 });
    try {
      this.database.exec("PRAGMA foreign_keys = ON;");
      this.initialize();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  private initialize(): void {
    this.transaction(() => {
      const version = this.database.prepare("PRAGMA user_version").get()?.user_version;
      if (version === 1) return;
      if (version !== 0) {
        throw new RepaFault("review_schema_unsupported", "复习数据库版本不受支持。", { version });
      }
      this.database.exec(`
        CREATE TABLE parameter_versions (
          version INTEGER PRIMARY KEY,
          data TEXT NOT NULL,
          recorded_by TEXT
        ) STRICT;
        CREATE TABLE items (
          id TEXT PRIMARY KEY,
          due_at INTEGER NOT NULL,
          paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
          data TEXT NOT NULL,
          created_by TEXT NOT NULL
        ) STRICT;
        CREATE INDEX items_due ON items(paused, due_at, id);
        CREATE TABLE events (
          id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL REFERENCES items(id),
          sequence INTEGER NOT NULL,
          data TEXT NOT NULL,
          UNIQUE(item_id, sequence)
        ) STRICT;
        CREATE TABLE operation_receipts (
          operation_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          input TEXT NOT NULL,
          result TEXT NOT NULL
        ) STRICT;
        PRAGMA user_version = 1;
      `);
      const parameters: ParameterVersion = {
        version: 1, createdAt: this.now(), libraryVersion: fsrs.libraryVersion,
        algorithmVersion: fsrs.algorithmVersion, parameters: fsrs.defaultParameters(),
      };
      this.database.prepare("INSERT INTO parameter_versions(version, data) VALUES (?, ?)")
        .run(parameters.version, encode(ParameterVersionSchema, parameters));
    });
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  }

  private transaction<T>(work: () => T, mode: "IMMEDIATE" | "DEFERRED" = "IMMEDIATE"): T {
    this.database.exec(`BEGIN ${mode}`);
    try {
      const result = work();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private mutate<I extends TSchema, R extends TSchema>(
    kind: string, inputSchema: I, resultSchema: R,
    input: Static<I> & { operationId: string }, work: () => Static<R>,
  ): Static<R> {
    return this.transaction(() => {
      const receipt = this.database.prepare("SELECT kind, input, result FROM operation_receipts WHERE operation_id = ?")
        .get(input.operationId);
      const encodedInput = JSON.stringify(input);
      if (receipt) {
        if (receipt.kind !== kind || !isDeepStrictEqual(decode(inputSchema, receipt.input), JSON.parse(encodedInput))) {
          throw new RepaFault("review_operation_conflict", "操作标识已经用于不同的复习修改。", { operationId: input.operationId });
        }
        return decode(resultSchema, receipt.result);
      }
      // 参数入口由宿主解析；只在实际写入 JSON 的持久边界验证。
      const result = work();
      this.database.prepare("INSERT INTO operation_receipts(operation_id, kind, input, result) VALUES (?, ?, ?, ?)")
        .run(input.operationId, kind, encode(inputSchema, input), encode(resultSchema, result));
      return result;
    });
  }

  private saveItem(item: ReviewItem): void {
    this.database.prepare("UPDATE items SET due_at = ?, paused = ?, data = ? WHERE id = ?")
      .run(item.dueAt, Number(item.paused), encode(ReviewItemSchema, item), item.id);
  }

  private append(event: ReviewEvent): void {
    this.database.prepare("INSERT INTO events(id, item_id, sequence, data) VALUES (?, ?, ?, ?)")
      .run(event.id, event.itemId, event.sequence, encode(ReviewEventSchema, event));
  }

  private events(itemId: string): ReviewEvent[] {
    return this.database.prepare("SELECT data FROM events WHERE item_id = ? ORDER BY sequence")
      .all(itemId).map((row) => decode(ReviewEventSchema, row.data));
  }

  private nextSequence(itemId: string): number {
    const value = this.database.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM events WHERE item_id = ?")
      .get(itemId)?.sequence;
    if (typeof value !== "number") throw new RepaFault("review_data_invalid", "无法取得复习记录的顺序。");
    return value;
  }

  private effective(events: readonly ReviewEvent[]): EffectiveReview[] {
    const reviews = new Map<string, EffectiveReview>();
    const originals = new Map<string, FeedbackEvent>();
    for (const event of events) {
      if (event.kind === "feedback") {
        originals.set(event.id, event);
        reviews.set(event.id, {
          feedbackId: event.id, sequence: event.sequence, rating: event.rating, review: event.reviewedAt,
        });
      }
    }
    // 每次更正重新解释原反馈，后来的 replace 可以恢复此前被 void 的事实。
    for (const event of events) {
      if (event.kind !== "correction") continue;
      const original = originals.get(event.feedbackId);
      if (!original) throw new RepaFault("review_data_invalid", "更正指向不存在的实际反馈。");
      if (event.correction.kind === "void") {
        reviews.delete(event.feedbackId);
      } else {
        reviews.set(event.feedbackId, {
          feedbackId: original.id, sequence: original.sequence,
          rating: event.correction.rating, review: event.correction.reviewedAt,
        });
      }
    }
    return [...reviews.values()].sort((a, b) => a.review - b.review || a.sequence - b.sequence);
  }

  private rebuild(item: ReviewItem, reviews: readonly EffectiveReview[], parameters: ParameterVersion) {
    const startedAt = Math.min(item.createdAt, reviews[0]?.review ?? item.createdAt);
    return fsrs.rebuild(startedAt, reviews, parameters.parameters);
  }

  private based(itemId: string, base: number): ReviewItem {
    const item = this.get(itemId);
    if (item.revision !== base) {
      throw new RepaFault("review_conflict", "复习项已被其他操作修改。", { itemId, base, revision: item.revision });
    }
    return item;
  }

  create(input: CreateReviewInput, recordedBy: CapabilitySource): ReviewMutationResult {
    return this.mutate("create", CreateReviewInputSchema, ReviewMutationResultSchema, input, () => {
      const now = this.now();
      const parameters = this.parameters();
      const card = fsrs.createCard(now);
      const item: ReviewItem = {
        id: randomUUID(), revision: 1, prompt: input.prompt,
        ...(input.answer === undefined ? {} : { answer: input.answer }),
        sources: input.sources ?? [], createdAt: now, updatedAt: now, paused: false,
        card, parameterVersion: parameters.version, dueAt: card.due,
      };
      this.database.prepare("INSERT INTO items(id, due_at, paused, data, created_by) VALUES (?, ?, ?, ?, ?)")
        .run(item.id, item.dueAt, 0, encode(ReviewItemSchema, item), encode(CapabilitySourceSchema, recordedBy));
      return { item };
    });
  }

  update(input: UpdateReviewInput, _actor: CapabilitySource): ReviewMutationResult {
    return this.mutate("update", UpdateReviewInputSchema, ReviewMutationResultSchema, input, () => {
      const item = this.based(input.itemId, input.base);
      if (input.patch.prompt !== undefined) item.prompt = input.patch.prompt;
      if (input.patch.answer === null) delete item.answer;
      else if (input.patch.answer !== undefined) item.answer = input.patch.answer;
      if (input.patch.sources !== undefined) item.sources = input.patch.sources;
      item.revision += 1;
      item.updatedAt = this.now();
      this.saveItem(item);
      return { item };
    });
  }

  get(itemId: string): ReviewItem {
    const row = this.database.prepare("SELECT data FROM items WHERE id = ?").get(itemId);
    if (!row) throw new RepaFault("review_not_found", "复习项不存在。", { itemId });
    return decode(ReviewItemSchema, row.data);
  }

  list(input: ListReviewsInput): ListReviewsResult {
    const limit = Math.min(input.limit ?? 50, 200);
    const rows = this.database.prepare(`
      SELECT data FROM items WHERE paused = ?
        AND (? IS NULL OR due_at <= ?)
        AND (? IS NULL OR due_at > ? OR (due_at = ? AND id > ?))
      ORDER BY due_at, id LIMIT ?
    `).all(Number(input.paused ?? false), input.dueBefore ?? null, input.dueBefore ?? null,
      input.after?.dueAt ?? null, input.after?.dueAt ?? null, input.after?.dueAt ?? null,
      input.after?.id ?? null, limit + 1);
    const items = rows.slice(0, limit).map((row) => decode(ReviewItemSchema, row.data));
    const last = items.at(-1);
    return { items, ...(rows.length > limit && last ? { next: { dueAt: last.dueAt, id: last.id } } : {}) };
  }

  feedback(input: SubmitFeedbackInput, actor: CapabilitySource): ReviewMutationResult {
    return this.mutate("feedback", SubmitFeedbackInputSchema, ReviewMutationResultSchema, input, () => {
      const item = this.based(input.itemId, input.base);
      // 这是反馈受理时匹配 base 的项目，不根据回填的 reviewedAt 推补过去的题面。
      const itemAtRecording = structuredClone({
        revision: item.revision, prompt: item.prompt,
        ...(item.answer === undefined ? {} : { answer: item.answer }),
        sources: item.sources,
      });
      const parameters = this.parameters();
      const now = this.now();
      const reviewedAt = input.reviewedAt ?? now;
      const sequence = this.nextSequence(item.id);
      const id = randomUUID();
      let result: FeedbackEvent["result"];
      let recomputedReviews: number | undefined;
      let currentCard: ReviewItem["card"];
      const lastReview = item.card.last_review;
      if (lastReview === undefined || reviewedAt >= lastReview) {
        const previousCard = lastReview === undefined && reviewedAt < item.createdAt ? fsrs.createCard(reviewedAt) : item.card;
        result = fsrs.schedule(previousCard, input.rating, reviewedAt, parameters.parameters);
        currentCard = result.card;
      } else {
        const reviews = this.effective(this.events(item.id));
        reviews.push({ feedbackId: id, sequence, rating: input.rating, review: reviewedAt });
        reviews.sort((a, b) => a.review - b.review || a.sequence - b.sequence);
        const rebuilt = this.rebuild(item, reviews, parameters);
        const index = reviews.findIndex((review) => review.feedbackId === id);
        // 当次结果保存该事实所对应的 card/log；全量当前估计单独更新，旧事件不被覆盖。
        const atReview = this.rebuild(item, reviews.slice(0, index + 1), parameters);
        const log = atReview.logs.at(-1);
        if (!log) throw new RepaFault("review_data_invalid", "调度器未返回实际反馈日志。");
        result = { card: atReview.card, log };
        currentCard = rebuilt.card;
        recomputedReviews = reviews.length;
      }
      const event: FeedbackEvent = {
        id, itemId: item.id, sequence, recordedAt: now, recordedBy: actor, kind: "feedback",
        reviewedAt, rating: input.rating,
        ...(input.response === undefined ? {} : { response: input.response }),
        ...(input.assistance === undefined ? {} : { assistance: input.assistance }),
        itemAtRecording,
        sources: input.sources ?? item.sources, parameterVersion: parameters.version, result,
      };
      delete item.manualDueAt;
      Object.assign(item, {
        card: currentCard, parameterVersion: parameters.version, dueAt: currentCard.due,
        revision: item.revision + 1, updatedAt: now,
      });
      this.append(event);
      this.saveItem(item);
      return { item, event, ...(recomputedReviews === undefined ? {} : { recomputedReviews }) };
    });
  }

  correct(input: CorrectFeedbackInput, actor: CapabilitySource): ReviewMutationResult {
    return this.mutate("correct", CorrectFeedbackInputSchema, ReviewMutationResultSchema, input, () => {
      const item = this.based(input.itemId, input.base);
      const events = this.events(item.id);
      if (!events.some((event) => event.id === input.feedbackId && event.kind === "feedback")) {
        throw new RepaFault("review_feedback_not_found", "需要更正的实际反馈不存在。", { feedbackId: input.feedbackId });
      }
      const parameters = this.parameters();
      const now = this.now();
      const event: ReviewEvent = {
        id: randomUUID(), itemId: item.id, sequence: (events.at(-1)?.sequence ?? 0) + 1,
        recordedAt: now, recordedBy: actor, kind: "correction", feedbackId: input.feedbackId,
        correction: input.correction, reason: input.reason, parameterVersion: parameters.version,
      };
      const reviews = this.effective([...events, event]);
      const { card } = this.rebuild(item, reviews, parameters);
      Object.assign(item, {
        card, parameterVersion: parameters.version, dueAt: item.manualDueAt ?? card.due,
        revision: item.revision + 1, updatedAt: now,
      });
      this.append(event);
      this.saveItem(item);
      return { item, event, recomputedReviews: reviews.length };
    });
  }

  setStatus(input: SetReviewStatusInput, _actor: CapabilitySource): ReviewMutationResult {
    return this.mutate("status", SetReviewStatusInputSchema, ReviewMutationResultSchema, input, () => {
      const item = this.based(input.itemId, input.base);
      item.paused = input.paused;
      item.revision += 1;
      item.updatedAt = this.now();
      this.saveItem(item);
      return { item };
    });
  }

  setSchedule(input: SetReviewScheduleInput, _actor: CapabilitySource): ReviewMutationResult {
    return this.mutate("schedule", SetReviewScheduleInputSchema, ReviewMutationResultSchema, input, () => {
      const item = this.based(input.itemId, input.base);
      if (input.dueAt === null) delete item.manualDueAt;
      else item.manualDueAt = input.dueAt;
      item.dueAt = item.manualDueAt ?? item.card.due;
      item.revision += 1;
      item.updatedAt = this.now();
      this.saveItem(item);
      return { item };
    });
  }

  history(input: ReviewHistoryInput): ReviewHistoryResult {
    this.get(input.itemId);
    const limit = Math.min(input.limit ?? 50, 200);
    const rows = this.database.prepare("SELECT data FROM events WHERE item_id = ? AND sequence > ? ORDER BY sequence LIMIT ?")
      .all(input.itemId, input.after ?? 0, limit + 1);
    const events = rows.slice(0, limit).map((row) => decode(ReviewEventSchema, row.data));
    const last = events.at(-1);
    return { events, ...(rows.length > limit && last ? { next: last.sequence } : {}) };
  }

  parameters(version?: number): ParameterVersion {
    const row = version === undefined
      ? this.database.prepare("SELECT data FROM parameter_versions ORDER BY version DESC LIMIT 1").get()
      : this.database.prepare("SELECT data FROM parameter_versions WHERE version = ?").get(version);
    if (!row) throw new RepaFault("review_parameters_not_found", "复习参数版本不存在。", { version });
    return decode(ParameterVersionSchema, row.data);
  }

  trainingSnapshot(): ReviewTrainingSnapshot {
    // 读事务固定参数与事实的同一快照；暂停只影响到期展示，不排除实际学习事实。
    return this.transaction(() => {
      const parameters = this.parameters();
      const items = this.database.prepare("SELECT data FROM items ORDER BY id").all().map((row) => {
        const { id } = decode(ReviewItemSchema, row.data);
        const reviews = this.effective(this.events(id)).map(({ rating, review }) => ({ rating, review }));
        return { id, reviews };
      });
      return { parameters, items };
    }, "DEFERRED");
  }

  setParameters(input: SetReviewParametersInput, actor: CapabilitySource): SetReviewParametersResult {
    return this.mutate("parameters", SetReviewParametersInputSchema, SetReviewParametersResultSchema, input, () => {
      const previous = this.parameters();
      if (previous.version !== input.base) {
        throw new RepaFault("review_conflict", "复习参数已被其他操作修改。", { base: input.base, version: previous.version });
      }
      let normalized: FsrsParameters;
      try {
        normalized = fsrs.normalizeParameters({ ...previous.parameters, ...input.patch });
      } catch {
        throw new RepaFault("review_parameters_invalid", "复习参数不能用于 FSRS 调度。");
      }
      const now = this.now();
      const parameters: ParameterVersion = {
        version: previous.version + 1, createdAt: now, libraryVersion: fsrs.libraryVersion,
        algorithmVersion: fsrs.algorithmVersion, parameters: normalized,
      };
      this.database.prepare("INSERT INTO parameter_versions(version, data, recorded_by) VALUES (?, ?, ?)")
        .run(parameters.version, encode(ParameterVersionSchema, parameters), encode(CapabilitySourceSchema, actor));
      const rows = this.database.prepare("SELECT data FROM items ORDER BY id").all();
      for (const row of rows) {
        const item = decode(ReviewItemSchema, row.data);
        const { card } = this.rebuild(item, this.effective(this.events(item.id)), parameters);
        Object.assign(item, {
          card, parameterVersion: parameters.version, dueAt: item.manualDueAt ?? card.due,
          revision: item.revision + 1, updatedAt: now,
        });
        this.saveItem(item);
      }
      return { parameters, recomputedItems: rows.length };
    });
  }
}
