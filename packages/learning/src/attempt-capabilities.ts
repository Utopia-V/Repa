import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { operationError, type BackendPlugin, type CapabilityDefinition, type InvocationContext } from "repa/plugin";
import { ContentChangeResultSchema, ContentRefSchema, IdSchema, RepaFault, object, type ContentChangeResult } from "repa/protocol";
import {
  AttemptViewSchema, RecordAttemptInputSchema, SaveJudgmentInputSchema, SelectJudgmentInputSchema,
} from "./attempt-schema.js";
import { LearningAttempts, attemptInputResources, judgmentInputResources } from "./attempts.js";

const getInput = object({ ref: ContentRefSchema });
const getToolInput = object({ contentId: IdSchema });
const recordToolInput = Type.Omit(RecordAttemptInputSchema, Type.Literal("operationId"));
const saveToolInput = object({
  ...Type.Omit(SaveJudgmentInputSchema, Type.Union([Type.Literal("operationId"), Type.Literal("ref")])).properties,
  contentId: IdSchema,
});
const selectToolInput = object({
  ...Type.Omit(SelectJudgmentInputSchema, Type.Union([Type.Literal("operationId"), Type.Literal("ref")])).properties,
  contentId: IdSchema,
});

function attempts(context: InvocationContext): LearningAttempts {
  if (context.scope.kind !== "space" || !context.content)
    throw new RepaFault("capability_scope", "学习作答记录需要所属空间。");
  return new LearningAttempts(context.content);
}

async function mutate(operationId: string, context: InvocationContext,
  work: (service: LearningAttempts) => Promise<ContentChangeResult>): Promise<ContentChangeResult> {
  try { return await work(attempts(context)); }
  catch (error) {
    if (context.source.kind === "agent") throw operationError(error, operationId);
    throw error;
  }
}

const savedResources = (result: ContentChangeResult) => result.contents.flatMap(content => content.resources);

export function attemptCapabilities(): BackendPlugin["capabilities"] {
  const get: CapabilityDefinition<typeof getInput, typeof AttemptViewSchema, object, unknown, typeof getToolInput> = {
    contract: { id: "repa.attempt.get", version: "1" }, implementationId: "official",
    inputSchema: getInput, outputSchema: AttemptViewSchema, scopes: ["space"], execution: "inline",
    tool: {
      name: "get_learning_attempt",
      description: "读取一次学习作答的原事实、候选判断与采用历史。返回 factId 与正文 base，用于保存判断或改变采用；候选存在不代表已经采用。",
      input: { schema: getToolInput, prepare(input, scope) {
        if (scope.kind !== "space") throw new RepaFault("capability_scope", "学习作答记录需要所属空间。");
        return { ref: { spaceId: scope.spaceId, id: input.contentId } };
      } },
    },
    outputResources: result => result.resources,
    invoke: (input, context) => attempts(context).get(input.ref),
  };
  const record: CapabilityDefinition<typeof RecordAttemptInputSchema, typeof ContentChangeResultSchema, object, unknown, typeof recordToolInput> = {
    contract: { id: "repa.attempt.record", version: "1" }, implementationId: "official",
    inputSchema: RecordAttemptInputSchema, outputSchema: ContentChangeResultSchema, scopes: ["space"], execution: "inline",
    tool: {
      name: "record_learning_attempt",
      description: "保存一次作答原事实及固定材料。actor 是回答产生者的声明，录入来源由实际调用另行记录；帮助或初始条件不清楚时使用 unknown。此操作不评分、不更新掌握状态。",
      input: { schema: recordToolInput, prepare: input => ({ ...input, operationId: randomUUID() }) },
    },
    inputResources: input => attemptInputResources(input.fact), outputResources: savedResources,
    invoke: (input, context) => mutate(input.operationId, context, service => service.record(input, context.source)),
  };
  const save: CapabilityDefinition<typeof SaveJudgmentInputSchema, typeof ContentChangeResultSchema, object, unknown, typeof saveToolInput> = {
    contract: { id: "repa.attempt.judgment.save", version: "1" }, implementationId: "official",
    inputSchema: SaveJudgmentInputSchema, outputSchema: ContentChangeResultSchema, scopes: ["space"], execution: "inline",
    tool: {
      name: "save_learning_judgment",
      description: "对固定 factId 保存有版本依据和明确 criterion 的候选判断，base 使用 get_learning_attempt 的正文版本。默认只保存；显式 adopt 才同次采用。supersedes 声明对同次作答既有判断的修正，不自动改变采用结果。",
      input: { schema: saveToolInput, prepare(input, scope) {
        if (scope.kind !== "space") throw new RepaFault("capability_scope", "学习作答记录需要所属空间。");
        const { contentId, ...value } = input;
        return { ...value, operationId: randomUUID(), ref: { spaceId: scope.spaceId, id: contentId } };
      } },
    },
    inputResources: input => judgmentInputResources(input.judgment), outputResources: savedResources,
    invoke: (input, context) => mutate(input.operationId, context, service => service.saveJudgment(input, context.source)),
  };
  const select: CapabilityDefinition<typeof SelectJudgmentInputSchema, typeof ContentChangeResultSchema, object, unknown, typeof selectToolInput> = {
    contract: { id: "repa.attempt.judgment.select", version: "1" }, implementationId: "official",
    inputSchema: SelectJudgmentInputSchema, outputSchema: ContentChangeResultSchema, scopes: ["space"], execution: "inline",
    tool: {
      name: "select_learning_judgment",
      description: "按已读取正文 base 采用一个已保存的候选，或用 null 撤销采用。每次选择保留原因和历史，不删除原回答与旧判断；并发更正返回版本冲突后先重新读取。",
      input: { schema: selectToolInput, prepare(input, scope) {
        if (scope.kind !== "space") throw new RepaFault("capability_scope", "学习作答记录需要所属空间。");
        const { contentId, ...value } = input;
        return { ...value, operationId: randomUUID(), ref: { spaceId: scope.spaceId, id: contentId } };
      } },
    },
    outputResources: savedResources,
    invoke: (input, context) => mutate(input.operationId, context, service => service.selectJudgment(input, context.source)),
  };
  return [get, record, save, select];
}
