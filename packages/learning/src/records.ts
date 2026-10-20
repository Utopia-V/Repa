import { isDeepStrictEqual } from "node:util";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { RepaFault } from "@repa/base";
import { contentVersion, parse } from "@repa/base/protocol";
import { DEFAULT_MODEL_CONFIG } from "@repa/learning-model";
import { topicQuestions, versionInput } from "./check/items.js";
import { checkSubmission, type LearningInput, type Submission, type SubmissionReceipt } from "./protocol.js";
import { MODEL_CONFIG_VERSION } from "./student-model.js";
import {
  GradeSchema, RecordSchema, SnapshotSchema,
  type Decision, type Grade, type LearningRecord, type Projection, type RecordBody, type Snapshot,
} from "./records-schema.js";

const originalAnswer = (entry: Submission) => ({
  taskId: entry.taskId, deliveryId: entry.deliveryId, submissionId: entry.submissionId,
  response: entry.response, acceptedAt: entry.acceptedAt, gradeRevision: entry.gradeRevision,
});
function invalid(message: string): never {
  throw new RepaFault("invalid_learning_log", message);
}

export class LearningRecords {
  private readonly entries: LearningRecord[] = [];
  get records(): LearningRecord[] { return structuredClone(this.entries); }
  private projection: Projection | undefined;
  private sequence = 0;
  private snapshots = new Map<string, Snapshot>();
  private submissions = new Map<string, Submission>();
  private starts = new Map<string, number>();
  private grades = new Map<string, Grade>();
  private tail: Promise<unknown> = Promise.resolve();
  private blocked = false;
  private closed = false;
  private readonly judging = new Map<string, Promise<SubmissionReceipt>>();
  private constructor(readonly file: string, private readonly clock: () => number) {}

  static async open(file: string, clock = Date.now): Promise<LearningRecords> {
    const log = new LearningRecords(file, clock);
    const bytes = await readLog(file);
    const end = bytes.lastIndexOf(10) + 1;
    log.blocked = end !== bytes.length;
    for (const line of new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)).split("\n").slice(0, -1)) {
      let record: LearningRecord;
      try {
        record = parse(RecordSchema, JSON.parse(line));
      } catch {
        invalid(`第 ${log.revision + 1} 行不是有效记录`);
      }
      await log.apply(record);
    }
    for (const submission of [...log.submissions.values(), ...log.projection?.state.task?.submissions ?? []]) {
      if (submission.processing.status !== "completed") submission.processing = { status: "interrupted", reason: "restart" };
    }
    const task = log.projection?.state.task;
    if (task?.phase.stage === "judging") task.phase = { stage: "recovery", submissionId: task.phase.submissionId };
    return log;
  }

  get revision(): number { return this.sequence; }
  get incompleteTail(): boolean { return this.blocked; }
  current(): Projection | undefined { return structuredClone(this.projection); }
  snapshot(id: string): Snapshot | undefined { return structuredClone(this.snapshots.get(id)); }
  submission(id: string): Submission | undefined { return structuredClone(this.submissions.get(id)); }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => {
      if (this.closed) throw new RepaFault("learning_closed", "学习记录已关闭");
      return action();
    });
    this.tail = result.catch(() => {});
    return result;
  }

  private async apply(record: LearningRecord): Promise<void> {
    if (record.seq !== this.revision + 1) invalid("记录序号不连续");
    if (record.type === "snapshot") {
      if (await contentVersion(record.snapshot) !== record.digest || this.snapshots.has(record.digest)) invalid("快照摘要错误或重复");
      const snapshot = record.snapshot;
      const entry = topicQuestions(snapshot.topic).find((entry) => entry.kp.id === snapshot.kpId && entry.question.id === snapshot.questionId);
      if (!entry || !snapshot.course.topics.includes(snapshot.topic.id)
        || await contentVersion(snapshot.topic) !== snapshot.topicVersion || await contentVersion(entry.kp) !== snapshot.kpVersion
        || await contentVersion(versionInput(entry.question, snapshot.topic)) !== snapshot.questionVersion) invalid("快照身份或内容版本错误");
      this.snapshots.set(record.digest, structuredClone(record.snapshot));
    } else if (record.type === "checkpoint" || record.type === "graded") {
      const next = structuredClone(record.projection);
      const deliveries = next.state.task?.deliveries ?? [];
      if (new Set(deliveries.map((entry) => entry.deliveryId)).size !== deliveries.length
        || new Set(deliveries.map((entry) => entry.submissionId)).size !== deliveries.length) invalid("交付和预留提交身份必须唯一");
      const previousTask = this.projection?.state.task;
      if (previousTask?.taskId === next.state.task?.taskId && previousTask) {
        if (!isDeepStrictEqual(deliveries.slice(0, previousTask.deliveries.length), previousTask.deliveries)) invalid("已交付题序和题面不能替换");
        for (const delivery of previousTask.deliveries) {
          if (next.deliveries[delivery.deliveryId] !== this.projection?.deliveries[delivery.deliveryId]) invalid("已交付快照不能替换");
        }
      }
      for (const delivery of deliveries) {
        if (this.starts.has(delivery.deliveryId) && !previousTask?.deliveries.some((entry) => entry.deliveryId === delivery.deliveryId)) invalid("交付身份不能重用");
        const snapshot = this.snapshots.get(next.deliveries[delivery.deliveryId] ?? "");
        if (!snapshot || !isDeepStrictEqual(snapshot.item, delivery.item)
          || snapshot.topic.id !== delivery.topicId || snapshot.kpId !== delivery.kpId) invalid("交付必须引用已保存且匹配的快照");
        if (!this.starts.has(delivery.deliveryId)) this.starts.set(delivery.deliveryId, record.at);
      }
      if (record.type === "graded") {
        const previous = this.submissions.get(record.submissionId);
        const result = next.state.task?.submissions.find((entry) => entry.submissionId === record.submissionId);
        if (!previous || previous.processing.status === "completed" || !result || result.processing.status !== "completed"
          || record.grade.feedback.verdict === "pending" || !isDeepStrictEqual(record.grade.feedback.item, previous.response.item)
          || result.gradeRevision !== previous.gradeRevision + 1
          || result.taskId !== previous.taskId || result.deliveryId !== previous.deliveryId || result.acceptedAt !== previous.acceptedAt
          || !isDeepStrictEqual(result.response, previous.response)) invalid("判分必须沿已接受的原答完成一次");
        this.submissions.set(record.submissionId, result);
        this.grades.set(record.submissionId, record.grade);
      }
      for (const previous of this.submissions.values()) {
        if (record.type === "graded" && previous.submissionId === record.submissionId) continue;
        if (previous.processing.status !== "completed" && next.state.task?.taskId !== previous.taskId) invalid("待判原答必须保留原任务");
        if (next.state.task?.taskId !== previous.taskId) continue;
        const entry = next.state.task.submissions.find((entry) => entry.submissionId === previous.submissionId);
        if (!entry || !isDeepStrictEqual(originalAnswer(entry), originalAnswer(previous))
          || (entry.processing.status === "completed") !== (previous.processing.status === "completed")) invalid("任务保存不能替换原答或判分");
      }
      const submissions = next.state.task?.submissions ?? [];
      if (new Set(submissions.map((entry) => entry.submissionId)).size !== submissions.length) invalid("任务不能复制原答");
      for (const entry of submissions) {
        if (!this.submissions.has(entry.submissionId)) invalid("任务保存不能伪造作答");
        if (entry.feedback && !isDeepStrictEqual(entry.feedback, this.grades.get(entry.submissionId)?.feedback)) invalid("只能释放已采用的判分");
        if (entry.processing.status !== "completed" && entry.explanation !== undefined) invalid("待判原答不能释放解析");
        this.submissions.set(entry.submissionId, entry);
      }
      this.projection = next;
    } else if (record.type === "accepted") {
      const submission = structuredClone(record.submission);
      const task = this.projection?.state.task;
      const delivery = task?.deliveries.find((entry) => entry.deliveryId === submission.deliveryId);
      if (!task || task.taskId !== submission.taskId || !delivery || delivery.submissionId !== submission.submissionId
        || submission.processing.status !== "accepted" || submission.gradeRevision !== 0 || submission.feedback !== undefined || submission.explanation !== undefined
        || submission.acceptedAt !== record.context.submittedAt || !isDeepStrictEqual(record.context.model.before, this.projection?.student)
        || this.submissions.has(submission.submissionId) || [...this.submissions.values()].some((entry) => entry.deliveryId === submission.deliveryId)
        || !checkSubmission(delivery.item, submission.response).ok) invalid("接受记录不匹配当前交付或重复");
      this.submissions.set(submission.submissionId, submission);
      task.submissions.push(submission);
      task.phase = { stage: "judging", submissionId: submission.submissionId };
    }
    if (this.projection) this.projection.state.revision = record.seq;
    // 投影会改变恢复显示；原始接受记录始终保留原貌。
    this.sequence = record.seq;
    this.entries.push(structuredClone(record));
  }

  private async append(body: RecordBody): Promise<void> {
    if (this.blocked) throw new RepaFault("learning_log_blocked", "日志尾部残缺或写入结果不明，请关闭空间后恢复");
    const record = parse(RecordSchema, { ...body, v: 1, seq: this.revision + 1, at: this.clock() });
    // 在碰磁盘前，使用相同重放路径验证完整语义。
    const candidate = new LearningRecords(this.file, this.clock);
    candidate.sequence = this.revision;
    candidate.projection = this.current();
    candidate.snapshots = new Map(this.snapshots);
    candidate.submissions = new Map(structuredClone([...this.submissions]));
    candidate.starts = new Map(this.starts);
    candidate.grades = new Map(this.grades);
    await candidate.apply(structuredClone(record));
    await contentVersion(record);
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      const handle = await open(this.file, "a", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const directory = await open(path.dirname(this.file), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      this.blocked = true;
      throw error;
    }
    this.projection = candidate.projection;
    this.snapshots = candidate.snapshots;
    this.submissions = candidate.submissions;
    this.starts = candidate.starts;
    this.grades = candidate.grades;
    this.sequence = record.seq;
    this.entries.push(structuredClone(record));
  }

  saveSnapshot(snapshot: Snapshot): Promise<string> {
    return this.serial(async () => {
      const copy = parse(SnapshotSchema, structuredClone(snapshot));
      const id = await contentVersion(copy);
      if (!this.snapshots.has(id)) await this.append({ type: "snapshot", digest: id, snapshot: copy });
      return id;
    });
  }

  checkpoint(
    expectedRevision: number,
    build: (current: Projection | undefined, now: number) => { projection: Projection; decision: Decision },
  ): Promise<void> {
    return this.serial(async () => {
      if (this.revision !== expectedRevision) throw new RepaFault("stale_state", "学习状态已改变");
      const now = this.clock();
      const result = build(this.current(), now);
      result.decision.now = now;
      await this.append({ type: "checkpoint", ...result });
    });
  }

  viewed(input: Omit<Extract<RecordBody, { type: "viewed" }>, "type">): Promise<void> {
    return this.serial(() => this.append({ type: "viewed", ...input }));
  }

  async submit(input: LearningInput<"submission.submit">): Promise<SubmissionReceipt> {
    return this.serial(async () => {
      const previous = this.submissions.get(input.submissionId);
      if (previous) {
        if (previous.taskId !== input.taskId || previous.deliveryId !== input.deliveryId || !isDeepStrictEqual(previous.response, input.response)) {
          throw new RepaFault("submission_conflict", "同一提交身份不能替换原答", { reason: "payload_conflict", submissionId: input.submissionId });
        }
        return { status: "recorded", submission: structuredClone(previous) };
      }
      const task = this.projection?.state.task;
      const delivery = task?.deliveries.find((entry) => entry.deliveryId === input.deliveryId);
      const now = this.clock();
      if (!task || task.taskId !== input.taskId || !delivery || delivery.submissionId !== input.submissionId
        || !["awaiting_answer", "judging", "recovery"].includes(task.phase.stage)
        || (delivery.mode !== "quiz" && (task.phase.stage !== "awaiting_answer" || task.phase.deliveryId !== delivery.deliveryId))
        || (task.deadlineAt !== null && now >= task.deadlineAt)) throw new RepaFault("stale_state", "交付已失效或已截止");
      const checked = checkSubmission(delivery.item, input.response);
      if (!checked.ok || (delivery.mode === "quiz" && input.response.dontKnow)) {
        return { status: "rejected", submissionId: input.submissionId, processing: { status: "not_accepted" }, problems: checked.ok ? [{ message: "测验不接受不会作答" }] : checked.problems };
      }
      const startedAt = this.starts.get(delivery.deliveryId) ?? now;
      const submission: Submission = {
        ...structuredClone(input), acceptedAt: now, processing: { status: "accepted" }, gradeRevision: 0,
      };
      const helpBefore = this.records.filter((record) => record.type === "viewed" && record.taskId === task.taskId && (record.deliveryId === undefined || record.deliveryId === input.deliveryId) && record.action === "help_before").map((record) => String(record.seq));
      await this.append({ type: "accepted", submission, context: {
        startedAt, submittedAt: now, startOffsetMs: startedAt - (task.startedAt ?? startedAt), submitOffsetMs: now - startedAt,
        helpBefore, model: { before: this.projection?.student ?? {}, now, configVersion: MODEL_CONFIG_VERSION, config: DEFAULT_MODEL_CONFIG },
      } });
      return { status: "recorded", submission: this.submission(input.submissionId) ?? submission };
    });
  }

  /** 服务调用不占串行入口；结果及其确定的状态转换合为一次追加。 */
  grade(
    id: string,
    judge: (submission: Submission, snapshot: Snapshot) => Promise<Grade>,
    advance: (current: Projection, submission: Submission, grade: Grade, now: number) => Projection,
  ): Promise<SubmissionReceipt> {
    const active = this.judging.get(id);
    if (active) return active;
    const work = (async (): Promise<SubmissionReceipt> => {
      const prepared = await this.serial(async () => {
        const submission = this.submission(id);
        if (!submission) throw new RepaFault("invalid_input", "找不到提交");
        if (submission.processing.status === "completed") return { submission, snapshot: undefined };
        const current = this.current();
        const snapshot = this.snapshot(current?.deliveries[submission.deliveryId] ?? "");
        if (!current || !snapshot) throw new RepaFault("invalid_input", "找不到原交付快照");
        return { submission, snapshot };
      });
      if (prepared.submission.processing.status === "completed") return { status: "recorded", submission: prepared.submission };
      if (!prepared.snapshot) throw new RepaFault("invalid_input", "找不到原交付快照");
      const grade = parse(GradeSchema, await judge(prepared.submission, prepared.snapshot));
      if (grade.feedback.verdict === "pending" || !isDeepStrictEqual(grade.feedback.item, prepared.submission.response.item)) {
        throw new RepaFault("invalid_grade", "判分尚未完成或不匹配原题");
      }
      return this.serial(async () => {
        const current = this.current();
        if (!current || current.state.task?.taskId !== prepared.submission.taskId) throw new RepaFault("stale_state", "待判任务已改变");
        const projection = advance(current, prepared.submission, grade, this.clock());
        await this.append({ type: "graded", submissionId: id, grade, projection });
        return { status: "recorded", submission: this.submission(id) ?? prepared.submission };
      });
    })();
    this.judging.set(id, work);
    const cleanup = () => { this.judging.delete(id); };
    work.then(cleanup, cleanup);
    return work;
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.judging.values());
    await this.tail;
    this.closed = true;
  }
}

async function readLog(file: string): Promise<Buffer> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return Buffer.alloc(0);
  }
}

export async function recoverLearningLog(source: string, destination: string): Promise<void> {
  const log = await LearningRecords.open(source);
  await log.close();
  const bytes = await readFile(source);
  const handle = await open(destination, "wx", 0o600);
  try {
    await handle.writeFile(bytes.subarray(0, bytes.lastIndexOf(10) + 1));
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await open(path.dirname(destination), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
