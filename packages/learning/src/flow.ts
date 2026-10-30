import { isDeepStrictEqual } from "node:util";
import { RepaFault } from "@repa/base";
import type { MethodContext, PluginInstance, PluginMethod } from "@repa/base/plugin";
import { parse, type ClientCapabilities } from "@repa/base/protocol";
import { deliverySeed, mapAnswer, renderDelivery } from "./delivery.js";
import { isQuiz, sequenceOf, taskId, topicEligible, type DeliveryRecord, type TaskEvidence } from "./flow-state.js";
import {
  checkSubmission,
  learningMethods,
  missingDeliveryCapabilities,
  type LearningInput,
  type LearningMethod,
  type SubmissionReceipt,
} from "./protocol.js";
import type { FactBody } from "./records-schema.js";
import type { LearningSession } from "./session.js";

/**
 * 教学方法：读当前状态、核对守卫，再追加学习者行为的事实。状态全部从事实重放得出，方法本身不保存画面。
 * beforeRestricted 在复习和测验开始计时之前调用，默认中止辅导 Agent。
 */
export async function connectLearning(
  session: LearningSession,
  hooks: { beforeRestricted?: () => Promise<void> } = {},
): Promise<Pick<PluginInstance, "methods" | "close">> {
  const methods: Record<string, PluginMethod> = {};
  const stale = (message: string) => new RepaFault("stale_state", message);
  const current = () => session.replay.currentEvidence();
  const kpOf = (delivery: DeliveryRecord) => session.course.questions.get(delivery.questionId)?.kp.id;
  const lookup = (id: string) => {
    const seq = sequenceOf(id, "s");
    const delivery = seq === undefined ? undefined : session.replay.delivery(seq);
    return delivery?.answer ? delivery : undefined;
  };

  function method<M extends LearningMethod>(
    name: M,
    action: (input: LearningInput<M>, context: MethodContext) => Promise<unknown>,
  ) {
    methods[name] = {
      parameters: learningMethods[name].input,
      result: learningMethods[name].result,
      invoke: async (raw, context) => {
        // 泛型索引的 schema 联合无法保留 M；parse 已校验所属方法的输入。
        const input = parse(learningMethods[name].input, raw) as LearningInput<M>;
        session.autoGrade(context.caller?.capabilities);
        try {
          return await action(input, context);
        } catch (error) {
          if (error instanceof RepaFault && error.code === "stale_state") {
            throw new RepaFault("stale_state", error.message, { reason: "stale", state: await session.state(context.caller?.capabilities) });
          }
          throw error;
        }
      },
    };
  }

  /** 课内交付和已选任务仍须有资格：课内只交付第一个未过的知识点，重判使已过的知识点退回时不能继续往下。 */
  function eligible(evidence: TaskEvidence) {
    const task = evidence.task;
    const position = session.position(evidence);
    let shownKp: string | undefined;
    if (position.stage === "explanation" || position.stage === "example") {
      shownKp = position.kp;
    } else if (position.stage === "awaiting_answer") {
      shownKp = kpOf(position.delivery);
    }
    const feedbackKp = position.stage === "feedback" ? kpOf(position.delivery) : undefined;
    const feedbackIndex = evidence.kps.findIndex((kp) => kp.kpId === feedbackKp);
    const rewound = feedbackIndex >= 0 && evidence.kps.slice(0, feedbackIndex).some((kp) => !kp.completed);
    const invalidShownKp = shownKp && shownKp !== evidence.kps.find((kp) => !kp.completed)?.kpId;
    if (task.kind === "lesson" && (invalidShownKp || rewound)) {
      throw stale("当前交付已失去课内资格，请中止后重新选择");
    }
    if (!topicEligible(session.course, session.before(), task.topicIds[0] ?? "", task.kind, session.clock())) {
      throw stale("任务已失去学习资格，请中止当前任务后重新选择");
    }
  }

  /**
   * 选下一道题：课按第一个未过的知识点，复习轮流覆盖知识点，测验每个 topic 一题；先筛掉发起调用的前端用不了的题，
   * 再在余下的题里优先没出过的。有题却一道也用不了时报告缺什么并保留任务，等能用的前端或可用的模型。
   */
  async function nextQuestion(evidence: TaskEvidence, capabilities: ClientCapabilities | undefined, topicId?: string): Promise<FactBody> {
    const task = evidence.task;
    const id = topicId ?? task.topicIds[0] ?? "";
    const topic = session.course.topics.get(id);
    let pool = session.pool(id, task.kind);
    if (task.retakes !== undefined) {
      const excluded = new Set(session.replay.task(task.retakes)?.deliveries.map((delivery) => delivery.questionId));
      pool = pool.filter((entry) => !excluded.has(entry.question.id));
    }
    if (task.kind === "lesson") {
      pool = pool.filter((entry) => entry.kp.id === evidence.kps.find((kp) => !kp.completed)?.kpId);
    }
    if (!topic || !pool.length) {
      throw new RepaFault("insufficient_items", "当前题池题量不足，无法交付或换题重考");
    }
    const usable = session.usable(capabilities);
    let candidates = pool.filter((entry) => usable(entry.question, topic));
    if (task.kind === "review") {
      const rotation = evidence.kps.filter((kp) => candidates.some((entry) => entry.kp.id === kp.kpId));
      const nextKp = rotation[task.deliveries.length % rotation.length]?.kpId;
      const rotated = candidates.filter((entry) => entry.kp.id === nextKp);
      if (rotated.length) {
        candidates = rotated;
      }
    }
    const entry = candidates.find((candidate) => session.replay.firstDelivered(candidate.question.id) === undefined) ?? candidates[0];
    if (!entry) {
      const first = pool[0];
      const missing = first ? session.missing(first.question, topic, capabilities) : [];
      if (missing.length) {
        throw new RepaFault("missing_capability", "前端不支持当前题目", { reason: "missing_capability", missing, taskId: taskId(task) });
      }
      throw new RepaFault("model_required", "这一步只剩要由模型判分的题，当前没有可用模型；可以中止任务，配置模型以后再继续");
    }
    const seed = deliverySeed();
    const mode = task.kind === "lesson" ? "practice" : task.kind === "review" ? "review" : "quiz";
    const { delivery } = await renderDelivery(entry.question, topic, entry.kp.id, mode, { deliveryId: "d0", submissionId: "s0", repeated: false }, seed);
    const missing = missingDeliveryCapabilities(capabilities, delivery);
    if (missing.length) {
      throw new RepaFault("missing_capability", "前端不支持当前题目", { reason: "missing_capability", missing, taskId: taskId(task) });
    }
    return { type: "delivered", task: task.seq, question: entry.question.id, seed };
  }

  /** 复习与测验先写下任务（准备阶段），等辅导停稳后才交付题目，第一道题出现时开始计时。 */
  async function startRestricted(capabilities: ClientCapabilities | undefined) {
    const evidence = current();
    if (!evidence || session.stage(evidence) !== "preparing") {
      throw stale("受限任务尚未进入准备阶段");
    }
    eligible(evidence);
    await hooks.beforeRestricted?.();
    await session.write(async () => {
      const latest = current();
      if (!latest || latest.task !== evidence.task || session.stage(latest) !== "preparing") {
        throw stale("任务状态已改变");
      }
      if (!isQuiz(latest.task.kind)) {
        return [await nextQuestion(latest, capabilities)];
      }
      const bodies: FactBody[] = [];
      for (const id of latest.task.topicIds) {
        bodies.push(await nextQuestion(latest, capabilities, id));
      }
      if (!bodies.length) {
        throw new RepaFault("insufficient_items", "测验没有可用题目");
      }
      return bodies;
    });
  }

  async function select(input: LearningInput<"menu.select">, context: MethodContext, originalTaskId?: string, quizOnly = false) {
    const capabilities = context.caller?.capabilities;
    let restricted = false;
    await session.write(async () => {
      const state = await session.state(capabilities);
      const candidate = state.menu?.candidates.find((entry) => entry.id === input.candidateId);
      if (
        !candidate ||
        state.menu?.menuId !== input.menuId ||
        (originalTaskId !== undefined && candidate.originalTaskId !== originalTaskId) ||
        (quizOnly && candidate.kind !== (originalTaskId ? "retake" : "quiz"))
      ) {
        throw stale("菜单已失效");
      }
      restricted = candidate.kind !== "lesson";
      const original = candidate.originalTaskId === undefined ? undefined : sequenceOf(candidate.originalTaskId, "t");
      return [{ type: "task", kind: candidate.kind, topics: candidate.topicIds, ...(original === undefined ? {} : { retakes: original }) }];
    });
    if (restricted) {
      await startRestricted(capabilities);
    }
    return session.state(capabilities);
  }

  method("state.get", async (_input, context) => session.state(context.caller?.capabilities));
  method("menu.select", (input, context) => select(input, context));
  method("quiz.start", (input, context) => select(input, context, undefined, true));
  method("quiz.retake", (input, context) => select(input, context, input.originalTaskId, true));
  method("task.resume", async (input, context) => {
    const evidence = current();
    if (
      !evidence ||
      input.taskId !== taskId(evidence.task) ||
      session.stage(evidence) !== "preparing" ||
      input.expectedStage !== "preparing" ||
      input.expectedRevision !== session.records.revision
    ) {
      throw stale("任务状态已改变");
    }
    await startRestricted(context.caller?.capabilities);
    return session.state(context.caller?.capabilities);
  });
  method("task.advance", async (input, context) => {
    const capabilities = context.caller?.capabilities;
    await session.write(async () => {
      const evidence = current();
      if (
        !evidence ||
        input.taskId !== taskId(evidence.task) ||
        input.expectedRevision !== session.records.revision ||
        input.expectedStage !== session.stage(evidence)
      ) {
        throw stale("任务状态已改变");
      }
      eligible(evidence);
      const task = evidence.task;
      const position = session.position(evidence);
      if (task.kind === "lesson" && position.stage === "explanation") {
        return [{ type: "viewed", task: task.seq, kp: position.kp, page: "example" }];
      }
      if (task.kind === "lesson" && position.stage === "example") {
        return [await nextQuestion(evidence, capabilities)];
      }
      // 判不出结果的作答不阻塞任务：从恢复阶段也可以继续下一题，这份作答等条件具备时再补判。
      if ((task.kind === "lesson" || task.kind === "review") && (position.stage === "feedback" || position.stage === "recovery")) {
        const kp = kpOf(position.delivery);
        const next = evidence.kps.find((entry) => !entry.completed)?.kpId;
        if (task.kind === "lesson" && evidence.kps.find((entry) => entry.kpId === kp)?.completed && next) {
          return [{ type: "viewed", task: task.seq, kp: next, page: "lesson" }];
        }
        return [await nextQuestion(evidence, capabilities)];
      }
      throw stale("当前阶段不能推进");
    });
    return session.state(capabilities);
  });
  method("task.abort", async (input, context) => {
    await session.write(async () => {
      const evidence = current();
      if (
        !evidence ||
        input.taskId !== taskId(evidence.task) ||
        input.expectedRevision !== session.records.revision ||
        input.expectedStage !== session.stage(evidence)
      ) {
        throw stale("任务状态已改变");
      }
      return evidence.outcome ? [] : [{ type: "ended", task: evidence.task.seq }];
    });
    return session.state(context.caller?.capabilities);
  });
  method("quiz.finish", async (input, context) => {
    await session.write(async () => {
      const evidence = current();
      if (!evidence || !isQuiz(evidence.task.kind) || input.taskId !== taskId(evidence.task)) {
        throw stale("当前测验已改变");
      }
      if (evidence.outcome) {
        return [];
      }
      const stage = session.stage(evidence);
      if (input.expectedRevision !== session.records.revision || input.expectedStage !== stage || stage === "preparing") {
        throw stale("测验仍在准备或状态已改变，请刷新后交卷");
      }
      return [{ type: "ended", task: evidence.task.seq }];
    });
    return session.state(context.caller?.capabilities);
  });
  method("progress.get", async (_input, context) => {
    const state = await session.state(context.caller?.capabilities);
    return { serverNow: state.serverNow, progress: state.progress };
  });
  method("progress.setGoal", async (input, context) => {
    await session.write(() => [{ type: "goal", xp: input.dailyGoalXp }]);
    return session.state(context.caller?.capabilities);
  });
  method("submission.get", async (input) => {
    const delivery = lookup(input.submissionId);
    return delivery
      ? { status: "found", submission: await session.submission(delivery), revision: session.records.revision }
      : { status: "absent", submissionId: input.submissionId, revision: session.records.revision };
  });
  method("submission.submit", async (input) => {
    const seq = sequenceOf(input.deliveryId, "d");
    let receipt: SubmissionReceipt | undefined;
    await session.write(async () => {
      const delivery = seq === undefined ? undefined : session.replay.delivery(seq);
      if (delivery?.answer) {
        // 同一提交身份的重交：载荷相同就返回已有状态，不同就报冲突。
        const existing = await session.submission(delivery);
        if (existing.taskId !== input.taskId || existing.submissionId !== input.submissionId || !isDeepStrictEqual(existing.response, input.response)) {
          throw new RepaFault("submission_conflict", "同一提交身份不能替换原答", { reason: "payload_conflict", submissionId: input.submissionId });
        }
        receipt = { status: "recorded", submission: existing };
        return [];
      }
      const evidence = current();
      const shown = delivery && (await session.render(delivery)).delivery;
      const stage = evidence && session.stage(evidence);
      const position = evidence && session.position(evidence);
      if (
        !evidence || !delivery || !shown || delivery.task !== evidence.task ||
        input.taskId !== taskId(evidence.task) || input.submissionId !== shown.submissionId ||
        !["awaiting_answer", "judging", "recovery"].includes(stage ?? "") ||
        (!isQuiz(evidence.task.kind) && (position?.stage !== "awaiting_answer" || position.delivery !== delivery)) ||
        (evidence.deadlineAt !== null && session.clock() >= evidence.deadlineAt)
      ) {
        throw stale("交付已失效或已截止");
      }
      const checked = checkSubmission(shown.item, input.response);
      if (!checked.ok || (isQuiz(evidence.task.kind) && input.response.dontKnow)) {
        receipt = {
          status: "rejected",
          submissionId: input.submissionId,
          processing: { status: "not_accepted" },
          problems: checked.ok ? [{ message: "测验不接受不会作答" }] : checked.problems,
        };
        return [];
      }
      eligible(evidence);
      const { idMap } = await session.render(delivery);
      const answers = Object.fromEntries(Object.entries(input.response.answers).map(([slotId, answer]) => {
        const slot = shown.item.slots.find((entry) => entry.id === slotId);
        return [slotId, slot ? mapAnswer(answer, slot, idMap) : answer];
      }));
      return [{
        type: "answered",
        delivery: delivery.seq,
        seen: input.response.item.version,
        answers,
        ...(input.response.dontKnow ? { dontKnow: true as const } : {}),
      }];
    });
    if (receipt?.status === "rejected") {
      return receipt;
    }
    // 新收下的作答当场判分；同载荷的重交也沿原提交继续判分，与恢复相同。
    const delivery = seq === undefined ? undefined : session.replay.delivery(seq);
    if (!delivery) {
      throw new RepaFault("invalid_input", "找不到提交");
    }
    await session.grade(delivery.seq);
    return { status: "recorded", submission: await session.submission(delivery) };
  });
  method("submission.resume", async (input) => {
    const delivery = lookup(input.submissionId);
    if (!delivery) {
      throw new RepaFault("invalid_input", "找不到提交");
    }
    await session.grade(delivery.seq);
    return { status: "recorded", submission: await session.submission(delivery) };
  });
  method("submission.appeal", async (input) => {
    const delivery = lookup(input.submissionId);
    await session.write(() => {
      if (!delivery || delivery.grades.length === 0 || delivery.grades.length !== input.expectedGradeRevision) {
        throw stale("目标判分版本已改变");
      }
      const latest = delivery.grades.at(-1);
      // 同一目标的申诉还没判出结果：合并到已有的申诉。
      if (delivery.appeal && latest && delivery.appeal.seq > latest.seq) {
        return [];
      }
      return [{ type: "appealed", delivery: delivery.seq, reason: input.reason }];
    });
    if (!delivery) {
      throw new RepaFault("invalid_input", "找不到提交");
    }
    await session.grade(delivery.seq);
    return { status: "recorded", submission: await session.submission(delivery) };
  });
  return { methods };
}
