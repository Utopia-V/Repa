import path from "node:path";
import { randomUUID } from "node:crypto";
import { Type, type Static, type TLiteral, type TOmit, type TSchema } from "typebox";
import type { BackendPlugin, CapabilityDefinition, InvocationContext, RepaCapabilityServices } from "repa/plugin";
import { RepaFault } from "repa/protocol";
import { ReviewStore } from "./store.js";
import { optimize } from "./optimizer.js";
import {
  CreateReviewInputSchema, UpdateReviewInputSchema, ListReviewsInputSchema, ListReviewsResultSchema, GetReviewInputSchema,
  ReviewItemSchema, SubmitFeedbackInputSchema, CorrectFeedbackInputSchema, SetReviewStatusInputSchema,
  SetReviewScheduleInputSchema, ReviewHistoryInputSchema, ReviewHistoryResultSchema,
  ParameterVersionSchema, SetReviewParametersInputSchema, SetReviewParametersResultSchema,
  ReviewMutationResultSchema, GetReviewParametersInputSchema,
  OptimizeReviewInputSchema, ReviewOptimizationResultSchema,
} from "./schema.js";
export * from "./schema.js";

type Context = InvocationContext<RepaCapabilityServices, ReviewStore>;
type ToolInput<I extends TSchema> = TOmit<I, TLiteral<"operationId">>;

function capability<I extends TSchema, O extends TSchema>(name: string, inputSchema: I, outputSchema: O,
  description: string, invoke: (input: Static<I>, store: ReviewStore, context: Context) => Static<O> | Promise<Static<O>>,
  options: { mutation?: boolean; execution?: "inline" | "background" } = {}): CapabilityDefinition<I, O, RepaCapabilityServices, ReviewStore, ToolInput<I>> {
  return {
    contract: { id: `repa.review.${name}`, version: "1" }, implementationId: "fsrs-sqlite",
    inputSchema, outputSchema, scopes: ["space"], execution: options.execution ?? (options.mutation ? "inline" : "query"),
    tool: {
      name: `review_${name.replaceAll(".", "_")}`, description,
      ...(options.mutation ? { input: {
        schema: Type.Omit(inputSchema, Type.Literal("operationId"), { additionalProperties: false }),
        // 泛型无法证明 Omit 后补回字段等于 I；宿主随后仍以公共 schema 校验完整输入。
        prepare: (input: Static<ToolInput<I>>) => Object.assign({}, input, { operationId: randomUUID() }) as Static<I>,
      } } : {}),
    },
    async invoke(input, context) {
      context.signal.throwIfAborted();
      if (!context.spaceRuntime) throw new RepaFault("review_unavailable", "复习数据服务尚未打开。");
      const result = await invoke(input, context.spaceRuntime, context);
      if (options.mutation) context.services?.events?.publish({
        format: { id: "repa.review.invalidated", version: "1" }, data: {},
      });
      return result;
    },
  };
}

/** 已启用插件声明能力；数据库按空间首次调用打开，算法和业务类型留在插件内。 */
export default function review(): BackendPlugin<RepaCapabilityServices, ReviewStore> {
  return {
    capabilities: [
      capability("create", CreateReviewInputSchema, ReviewMutationResultSchema,
        "创建复习项，可附本空间内容标识、所见修订与定位。",
        (input, store, context) => store.create(input, context.source), { mutation: true }),
      capability("update", UpdateReviewInputSchema, ReviewMutationResultSchema,
        "维护同一复习项的题目、参考答案和来源；base 来自所见项目修订。patch 中省略字段保持原值，answer:null 删除答案，sources:[] 清空来源。保留记忆状态、历史与人工安排；评分更正使用 review_correct，不同的复习项目另行创建。",
        (input, store, context) => store.update(input, context.source), { mutation: true }),
      capability("get", GetReviewInputSchema, ReviewItemSchema,
        "读取复习项及其修订、实际来源与当前调度估计。",
        (input, store) => store.get(input.itemId)),
      capability("list", ListReviewsInputSchema, ListReviewsResultSchema,
        "按到期时间列出复习项；dueBefore 使用毫秒时间戳，省略时不限定到期时间。默认排除暂停项。",
        (input, store) => store.list(input)),
      capability("feedback", SubmitFeedbackInputSchema, ReviewMutationResultSchema,
        "记录一次实际复习反馈：1 再来（答错或未能回忆）、2 困难（答对但费力）、3 良好（正常答对）、4 容易（轻松答对）。base 使用实际读取的项目修订。assistance 只记录实际帮助条件，未知时省略。保留原始作答或明确自评，不把助手答案记为学习者表现。",
        (input, store, context) => store.feedback(input, context.source), { mutation: true }),
      capability("correct", CorrectFeedbackInputSchema, ReviewMutationResultSchema,
        "追加反馈更正并重算当前估计；feedbackId 指向原反馈，原记录和当时结果继续保留。说明更正原因。",
        (input, store, context) => store.correct(input, context.source), { mutation: true }),
      capability("status", SetReviewStatusInputSchema, ReviewMutationResultSchema,
        "暂停或恢复复习项；不把状态切换计作学习反馈。",
        (input, store, context) => store.setStatus(input, context.source), { mutation: true }),
      capability("schedule", SetReviewScheduleInputSchema, ReviewMutationResultSchema,
        "明确调整未来到期时间，null 恢复算法推荐；不会伪造已发生的复习。下一次真实反馈后采用新推荐。",
        (input, store, context) => store.setSchedule(input, context.source), { mutation: true }),
      capability("history", ReviewHistoryInputSchema, ReviewHistoryResultSchema,
        "分页读取原始反馈和追加更正，区分实际发生时间、录入时间与录入来源。",
        (input, store) => store.history(input)),
      capability("parameters.get", GetReviewParametersInputSchema, ParameterVersionSchema,
        "读取当前或指定版本的完整 FSRS 参数及库、算法版本。默认参数无需已有复习历史。",
        (input, store) => store.parameters(input.version)),
      capability("parameters.set", SetReviewParametersInputSchema, SetReviewParametersResultSchema,
        "按版本修改 FSRS 参数并重算当前估计，返回影响项目数；不改写原反馈、旧参数或人工安排。",
        (input, store, context) => store.setParameters(input, context.source), { mutation: true }),
      capability("parameters.optimize", OptimizeReviewInputSchema, ReviewOptimizationResultSchema,
        "根据真实反馈计算 FSRS 候选参数并返回样本范围；matchesDefaultWeights 表示结果仍为默认权重，不能当作个人参数改善。不会自动修改安排，采用时用返回的 parameterVersion 作为 parameters.set 的 base。",
        (input, store, context) => optimize(store.trainingSnapshot(), {
          signal: context.signal, timeoutSeconds: input.timeoutSeconds, progress: context.services?.progress,
        }), { execution: "background" }),
    ],
    openSpace(context) {
      context.signal.throwIfAborted();
      return new ReviewStore(path.join(context.dataDirectory, "reviews.sqlite"));
    },
    closeSpace(store) { store.close(); },
  };
}
