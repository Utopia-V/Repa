import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { operationError, type BackendPlugin, type CapabilityDefinition, type InvocationContext } from "repa/plugin";
import { ContentChangeResultSchema, IdSchema, literals, object, RevisionSchema, RepaFault } from "repa/protocol";
import { LearningContext } from "./context.js";
import { ContextBindingSchema, ContextStateSchema, ContextViewSchema } from "./schema.js";

const setInput = object({ operationId: IdSchema, base: RevisionSchema, binding: ContextBindingSchema });
export const LEARNING_CONTEXT_TOOL = {
  name: "learning_context",
  description: "读取当前学习空间持续维护的完整学习语境及其来源。",
  parameters: object({}),
};
const GET_LEARNING_CONTEXT_TOOL = {
  name: "get_learning_context",
  description: "读取当前学习语境的绑定与修改基准；返回的 revision 用于 set_learning_context。",
  parameters: object({}),
};
const SET_LEARNING_CONTEXT_TOOL = {
  name: "set_learning_context",
  description: "选择本空间已登记文档或组成清单作为学习语境，binding 为 null 时清空绑定。base 使用 get_learning_context 返回的 revision；组成清单的正文继续通过内容工具编辑。",
  parameters: object({
    base: RevisionSchema,
    binding: Type.Union([Type.Null(), object({ kind: literals(["document", "composition"]), contentId: IdSchema })]),
  }),
};
export const LEARNING_CONTEXT_TOOLS = {
  "repa.context.get": GET_LEARNING_CONTEXT_TOOL,
  "repa.context.set": SET_LEARNING_CONTEXT_TOOL,
  "repa.context.preview": LEARNING_CONTEXT_TOOL,
};
function learning(context: InvocationContext): LearningContext {
  if (context.scope.kind !== "space" || !context.content) throw new RepaFault("capability_scope", "学习语境需要所属空间。");
  return new LearningContext(context.content);
}

export function createLearningPlugin(): BackendPlugin {
  const set: CapabilityDefinition<typeof setInput, typeof ContentChangeResultSchema, object, unknown, typeof SET_LEARNING_CONTEXT_TOOL.parameters> = {
    contract: { id: "repa.context.set", version: "1" }, implementationId: "official",
    inputSchema: setInput, outputSchema: ContentChangeResultSchema, scopes: ["space"], execution: "inline",
    tool: {
      name: SET_LEARNING_CONTEXT_TOOL.name, description: SET_LEARNING_CONTEXT_TOOL.description,
      input: {
        schema: SET_LEARNING_CONTEXT_TOOL.parameters,
        prepare(input, scope) {
          if (scope.kind !== "space") throw new RepaFault("capability_scope", "学习语境需要所属空间。");
          return {
            operationId: randomUUID(), base: input.base,
            binding: input.binding === null ? null : {
              kind: input.binding.kind, ref: { spaceId: scope.spaceId, id: input.binding.contentId },
            },
          };
        },
      },
    },
    async invoke(input, context) {
      // 保留已持久公共调用的原去重形状，空间归属始终来自本次调用。
      const params = { ...input, ...(context.scope.kind === "space" ? { spaceId: context.scope.spaceId } : {}) };
      try {
        return await learning(context).set(params);
      } catch (error) {
        if (context.source.kind === "agent") throw operationError(error, input.operationId);
        throw error;
      }
    },
  };
  return {
    capabilities: [
      {
        contract: { id: "repa.context.get", version: "1" }, implementationId: "official",
        inputSchema: GET_LEARNING_CONTEXT_TOOL.parameters, outputSchema: ContextStateSchema, scopes: ["space"], execution: "query",
        tool: { name: GET_LEARNING_CONTEXT_TOOL.name, description: GET_LEARNING_CONTEXT_TOOL.description },
        invoke: (_input, context) => learning(context).get(),
      },
      set,
      {
        contract: { id: "repa.context.preview", version: "1" }, implementationId: "official",
        inputSchema: LEARNING_CONTEXT_TOOL.parameters, outputSchema: ContextViewSchema, scopes: ["space"], execution: "query",
        tool: { name: LEARNING_CONTEXT_TOOL.name, description: LEARNING_CONTEXT_TOOL.description },
        invoke: (_input, context) => learning(context).preview(),
      },
    ],
  };
}
