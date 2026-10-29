import { randomUUID } from "node:crypto";
import { type Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  SessionManager,
  SettingsManager,
  type AgentSession,
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
  let submitted = false;
  let output: unknown;
  let invalid: RepaFault | undefined;
  // 工具先于短会话建立，会话建好后再填入。
  let shortSession: AgentSession | undefined;
  const tools: ToolDefinition[] = schema === undefined ? [] : [defineTool({
    name: "submit_result",
    label: "提交结果",
    description: "提交符合指定 schema 的结果",
    parameters: schema,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    // Pi 1.1.0 先调用 prepareArguments，再转换类型、校验参数。校验失败时 Pi 自己生成工具错误，
    // 不经过 execute，也就没有 terminate，工具循环会再请求一次模型；类型不对的值还可能转换后通过校验。
    // 因此在这里检查原始参数，不合格就记下诊断并中止短会话：下一次请求以已中止的信号开始，不会发出。
    // 升级时核对 agent-loop 的 prepareToolCall 和中止后的下一次请求。
    prepareArguments(raw) {
      if (!Value.Check(schema, raw)) {
        invalid = invalidOutput(schema, raw);
        shortSession?.agent.abort();
      }
      return raw;
    },
    async execute(_callId, input) {
      submitted = true;
      if (!Value.Check(schema, input)) {
        invalid = invalidOutput(schema, input);
        return { content: [{ type: "text", text: invalid.message }], details: {}, terminate: true };
      }
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
  const system = schema === undefined ? request.system ?? "" : [request.system, "用 submit_result 工具提交结果，只调用一次。"].filter(Boolean).join("\n\n");
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
  shortSession = session;
  const abort = () => { session.agent.abort(); };
  request.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (request.signal?.aborted) throw new RepaFault("cancelled", "模型请求已取消");
    await session.prompt(request.prompt, { expandPromptTemplates: false });
    const last = session.messages.findLast(message => message.role === "assistant");
    // 参数不合格时是 submit_result 中止了会话，交回诊断，不算取消。
    if (invalid !== undefined) throw invalid;
    if (request.signal?.aborted || last?.stopReason === "aborted") throw new RepaFault("cancelled", "模型请求已取消");
    if (last?.stopReason === "error") throw new RepaFault("model_error", last.errorMessage ?? "模型请求失败");
    if (schema !== undefined) {
      if (!submitted) throw new RepaFault("invalid_model_output", "模型没有调用 submit_result");
      return output;
    }
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
