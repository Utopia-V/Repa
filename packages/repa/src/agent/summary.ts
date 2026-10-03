import { getCurrentSystemPrompt, normalizeContext, type TranscriptContext } from "@earendil-works/pi-ai";
import { compact, convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { RepaFault } from "../errors.js";
import type { SummaryPrompts } from "./summary-settings.js";

export { SummaryPromptsSchema, type SummaryPrompts } from "./summary-settings.js";

type CompactArguments = Parameters<typeof compact>;
export type CompactWithPromptsOptions = {
  preparation: CompactArguments[0];
  model: CompactArguments[1];
  apiKey?: CompactArguments[2];
  headers?: CompactArguments[3];
  customInstructions?: CompactArguments[4];
  signal?: CompactArguments[5];
  thinkingLevel?: CompactArguments[6];
  streamFn: NonNullable<CompactArguments[7]>;
  env?: CompactArguments[8];
  retry?: CompactArguments[9];
  callbacks?: CompactArguments[10];
  sessionId?: CompactArguments[11];
  prompts: SummaryPrompts;
  onPrompt?: (prompt: {
    kind: "initial" | "update" | "turn-prefix";
    system: string;
    instructions: string;
  }) => void;
};

/** 保留 Pi 的压缩生命周期，仅在已绑定的模型调用前替换摘要提示。 */
export async function compactWithPrompts(options: CompactWithPromptsOptions): ReturnType<typeof compact> {
  options.signal?.throwIfAborted();
  const { preparation, prompts } = options;
  let streamFn = options.streamFn;
  if (prompts.system !== null || prompts.instructions !== null || options.onPrompt) {
    const historyPrefix = [
      `<conversation>\n${serializeConversation(convertToLlm(preparation.messagesToSummarize))}\n</conversation>\n\n`,
      preparation.previousSummary ? `<previous-summary>\n${preparation.previousSummary}\n</previous-summary>\n\n` : "",
    ].join("");
    const turnPrefix = `# Conversation\n${serializeConversation(convertToLlm(preparation.turnPrefixMessages))}\n\n# Instructions\n`;
    streamFn = (model, context, requestOptions) => {
      let messages = context.messages.filter((message) => message.role !== "system");
      let prompt: Parameters<NonNullable<CompactWithPromptsOptions["onPrompt"]>>[0] | undefined;
      if (prompts.instructions !== null || options.onPrompt) {
        // Pi 0.87.1 没有逐组提示入口。只识别它由 preparation 生成的单条请求封套，
        // 不搜索历史正文、不依赖调用次数；SDK 重试同一组也保持相同输入。
        const user = messages[0];
        if (messages.length !== 1 || user?.role !== "user" || !Array.isArray(user.content) || user.content.length !== 1 || user.content[0]?.type !== "text")
          throw new RepaFault("configuration", "Pi 摘要请求结构已改变，无法应用摘要指令覆盖。");
        const text = user.content[0].text;
        let prefix: string;
        let kind: "initial" | "update" | "turn-prefix";
        if (text.startsWith(historyPrefix)) {
          prefix = historyPrefix;
          kind = preparation.previousSummary ? "update" : "initial";
        } else if (preparation.isSplitTurn && text.startsWith(turnPrefix)) {
          prefix = turnPrefix;
          kind = "turn-prefix";
        } else throw new RepaFault("configuration", "Pi 摘要数据封套与压缩准备不一致，无法应用摘要指令覆盖。");
        let instructions = text.slice(prefix.length);
        if (prompts.instructions !== null) {
          const focus = options.customInstructions ? `\n\nAdditional focus: ${options.customInstructions}` : "";
          instructions = `${prompts.instructions}${focus}`;
          messages = [{ ...user, content: [{ type: "text", text: `${prefix}${instructions}` }] }];
        }
        prompt = { kind, system: prompts.system ?? getCurrentSystemPrompt(context.messages), instructions };
      }
      const next: TranscriptContext = prompts.system === null && prompts.instructions === null
        ? context
        : normalizeContext({
          ...context,
          systemPrompt: prompts.system ?? getCurrentSystemPrompt(context.messages),
          messages,
        });
      if (prompt) options.onPrompt?.(prompt);
      return options.streamFn(model, next, requestOptions);
    };
  }
  const result = await compact(
    preparation,
    options.model,
    options.apiKey,
    options.headers,
    options.customInstructions,
    options.signal,
    options.thinkingLevel,
    streamFn,
    options.env,
    options.retry,
    options.callbacks,
    options.sessionId,
  );
  // Pi 0.87.1 的摘要失败判断未包含 aborted，不能把取消结果作为压缩检查点。
  options.signal?.throwIfAborted();
  return result;
}
