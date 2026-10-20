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
import { pythonAvailable, runnerVersion } from "./python-execution.js";
import { createSnapshot } from "./snapshot.js";

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
      const matchesPool = entry.pool === (kind === "lesson" ? "practice" : "review");
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
    const inherited = model.forced.get(id) === "lesson" ? [] : model.lessons.get(id) ?? [];
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
    const timeZone = current.state.progress.timeZone;
    current.state.progress.day = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
    current.state.progress.completedTopics = Object.keys(model.student).length;
    current.state.progress.completionRate = Object.keys(model.student).length / course.topics.length;
    const restricted = task?.kind === "review" && !finished(task);
    current.state.restrictions = {
      kind: restricted ? "review" : "none",
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
      current.state.menu = menu;
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
    if (task.kind === "lesson" && shownKp && shownKp !== task.kps.find((kp) => !kp.completed)?.kpId) {
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
  async function nextQuestion(current: Projection, capabilities?: ClientCapabilities) {
    pythonReady = await pythonAvailable(host, course.course.runtime, runner);
    const task = requireTask(current);
    const seen = new Set(Object.values(current.deliveries).map((digest) => records.snapshot(digest)?.questionId));
    let pool = questions(task.topicIds[0] ?? "", task.kind);
    if (task.kind === "lesson") {
      pool = pool.filter((entry) => entry.kp.id === task.kps.find((kp) => !kp.completed)?.kpId);
    } else {
      const rotation = task.kps.filter((kp) => pool.some((entry) => entry.kp.id === kp.kpId));
      const nextKp = rotation[task.deliveries.length % rotation.length]?.kpId;
      const rotated = pool.filter((entry) => entry.kp.id === nextKp);
      if (rotated.length) {
        pool = rotated;
      }
    }
    const entry = pool.find((entry) => !seen.has(entry.question.id)) ?? pool[0];
    if (!entry) {
      throw new RepaFault("service_failed", "当前题池没有可交付题目");
    }
    const topic = course.topics.find((topic) => topic.id === task.topicIds[0]);
    if (!topic) {
      throw new RepaFault("invalid_input", "课程不存在");
    }
    const { delivery, idMap } = await deliver(
      entry.question,
      topic,
      entry.kp.id,
      task.kind === "lesson" ? "practice" : "review",
      seen.has(entry.question.id),
      records.revision,
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
      task.kps = kpProgress(
        entry,
        before.forced.get(task.topicIds[0] ?? "") === "lesson" ? [] : before.lessons.get(task.topicIds[0] ?? ""),
      );
      if (task.kps.every((kp) => kp.completed)) {
        outcome = "passed";
      } else if (task.kps.some((kp) => !kp.completed && kp.attempts >= 5)) {
        outcome = "failed";
      }
      submission.feedback = grade.feedback;
      release(task, evidence);
    } else {
      const result = reviewResult(entry);
      if (result.passed) {
        outcome = "passed";
      } else if (task.deadlineAt !== null && now >= task.deadlineAt) {
        outcome = "timeout";
      } else if (result.count >= 5) {
        outcome = "failed";
      }
    }
    task.phase = outcome ? { stage: "completed", outcome } : { stage: "feedback", submissionId };
    if (outcome) {
      release(task, evidence);
    }
    return reconcile(current, evidence, now);
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
            advanceGrade(current, id, grade, now);
            if (!finished(task)) {
              task.phase =
                previousPhase.stage === "completed" ? { stage: "completed", outcome: "failed" } : previousPhase;
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
    const expiredReview =
      task?.kind === "review" &&
      !finished(task) &&
      task.deadlineAt !== null &&
      clock() >= task.deadlineAt &&
      task.submissions.every((entry) => entry.processing.status === "completed");
    if (expiredReview) {
      task.phase = { stage: "completed", outcome: "timeout" };
      release(task, taskEvidence(records.records));
      await save(current);
    } else if (
      current.state.progress.day !==
      new Intl.DateTimeFormat("en-CA", {
        timeZone: current.state.progress.timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(clock())
    ) {
      await save(current);
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
          return await action(parse(learningMethods[name].input, raw) as LearningInput<M>, context);
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
  method("menu.select", async (input, context) => {
    const current = state();
    const menu = current.state.menu;
    const candidate = menu?.candidates.find((entry) => entry.id === input.candidateId);
    const valid = learningMenu(course, taskEvidence(records.records), clock(), menu, supply).menu.candidates;
    const invalidSelection =
      !candidate ||
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
    const seed = Math.floor(Math.random() * 0x7fffffff);
    const kps = topic.kps.map((kp) => ({
      kpId: kp.id,
      attempts: 0,
      consecutiveCorrect: 0,
      completed:
        candidate.kind === "lesson" &&
        model.forced.get(topic.id) !== "lesson" &&
        (model.lessons.get(topic.id)?.find((entry) => entry.kpId === kp.id)?.completed ?? false),
    }));
    current.state.task = {
      taskId: opaqueId(),
      kind: candidate.kind,
      topicIds: candidate.topicIds,
      phase: { stage: "preparing" },
      startedAt: candidate.kind === "review" ? null : clock(),
      deadlineAt: null,
      kps: candidate.kind === "review" ? shuffled(kps, seed) : kps,
      deliveries: [],
      submissions: [],
    };
    current.state.menu = null;
    if (candidate.kind === "lesson") {
      await page(current.state.task, "explanation");
    } else {
      await save(current, undefined, candidate.id, seed);
      await startRestricted(current, context);
    }
    return save(current, undefined, candidate.id, seed);
  });
  async function startRestricted(current: Projection, context: MethodContext) {
    eligible(current);
    const task = requireTask(current);
    await hooks.beforeRestricted?.(task);
    task.startedAt = clock();
    task.deadlineAt = task.startedAt + 600_000;
    await nextQuestion(current, context.caller?.capabilities);
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
    await refresh();
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
    task.phase = { stage: "aborted", reason: "学习者中止" };
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
