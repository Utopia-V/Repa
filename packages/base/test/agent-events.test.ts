import assert from "node:assert/strict";
import test from "node:test";
import { convertEvent, entryToPublic, errorStatus } from "../src/agent/events.js";

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

test("模型请求失败时按 Pi 统一的“状态码: 原文”格式取出状态码，历史条目带上它；认不出时不带", () => {
  assert.equal(errorStatus('401: {"message":"Authentication Fails, Your api key: ****0000 is invalid"}'), 401);
  assert.equal(errorStatus("Mistral error (429): Too Many Requests"), 429);
  assert.equal(errorStatus("402: Insufficient Balance"), 402);
  assert.equal(errorStatus("Provider stopped with: sensitive"), undefined);
  assert.equal(errorStatus("fetch failed"), undefined);
  assert.equal(errorStatus(undefined), undefined);

  const message = (errorMessage: string) => entryToPublic({
    type: "message", id: "entry", parentId: null, timestamp: "2026-10-13T00:00:00.000Z",
    message: {
      role: "assistant", content: [], api: "openai-completions", provider: "deepseek", model: "deepseek-chat",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "error", errorMessage, timestamp: 1,
    },
  } as never);
  assert.equal((message("401: invalid key")?.data as { errorStatus?: number }).errorStatus, 401);
  assert.equal("errorStatus" in (message("fetch failed")?.data as object), false);
});
