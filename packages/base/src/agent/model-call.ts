import { randomUUID } from "node:crypto";
import { type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  SessionManager,
  SettingsManager,
  type ModelRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { ModelCallScope } from "../agent.js";
import type { CompletionRequest } from "../plugin.js";
import { currentRun } from "../run-context.js";
import { RepaFault } from "../schema.js";
import { textContent } from "./events.js";
import { saveParent } from "./parent.js";

export const MODEL_CALL_ENTRY = "repa-model-call";
const SUBMIT_RESULT = "submit_result";
// 结构化调用最多请求的次数：第一次不合格时，模型按 Pi 交回的工具错误改正一次。
const MAX_REQUESTS = 2;

export function isModelCall(manager: SessionManager): boolean {
  return manager.getEntries().some(entry => entry.type === "custom" && entry.customType === MODEL_CALL_ENTRY);
}

interface ModelCallOptions {
  agentDir: string;
  modelRuntime: ModelRuntime;
  model: Model<string>;
  settings: SettingsManager;
  scope?: ModelCallScope;
}

function invalidOutput(schema: TSchema, value: unknown): RepaFault {
  const first = Value.Errors(schema, value)[0];
  if (first === undefined) return new RepaFault("invalid_model_output", "模型返回的参数不符合 schema");
  let field = first.instancePath;
  const missing = "requiredProperties" in first.params ? first.params.requiredProperties : undefined;
  if (first.keyword === "required" && Array.isArray(missing) && typeof missing[0] === "string") {
    field += `/${missing[0].replace(/~/gu, "~0").replace(/\//gu, "~1")}`;
  }
  return new RepaFault("invalid_model_output", `${field || "/"}：${first.message}`);
}

/** 一轮回复没有交出合格结果的原因：调用了不存在的工具、参数不合格，或者没有调用工具。 */
function turnFailure(message: AssistantMessage, schema: TSchema): RepaFault {
  const calls = message.content.filter(part => part.type === "toolCall");
  const unknown = calls.find(call => call.name !== SUBMIT_RESULT);
  if (unknown !== undefined) return new RepaFault("invalid_model_output", `模型调用了不存在的工具 ${unknown.name}`);
  const [call] = calls;
  if (call !== undefined) return invalidOutput(schema, call.arguments);
  return new RepaFault("invalid_model_output", `模型没有调用 ${SUBMIT_RESULT}`);
}

/** 每次插件调用独占一个短会话，Pi 负责请求、工具循环、消息与用量落盘。 */
export function modelCall(request: CompletionRequest, schema: undefined, options: ModelCallOptions): Promise<string>;
export function modelCall<S extends TSchema>(request: CompletionRequest, schema: S, options: ModelCallOptions): Promise<Static<S>>;
export async function modelCall(request: CompletionRequest, schema: TSchema | undefined, options: ModelCallOptions): Promise<unknown> {
  if (request.signal?.aborted) throw new RepaFault("cancelled", "模型请求已取消");
  const { scope } = options;
  const cwd = scope?.root ?? options.agentDir;
  const manager = scope === undefined
    ? SessionManager.inMemory(cwd)
    : SessionManager.create(cwd, scope.sessionsDir, { id: randomUUID() });
  if (scope !== undefined) {
    manager.appendCustomEntry(MODEL_CALL_ENTRY, { pluginId: scope.pluginId });
    const parent = currentRun();
    if (parent !== undefined) {
      await saveParent(scope.sessionsDir, manager.getSessionId(), {
        sessionId: parent.sessionId,
        runId: parent.runId,
        // 视图等运行内调用不属于工具；用调用自身的编号标记来源。
        callId: parent.callId ?? manager.getSessionId(),
      });
    }
  }
  let accepted = false;
  let output: unknown;
  const tools: ToolDefinition[] = schema === undefined ? [] : [defineTool({
    name: SUBMIT_RESULT,
    label: "提交结果",
    description: "提交符合指定 schema 的结果",
    parameters: schema,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    // Pi 先按 schema 转换并校验参数，不合格时把错误作为工具结果交回模型，不会执行到这里；收下之前仍严格检查一次。
    async execute(_callId, input) {
      if (!Value.Check(schema, input)) throw invalidOutput(schema, input);
      accepted = true;
      output = input;
      return { content: [{ type: "text", text: "已收到" }], details: {}, terminate: true };
    },
  })];
  // 单次请求失败直接交回调用方；自动重试和压缩会额外请求，不适用于短调用。
  const settings = SettingsManager.inMemory({
    ...options.settings.getSettings(),
    retry: { enabled: false },
    compaction: { enabled: false },
  });
  const system = schema === undefined ? request.system ?? "" : [request.system, `用 ${SUBMIT_RESULT} 工具提交结果，只调用一次。`].filter(Boolean).join("\n\n");
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: options.agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: system,
    extensionFactories: [pi => {
      // 短调用只使用调用者的系统提示，不追加 Agent 默认的工作目录说明。
      pi.on("before_agent_start", () => ({ systemPrompt: system }));
      pi.on("message_end", event => {
        if (event.message.role !== "system") return;
        // Pi 1.1.0 的 forceSystemPrompt 只改变请求投影；公开的消息替换入口让落盘提示与请求一致。
        // 升级时核对 AgentSession 的 forced prompt projection 和 message_end replacement。
        return { message: { ...event.message, content: system, sections: undefined } };
      });
    }],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir: options.agentDir,
    modelRuntime: options.modelRuntime,
    model: options.model,
    sessionManager: manager,
    settingsManager: settings,
    resourceLoader: loader,
    tools: tools.map(tool => tool.name),
    customTools: tools,
  });
  let requests = 0;
  // failure 是最近一轮没有交出合格结果的原因；invalid 是因此中止短会话时交回的诊断。
  let failure: RepaFault | undefined;
  let invalid: RepaFault | undefined;
  session.subscribe(event => {
    // prompt 先做鉴权、before_agent_start 等准备，这时还没有进行中的运行，取消监听里的 abort 落空；
    // 运行开始时再看一次调用方的信号。中止后的请求以已中止的信号开始，不会发出。
    if (event.type === "agent_start" && request.signal?.aborted) session.agent.abort();
    if (event.type === "message_end" && event.message.role === "assistant") requests++;
    if (event.type !== "turn_end" || schema === undefined || request.signal?.aborted) return;
    const message = event.message;
    // 出错或中止的一轮之后 Pi 不再请求，按模型错误或取消交回。
    if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") return;
    // Pi 的工具循环没有次数上限：工具名写错或参数不合格时，它把错误交回模型再请求，直到模型改对。
    // 这里只留一次改正的机会，第二次仍不合格就中止。收下结果后也中止：同一批里还有失败的调用时，Pi 会再请求一次。
    if (!accepted) {
      failure = turnFailure(message, schema);
      if (requests < MAX_REQUESTS) return;
      invalid = failure;
    }
    session.agent.abort();
  });
  const abort = () => { session.agent.abort(); };
  request.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (request.signal?.aborted) throw new RepaFault("cancelled", "模型请求已取消");
    await session.prompt(request.prompt, { expandPromptTemplates: false });
    // 两次请求仍没有合格结果时是这里中止了会话，交回诊断，不算取消。
    if (invalid !== undefined) throw invalid;
    if (request.signal?.aborted) throw new RepaFault("cancelled", "模型请求已取消");
    // 收下结果后中止的多余请求会留下一条中止的助手消息，结果照样交回。
    if (accepted) return output;
    const last = session.messages.findLast(message => message.role === "assistant");
    if (last?.stopReason === "aborted") throw new RepaFault("cancelled", "模型请求已取消");
    if (last?.stopReason === "error") throw new RepaFault("model_error", last.errorMessage ?? "模型请求失败");
    if (schema !== undefined) throw failure ?? new RepaFault("invalid_model_output", `模型没有调用 ${SUBMIT_RESULT}`);
    return textContent(last?.content);
  } catch (error) {
    if (error instanceof RepaFault) throw error;
    if (request.signal?.aborted) throw new RepaFault("cancelled", "模型请求已取消");
    throw new RepaFault("model_error", error instanceof Error ? error.message : String(error));
  } finally {
    request.signal?.removeEventListener("abort", abort);
    session.dispose();
  }
}
