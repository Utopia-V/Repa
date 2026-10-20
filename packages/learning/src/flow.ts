import { isDeepStrictEqual } from "node:util";
import { RepaFault } from "@repa/base";
import { isDue } from "@repa/learning-model";
import type { Host, MethodContext, PluginInstance, PluginMethod } from "@repa/base/plugin";
import { contentVersion, parse, type ClientCapabilities } from "@repa/base/protocol";
import type { ResolvedCourse } from "./course-sources.js";
import { content, slotTests, topicQuestions } from "./check/items.js";
import { deliver, opaqueId, shuffled } from "./delivery.js";
import { learningMenu } from "./flow-menu.js";
import {
  finished,
  FLOW_VERSION,
  graphFor,
  isQuiz,
  quizCorrect,
  kpProgress,
  replayLearning,
  requireTask,
  reviewResult,
  taskEvidence,
  type TaskEvidence,
} from "./flow-state.js";
import { judgeSubmission } from "./judge.js";
import {
  learningMethods,
  missingDeliveryCapabilities,
  type ContentPage,
  type LearningInput,
  type LearningMethod,
  type LearningTask,
} from "./protocol.js";
import type { Grade, Projection } from "./records-schema.js";
import type { LearningRecords } from "./records.js";
import { progressMenu, updateProgress } from "./progress.js";
import { pythonAvailable, runnerVersion } from "./python-execution.js";
import { createSnapshot } from "./snapshot.js";

const POOLS = {
  lesson: "practice",
  review: "review",
  quiz: "quiz",
  retake: "quiz",
} as const;

/** 调用方先持久保存 preparing；复习与测验共用取消停稳后的计时、交付步骤。 */
export async function beginRestricted(
  task: LearningTask,
  stop: () => Promise<void>,
  deliver: () => Promise<void>,
  clock = Date.now,
  durationMs = 600_000,
): Promise<void> {
  if (task.phase.stage !== "preparing") {
    throw new RepaFault("stale_state", "受限任务尚未进入准备阶段");
  }
  await stop();
  task.startedAt = clock();
  task.deadlineAt = task.startedAt + durationMs;
  await deliver();
}

export async function connectLearning(
  records: LearningRecords,
  course: ResolvedCourse,
  host: Host,
  clock = Date.now,
  hooks: { beforeRestricted?: (task: LearningTask) => Promise<void> } = {},
): Promise<Pick<PluginInstance, "methods" | "close">> {
  const graph = graphFor(course);
  let pythonReady = false;
  const runner = await runnerVersion();
  const state = () => {
    const current = records.current();
    if (!current) {
      throw new RepaFault("service_failed", "学习状态尚未初始化");
    }
    return current;
  };
  const questions = (id: string, kind: LearningTask["kind"]) => {
    const topic = course.topics.find((entry) => entry.id === id);
    if (!topic) {
      return [];
    }
    return topicQuestions(topic).filter((entry) => {
      const matchesPool = entry.pool === POOLS[kind];
      if (!matchesPool) {
        return false;
      }
      const requiresPython = entry.question.slots.some((slot) => slotTests(slot).length);
      return !requiresPython || (pythonReady && course.expected?.[entry.question.id] !== undefined);
    });
  };
  const supply = (id: string, kind: LearningTask["kind"], model: ReturnType<typeof replayLearning>) => {
    const available = questions(id, kind);
    if (kind !== "lesson") {
      return available.length > 0;
    }
    const inherited = model.lessons.get(id) ?? [];
    const topic = course.topics.find((entry) => entry.id === id);
    return (
      topic?.kps.every((kp) => {
        const completed = inherited.some((entry) => entry.kpId === kp.id && entry.completed);
        return completed || available.some((entry) => entry.kp.id === kp.id);
      }) ?? false
    );
  };
  function reconcile(current: Projection, evidence: TaskEvidence[], now: number): Projection {
    const task = current.state.task;
    const entry = evidence.find((entry) => entry.task.taskId === task?.taskId);
    if (entry && task) {
      if (!finished(entry.task)) {
        entry.at = now;
      }
      if (task.phase.stage === "completed" && task.phase.outcome === "timeout" && task.deadlineAt !== null) {
        entry.at = task.deadlineAt;
      }
      entry.task = task;
    }
    const model = replayLearning(evidence, course);
    current.student = model.student;
    current.state.serverNow = now;
    updateProgress(current, evidence, course, now, (id) => questions(id, "quiz").length > 0);
    const restricted = task && task.kind !== "lesson" && !finished(task);
    let restriction: Projection["state"]["restrictions"]["kind"] = "none";
    if (restricted) {
      restriction = isQuiz(task) ? "quiz" : "review";
    }
    current.state.restrictions = {
      kind: restriction,
      tutorAllowed: !restricted,
      referenceContentAllowed: !restricted,
    };
    if (!task || finished(task)) {
      const history = records.records;
      const previous =
        current.state.menu ??
        history.filter((record) => "projection" in record).findLast((record) => record.projection.state.menu)
          ?.projection.state.menu ??
        null;
      const selected = history
        .filter((record) => record.type === "checkpoint")
        .findLast((record) => record.decision.selected !== null)?.decision.selected;
      const retained = previous && {
        ...previous,
        candidates: previous.candidates.filter((candidate) => candidate.id !== selected),
      };
      const menu = learningMenu(course, evidence, now, retained ?? null, supply).menu;
      if (!current.state.menu && previous) {
        menu.menuId = opaqueId();
      }
      current.state.menu = progressMenu(current, evidence, course, menu);
    }
    return current;
  }
  async function save(
    current: Projection,
    evidence = taskEvidence(records.records),
    selected: string | null = null,
    seed = 0,
  ) {
    const changed = records.records.some((record) => record.seq > current.state.revision && record.type !== "snapshot");
    if (changed) {
      throw new RepaFault("stale_state", "学习状态已改变", { reason: "stale", state: state().state });
    }
    await records.checkpoint(records.revision, (_previous, now) => ({
      projection: reconcile(current, evidence, now),
      decision: {
        policyVersion: FLOW_VERSION,
        now,
        seed,
        selected,
        candidates: current.state.menu?.candidates.map((entry) => entry.id) ?? [],
        scores: {},
      },
    }));
    const saved = state().state;
    if (saved.task?.phase.stage === "explanation" || saved.task?.phase.stage === "example") {
      const phase = saved.task.phase;
      await records.viewed({
        taskId: saved.task.taskId,
        action: phase.stage === "explanation" ? "explanation" : "kp",
        ref: phase.page.ref,
      });
      saved.revision = records.revision;
    }
    current.state.revision = records.revision;
    host.emit({
      type: "learning.changed",
      revision: records.revision,
      taskId: saved.task?.taskId ?? null,
      menuId: saved.menu?.menuId ?? null,
    });
    return saved;
  }
  async function page(task: LearningTask, stage: "explanation" | "example") {
    const topic = course.topics.find((entry) => entry.id === task.topicIds[0]);
    const kp = topic?.kps.find((kp) => !task.kps.find((entry) => entry.kpId === kp.id)?.completed);
    if (!topic || !kp) {
      throw new RepaFault("invalid_input", "当前知识点不存在");
    }
    const ref = {
      courseId: course.course.id,
      topicId: topic.id,
      kpId: kp.id,
      id: `${kp.id}.${stage}`,
      version: await contentVersion(kp),
      kind: stage === "example" ? ("example" as const) : ("lesson" as const),
    };
    const blocks =
      stage === "example" ? [...content(kp.example?.body), ...content(kp.example?.explanation)] : content(kp.lesson);
    const result: ContentPage = {
      ref,
      origin: { taskId: task.taskId, content: ref },
      offset: 0,
      total: blocks.length,
      blocks,
    };
    task.phase = { stage, page: result };
  }
  function eligible(current: Projection) {
    const task = requireTask(current);
    const model = replayLearning(
      taskEvidence(records.records).filter((entry) => entry.task.taskId !== task.taskId),
      course,
    );
    const topic = course.topics.find((entry) => entry.id === task.topicIds[0]);
    const phase = task.phase;
    const deliveredKp =
      phase.stage === "awaiting_answer"
        ? task.deliveries.find((entry) => entry.deliveryId === phase.deliveryId)?.kpId
        : undefined;
    const shownKp = phase.stage === "explanation" || phase.stage === "example" ? phase.page.ref.kpId : deliveredKp;
    const feedbackSubmission =
      phase.stage === "feedback"
        ? task.submissions.find((entry) => entry.submissionId === phase.submissionId)
        : undefined;
    const feedbackKp = task.deliveries.find((entry) => entry.deliveryId === feedbackSubmission?.deliveryId)?.kpId;
    const feedbackIndex = task.kps.findIndex((kp) => kp.kpId === feedbackKp);
    const rewoundFeedback = feedbackIndex >= 0 && task.kps.slice(0, feedbackIndex).some((kp) => !kp.completed);
    const invalidShownKp = shownKp && shownKp !== task.kps.find((kp) => !kp.completed)?.kpId;
    if (task.kind === "lesson" && (invalidShownKp || rewoundFeedback)) {
      throw new RepaFault("stale_state", "当前交付已失去课内资格，请中止后重新选择", {
        reason: "stale",
        state: current.state,
      });
    }
    const remembered = model.student[task.topicIds[0] ?? ""];
    const forcedReview = model.forced.get(task.topicIds[0] ?? "") === "review";
    const ineligibleReview =
      task.kind === "review" && (!remembered || (!forcedReview && !isDue(remembered, clock() / 86_400_000)));
    const ineligibleLesson =
      task.kind === "lesson" &&
      (!topic?.prerequisites.every((id) => model.student[id]) ||
        (model.forced.size && model.forced.get(topic.id) !== "lesson"));
    if (ineligibleReview || ineligibleLesson) {
      throw new RepaFault("stale_state", "任务已失去学习资格，请中止当前任务后重新选择", {
        reason: "stale",
        state: current.state,
      });
    }
  }
  async function nextQuestion(current: Projection, capabilities?: ClientCapabilities, topicId?: string) {
    pythonReady = await pythonAvailable(host, course.course.runtime, runner);
    const task = requireTask(current);
    const seen = new Set(Object.values(current.deliveries).map((digest) => records.snapshot(digest)?.questionId));
    const id = topicId ?? task.topicIds[0] ?? "";
    let pool = questions(id, task.kind);
    const originalId = current.xp?.origins[task.taskId];
    if (originalId) {
      const original = taskEvidence(records.records).find((entry) => entry.task.taskId === originalId);
      const excluded = new Set(original?.task.deliveries.map((delivery) =>
        records.snapshot(current.deliveries[delivery.deliveryId] ?? "")?.questionId,
      ));
      pool = pool.filter((entry) => !excluded.has(entry.question.id));
    }
    if (task.kind === "lesson") {
      pool = pool.filter((entry) => entry.kp.id === task.kps.find((kp) => !kp.completed)?.kpId);
    } else if (!isQuiz(task)) {
      const rotation = task.kps.filter((kp) => pool.some((entry) => entry.kp.id === kp.kpId));
      const nextKp = rotation[task.deliveries.length % rotation.length]?.kpId;
      const rotated = pool.filter((entry) => entry.kp.id === nextKp);
      if (rotated.length) {
        pool = rotated;
      }
    }
    const entry = pool.find((entry) => !seen.has(entry.question.id)) ?? pool[0];
    if (!entry) {
      throw new RepaFault("insufficient_items", "当前题池题量不足，无法交付或换题重考");
    }
    const topic = course.topics.find((topic) => topic.id === id);
    if (!topic) {
      throw new RepaFault("invalid_input", "课程不存在");
    }
    const { delivery, idMap } = await deliver(
      entry.question,
      topic,
      entry.kp.id,
      POOLS[task.kind],
      seen.has(entry.question.id),
    );
    const missing = missingDeliveryCapabilities(capabilities, delivery);
    if (missing.length) {
      throw new RepaFault("missing_capability", "前端不支持当前题目", {
        reason: "missing_capability",
        missing,
        taskId: task.taskId,
      });
    }
    const digest = await records.saveSnapshot(
      await createSnapshot({
        course: course.course,
        topic,
        kpId: entry.kp.id,
        questionId: entry.question.id,
        item: delivery.item,
        idMap,
        graph,
        ...(course.expected?.[entry.question.id] ? { expected: course.expected[entry.question.id] } : {}),
      }),
    );
    current.deliveries[delivery.deliveryId] = digest;
    task.deliveries.push(delivery);
    task.phase = { stage: "awaiting_answer", deliveryId: delivery.deliveryId };
  }
  function advanceGrade(current: Projection, submissionId: string, grade: Grade, now: number) {
    const task = requireTask(current);
    const submission = task.submissions.find((entry) => entry.submissionId === submissionId);
    if (!submission) {
      throw new RepaFault("invalid_input", "找不到原答");
    }
    submission.processing = { status: "completed" };
    submission.gradeRevision++;
    const evidence = taskEvidence(records.records, { id: submissionId, grade });
    const entry = evidence.find((entry) => entry.task.taskId === task.taskId);
    if (!entry) {
      throw new RepaFault("invalid_input", "找不到任务证据");
    }
    entry.task = task;
    entry.at = now;
    let outcome: "passed" | "failed" | "timeout" | undefined;
    if (task.kind === "lesson") {
      const before = replayLearning(
        evidence.filter((item) => item !== entry),
        course,
      );
      task.kps = kpProgress(entry, before.lessons.get(task.topicIds[0] ?? ""));
      if (task.kps.every((kp) => kp.completed)) {
        outcome = "passed";
      } else if (task.kps.some((kp) => !kp.completed && kp.attempts >= 5)) {
        outcome = "failed";
      }
      submission.feedback = grade.feedback;
      release(task, evidence);
    } else if (isQuiz(task)) {
      const pending = task.submissions.find((entry) => entry.processing.status !== "completed");
      if (pending) {
        task.phase = { stage: "judging", submissionId: pending.submissionId };
      } else {
        const next = task.deliveries.find((delivery) => !task.submissions.some((entry) => entry.deliveryId === delivery.deliveryId));
        task.phase = { stage: "awaiting_answer", deliveryId: next?.deliveryId ?? submission.deliveryId };
        if (task.deadlineAt !== null && now >= task.deadlineAt) {
          completeQuiz(task, evidence, true);
        }
      }
      return reconcile(current, evidence, now);
    } else {
      const result = reviewResult(entry);
      if (result.passed) {
        outcome = "passed";
      } else if (result.count >= 5) {
        outcome = "failed";
      } else if (task.deadlineAt !== null && now >= task.deadlineAt) {
        outcome = "timeout";
      }
    }
    task.phase = outcome ? { stage: "completed", outcome } : { stage: "feedback", submissionId };
    if (outcome) {
      release(task, evidence);
    }
    return reconcile(current, evidence, now);
  }
  function completeQuiz(task: LearningTask, evidence: TaskEvidence[], expired: boolean) {
    const entry = evidence.find((entry) => entry.task.taskId === task.taskId);
    const passed = entry && task.topicIds.every((id) => quizCorrect(entry, id));
    let outcome: "passed" | "failed" | "timeout" = "failed";
    if (passed) {
      outcome = "passed";
    } else if (expired) {
      outcome = "timeout";
    }
    task.phase = { stage: "completed", outcome };
    release(task, evidence);
  }
  function release(task: LearningTask, evidence: TaskEvidence[]) {
    for (const submission of task.submissions) {
      const grade = evidence
        .find((entry) => entry.task.taskId === task.taskId)
        ?.attempts.find((attempt) => attempt.submission.submissionId === submission.submissionId)?.grade;
      if (!grade) {
        continue;
      }
      submission.feedback = grade.feedback;
      const snapshot = records.snapshot(state().deliveries[submission.deliveryId] ?? "");
      const question =
        snapshot && topicQuestions(snapshot.topic).find((entry) => entry.question.id === snapshot.questionId)?.question;
      if (question) {
        submission.explanation = content(question.explanation);
      }
    }
  }
  async function resume(id: string) {
    try {
      const receipt = await records.grade(
        id,
        async (submission, snapshot) => {
          const grade = await judgeSubmission(host, submission, snapshot);
          const accepted = records.records.find(
            (record) => record.type === "accepted" && record.submission.submissionId === id,
          );
          if (accepted?.type === "accepted" && accepted.context.helpBefore.length) {
            grade.feedback.evidence = { status: "ineligible", reason: "作答前已获取帮助" };
          }
          return grade;
        },
        (current, submission, grade, now) => {
          if (!records.records.some((record) => record.type === "appeal" && record.submissionId === id)) {
            return advanceGrade(current, submission.submissionId, grade, now);
          }
          const evidence = taskEvidence(records.records, { id, grade });
          const task = current.state.task;
          if (task?.taskId === submission.taskId) {
            const previousPhase = task.phase;
            if (isQuiz(task)) {
              const answer = task.submissions.find((entry) => entry.submissionId === id);
              if (answer) {
                answer.processing = { status: "completed" };
                answer.gradeRevision++;
              }
              if (previousPhase.stage === "completed") {
                completeQuiz(task, evidence, previousPhase.outcome === "timeout");
              }
            } else {
              advanceGrade(current, id, grade, now);
              if (!finished(task)) {
                task.phase = previousPhase.stage === "completed"
                  ? { stage: "completed", outcome: "failed" }
                  : previousPhase;
              }
            }
            if (finished(task)) {
              release(task, evidence);
            }
          }
          return reconcile(current, evidence, now);
        },
      );
      const saved = state().state;
      host.emit({
        type: "learning.changed",
        revision: records.revision,
        taskId: saved.task?.taskId ?? null,
        menuId: saved.menu?.menuId ?? null,
        submissionId: id,
      });
      return receipt;
    } catch (error) {
      const current = state();
      const task = current.state.task;
      const submission = task?.submissions.find((entry) => entry.submissionId === id);
      if (submission && submission.processing.status !== "completed") {
        submission.processing = {
          status: "interrupted",
          reason:
            error instanceof RepaFault && error.code === "uncertain_grade" ? "uncertain_grade" : "service_failure",
        };
        if (task) {
          task.phase = { stage: "recovery", submissionId: id };
        }
        await save(current);
        return { status: "recorded" as const, submission: records.submission(id) ?? submission };
      }
      const pending = records.submission(id);
      if (pending?.processing.status === "interrupted") {
        return { status: "recorded" as const, submission: pending };
      }
      throw error;
    }
  }
  async function refresh() {
    const current = state();
    const task = current.state.task;
    const expired =
      task && task.kind !== "lesson" &&
      !finished(task) &&
      task.deadlineAt !== null &&
      clock() >= task.deadlineAt &&
      task.submissions.every((entry) => entry.processing.status === "completed");
    if (expired) {
      if (isQuiz(task)) {
        completeQuiz(task, taskEvidence(records.records), true);
      } else {
        task.phase = { stage: "completed", outcome: "timeout" };
        release(task, taskEvidence(records.records));
      }
      await save(current);
    } else {
      const preview = reconcile(structuredClone(current), taskEvidence(records.records), clock());
      const changed = !isDeepStrictEqual(preview.state.menu, current.state.menu)
        || !isDeepStrictEqual(preview.state.progress, current.state.progress)
        || !isDeepStrictEqual(preview.xp, current.xp);
      if (changed) {
        await save(preview);
      }
    }
    const result = { ...state().state, serverNow: clock() };
    if (result.task) {
      result.task.submissions = result.task.submissions.map(
        (submission) => records.submission(submission.submissionId) ?? submission,
      );
    }
    return result;
  }
  const methods: Record<string, PluginMethod> = {};
  function method<M extends LearningMethod>(
    name: M,
    action: (input: LearningInput<M>, context: MethodContext) => Promise<unknown>,
  ) {
    methods[name] = {
      parameters: learningMethods[name].input,
      result: learningMethods[name].result,
      invoke: async (raw, context) => {
        if (["state.get", "menu.select", "task.advance"].includes(name)) {
          const available = await pythonAvailable(host, course.course.runtime, runner);
          if (available !== pythonReady) {
            pythonReady = available;
            await save(state());
          }
        }
        // 泛型索引的 schema 联合无法保留 M；parse 已校验所属方法的输入。
        try {
          const input = parse(learningMethods[name].input, raw) as LearningInput<M>;
          await refresh();
          return await action(input, context);
        } catch (error) {
          if (error instanceof RepaFault && error.code === "stale_state") {
            throw new RepaFault("stale_state", error.message, { reason: "stale", state: state().state });
          }
          throw error;
        }
      },
    };
  }
  method("state.get", async () => refresh());
  method("submission.get", async (input) => {
    const submission = records.submission(input.submissionId);
    return submission
      ? { status: "found", submission, revision: records.revision }
      : { status: "absent", submissionId: input.submissionId, revision: records.revision };
  });
  async function select(input: LearningInput<"menu.select">, context: MethodContext, originalTaskId?: string, quizOnly = false) {
    const current = state();
    const menu = current.state.menu;
    const candidate = menu?.candidates.find((entry) => entry.id === input.candidateId);
    const evidence = taskEvidence(records.records);
    const normal = learningMenu(course, evidence, clock(), menu, supply).menu;
    const valid = progressMenu(current, evidence, course, normal).candidates;
    const invalidSelection =
      !candidate ||
      (originalTaskId !== undefined && candidate.originalTaskId !== originalTaskId) ||
      (quizOnly && candidate.kind !== (originalTaskId ? "retake" : "quiz")) ||
      menu?.menuId !== input.menuId ||
      !valid.some((entry) => entry.id === candidate.id) ||
      (current.state.task && !finished(current.state.task));
    if (invalidSelection) {
      throw new RepaFault("stale_state", "菜单已失效");
    }
    const topic = course.topics.find((topic) => topic.id === candidate.topicIds[0]);
    if (!topic) {
      throw new RepaFault("invalid_input", "课程不存在");
    }
    const model = replayLearning(taskEvidence(records.records), course);
    const seed = current.xp?.pending?.seed ?? Math.floor(Math.random() * 0x7fffffff);
    const kps = topic.kps.map((kp) => ({
      kpId: kp.id,
      attempts: 0,
      consecutiveCorrect: 0,
      completed:
        candidate.kind === "lesson" &&
        (model.lessons.get(topic.id)?.find((entry) => entry.kpId === kp.id)?.completed ?? false),
    }));
    current.state.task = {
      taskId: opaqueId(),
      kind: candidate.kind,
      topicIds: candidate.topicIds,
      phase: { stage: "preparing" },
      startedAt: candidate.kind === "lesson" ? clock() : null,
      deadlineAt: null,
      kps: candidate.kind === "review" ? shuffled(kps, seed) : kps,
      deliveries: [],
      submissions: [],
    };
    const xp = current.xp;
    if (xp && candidate.kind === "quiz") {
      xp.consumed++;
      delete xp.pending;
    }
    if (xp && candidate.originalTaskId) {
      xp.origins[current.state.task.taskId] = candidate.originalTaskId;
    }
    current.state.menu = null;
    if (candidate.kind === "lesson") {
      await page(current.state.task, "explanation");
    } else {
      await save(current, undefined, candidate.id, seed);
      await startRestricted(current, context);
    }
    return save(current, undefined, candidate.id, seed);
  }
  method("menu.select", (input, context) => select(input, context));
  method("quiz.start", (input, context) => select(input, context, undefined, true));
  method("quiz.retake", (input, context) => select(input, context, input.originalTaskId, true));
  async function startRestricted(current: Projection, context: MethodContext) {
    eligible(current);
    const task = requireTask(current);
    await beginRestricted(
      task,
      async () => {
        await hooks.beforeRestricted?.(task);
      },
      async () => {
        if (isQuiz(task)) {
          for (const id of task.topicIds) {
            await nextQuestion(current, context.caller?.capabilities, id);
          }
          const first = task.deliveries[0];
          if (!first) {
            throw new RepaFault("insufficient_items", "测验没有可用题目");
          }
          task.phase = { stage: "awaiting_answer", deliveryId: first.deliveryId };
        } else {
          await nextQuestion(current, context.caller?.capabilities);
        }
      },
      clock,
      isQuiz(task) ? 900_000 : 600_000,
    );
  }
  method("task.resume", async (input, context) => {
    const current = state();
    const task = requireTask(current);
    if (
      task.taskId !== input.taskId ||
      task.phase.stage !== "preparing" ||
      input.expectedStage !== "preparing" ||
      input.expectedRevision !== records.revision
    ) {
      throw new RepaFault("stale_state", "任务状态已改变");
    }
    await startRestricted(current, context);
    return save(current);
  });
  method("task.advance", async (input, context) => {
    const current = state();
    const task = requireTask(current);
    if (
      input.taskId !== task.taskId ||
      input.expectedRevision !== records.revision ||
      input.expectedStage !== task.phase.stage
    ) {
      throw new RepaFault("stale_state", "任务状态已改变", { reason: "stale", state: current.state });
    }
    eligible(current);
    if (task.phase.stage === "explanation") {
      await page(task, "example");
    } else if (task.phase.stage === "example") {
      await nextQuestion(current, context.caller?.capabilities);
    } else if (task.phase.stage === "feedback") {
      if (task.kind === "lesson" && task.kps.find((entry) => entry.kpId === task.deliveries.at(-1)?.kpId)?.completed) {
        await page(task, "explanation");
      } else {
        await nextQuestion(current, context.caller?.capabilities);
      }
    } else {
      throw new RepaFault("stale_state", "当前阶段不能推进");
    }
    return save(current);
  });
  method("task.abort", async (input) => {
    const current = state();
    const task = requireTask(current);
    if (
      input.taskId !== task.taskId ||
      input.expectedRevision !== records.revision ||
      input.expectedStage !== task.phase.stage ||
      task.submissions.some((entry) => entry.processing.status !== "completed")
    ) {
      throw new RepaFault("stale_state", "任务状态已改变或仍在判分");
    }
    if (finished(task)) {
      return current.state;
    }
    if (isQuiz(task) && task.phase.stage !== "preparing") {
      completeQuiz(task, taskEvidence(records.records), false);
    } else {
      if (task.kind === "quiz" && current.xp) {
        current.xp.consumed--;
      }
      if (current.xp) {
        delete current.xp.origins[task.taskId];
      }
      task.phase = { stage: "aborted", reason: "学习者中止" };
    }
    return save(current);
  });
  method("quiz.finish", async (input) => {
    const current = state();
    const task = requireTask(current);
    if (!isQuiz(task) || task.taskId !== input.taskId) {
      throw new RepaFault("stale_state", "当前测验已改变");
    }
    if (finished(task)) {
      return current.state;
    }
    if (input.expectedRevision !== records.revision || input.expectedStage !== task.phase.stage
      || task.phase.stage === "preparing" || task.submissions.some((entry) => entry.processing.status !== "completed")) {
      throw new RepaFault("stale_state", "测验仍在准备或判分，请恢复后交卷");
    }
    completeQuiz(task, taskEvidence(records.records), false);
    return save(current);
  });
  method("progress.get", async () => {
    const current = await refresh();
    return { serverNow: current.serverNow, progress: current.progress };
  });
  method("progress.setGoal", async (input) => {
    const current = state();
    current.state.progress.dailyGoalXp = input.dailyGoalXp;
    return save(current);
  });
  method("submission.submit", async (input) => {
    if (!records.submission(input.submissionId)) {
      eligible(state());
    }
    const receipt = await records.submit(input);
    if (receipt.status === "recorded") {
      host.emit({
        type: "learning.changed",
        revision: records.revision,
        taskId: input.taskId,
        menuId: null,
        submissionId: input.submissionId,
      });
    }
    return receipt.status === "recorded" ? resume(input.submissionId) : receipt;
  });
  method("submission.appeal", async (input) => {
    await records.appeal(input);
    return resume(input.submissionId);
  });
  method("submission.resume", async (input) => resume(input.submissionId));
  if (!records.current()) {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    await save({
      state: {
        revision: 0,
        serverNow: clock(),
        task: null,
        menu: null,
        course: { id: course.course.id, title: course.course.title, version: course.course.version },
        restrictions: { kind: "none", tutorAllowed: true, referenceContentAllowed: true },
        progress: {
          day: "1970-01-01",
          timeZone,
          dailyGoalXp: 20,
          todayXp: 0,
          totalXp: 0,
          completedTopics: 0,
          totalTopics: course.topics.length,
          completionRate: 0,
          etaDays: null,
        },
      },
      student: {},
      deliveries: {},
    });
  }
  await refresh();
  return { methods };
}
