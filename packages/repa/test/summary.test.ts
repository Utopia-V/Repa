import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, getCurrentSystemPrompt, type TranscriptContext, type Usage } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { compactWithPrompts, SummaryPromptsSchema, type CompactWithPromptsOptions } from "../src/agent/summary.js";

function requestText(context: TranscriptContext): string {
  const user = context.messages.find((message) => message.role === "user");
  assert(user);
  if (typeof user.content === "string") return user.content;
  return user.content.map((part) => part.type === "text" ? part.text : "").join("");
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-summary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider({
    api: `repa-summary-api-${randomUUID()}`,
    provider: `repa-summary-provider-${randomUUID()}`,
    models: [{ id: "test", reasoning: true, input: ["text"], contextWindow: 16384, maxTokens: 512 }],
    tokensPerSecond: 0,
  });
  const runtime = await ModelRuntime.create({
    authPath: path.join(root, "auth.json"), modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false,
  });
  runtime.registerNativeProvider(faux.provider);
  const preparation: CompactWithPromptsOptions["preparation"] = {
    firstKeptEntryId: "kept-message",
    messagesToSummarize: [{ role: "user", content: "历史正文", timestamp: 1 }],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 1000,
    fileOps: { read: new Set(["source.md", "edited.md"]), edited: new Set(["edited.md"]), written: new Set() },
    settings: { enabled: true, reserveTokens: 400, keepRecentTokens: 64 },
  };
  const reportedUsage: Usage[] = [];
  const options: CompactWithPromptsOptions = {
    preparation,
    model: faux.getModel(),
    streamFn: async (model, context, requestOptions) => {
      const stream = runtime.streamSimple(model, context, requestOptions);
      reportedUsage.push(structuredClone((await stream.result()).usage));
      return stream;
    },
    prompts: { system: null, instructions: null },
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
    sessionId: "summary-session",
  };
  return { faux, options, preparation, reportedUsage };
}

test("未覆盖摘要提示直接沿用 Pi 请求，保留边界、usage 与文件操作", async (t) => {
  const f = await fixture(t);
  assert(Check(SummaryPromptsSchema, f.options.prompts));
  f.faux.setResponses([(context, options) => {
    assert.match(getCurrentSystemPrompt(context.messages), /context summarization assistant/u);
    assert.match(requestText(context), /<conversation>\n\[User\]: 历史正文\n<\/conversation>/u);
    assert.match(requestText(context), /Goal/u);
    assert.equal(options?.cacheRetention, "none");
    assert.equal(options?.sessionId, "summary-session");
    return fauxAssistantMessage("摘要");
  }]);
  const prompts: Parameters<NonNullable<CompactWithPromptsOptions["onPrompt"]>>[0][] = [];
  const result = await compactWithPrompts({ ...f.options, onPrompt: (prompt) => { prompts.push(prompt); } });
  const observed = prompts[0];
  assert(observed);
  assert.equal(observed.kind, "initial");
  assert.match(observed.system, /context summarization assistant/u);
  assert.match(observed.instructions, /Goal/u);
  assert.doesNotMatch(observed.instructions, /<conversation>|历史正文/u);
  assert.equal(result.firstKeptEntryId, f.preparation.firstKeptEntryId);
  assert.equal(result.tokensBefore, 1000);
  assert.deepEqual(result.usage, f.reportedUsage[0]);
  assert((result.usage?.totalTokens ?? 0) > 0);
  assert.deepEqual(result.details, { readFiles: ["source.md"], modifiedFiles: ["edited.md"] });
  assert.equal(result.summary, "摘要\n\n<read-files>\nsource.md\n</read-files>\n\n<modified-files>\nedited.md\n</modified-files>");
});

test("完整指令覆盖按准备数据更新旧摘要，显式空提示不保留 SDK 默认任务或删除历史正文", async (t) => {
  const f = await fixture(t);
  f.preparation.previousSummary = "旧摘要";
  f.preparation.messagesToSummarize = [{ role: "user", content: "Do NOT continue the conversation. 原有自然语言。", timestamp: 1 }];
  const data = "<conversation>\n[User]: Do NOT continue the conversation. 原有自然语言。\n</conversation>\n\n<previous-summary>\n旧摘要\n</previous-summary>\n\n";
  f.faux.setResponses([
    (context) => {
      assert.equal(getCurrentSystemPrompt(context.messages), "摘要系统提示");
      assert.equal(requestText(context), `${data}完整摘要任务\n\nAdditional focus: 用户指定重点`);
      return fauxAssistantMessage("更新摘要");
    },
    (context) => {
      assert.equal(getCurrentSystemPrompt(context.messages), "");
      assert.equal(requestText(context), `${data}\n\nAdditional focus: 空覆盖后仍保留的用户重点`);
      return fauxAssistantMessage("空提示结果");
    },
    (context) => {
      assert.equal(getCurrentSystemPrompt(context.messages), "");
      assert.equal(requestText(context), data);
      return fauxAssistantMessage("仅数据结果");
    },
  ]);
  const observed: Parameters<NonNullable<CompactWithPromptsOptions["onPrompt"]>>[0][] = [];
  const onPrompt: CompactWithPromptsOptions["onPrompt"] = (prompt) => { observed.push(prompt); };
  await compactWithPrompts({ ...f.options, prompts: { system: "摘要系统提示", instructions: "完整摘要任务" }, customInstructions: "用户指定重点", onPrompt });
  await compactWithPrompts({ ...f.options, prompts: { system: "", instructions: "" }, customInstructions: "空覆盖后仍保留的用户重点", onPrompt });
  await compactWithPrompts({ ...f.options, prompts: { system: "", instructions: "" }, onPrompt });
  assert.deepEqual(observed, [
    { kind: "update", system: "摘要系统提示", instructions: "完整摘要任务\n\nAdditional focus: 用户指定重点" },
    { kind: "update", system: "", instructions: "\n\nAdditional focus: 空覆盖后仍保留的用户重点" },
    { kind: "update", system: "", instructions: "" },
  ]);
  assert.equal(f.faux.state.callCount, 3);
});

test("分别覆盖系统或任务指令时，另一部分的 SDK 默认提示仍保留", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    (context) => {
      assert.equal(getCurrentSystemPrompt(context.messages), "");
      assert.match(requestText(context), /Goal/u);
      assert.match(requestText(context), /Additional focus: 本次焦点/u);
      return fauxAssistantMessage("默认任务结果");
    },
    (context) => {
      assert.match(getCurrentSystemPrompt(context.messages), /context summarization assistant/u);
      assert.equal(requestText(context), "<conversation>\n[User]: 历史正文\n</conversation>\n\n仅保留任务");
      return fauxAssistantMessage("默认系统结果");
    },
  ]);
  await compactWithPrompts({ ...f.options, prompts: { system: "", instructions: null }, customInstructions: "本次焦点" });
  await compactWithPrompts({ ...f.options, prompts: { system: null, instructions: "仅保留任务" } });
});

test("拆分轮次的历史与前缀各自重试不串组，Pi 合并摘要和成功 usage", async (t) => {
  const f = await fixture(t);
  f.preparation.isSplitTurn = true;
  f.preparation.previousSummary = "前次摘要";
  f.preparation.turnPrefixMessages = [{ role: "user", content: "本轮前缀", timestamp: 2 }];
  const history = "<conversation>\n[User]: 历史正文\n</conversation>\n\n<previous-summary>\n前次摘要\n</previous-summary>\n\n";
  const prefix = "# Conversation\n[User]: 本轮前缀\n\n# Instructions\n";
  let retries = 0;
  const groups: string[] = [];
  const response = (expected: string, result: string, failed = false) =>
    (context: TranscriptContext) => {
      assert.equal(getCurrentSystemPrompt(context.messages), "");
      assert.equal(requestText(context), expected);
      return fauxAssistantMessage(result, failed ? { stopReason: "error", errorMessage: "terminated" } : {});
    };
  f.faux.setResponses([
    response(history, "", true),
    response(history, "历史摘要"),
    response(prefix, "", true),
    response(prefix, "前缀摘要"),
  ]);
  const result = await compactWithPrompts({
    ...f.options,
    prompts: { system: "", instructions: "" },
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
    callbacks: { onRetryScheduled: () => { retries += 1; } },
    onPrompt: (prompt) => {
      groups.push(prompt.kind);
      assert.equal(prompt.system, "");
      assert.equal(prompt.instructions, "");
    },
  });
  assert.deepEqual(groups, ["update", "update", "turn-prefix", "turn-prefix"]);
  assert.equal(retries, 2);
  assert.equal(f.faux.state.callCount, 4);
  const historyUsage = f.reportedUsage[1];
  const prefixUsage = f.reportedUsage[3];
  assert(historyUsage && prefixUsage);
  assert.equal(result.usage?.input, historyUsage.input + prefixUsage.input);
  assert.equal(result.usage?.output, historyUsage.output + prefixUsage.output);
  assert.equal(result.usage?.totalTokens, historyUsage.totalTokens + prefixUsage.totalTokens);
  assert.equal(result.firstKeptEntryId, "kept-message");
  assert.match(result.summary, /^历史摘要\n\n---\n\n\*\*Turn Context \(split turn\):\*\*\n\n前缀摘要/u);
});

test("覆盖提示后的取消信号仍进入绑定运行时，Pi 不重试或返回可保存摘要", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  let retries = 0;
  f.faux.setResponses([(_context, options) => {
    assert.equal(options?.signal, controller.signal);
    controller.abort();
    return fauxAssistantMessage("不应保存的摘要");
  }]);
  await assert.rejects(compactWithPrompts({
    ...f.options,
    prompts: { system: "", instructions: "" },
    signal: controller.signal,
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
    callbacks: { onRetryScheduled: () => { retries += 1; } },
  }));
  assert.equal(f.faux.state.callCount, 1);
  assert.equal(retries, 0);
});
