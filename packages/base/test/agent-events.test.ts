import assert from "node:assert/strict";
import test from "node:test";
import { convertEvent, entryToPublic, retriedFailures } from "../src/agent/events.js";
import { modelError, modelFailure } from "../src/agent/model-failure.js";
import { modelFailureOf, RepaFault } from "../src/schema.js";

test("工具的实时结束事件和历史条目保留同一份 details，包括空值和错误结果", () => {
  for (const details of [{ sessionId: "child", runId: "child-run" }, null, false, 0]) {
    for (const isError of [false, true]) {
      const content = [{ type: "text" as const, text: "工具结果" }];
      const history = entryToPublic({
        type: "message", id: "entry", parentId: null, timestamp: "2026-10-13T00:00:00.000Z",
        message: { role: "toolResult", toolCallId: "call", toolName: "demo", content, details, isError, timestamp: 1 },
      });
      const [live] = convertEvent("session", {
        type: "tool_execution_end", toolCallId: "call", toolName: "demo", result: { content, details }, isError,
      }, "run");
      assert.deepEqual(history?.data, { callId: "call", tool: "demo", isError, details });
      assert.deepEqual(live, { sessionId: "session", runId: "run", type: "toolEnd", tool: "demo", data: { callId: "call", isError, details } });
    }
  }
});

test("工具没有 details 时实时与历史省略该字段", () => {
  const history = entryToPublic({
    type: "message", id: "entry", parentId: null, timestamp: "2026-10-13T00:00:00.000Z",
    message: { role: "toolResult", toolCallId: "call", toolName: "demo", content: [], isError: false, timestamp: 1 },
  });
  assert.deepEqual(history?.data, { callId: "call", tool: "demo", isError: false });
  for (const result of [{ content: [] }, { details: undefined }, null]) {
    const [live] = convertEvent("session", { type: "tool_execution_end", toolCallId: "call", toolName: "demo", result, isError: false });
    assert.deepEqual(live?.data, { callId: "call", isError: false });
  }
});

const failedAssistant = (errorMessage: string) => ({
  role: "assistant", content: [], api: "openai-completions", provider: "deepseek", model: "deepseek-chat",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "error", errorMessage, timestamp: 1,
});

test("模型请求失败按开头的状态码或连接错误的写法分类，不读各家报错的正文", () => {
  const cases: [string | undefined, string][] = [
    ['401: {"message":"Authentication Fails, Your api key: ****0000 is invalid","type":"authentication_error"}', "auth"],
    ["403 status code (no body)", "auth"],
    ['402: {"message":"Insufficient Balance","type":"unknown_error"}', "balance"],
    ["402 Insufficient Balance", "balance"],
    ['429: {"message":"You exceeded your current quota","code":"insufficient_quota"}', "balance"],
    ["Mistral error (429): Too Many Requests", "rate_limit"],
    ['429: {"message":"Rate Limit Reached"}', "rate_limit"],
    ['500: {"message":"Server Error"}', "server"],
    ['503: {"message":"Server Overloaded"}', "server"],
    ['422: {"message":"Invalid Parameters"}', "other"],
    ["Request timed out.", "network"],
    ["Connection error.", "network"],
    ["fetch failed", "network"],
    ["terminated", "network"],
    ["getaddrinfo ENOTFOUND api.deepseek.com", "network"],
    ["上下文超过 (500 tokens) 限制", "other"],
    ["Provider stopped with: sensitive", "other"],
    [undefined, "other"],
  ];
  for (const [message, failure] of cases) assert.equal(modelFailure(message), failure, message);
});

test("插件从 model_error 取出分类；别的错误没有分类", () => {
  assert.equal(modelFailureOf(modelError("402: Insufficient Balance")), "balance");
  assert.equal(modelFailureOf(new RepaFault("model_error", "x", { failure: "unknown" })), "other");
  assert.equal(modelFailureOf(new RepaFault("cancelled", "x")), undefined);
  assert.equal(modelFailureOf(new Error("402: Insufficient Balance")), undefined);
});

test("出错的回答在历史里带上原文和分类；被 Pi 自动重试过的标为 retried", () => {
  const branch = [
    { type: "message", id: "first", parentId: null, timestamp: "2026-10-13T00:00:00.000Z", message: failedAssistant("Request timed out.") },
    { type: "context_edit", id: "edit", parentId: "first", timestamp: "2026-10-13T00:00:01.000Z", targetId: "first", replacement: null },
    { type: "message", id: "last", parentId: "edit", timestamp: "2026-10-13T00:00:02.000Z", message: failedAssistant("Request timed out.") },
  ] as never[];
  const retried = retriedFailures(branch);
  assert.deepEqual([...retried], ["first"]);
  const data = (entry: never) => entryToPublic(entry, retried.has((entry as { id: string }).id))?.data;
  assert.deepEqual(data(branch[0] as never), {
    stopReason: "error", errorMessage: "Request timed out.", failure: "network", retried: true, provider: "deepseek", model: "deepseek-chat", calls: [],
  });
  assert.deepEqual(data(branch[2] as never), {
    stopReason: "error", errorMessage: "Request timed out.", failure: "network", provider: "deepseek", model: "deepseek-chat", calls: [],
  });
});

test("后端关闭时被取消的模型请求按 aborted 交出，不带出错信息；别的失败照旧，实时事件里不逐次报错", () => {
  const history = (errorMessage: string) => entryToPublic({
    type: "message", id: "entry", parentId: null, timestamp: "2026-10-13T00:00:00.000Z", message: failedAssistant(errorMessage),
  } as never)?.data as { stopReason: string; errorMessage?: string };
  assert.equal(history("This operation was aborted").stopReason, "aborted");
  assert.equal("errorMessage" in history("This operation was aborted"), false);
  assert.deepEqual([history("fetch failed").stopReason, history("fetch failed").errorMessage], ["error", "fetch failed"]);

  const live = (errorMessage: string) => convertEvent("session", { type: "message_end", message: failedAssistant(errorMessage) } as never, "run");
  assert.deepEqual(live("This operation was aborted").map((event) => event.type), ["message", "usage"]);
  assert.equal((live("This operation was aborted")[0]?.data as { stopReason: string }).stopReason, "aborted");
  // 出错的回答只报消息与用量；失败由运行一级的 error 事件报一次，Pi 自动重试的每一次不各报一遍。
  assert.deepEqual(live("fetch failed").map((event) => event.type), ["message", "usage"]);
});
